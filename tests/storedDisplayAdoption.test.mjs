import { installSharedStateEndpointFixture } from "./helpers/sharedStateEndpointFixture.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";
import { mergeStoredState } from "../stateMerge.js";
import { invoiceDeletionReviewMatches } from "../invoiceBulkDeletion.js";

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
let restoreEndpoint = () => {};
after(() => { restoreEndpoint(); Object.assign(idb, originalIdb); Object.assign(supabase, original); });
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
  const hook = new Function("useState", "useRef", "useEffect", "useCallback", "store", "mergeStoredState", "stableInvoiceReviewJSON", "invoiceDeletionReviewMatches", `const DB_READ_OK = true; ${hookSource}; return useStoredState;`)(useState, useRef, useEffect, fn => fn, store, mergeStoredState, stableInvoiceReviewJSON, invoiceDeletionReviewMatches);
  function render() { cursor = 0; dirty = false; output = hook(key, initial); }
  return { get result() { return output; }, async settle() { for (let pass = 0; pass < 15; pass++) { if (dirty) render(); while (effects.length) effects.shift()(); await tick(); } }, dispose() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function database(value, key = "sps_clients") {
  const state = { value: json(value), version: 1, calls: 0 };
  supabase.from = () => ({ select(columns) { const builder = { eq() { return builder; }, in() { return builder; }, async maybeSingle() { return { data: { key, value: state.value, version: state.version }, error: null }; }, then(resolve, reject) { return Promise.resolve({ data: [{ key, value: state.value, version: state.version }], error: null }).then(resolve, reject); } }; return builder; } });
  supabase.rpc = async (_name, args) => { state.calls++; if (args.p_expected_version !== state.version) return { data: [{ applied: false, current_version: state.version }], error: null }; state.value = args.p_value; state.version++; return { data: [{ applied: true, current_version: state.version }], error: null }; };
  restoreEndpoint(); restoreEndpoint = installSharedStateEndpointFixture({ store, supabase, readRow: requested => requested === key ? state : null });
  return state;
}

for (const unstaged of [false, true]) {
  test(`actual invoice hook adopts fresh paid B around A conflict without restaging accounting${unstaged ? ' and keeps an unstaged edit' : ''}`, async () => {
    const uid = `hook-invoice-refresh-${unstaged}`, key = 'sps_invoices';
    const a = { id: 'a', qbId: '1', notes: 'Before A', total: 100, balance: 100, status: 'Sent' };
    const b = { id: 'b', qbId: '2', notes: 'Before B', total: 200, balance: 200, status: 'Sent' };
    const base = [a, b], local = [{ ...a, notes: 'Local A' }, b], office = { ...a, notes: 'Office A' };
    const db = database(base, key); store.setUser(uid); await store.initialize();
    const h = mountHook(key, []);
    try {
      await h.settle(); db.value = json([office, b]); db.version = 2;
      h.result[1](local); await h.settle();
      assert.equal(store.listConflicts()[0]?.key, key);
      const retained = localValues.get(`sps_pending_writes:${uid}`), writes = db.calls;
      const paid = { ...b, status: 'Paid', balance: 0 }; db.value = json([office, paid]); db.version = 3;
      const receipt = await store.acceptInvoiceRefreshSnapshot({ ok: true, actorId: uid, key, complete: true,
        invoices: [office, paid], beforeVersion: 2, afterVersion: 3 }, store.captureIdentity());
      assert.equal(receipt.ok, true);
      if (unstaged) h.result[1](current => current.map(item => item.id === 'a' ? { ...item, visitNote: 'Typed during refresh' } : item));
      h.result[4](receipt.parsedValue); await h.settle();
      assert.deepEqual(h.result[0].find(item => item.id === 'b'), paid);
      assert.equal(h.result[0].find(item => item.id === 'a').notes, 'Local A');
      assert.equal(db.calls, writes, 'an existing A conflict cannot trigger a new whole-ledger accounting write');
      if (!unstaged) assert.equal(localValues.get(`sps_pending_writes:${uid}`), retained);
      else assert.equal(JSON.parse(JSON.parse(localValues.get(`sps_pending_writes:${uid}`))[key].localValue)[0].visitNote, 'Typed during refresh');
    } finally { h.dispose(); }
  });
}

test('actual invoice hook keeps canonical paid accounting over a retained old fee and review flag without autosaving the projection', async () => {
  const uid = 'hook-invoice-authority', key = 'sps_invoices';
  const line = { id: 'service', desc: 'October maintenance', qty: '1', unitPrice: '100.00', amount: 100 };
  const before = { id: 'a', qbId: '1', notes: 'Before', total: 100, balance: 100, status: 'Overdue', lineItems: [line], qbSyncStatus: 'synced' };
  const stale = { ...before, notes: 'Local', locallyEdited: true, qbSyncStatus: 'dirty', lateFeeAppliedAt: '2026-10-22',
    lineItems: [line, { id: 'lf_a_2026-10-22', desc: 'Late Fee', qty: '1', unitPrice: '5.00', amount: 5, taxable: false, isLateFee: true, kind: 'lateFee' }] };
  const db = database([before], key); store.setUser(uid); await store.initialize();
  const h = mountHook(key, []);
  try {
    await h.settle(); db.value = json([{ ...before, notes: 'Office' }]); db.version = 2;
    h.result[1]([stale]); await h.settle();
    const retained = localValues.get(`sps_pending_writes:${uid}`), writes = db.calls;
    const paid = { ...before, notes: 'Office', status: 'Paid', balance: 0,
      qbReviewResolution: { resolvedAt: '2026-10-22T15:00:00Z', confirmedResultHash: 'saved-result' }, locallyEdited: false };
    db.value = json([paid]); db.version = 3;
    const receipt = await store.acceptInvoiceRefreshSnapshot({ ok: true, actorId: uid, key, complete: true,
      invoices: [paid], beforeVersion: 2, afterVersion: 3 }, store.captureIdentity());
    assert.equal(receipt.ok, true); h.result[4](receipt.parsedValue); await h.settle();
    assert.equal(h.result[0][0].status, 'Paid'); assert.equal(h.result[0][0].balance, 0);
    assert.deepEqual(h.result[0][0].lineItems, [line]); assert.equal(h.result[0][0].qbSyncStatus, 'synced');
    assert.equal(h.result[0][0].notes, 'Local'); assert.equal(db.calls, writes);
    assert.equal(localValues.get(`sps_pending_writes:${uid}`), retained, 'display adoption cannot turn a reviewed fee into new local work');
  } finally { h.dispose(); }
});

test('a later note edit cannot erase a genuine held accounting proposal after canonical display adoption', async () => {
  const uid = 'hook-invoice-hidden-proposal', key = 'sps_invoices';
  const before = { id: 'a', qbId: '1', notes: 'Before', total: 100, balance: 100, status: 'Sent' };
  const proposed = { ...before, notes: 'Local', total: 150, balance: 150 };
  const db = database([before], key); store.setUser(uid); await store.initialize();
  const h = mountHook(key, []);
  try {
    await h.settle(); db.value = json([{ ...before, notes: 'Office' }]); db.version = 2;
    h.result[1]([proposed]); await h.settle();
    const canonical = { ...before, status: 'Paid', balance: 0, notes: 'Office',
      qbWriteReview: { candidateId: 'held', reason: 'different-finance', savedAt: '2026-10-22T15:00:00Z' } };
    db.value = json([canonical]); db.version = 3;
    const receipt = await store.acceptInvoiceRefreshSnapshot({ ok: true, actorId: uid, key, complete: true,
      invoices: [canonical], beforeVersion: 2, afterVersion: 3 }, store.captureIdentity());
    assert.deepEqual(receipt.confirmedParsedValue, [canonical]);
    h.result[4](receipt.parsedValue); await h.settle();
    assert.equal(h.result[0][0].total, 100);
    h.result[1](current => current.map(invoice => ({ ...invoice, visitNote: 'New genuine note' }))); await h.settle();
    const retained = JSON.parse(JSON.parse(localValues.get(`sps_pending_writes:${uid}`))[key].localValue)[0];
    assert.equal(retained.total, 150, 'the hidden proposal remains recoverable');
    assert.equal(retained.visitNote, 'New genuine note');
    assert.equal(JSON.parse((await store.get(key)).value)[0].total, 100, 'canonical accounting remains visible');
  } finally { h.dispose(); }
});
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

for (const unstaged of [false, true]) {
  test(`compact client receipt is displayed without a roster save${unstaged ? ' while preserving an unstaged edit' : ''}`,async()=>{
    const uid=`hook-compact-create-${unstaged}`,key='sps_clients';
    const base=[{id:'client',name:'Existing client',notes:'Before',history:[]}];
    const created={id:'new-client-uuid',name:'Cedar House',history:[],equipment:[]};
    const db=database(base);store.setUser(uid);await store.initialize();
    const h=mountHook(key,[]);
    try {
      await h.settle();
      if(unstaged) h.result[1](current=>[{...current[0],notes:'Typed during creation'}]);
      db.value=json([...base,created]);db.version=2;
      const saved=await store.acceptCreatedClient({client:created,beforeVersion:1,afterVersion:2,replayed:false},store.captureIdentity());
      assert.equal(saved.ok,true);h.result[4](saved.parsedValue);await h.settle();
      assert.equal(h.result[0].length,2);assert.equal(h.result[0][1].name,'Cedar House');
      assert.equal(h.result[0][0].notes,unstaged?'Typed during creation':'Before');
      assert.equal(db.calls,unstaged?1:0,'only a real concurrent user edit should write the roster');
      assert.equal(JSON.parse(db.value).filter(c=>c.id===created.id).length,1);
    }finally{h.dispose()}
  });
}

for (const unstaged of [false, true]) {
  test(`confirmed deletion display ${unstaged ? 'preserves a newer React-only edit for durable recovery' : 'removes the exact reviewed invoice without another write'}`, async () => {
    const uid = `hook-confirmed-deletion-${unstaged}`, key = 'sps_invoices';
    const before = {id:'delete-target',qbId:'5287',number:'2035',status:'Sent',total:192.5,balance:192.5,notes:'Reviewed'};
    const other = {id:'keep',number:'2036',status:'Draft',total:100,notes:'Other'};
    const db = database([before,other],key); store.setUser(uid); await store.initialize();
    const h = mountHook(key,[]);
    try {
      await h.settle(); db.value = json([other]); db.version = 2;
      const values = {sps_invoices:[other],sps_estimates:[],sps_schedule:[],sps_maintenance_billing:{version:2,policies:{},allocations:{}}};
      const receipt = {success:true,complete:true,actorId:uid,deletedInvoiceId:before.id,qbId:before.qbId,beforeInvoice:before,
        beforeVersions:{sps_invoices:1,sps_estimates:0,sps_schedule:0,sps_maintenance_billing:0},
        versions:{sps_invoices:2,sps_estimates:0,sps_schedule:0,sps_maintenance_billing:0},values};
      const accepted=await store.acceptInvoiceDeletionSnapshot(receipt,store.captureIdentity(),{expectedInvoice:before});
      assert.equal(accepted.ok,true,accepted.error?.message);
      if(unstaged)h.result[1](rows=>rows.map(row=>row.id===before.id?{...row,notes:'Typed during deletion'}:row));
      h.result[4](accepted.values.sps_invoices,{deletedInvoice:{id:before.id,before}});await h.settle();
      assert.deepEqual(JSON.parse(db.value),[other]);assert.equal(db.calls,0,'a confirmed deletion never triggers a replacement ledger write');
      if(unstaged){
        const pending=JSON.parse(localValues.get(`sps_pending_writes:${uid}`))[key];
        assert.equal(JSON.parse(pending.localValue).find(row=>row.id===before.id).notes,'Typed during deletion');
        assert.equal(pending.status,'conflict');assert.deepEqual(JSON.parse((await store.get(key)).value),[other]);
      }else assert.deepEqual(h.result[0],[other]);
    }finally{h.dispose();}
  });
}
