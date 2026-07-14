import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) { super(type); this.detail = options.detail; }
  };
}
globalThis.document = new EventTarget();
const localValues = new Map();
globalThis.localStorage = {
  getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
  setItem(key, value) { localValues.set(key, String(value)); },
  removeItem(key) { localValues.delete(key); },
};

const { store, supabase } = await import("../supabaseClient.js");
const originalFrom = supabase.from.bind(supabase);
const originalRpc = supabase.rpc.bind(supabase);
const originalRefresh = supabase.auth.refreshSession.bind(supabase.auth);

afterEach(async () => {
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
  supabase.auth.refreshSession = originalRefresh;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (value) => JSON.stringify(value);

function installDatabase(initialRows, options = {}) {
  const rows = new Map(Object.entries(initialRows).map(([key, row]) => [key, { ...row }]));
  let casCalls = 0;
  let deleteCalls = 0;
  let readCalls = 0;
  let versionProbeCalls = 0;

  supabase.auth.refreshSession = async () => ({ data: {}, error: null });
  supabase.from = (table) => {
    assert.equal(table, "app_state");
    return {
      select(columns) {
        let selectedKey = null;
        let selectedKeys = null;
        const builder = {
          eq(field, value) { assert.equal(field, "key"); selectedKey = value; return builder; },
          in(field, values) { assert.equal(field, "key"); selectedKeys = new Set(values); return builder; },
          async maybeSingle() {
            readCalls += 1;
            if (options.beforeRead) await options.beforeRead({ call: readCalls, key: selectedKey, rows });
            if (options.readError) return { data: null, error: options.readError };
            const row = rows.get(selectedKey);
            return { data: row ? { key: selectedKey, ...row } : null, error: null };
          },
          then(resolve, reject) {
            if (columns === "key, version") versionProbeCalls += 1;
            const data = [...rows.entries()]
              .filter(([key]) => !selectedKeys || selectedKeys.has(key))
              .map(([key, row]) => columns === "key, version" ? { key, version: row.version } : { key, ...row });
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  };
  supabase.rpc = async (name, args) => {
    if (name === "sps_app_state_batch_cas") {
      const operations = args.p_operations || [];
      const conflict = operations.find((operation) => {
        const current = rows.get(operation.key);
        return Number(operation.expected_version) !== (current ? current.version : 0);
      });
      if (conflict) {
        return { data: [{ applied: false, outcome: "conflict", conflict_key: conflict.key, current_versions: {} }], error: null };
      }
      const versions = {};
      for (const operation of operations) {
        const current = rows.get(operation.key);
        const version = current ? current.version + 1 : 1;
        rows.set(operation.key, { value: operation.value, version, updated_at: null });
        versions[operation.key] = version;
      }
      return { data: [{ applied: true, outcome: "updated", conflict_key: null, current_versions: versions }], error: null };
    }
    if (name === "sps_app_state_cas") {
      casCalls += 1;
      if (options.beforeCas) await options.beforeCas({ call: casCalls, args, rows });
      const current = rows.get(args.p_key);
      const expected = current ? current.version : 0;
      if (Number(args.p_expected_version) !== expected) {
        return { data: [{ applied: false, outcome: current ? "conflict" : "missing", current_version: current ? current.version : null, changed_at: null }], error: null };
      }
      const version = current ? current.version + 1 : 1;
      rows.set(args.p_key, { value: args.p_value, version, updated_at: null });
      return { data: [{ applied: true, outcome: current ? "updated" : "inserted", current_version: version, changed_at: null }], error: null };
    }
    if (name === "sps_app_state_delete_cas") {
      deleteCalls += 1;
      if (options.beforeDelete) await options.beforeDelete({ call: deleteCalls, args, rows });
      const current = rows.get(args.p_key);
      if (!current || current.version !== Number(args.p_expected_version)) {
        return { data: [{ applied: false, outcome: current ? "conflict" : "missing", current_version: current ? current.version : null, changed_at: null }], error: null };
      }
      rows.delete(args.p_key);
      return { data: [{ applied: true, outcome: "deleted", current_version: current.version, changed_at: null }], error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  };
  return { rows, get casCalls() { return casCalls; }, get deleteCalls() { return deleteCalls; }, get readCalls() { return readCalls; }, get versionProbeCalls() { return versionProbeCalls; } };
}

async function loadAs(uid, key) {
  store.setUser(uid);
  await store.get(key);
  await tick();
}

test("browser CAS merges independent cross-device edits instead of overwriting", async () => {
  const base = [{ id: "c1", phone: "111" }, { id: "c2", city: "Old" }];
  const db = installDatabase({ sps_clients: { value: json(base), version: 1, updated_at: null } });
  await loadAs("browser-merge", "sps_clients");

  const remote = structuredClone(base);
  remote[1].city = "Remote City";
  db.rows.set("sps_clients", { value: json(remote), version: 2, updated_at: null });
  const local = structuredClone(base);
  local[0].phone = "222";

  const result = await store.set("sps_clients", json(local), { baseValue: json(base) });
  const saved = JSON.parse(db.rows.get("sps_clients").value);

  assert.equal(result.ok, true);
  assert.equal(saved[0].phone, "222");
  assert.equal(saved[1].city, "Remote City");
  assert.equal(db.rows.get("sps_clients").version, 3);
});

test("targeted refresh adopts a clean remote schedule and publishes a safe reconcile", async () => {
  const base = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  const remote = [{ date: "07/13/2026", stops: [{ sid: "base" }, { sid: "remote" }] }];
  const db = installDatabase({ sps_schedule: { value: json(base), version: 1, updated_at: null } });
  await loadAs("schedule-refresh-clean", "sps_schedule");

  const reconciles = [];
  const onReconciled = (event) => { if (event.detail && event.detail.key) reconciles.push(event.detail); };
  document.addEventListener("sps-reconciled", onReconciled);
  try {
    db.rows.set("sps_schedule", { value: json(remote), version: 2, updated_at: null });
    const result = await store.refresh("sps_schedule");
    const cached = await store.get("sps_schedule");

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.pending, false);
    assert.equal(result.version, 2);
    assert.deepEqual(JSON.parse(cached.value), remote);
    assert.equal(cached.version, 2);
    assert.deepEqual(reconciles, [{ key: "sps_schedule", forceRemote: false, remoteMissing: false }]);
  } finally {
    document.removeEventListener("sps-reconciled", onReconciled);
  }
});

test("group refresh probes versions and downloads only changed shared records", async () => {
  const schedule = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  const completed = { base: true };
  const db = installDatabase({
    sps_schedule: { value: json(schedule), version: 2, updated_at: null },
    sps_completed: { value: json(completed), version: 4, updated_at: null },
  });
  await loadAs("schedule-version-probe", "sps_schedule");

  const nextCompleted = { ...completed, remote: true };
  db.rows.set("sps_completed", { value: json(nextCompleted), version: 5, updated_at: null });
  const result = await store.refreshChanged(["sps_schedule", "sps_completed"]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changedKeys, ["sps_completed"]);
  assert.equal(db.versionProbeCalls, 1);
  assert.equal(db.readCalls, 1);
  assert.deepEqual(JSON.parse((await store.get("sps_completed")).value), nextCompleted);

  const unchanged = await store.refreshChanged(["sps_schedule", "sps_completed"]);
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.changedKeys, []);
  assert.equal(db.versionProbeCalls, 2);
  assert.equal(db.readCalls, 1);
});

test("group version probe detects remote deletion through the dirty-aware refresh path", async () => {
  const schedule = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  const db = installDatabase({ sps_schedule: { value: json(schedule), version: 3, updated_at: null } });
  await loadAs("schedule-version-delete", "sps_schedule");

  db.rows.delete("sps_schedule");
  const result = await store.refreshChanged(["sps_schedule"]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changedKeys, ["sps_schedule"]);
  assert.equal(db.versionProbeCalls, 1);
  assert.equal(db.readCalls, 1);
  assert.equal(await store.get("sps_schedule"), null);
});

test("targeted refresh reconciles React even when the store already has the remote version", async () => {
  const current = [{ date: "07/13/2026", stops: [{ sid: "current" }] }];
  installDatabase({ sps_schedule: { value: json(current), version: 3, updated_at: null } });
  await loadAs("schedule-refresh-missed-boot-event", "sps_schedule");

  const reconciles = [];
  const onReconciled = (event) => { if (event.detail && event.detail.key) reconciles.push(event.detail); };
  document.addEventListener("sps-reconciled", onReconciled);
  try {
    const result = await store.refresh("sps_schedule");

    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.deepEqual(reconciles, [{ key: "sps_schedule", forceRemote: false, remoteMissing: false }]);
  } finally {
    document.removeEventListener("sps-reconciled", onReconciled);
  }
});

test("targeted refresh reports a clean remote deletion without preserving stale cache", async () => {
  const base = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  const db = installDatabase({ sps_schedule: { value: json(base), version: 4, updated_at: null } });
  await loadAs("schedule-refresh-delete", "sps_schedule");

  const reconciles = [];
  const onReconciled = (event) => { if (event.detail && event.detail.key) reconciles.push(event.detail); };
  document.addEventListener("sps-reconciled", onReconciled);
  try {
    db.rows.delete("sps_schedule");
    const result = await store.refresh("sps_schedule");
    const cached = await store.get("sps_schedule");

    assert.equal(result.ok, true);
    assert.equal(result.exists, false);
    assert.equal(cached, null);
    assert.deepEqual(reconciles, [{ key: "sps_schedule", forceRemote: false, remoteMissing: true }]);
  } finally {
    document.removeEventListener("sps-reconciled", onReconciled);
  }
});

test("refresh preserves an optimistic schedule edit and the queued CAS merges the remote change", async () => {
  const baseStop = { sid: "base", clientId: "c1", time: "8:00 AM" };
  const base = [{ date: "07/13/2026", stops: [baseStop] }];
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const db = installDatabase(
    { sps_schedule: { value: json(base), version: 1, updated_at: null } },
    { beforeRead: async ({ call }) => { if (call === 1) { readStarted(); await gate; } } }
  );
  await loadAs("schedule-refresh-pending", "sps_schedule");

  const remote = [{ date: "07/13/2026", stops: [baseStop, { sid: "remote", clientId: "c2" }] }];
  db.rows.set("sps_schedule", { value: json(remote), version: 2, updated_at: null });
  const refresh = store.refresh("sps_schedule");
  await started;

  const local = [{ date: "07/13/2026", stops: [baseStop, { sid: "local", clientId: "c3" }] }];
  const save = store.set("sps_schedule", json(local), { baseValue: json(base) });
  assert.deepEqual(JSON.parse((await store.get("sps_schedule")).value), local);

  releaseRead();
  const refreshResult = await refresh;
  const saveResult = await save;
  const stored = JSON.parse(db.rows.get("sps_schedule").value);
  const savedSids = stored.flatMap((day) => day.stops || []).map((stop) => stop.sid);

  assert.equal(refreshResult.ok, true);
  assert.equal(refreshResult.pending, true);
  assert.equal(saveResult.ok, true);
  assert.deepEqual(new Set(savedSids), new Set(["base", "remote", "local"]));
  assert.equal(db.rows.get("sps_schedule").version, 3);
});

test("failed targeted refresh leaves the confirmed schedule cache untouched", async () => {
  const base = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  const readError = new Error("temporary network failure");
  const db = installDatabase(
    { sps_schedule: { value: json(base), version: 7, updated_at: null } },
    { readError }
  );
  await loadAs("schedule-refresh-error", "sps_schedule");

  const result = await store.refresh("sps_schedule");
  const cached = await store.get("sps_schedule");

  assert.equal(result.ok, false);
  assert.equal(result.error, readError);
  assert.deepEqual(JSON.parse(cached.value), base);
  assert.equal(cached.version, 7);
  assert.equal(db.readCalls, 3);
});

test("a refresh started by a prior signed-in identity cannot land after an account switch", async () => {
  const base = [{ date: "07/13/2026", stops: [{ sid: "base" }] }];
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const db = installDatabase(
    { sps_schedule: { value: json(base), version: 1, updated_at: null } },
    { beforeRead: async ({ call }) => { if (call === 1) { readStarted(); await gate; } } }
  );
  await loadAs("schedule-refresh-old-user", "sps_schedule");

  db.rows.set("sps_schedule", { value: json([{ date: "07/13/2026", stops: [{ sid: "other-account" }] }]), version: 2, updated_at: null });
  const keyedReconciles = [];
  const onReconciled = (event) => { if (event.detail && event.detail.key) keyedReconciles.push(event.detail); };
  document.addEventListener("sps-reconciled", onReconciled);
  try {
    const refresh = store.refresh("sps_schedule");
    await started;
    store.setUser("schedule-refresh-new-user");
    releaseRead();
    const result = await refresh;

    assert.equal(result.ok, false);
    assert.equal(result.staleIdentity, true);
    assert.deepEqual(keyedReconciles, []);
  } finally {
    document.removeEventListener("sps-reconciled", onReconciled);
  }
});

test("browser pauses on a same-field conflict until an employee chooses", async () => {
  const base = [{ id: "c1", name: "Original" }];
  const db = installDatabase({ sps_clients: { value: json(base), version: 1, updated_at: null } });
  await loadAs("browser-conflict", "sps_clients");
  db.rows.set("sps_clients", { value: json([{ id: "c1", name: "Shared" }]), version: 2, updated_at: null });

  const result = await store.set("sps_clients", json([{ id: "c1", name: "Mine" }]), { baseValue: json(base) });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(store.listConflicts()[0].key, "sps_clients");

  const resolved = await store.resolveConflict("sps_clients", "remote");
  assert.equal(resolved.ok, true);
  assert.equal(JSON.parse(resolved.value)[0].name, "Shared");
  assert.deepEqual(store.listConflicts(), []);
});

test("an older response cannot clear a newer queued edit", async () => {
  const base = [{ id: "c1", note: "A" }];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const db = installDatabase(
    { sps_clients: { value: json(base), version: 1, updated_at: null } },
    { beforeCas: async ({ call }) => { if (call === 1) { firstStarted(); await gate; } } }
  );
  await loadAs("browser-chain", "sps_clients");

  const first = store.set("sps_clients", json([{ id: "c1", note: "B" }]), { baseValue: json(base) });
  await started;
  const second = store.set("sps_clients", json([{ id: "c1", note: "C" }]), { baseValue: json(base) });
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(JSON.parse(db.rows.get("sps_clients").value)[0].note, "C");
  assert.equal(db.rows.get("sps_clients").version, 3);
  assert.deepEqual(store.listConflicts(), []);
});

test("a delete is serialized behind an in-flight save", async () => {
  const base = [{ id: "c1", note: "A" }];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const db = installDatabase(
    { sps_clients: { value: json(base), version: 1, updated_at: null } },
    { beforeCas: async ({ call }) => { if (call === 1) { firstStarted(); await gate; } } }
  );
  await loadAs("browser-delete-after-set", "sps_clients");

  const save = store.set("sps_clients", json([{ id: "c1", note: "B" }]), { baseValue: json(base) });
  await started;
  const removal = store.remove("sps_clients", { force: true });
  releaseFirst();
  await Promise.all([save, removal]);

  assert.equal(db.rows.has("sps_clients"), false);
  assert.equal(db.deleteCalls, 1);
});

test("a delayed delete response cannot erase a newer recreation", async () => {
  const base = [{ id: "c1", note: "A" }];
  let releaseDelete;
  let deleteStarted;
  const started = new Promise((resolve) => { deleteStarted = resolve; });
  const gate = new Promise((resolve) => { releaseDelete = resolve; });
  const db = installDatabase(
    { sps_clients: { value: json(base), version: 1, updated_at: null } },
    { beforeDelete: async ({ call }) => { if (call === 1) { deleteStarted(); await gate; } } }
  );
  await loadAs("browser-set-after-delete", "sps_clients");

  const removal = store.remove("sps_clients", { force: true });
  await started;
  const recreation = store.set("sps_clients", json([{ id: "c2", note: "new" }]), { baseValue: json(base) });
  releaseDelete();
  await Promise.all([removal, recreation]);

  assert.equal(JSON.parse(db.rows.get("sps_clients").value)[0].id, "c2");
  assert.deepEqual(store.listConflicts(), []);
});

test("atomic multi-section replacement applies every section together", async () => {
  const db = installDatabase({
    sps_clients: { value: json([{ id: "old" }]), version: 3, updated_at: null },
    sps_schedule: { value: json([{ date: "old", stops: [] }]), version: 8, updated_at: null },
  });
  await loadAs("browser-batch-success", "sps_clients");

  const result = await store.replaceMany([
    { key: "sps_clients", value: json([{ id: "new" }]), expectedVersion: 3 },
    { key: "sps_schedule", value: json([]), expectedVersion: 8 },
  ]);

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(db.rows.get("sps_clients").value)[0].id, "new");
  assert.deepEqual(JSON.parse(db.rows.get("sps_schedule").value), []);
});

test("atomic multi-section replacement changes nothing when one baseline is stale", async () => {
  const originalClients = json([{ id: "shared-newer" }]);
  const originalSchedule = json([{ date: "keep", stops: [] }]);
  const db = installDatabase({
    sps_clients: { value: originalClients, version: 4, updated_at: null },
    sps_schedule: { value: originalSchedule, version: 8, updated_at: null },
  });
  await loadAs("browser-batch-conflict", "sps_clients");

  const result = await store.replaceMany([
    { key: "sps_clients", value: json([{ id: "restore" }]), expectedVersion: 3 },
    { key: "sps_schedule", value: json([]), expectedVersion: 8 },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.conflictKey, "sps_clients");
  assert.equal(db.rows.get("sps_clients").value, originalClients);
  assert.equal(db.rows.get("sps_schedule").value, originalSchedule);
});
