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
const originalIdb = { get: idb.get, set: idb.set, del: idb.del };
const idbValues = new Map();
let idbMode = "write";
let idbDeleteMode = "delete";
idb.get = async (key) => idbValues.get(key) || null;
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
    assert.equal(Number(args.p_expected_version), row.version);
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
  const key = "sps_schedule";
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
  const key = "sps_clients";
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
  const key = "sps_schedule";
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
