import test, { after } from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) { super(type); this.detail = options.detail; }
  };
}
globalThis.document = new EventTarget();

const localValues = new Map();
let localMode = "write";
globalThis.localStorage = {
  getItem(key) { return localValues.has(key) ? localValues.get(key) : null; },
  setItem(key, value) {
    if (localMode === "throw") throw new Error("localStorage quota exceeded");
    if (localMode === "drop") return;
    localValues.set(key, String(value));
  },
  removeItem(key) { localValues.delete(key); },
};

const { idb } = await import("../idbStore.js");
const originalIdb = { get: idb.get, getVerified: idb.getVerified, set: idb.set, del: idb.del };
const idbValues = new Map();
let idbMode = "write";
let idbDeleteMode = "delete";
idb.get = async (key) => idbValues.get(key) || null;
idb.getVerified = (...args) => idb.get(...args);
idb.set = async (key, value) => {
  if (idbMode === "throw") throw new Error("IndexedDB unavailable");
  if (idbMode === "drop") return null;
  idbValues.set(key, structuredClone(value));
  return key;
};
idb.del = async (key) => {
  if (idbDeleteMode === "throw") throw new Error("IndexedDB delete failed");
  if (idbDeleteMode === "drop") return null;
  idbValues.delete(key);
  return true;
};

const { store, supabase } = await import("../supabaseClient.js");
const originalFrom = supabase.from.bind(supabase);
const originalRpc = supabase.rpc.bind(supabase);
const originalRefresh = supabase.auth.refreshSession.bind(supabase.auth);

after(() => {
  idb.get = originalIdb.get;
  idb.getVerified = originalIdb.getVerified;
  idb.set = originalIdb.set;
  idb.del = originalIdb.del;
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
  supabase.auth.refreshSession = originalRefresh;
});

const json = (value) => JSON.stringify(value);

function installDatabase(key, initialValue, beforeCas = () => {}) {
  let row = { value: initialValue, version: 1, updated_at: null };
  let casCalls = 0;
  supabase.auth.refreshSession = async () => ({ data: {}, error: null });
  supabase.from = (table) => {
    assert.equal(table, "app_state");
    return {
      select(columns) {
        let selectedKey = null;
        const builder = {
          eq(field, value) { assert.equal(field, "key"); selectedKey = value; return builder; },
          in(field) { assert.equal(field, "key"); return builder; },
          async maybeSingle() {
            return { data: selectedKey === key ? { key, ...row } : null, error: null };
          },
          then(resolve, reject) {
            const data = columns === "key, version"
              ? [{ key, version: row.version }]
              : [{ key, ...row }];
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  };
  supabase.rpc = async (name, args) => {
    assert.equal(name, "sps_app_state_cas");
    casCalls += 1;
    beforeCas();
    assert.equal(args.p_key, key);
    if (Number(args.p_expected_version) !== row.version) {
      return { data: [{ applied: false, outcome: "conflict", current_version: row.version }], error: null };
    }
    row = { value: args.p_value, version: row.version + 1, updated_at: null };
    return {
      data: [{ applied: true, outcome: "updated", current_version: row.version, changed_at: null }],
      error: null,
    };
  };
  return {
    get casCalls() { return casCalls; },
    get row() { return row; },
  };
}

async function prepare(uid, key) {
  localValues.clear();
  idbValues.clear();
  idbDeleteMode = "delete";
  store.setUser(uid);
  await store.get(key);
}

test("a verified IndexedDB pending copy allows the network commit when localStorage is unavailable", async () => {
  const uid = "pending-idb-only";
  const key = "sps_durability_test";
  const base = json([{ sid: "base" }]);
  const next = json([{ sid: "base" }, { sid: "next" }]);
  localMode = "throw";
  idbMode = "write";
  let durableAtCas = false;
  const db = installDatabase(key, base, () => {
    durableAtCas = idbValues.has(`pending-v2:${uid}`);
  });
  await prepare(uid, key);

  const result = await store.set(key, next, { baseValue: base });

  assert.equal(result.ok, true);
  assert.equal(db.casCalls, 1);
  assert.equal(durableAtCas, true);
  assert.equal(db.row.value, next);
});

test("a verified localStorage pending copy allows the network commit when IndexedDB drops the write", async () => {
  const uid = "pending-local-only";
  const key = "sps_durability_test";
  const base = json([{ id: "c1", note: "base" }]);
  const next = json([{ id: "c1", note: "next" }]);
  localMode = "write";
  idbMode = "drop";
  let durableAtCas = false;
  const db = installDatabase(key, base, () => {
    durableAtCas = localValues.has(`sps_pending_writes:${uid}`);
  });
  await prepare(uid, key);

  const result = await store.set(key, next, { baseValue: base });

  assert.equal(result.ok, true);
  assert.equal(db.casCalls, 1);
  assert.equal(durableAtCas, true);
  assert.equal(db.row.value, next);
});

test("a failed IndexedDB delete is replaced by a verified empty tombstone after the server commit", async () => {
  const uid = "pending-idb-delete-fails";
  const key = "sps_durability_test";
  const base = json([{ sid: "base" }]);
  const next = json([{ sid: "base" }, { sid: "confirmed" }]);
  localMode = "write";
  idbMode = "write";
  const db = installDatabase(key, base, () => { idbDeleteMode = "throw"; });
  await prepare(uid, key);

  const result = await store.set(key, next, { baseValue: base });
  const pendingSnapshot = idbValues.get(`pending-v2:${uid}`);

  assert.equal(result.ok, true);
  assert.equal(db.casCalls, 1);
  assert.equal(db.row.value, next);
  assert.deepEqual(pendingSnapshot?.data, {}, "the stale replayable envelope must be replaced even when delete fails");
  assert.equal(localValues.get(`sps_pending_writes:${uid}`), undefined);
});

test("the network commit is blocked for review when neither local durable store retains the pending copy", async () => {
  const uid = "pending-nowhere";
  const key = "sps_invoices";
  const base = json([{ id: "i1", total: 100 }]);
  const next = json([{ id: "i1", total: 125 }]);
  localMode = "drop";
  idbMode = "drop";
  const db = installDatabase(key, base);
  await prepare(uid, key);

  const result = await store.set(key, next, { baseValue: base });

  assert.equal(result.ok, false);
  assert.equal(result.durabilityFailed, true);
  assert.equal(result.review, true);
  assert.equal(result.queued, false);
  assert.equal(result.error.code, "pending_durability_unavailable");
  assert.match(result.error.message, /could not be saved on this device/i);
  assert.equal(db.casCalls, 0, "Supabase must not run ahead of an unverified in-memory-only edit");
  assert.equal(localValues.has(`sps_pending_writes:${uid}`), false);
  assert.equal(idbValues.has(`pending-v2:${uid}`), false);
  assert.equal((await store.get(key)).value, next, "the open screen keeps the optimistic value for review and retry");
});

test("a timed-out committed CAS releases the queue and retry verifies the existing save without applying twice", async () => {
  const key = "sps_estimates", uid = "pending-network-timeout";
  const base = json([{ id: "estimate", title: "Before" }]);
  const next = json([{ id: "estimate", title: "After" }]);
  localMode = "write"; idbMode = "write";
  const db = installDatabase(key, base);
  await prepare(uid, key);
  const ordinaryRpc = supabase.rpc;
  let first = true;
  supabase.rpc = async (name, args) => {
    const receipt = await ordinaryRpc(name, args);
    if (first) { first = false; return new Promise(() => {}); }
    return receipt;
  };
  const originalTimer = globalThis.setTimeout, originalNow = Date.now;
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms === 20_000 ? 5 : ms, ...args);
  try {
    const uncertain = await store.set(key, next, { baseValue: base });
    assert.equal(uncertain.ok, false); assert.equal(uncertain.queued, true);
    assert.equal(uncertain.error.code, "APP_STATE_REQUEST_TIMEOUT");
    assert.equal(db.row.value, next, "the server committed even though its reply never arrived");
    assert.ok(idbValues.get(`pending-v2:${uid}`)?.data[key]);
    const now = originalNow(); Date.now = () => now + 10_000;
    const recovered = await store.flushKey(key);
    assert.equal(recovered.ok, true); assert.equal(db.row.version, 2);
    assert.equal(db.casCalls, 2, "retry conflicts on the old version, then verifies the already-applied value");
    assert.equal(idbValues.has(`pending-v2:${uid}`), false);
  } finally { globalThis.setTimeout = originalTimer; Date.now = originalNow; }
});

test("failed durable cleanup reads cannot be treated as proof that the pending intent was deleted", async () => {
  const key = "sps_durability_test", uid = "pending-cleanup-read-failure";
  const base = json([{ sid: "stop", note: "Before" }]);
  const next = json([{ sid: "stop", note: "After" }]);
  localMode = "write"; idbMode = "write";
  let serverCommitted = false;
  const db = installDatabase(key, base, () => { serverCommitted = true; idbDeleteMode = "drop"; });
  await prepare(uid, key);
  idb.getVerified = async key => {
    if (serverCommitted) throw Object.assign(new Error("Device storage read timed out"), { code: "IDB_TIMEOUT" });
    return idb.get(key);
  };
  try {
    const result = await store.set(key, next, { baseValue: base });
    assert.equal(result.ok, false); assert.equal(result.error.code, "pending_cleanup_unavailable");
    assert.equal(db.row.value, next); assert.equal(db.row.version, 2);
    assert.ok(idbValues.get(`pending-v2:${uid}`)?.data[key], "retain the unresolved local intent for a safe retry");
  } finally { idb.getVerified = (...args) => idb.get(...args); }
});

for (const method of ["flushKey", "flush"]) {
  test(`${method} retries recovered device storage without requiring another edit`, async () => {
    const key = "sps_durability_test", uid = `pending-recovered-${method}`;
    const base = json([{ id: "c1", notes: "Before" }]);
    const next = json([{ id: "c1", notes: "After" }]);
    localMode = "drop"; idbMode = "drop";
    const db = installDatabase(key, base);
    await prepare(uid, key);
    const first = await store.set(key, next, { baseValue: base });
    assert.equal(first.durabilityFailed, true);
    assert.equal(db.casCalls, 0);
    await new Promise(resolve => setImmediate(resolve)); // let the initial read's background drain settle

    idbMode = "write";
    const retry = await store[method](key);

    assert.equal(retry.ok, true, "retry must verify a new durable copy instead of replaying the old storage failure");
    assert.equal(db.casCalls, 1);
    assert.equal(db.row.value, next);
    assert.equal(idbValues.has(`pending-v2:${uid}`), false);
  });
}

test("a conflict choice retains the newest edit until device storage can protect it", async () => {
  const key = "sps_durability_test", uid = "conflict-needs-durable-edit";
  const base = json([{ id: "c1", notes: "Before" }]);
  const shared = json([{ id: "c1", notes: "Shared" }]);
  const local = json([{ id: "c1", notes: "Local" }]);
  const newest = json([{ id: "c1", notes: "Newest local" }]);
  localMode = "write"; idbMode = "write";
  const db = installDatabase(key, base);
  await prepare(uid, key);
  db.row.value = shared; db.row.version += 1;
  assert.equal((await store.set(key, local, { baseValue: base })).conflict, true);

  localMode = "drop"; idbMode = "drop";
  assert.equal((await store.set(key, newest, { baseValue: base })).durabilityFailed, true);
  const beforeChoice = db.casCalls;
  const blocked = await store.resolveConflict(key, "local");
  assert.equal(blocked.durabilityFailed, true);
  assert.equal(blocked.queued, false);
  assert.equal(db.casCalls, beforeChoice, "a resolution cannot bypass the durable-intent fence");
  assert.equal(db.row.value, shared);
  assert.equal((await store.get(key)).value, newest);
  assert.equal(store.listConflicts()[0]?.key, key);

  idbMode = "write";
  const resolved = await store.resolveConflict(key, "local");
  assert.equal(resolved.ok, true);
  assert.equal(db.row.value, newest);
  assert.equal(db.casCalls, beforeChoice + 1);
  assert.deepEqual(store.listConflicts(), []);
});

test("failed pending hydration preserves an IndexedDB-only intent and later combines the new edit", async () => {
  const key = "sps_durability_test", uid = "pending-hydration-read-failure";
  const base = json([{ id: "c1", notes: "Before", phone: "111" }]);
  const offline = json([{ id: "c1", notes: "Original offline report", phone: "111" }]);
  const newer = json([{ id: "c1", notes: "Before", phone: "222" }]);
  localValues.clear(); idbValues.clear(); localMode = "throw"; idbMode = "write"; idbDeleteMode = "delete";
  const original = { uid, at: 1000, data: { [key]: {
    v: 2, opId: "original-offline-intent", baseExists: true, baseValue: base,
    baseVersion: 1, localValue: offline, status: "pending", conflicts: [],
    createdAt: 1000, updatedAt: 1000,
  } } };
  idbValues.set(`pending-v2:${uid}`, structuredClone(original));
  const db = installDatabase(key, base);
  let readsFail = true;
  const read = idb.get;
  idb.get = async storageKey => storageKey === `pending-v2:${uid}` && readsFail ? null : read(storageKey);
  idb.getVerified = async storageKey => {
    if (storageKey === `pending-v2:${uid}` && readsFail) throw Object.assign(new Error("Pending storage read timed out"), { code: "IDB_TIMEOUT" });
    return read(storageKey);
  };
  try {
    store.setUser(uid);
    await store.get(key);
    const blocked = await store.set(key, newer, { baseValue: base });
    assert.equal(blocked.durabilityFailed, true);
    assert.equal(db.casCalls, 0);
    assert.deepEqual(idbValues.get(`pending-v2:${uid}`), original, "failed hydration must not replace an unread queue");
    await store.initialize();
    readsFail = false;
    await store.get(key); // a background read can recover storage before the retained form retries
    // The form retains its new value after the failed save; retry submits that same edit/base.
    const recovered = await store.set(key, newer, { baseValue: base });
    assert.equal(recovered.ok, true);
    assert.deepEqual(JSON.parse(db.row.value), [{ id: "c1", notes: "Original offline report", phone: "222" }]);
    assert.equal(db.casCalls, 2, "recover the original intent before merging the new form edit");
  } finally {
    idb.get = read;
    idb.getVerified = (...args) => idb.get(...args);
  }
});

test("repeated new saves cannot replace an unresolved conflict recovered during hydration", async () => {
  const key = "sps_durability_test", uid = "pending-hydration-conflict";
  const base = json([{ id: "c1", notes: "Before", phone: "111" }]);
  const offline = json([{ id: "c1", notes: "Offline notes", phone: "111" }]);
  const newer = json([{ id: "c1", notes: "Before", phone: "222" }]);
  localValues.clear(); idbValues.clear(); localMode = "throw"; idbMode = "write"; idbDeleteMode = "delete";
  idbValues.set(`pending-v2:${uid}`, { uid, at: 1000, data: { [key]: {
    v: 2, opId: "original-conflict", baseExists: true, baseValue: base, baseVersion: 1,
    localValue: offline, status: "conflict", conflicts: [{ path: "$.id:c1.notes", kind: "same-field-edit" }],
    createdAt: 1000, updatedAt: 1000,
  } } });
  const db = installDatabase(key, json([{ id: "c1", notes: "Shared notes", phone: "111" }]));
  store.setUser(uid);
  assert.equal((await store.set(key, newer, { baseValue: base })).conflict, true);
  assert.equal((await store.set(key, newer, { baseValue: base })).conflict, true);
  assert.equal(db.casCalls, 0);
  assert.equal(idbValues.get(`pending-v2:${uid}`).data[key].localValue, offline);
  assert.equal((await store.resolveConflict(key, "local")).ok, true);
  assert.equal((await store.set(key, newer, { baseValue: base })).ok, true);
  assert.deepEqual(JSON.parse(db.row.value), [{ id: "c1", notes: "Offline notes", phone: "222" }]);
});

test("a conflict choice cannot bypass an unread newer IndexedDB intent", async () => {
  const key = "sps_durability_test", uid = "conflict-hydration-read-failure";
  const base = json([{ id: "c1", notes: "Before" }]);
  const shared = json([{ id: "c1", notes: "Shared notes" }]);
  const older = json([{ id: "c1", notes: "Older offline notes" }]);
  const newest = json([{ id: "c1", notes: "Newest offline notes" }]);
  localValues.clear(); idbValues.clear(); localMode = "write"; idbMode = "write"; idbDeleteMode = "delete";
  const envelope = {
    v: 2, opId: "older-conflict", baseExists: true, baseValue: base, baseVersion: 1,
    localValue: older, status: "conflict", conflicts: [{ path: "$.id:c1.notes", kind: "same-field-edit" }],
    createdAt: 1000, updatedAt: 1000,
  };
  localValues.set(`sps_pending_writes:${uid}`, json({ [key]: envelope }));
  const original = { uid, at: 2000, data: { [key]: { ...envelope, opId: "newest-conflict", localValue: newest, updatedAt: 2000 } } };
  idbValues.set(`pending-v2:${uid}`, structuredClone(original));
  const db = installDatabase(key, shared);
  const read = idb.getVerified;
  idb.getVerified = async () => { throw Object.assign(new Error("Pending storage read timed out"), { code: "IDB_TIMEOUT" }); };
  try {
    store.setUser(uid);
    const blocked = await store.resolveConflict(key, "local");
    assert.equal(blocked.durabilityFailed, true);
    assert.equal(db.casCalls, 0, "never resolve an older fallback before the complete queue can be read");
    assert.deepEqual(idbValues.get(`pending-v2:${uid}`), original);
    idb.getVerified = read;
    assert.equal((await store.resolveConflict(key, "local")).ok, true);
    assert.equal(db.row.value, newest);
  } finally { idb.getVerified = read; }
});

async function prepareClientConflict(uid, { withPulse = false } = {}) {
  const key = "sps_durability_test", pulse = "sps_conflict_test_pulse";
  const base = json([{ id: "c1", notes: "Before" }]);
  const local = json([{ id: "c1", notes: "Local" }]);
  const shared = json([{ id: "c1", notes: "Shared" }]);
  const envelope = (value, baseline) => ({
    v: 2, opId: `original-${value}`, baseExists: true, baseValue: baseline, baseVersion: 1,
    localValue: value, status: "conflict", conflicts: [{ path: "$.id:c1.notes", kind: "same-field-edit" }],
    createdAt: 1000, updatedAt: 1000,
  });
  localValues.clear(); idbValues.clear(); localMode = "write"; idbMode = "write"; idbDeleteMode = "delete";
  const data = { [key]: envelope(local, base) };
  if (withPulse) data[pulse] = envelope(json({ tick: -1 }), json({ tick: -2 }));
  idbValues.set(`pending-v2:${uid}`, { uid, at: 1000, data });
  const db = installDatabase(key, shared);
  store.setUser(uid); await store.get(key); await store.initialize();
  return { key, pulse, base, local, shared, db };
}

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("a client conflict finishes while unrelated pending saves continue", async () => {
  const uid = "conflict-unrelated-save-fence";
  const { key, pulse, db } = await prepareClientConflict(uid, { withPulse: true });
  const ordinarySet = idb.set;
  let producing = true, writes = 0;
  const saves = [];
  idb.set = async (storageKey, value) => {
    if (storageKey === `pending-v2:${uid}`) {
      await new Promise(resolve => setImmediate(resolve));
      if (producing && writes < 20) {
        writes += 1;
        saves.push(store.set(pulse, json({ tick: writes }), { baseValue: json({ tick: -2 }) }));
      }
    }
    return ordinarySet(storageKey, value);
  };
  try {
    saves.push(store.set(pulse, json({ tick: 0 }), { baseValue: json({ tick: -2 }) }));
    const result = await store.resolveConflict(key, "local");
    assert.equal(result.ok, true);
    assert.equal(db.casCalls, 1);
    assert.ok(writes < 20, "the client choice must finish before unrelated saves stop extending the global queue");
  } finally {
    producing = false;
    await Promise.all(saves);
    idb.set = ordinarySet;
  }
});

test("a conflict choice cannot use an older durability receipt for a newer same-key edit", async () => {
  const uid = "conflict-same-key-durability-fence";
  const { key, pulse, base, db } = await prepareClientConflict(uid, { withPulse: true });
  const newest = json([{ id: "c1", notes: "Newest" }]);
  const first = deferred(), entered = deferred(), newer = deferred(), newerEntered = deferred();
  const ordinarySet = idb.set;
  let firstWrite = true;
  idb.set = async (storageKey, value) => {
    if (storageKey === `pending-v2:${uid}`) {
      if (firstWrite) { firstWrite = false; entered.resolve(); await first.promise; }
      else if (value.data[key]?.localValue === newest) { newerEntered.resolve(); await newer.promise; }
    }
    return ordinarySet(storageKey, value);
  };
  let pulseSave, latestSave;
  try {
    pulseSave = store.set(pulse, json({ tick: 0 }), { baseValue: json({ tick: -2 }) });
    await entered.promise;
    const choice = store.resolveConflict(key, "local");
    await new Promise(resolve => setImmediate(resolve));
    latestSave = store.set(key, newest, { baseValue: base });
    first.resolve();
    await newerEntered.promise;
    const result = await choice;
    assert.equal(result.superseded, true);
    assert.equal(db.casCalls, 0, "the newer value is not yet durably stored");
    newer.resolve(); await latestSave;
    const retried = await store.resolveConflict(key, "local");
    assert.equal(retried.ok, true); assert.equal(db.row.value, newest);
  } finally {
    first.resolve(); newer.resolve();
    await Promise.all([pulseSave, latestSave].filter(Boolean));
    idb.set = ordinarySet;
  }
});

test("an account switch invalidates a conflict choice waiting for local durability", async () => {
  const uid = "conflict-identity-durability-fence";
  const { key, pulse, db } = await prepareClientConflict(uid, { withPulse: true });
  const held = deferred(), entered = deferred();
  const ordinarySet = idb.set;
  idb.set = async (storageKey, value) => {
    if (storageKey === `pending-v2:${uid}`) { entered.resolve(); await held.promise; }
    return ordinarySet(storageKey, value);
  };
  let pulseSave;
  try {
    pulseSave = store.set(pulse, json({ tick: 0 }), { baseValue: json({ tick: -2 }) });
    await entered.promise;
    const choice = store.resolveConflict(key, "local");
    await new Promise(resolve => setImmediate(resolve));
    store.setUser("different-account");
    held.resolve();
    const result = await choice;
    assert.equal(result.staleIdentity, true); assert.equal(db.casCalls, 0);
    assert.ok(idbValues.get(`pending-v2:${uid}`)?.data[key], "the original account's unsaved work remains recoverable");
    assert.equal(idbValues.has("pending-v2:different-account"), false);
  } finally { held.resolve(); await pulseSave; idb.set = ordinarySet; }
});

test("identical conflict autosaves retain their original intent without rewriting the large pending copy", async () => {
  const uid = "conflict-identical-autosaves";
  const { key, base, local, db } = await prepareClientConflict(uid);
  const original = structuredClone(idbValues.get(`pending-v2:${uid}`));
  const ordinarySet = idb.set;
  let pendingWrites = 0;
  idb.set = async (storageKey, value) => {
    if (storageKey === `pending-v2:${uid}`) pendingWrites += 1;
    return ordinarySet(storageKey, value);
  };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => store.set(key, local, { baseValue: base })));
    assert.ok(results.every(result => result.conflict));
    assert.equal(pendingWrites, 0);
    assert.deepEqual(idbValues.get(`pending-v2:${uid}`), original);
    assert.equal(db.casCalls, 0);
    assert.equal((await store.resolveConflict(key, "local")).ok, true);
  } finally { idb.set = ordinarySet; }
});
