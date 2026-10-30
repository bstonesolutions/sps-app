import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { applySharedStateIntent } from '../sharedStateIntent.js';
import { saveClientEditorChanges } from '../clientEditSave.js';

if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const disk = new Map(), local = new Map();
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
const { idb } = await import('../idbStore.js');
const originalIdb = { get: idb.get, getVerified: idb.getVerified, set: idb.set, del: idb.del };
idb.get = idb.getVerified = async key => structuredClone(disk.get(key));
idb.set = async (key, value) => { disk.set(key, structuredClone(value)); return key; };
idb.del = async key => { disk.delete(key); };
const { store, supabase } = await import('../supabaseClient.js');
const original = { from: supabase.from, rpc: supabase.rpc, getSession: supabase.auth.getSession, fetch: globalThis.fetch };
after(() => { Object.assign(idb, originalIdb); supabase.from = original.from; supabase.rpc = original.rpc; supabase.auth.getSession = original.getSession; globalThis.fetch = original.fetch; });
const json = JSON.stringify;
const a = { id: 'a', name: 'Client A', notes: 'Before A', address: 'Old address' };
const b = { id: 'b', name: 'Client B', notes: 'Before B' };
let sequence = 0;
async function harness(value = [a, b], key = 'sps_clients') {
  disk.clear(); local.clear();
  const uid = `shared-store-${++sequence}`;
  const state = { value: structuredClone(value), version: 1, writes: 0, requests: [], loseNextReply: false, beforeResponse: null, beforeSession: null };
  supabase.from = () => ({ select() { const query = { eq() { return query; }, in() { return query; }, async maybeSingle() { return { data: { key, value: json(state.value), version: state.version }, error: null }; }, then(resolve, reject) { return Promise.resolve({ data: [{ key, value: json(state.value), version: state.version }], error: null }).then(resolve, reject); } }; return query; } });
  supabase.rpc = async () => { throw new Error('Protected records must never use the legacy whole-snapshot RPC'); };
  supabase.auth.getSession = async () => { await state.beforeSession?.(); return { data: { session: { user: { id: uid }, access_token: 'test-token' } } }; };
  globalThis.fetch = async (_url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    const intent = JSON.parse(request.body); state.requests.push(intent);
    assert.ok(local.has(`sps_pending_writes:${uid}`) || disk.has(`pending-v2:${uid}`), 'intent must be durable before mutation');
    const beforeVersion = state.version;
    const applied = await applySharedStateIntent(intent, state.value);
    if (!applied.applied) return { ok: false, status: 409, json: async () => ({ ok: false, code: 'shared-state-field-conflict', actorId: uid, key, operationId: intent.operationId, currentVersion: state.version, conflicts: applied.conflicts }) };
    if (applied.changed) { state.value = applied.value; state.version++; state.writes++; }
    const response = { ok: true, actorId: uid, key, operationId: intent.operationId, beforeVersion, afterVersion: state.version, value: structuredClone(state.value), complete: true };
    await state.beforeResponse?.();
    if (state.loseNextReply) { state.loseNextReply = false; throw new Error('Response lost after commit'); }
    return { ok: true, status: 200, json: async () => response };
  };
  store.setUser(uid); await store.initialize(); await store.get(key);
  return { uid, state, key, pending: () => JSON.parse(local.get(`sps_pending_writes:${uid}`) || '{}')[key], replace(value) { state.value = structuredClone(value); state.version++; } };
}

test('a newly typed edit survives a slower use saved changes response',async()=>{
  const h=await harness();h.replace([{...a,notes:'Office note'},b]);
  await store.set(h.key,json([{...a,notes:'Phone note'},b]),{baseValue:json([a,b])});
  let nextSave;
  h.state.beforeResponse=async()=>{
    h.state.beforeResponse=null;
    nextSave=store.set(h.key,json([{...a,notes:'Newly typed note'},b]),{baseValue:json([{...a,notes:'Phone note'},b])});
  };
  await store.resolveConflict(h.key,'remote');
  await nextSave;
  assert.equal(h.state.value[0].notes,'Office note');
  assert.equal(JSON.parse(h.pending().localValue)[0].notes,'Newly typed note','the later form edit must remain recoverable until reviewed');
});

test('account switch during failed pending cleanup cannot restore the prior account intent into the next account',async()=>{
  const h=await harness();const originalDel=idb.del,originalVerified=idb.getVerified;let armed=false,failedCleanup=false;
  const nextUid='account-after-cleanup-switch';
  h.state.beforeResponse=async()=>{h.state.beforeResponse=null;armed=true;};
  idb.del=async key=>{
    if(armed&&key===`pending-v2:${h.uid}`){armed=false;failedCleanup=true;store.setUser(nextUid);throw new Error('Cleanup failed while account changed');}
    return originalDel(key);
  };
  idb.getVerified=async key=>{if(failedCleanup&&key===`pending-v2:${h.uid}`)throw new Error('Cannot verify prior cleanup');return originalVerified(key);};
  try{
    const result=await store.set(h.key,json([{...a,notes:'Old account edit'},b]),{baseValue:json([a,b])});
    assert.equal(result.staleIdentity,true,'completion must stop before restoring pending state after account change');
    assert.equal(local.has(`sps_pending_writes:${nextUid}`),false,'old account intent cannot be stored under next account');
    assert.equal(disk.get(`pending-v2:${nextUid}`)?.data?.[h.key],undefined);
  }finally{idb.del=originalDel;idb.getVerified=originalVerified;}
});
