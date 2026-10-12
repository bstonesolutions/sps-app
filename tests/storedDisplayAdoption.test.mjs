import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mergeStoredState } from "../stateMerge.js";

if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const localValues = new Map(), disk = new Map();
globalThis.localStorage = { getItem: key => localValues.get(key) ?? null, setItem: (key, value) => localValues.set(key, value), removeItem: key => localValues.delete(key) };
const { idb } = await import("../idbStore.js");
const originalIdb = { get: idb.get, getVerified: idb.getVerified, set: idb.set, del: idb.del };
idb.get = idb.getVerified = async key => structuredClone(disk.get(key));
idb.set = async (key, value) => { disk.set(key, structuredClone(value)); return key; };
idb.del = async key => { disk.delete(key); };
const { store, supabase } = await import("../supabaseClient.js");
globalThis.window = {};
const original = { from: supabase.from, rpc: supabase.rpc };
after(() => { Object.assign(idb, originalIdb); Object.assign(supabase, original); });
const json = JSON.stringify;
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const start = source.indexOf("function useStoredState(");
const end = source.indexOf("// Debounced auto-save", start);
const hookSource = source.slice(start, end);

// Executes the actual App hook, including dependency-based effects, cleanups, refs and functional
// setters. Pausing effect delivery reproduces a React edit not yet staged when refresh completes.
function mountHook(key, initial) {
  let cursor = 0, dirty = true, output;
  const slots = [], effects = [];
  function useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], update => { const next = typeof update === "function" ? update(slots[i]) : update; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; }
  function useRef(initial) { const i = cursor++; return slots[i] || (slots[i] = { current: initial }); }
  function useEffect(effect, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } }
  const hook = new Function("useState", "useRef", "useEffect", "useCallback", "store", "mergeStoredState", `const DB_READ_OK = true; ${hookSource}; return useStoredState;`)(useState, useRef, useEffect, fn => fn, store, mergeStoredState);
  function render() { cursor = 0; dirty = false; output = hook(key, initial); }
  return { get result() { return output; }, async settle() { for (let pass = 0; pass < 15; pass++) { if (dirty) render(); while (effects.length) effects.shift()(); await tick(); } }, dispose() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function database(value) {
  const state = { value: json(value), version: 1, calls: 0 };
  supabase.from = () => ({ select(columns) { const builder = { eq() { return builder; }, in() { return builder; }, async maybeSingle() { return { data: { key: "sps_clients", value: state.value, version: state.version }, error: null }; }, then(resolve, reject) { return Promise.resolve({ data: [{ key: "sps_clients", value: state.value, version: state.version }], error: null }).then(resolve, reject); } }; return builder; } });
  supabase.rpc = async (_name, args) => { state.calls++; if (args.p_expected_version !== state.version) return { data: [{ applied: false, current_version: state.version }], error: null }; state.value = args.p_value; state.version++; return { data: [{ applied: true, current_version: state.version }], error: null }; };
  return state;
}
for (const unstaged of [false, true]) {
  test(`actual stored-state hook adopts report projection without restaging it${unstaged ? " and preserves an unstaged edit" : ""}`, async () => {
    const uid = `hook-display-${unstaged}`, key = "sps_clients";
    const base = [{ id: "client", notes: "Before", phone: "111", history: [] }];
    const local = [{ ...base[0], notes: "Local" }];
    const shared = [{ ...base[0], notes: "Shared" }];
    const db = database(base);
    store.setUser(uid); await store.initialize(); await store.get(key);
    const h = mountHook(key, []); await h.settle();
    db.value = json(shared); db.version++;
    h.result[1](local); await h.settle();
    assert.equal(store.listConflicts()[0]?.key, key);
    const retained = localValues.get(`sps_pending_writes:${uid}`);
    const report = { id: "report", sid: "stop", note: "Confirmed" };
    db.value = json([{ ...shared[0], history: [report] }]); db.version++;
    await store.refresh(key);
    const projected = JSON.parse((await store.get(key)).value);
    if (unstaged) h.result[1](current => [{ ...current[0], phone: "222" }]);
    h.result[4](projected);
    await h.settle();
    assert.deepEqual(h.result[0][0].history, [report]);
    assert.equal(h.result[0][0].notes, "Local");
    assert.equal(h.result[0][0].phone, unstaged ? "222" : "111");
    if (!unstaged) assert.equal(localValues.get(`sps_pending_writes:${uid}`), retained, "display adoption must not replace the durable intent");
    else assert.equal(JSON.parse(JSON.parse(localValues.get(`sps_pending_writes:${uid}`))[key].localValue)[0].phone, "222", "the unstaged user edit must become durable");

    // Another device reverses the completed report before the user resolves the old notes conflict.
    db.value = json(shared); db.version++;
    await store.refresh(key);
    const resolved = await store.resolveConflict(key, "local");
    assert.equal(resolved.ok, true);
    const final = JSON.parse(db.value)[0];
    assert.deepEqual(final.history, [], "choosing local notes must not resurrect a report previously added only by display refresh");
    assert.equal(final.notes, "Local");
    assert.equal(final.phone, unstaged ? "222" : "111");
    h.dispose();
  });
}

test("actual stored-state hook does not autosave PostgreSQL jsonb text formatting after confirmation", async () => {
  const key = "sps_clients", uid = "hook-sql-json-format";
  const base = [{ id: "client", notes: "Before", history: [] }];
  const db = database(base);
  // Matches PostgreSQL jsonb::text spacing and field order, rather than compact JSON.stringify.
  db.value = '[{"id": "client", "notes": "Before", "history": []}]';
  const originalRpc = supabase.rpc;
  supabase.rpc = async (...args) => {
    const result = await originalRpc(...args);
    const client = JSON.parse(db.value)[0];
    db.value = `[{"id": ${json(client.id)}, "notes": ${json(client.notes)}, "history": ${json(client.history)}}]`;
    return result;
  };
  store.setUser(uid); await store.initialize();
  const h = mountHook(key, []);
  try {
    await h.settle();
    assert.equal(db.calls, 0, "loading PostgreSQL formatting must not stage a write");
    h.result[1](current => [{ ...current[0], notes: "Office edit" }]);
    await h.settle();
    assert.equal(db.calls, 1, "one edit must settle after one confirmed write");
    assert.equal(h.result[0][0].notes, "Office edit");
    assert.equal((await store.get(key)).value, json(JSON.parse(db.value)));
    await store.refresh(key); await h.settle();
    assert.equal(db.calls, 1, "forced confirmed refresh must also settle without another write");
  } finally { h.dispose(); }
});

test("accepted report edits display the confirmed server report over retained local conflicts without restaging", async () => {
  const key="sps_clients",uid="hook-accepted-report-authority";
  const report={sid:"s1",completionReceiptId:"r1",notes:"Original accepted report",photos:["original"]};
  const legacy={sid:"legacy",notes:"Original legacy report"};
  const base=[{id:"client",notes:"Profile before",phone:"111",history:[report,legacy]}];
  const local=[{...base[0],notes:"Local profile",history:[{...report,notes:"Old generic edit"},{...legacy,notes:"Local legacy edit"}]}];
  const remote=[{...base[0],notes:"Office profile"}];
  const db=database(base);store.setUser(uid);await store.initialize();
  const h=mountHook(key,[]);
  try{
    await h.settle();db.value=json(remote);db.version++;h.result[1](local);await h.settle();
    assert.equal(store.listConflicts()[0]?.key,key);
    const retained=localValues.get(`sps_pending_writes:${uid}`),calls=db.calls;
    const corrected={...report,notes:"Server API correction",photos:["corrected"]};
    db.value=json([{...remote[0],history:[corrected,legacy]}]);db.version++;
    await store.refresh(key);
    const display=JSON.parse((await store.get(key)).value);
    assert.deepEqual(display[0].history[0],corrected);
    assert.equal(display[0].notes,"Local profile");
    assert.equal(display[0].history[1].notes,"Local legacy edit");
    h.result[4](display);await h.settle();
    assert.deepEqual(h.result[0][0].history[0],corrected);
    assert.equal(h.result[0][0].notes,"Local profile");
    assert.equal(h.result[0][0].history[1].notes,"Local legacy edit");
    assert.equal(localValues.get(`sps_pending_writes:${uid}`),retained);
    assert.equal(db.calls,calls,"display adoption cannot create another save");
  }finally{h.dispose()}
});
