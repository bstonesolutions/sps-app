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

test('a current row revision never replaces the original field hashes', async () => {
  const h = await harness();
  h.replace([{ ...a, name: 'Office name', address: 'New address' }, b]);
  await store.refresh(h.key);
  const result = await store.set(h.key, json([{ ...a, name: 'Old phone name' }, b]), { baseValue: json([a, b]) });
  assert.equal(result.ok, false); assert.equal(result.conflict, true);
  assert.equal(h.state.writes, 0); assert.equal(h.state.value[0].name, 'Office name');
  assert.equal(h.state.value[0].address, 'New address');
  assert.equal(h.pending().baseValue, json([a, b]));
});

test('independent fields merge on the server without uploading the stale whole roster', async () => {
  const h = await harness();
  h.replace([{ ...a, address: 'New address' }, b, { id: 'c', name: 'New client' }]);
  const result = await store.set(h.key, json([{ ...a, name: 'Updated name' }, b]), { baseValue: json([a, b]) });
  assert.equal(result.ok, true); assert.equal(h.state.value.length, 3);
  assert.equal(h.state.value[0].address, 'New address'); assert.equal(h.state.value[0].name, 'Updated name');
  assert.equal(h.state.requests[0].operations.length, 1);
  assert.deepEqual(h.state.requests[0].operations[0].path, ['name']);
  assert.equal(h.pending(), undefined);
});

test('permanent protected-save rejection pauses automatic retries and use saved actually discards it', async () => {
  const h = await harness();
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return { ok: false, status: 409, json: async () => ({ ok: false,
    code: 'SHARED_STATE_PATCH_PROTECTED_CHANGE', error: 'A saved report cannot be replaced' }) }; };
  const edited = [{ ...a, notes: 'Rejected local edit' }, b];
  const failed = await store.set(h.key, json(edited), { baseValue: json([a, b]) });
  assert.equal(failed.conflict, true); assert.equal(h.pending().status, 'conflict');
  const originalBase = h.pending().baseValue;
  for (let index=0; index<8; index++) { await store.flush(); await store.set(h.key, json(edited), { baseValue: json([a, b]) }); }
  assert.equal(attempts, 1); assert.equal(h.pending().baseValue, originalBase);
  const result = await store.resolveConflict(h.key, 'remote');
  assert.equal(result.ok, true); assert.equal(attempts, 1); assert.equal(h.pending(), undefined);
  assert.deepEqual(JSON.parse((await store.get(h.key)).value), [a,b]);
});

test('lost save response retains the same original intent and retry does not repeat the change', async () => {
  const h = await harness(); h.state.loseNextReply = true;
  assert.equal((await store.set(h.key, json([{ ...a, notes: 'Saved once' }, b]), { baseValue: json([a, b]) })).ok, false);
  const retained = h.pending(); assert.ok(retained);
  assert.equal((await store.flushKey(h.key)).ok, true);
  assert.deepEqual(h.state.requests[1], h.state.requests[0]);
  assert.equal(h.state.writes, 1); assert.equal(h.pending(), undefined);
});

test('a reviewed local choice cannot overwrite a third change made while review is open', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone' }, b]), { baseValue: json([a, b]) });
  h.replace([{ ...a, notes: 'Third edit' }, b]);
  const firstChoice = await store.resolveConflict(h.key, 'local');
  assert.equal(firstChoice.ok, false); assert.equal(h.state.value[0].notes, 'Third edit');
  const resolution = await store.resolveConflict(h.key, 'local');
  assert.equal(resolution.ok, true, JSON.stringify({ resolution, requests: h.state.requests, pending: h.pending() }));
  assert.equal(h.state.value[0].notes, 'Phone');
});

test('client B can save while client A has an unresolved edit and A remains recoverable', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office A' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone A' }, b]), { baseValue: json([a, b]) });
  const result = await store.patchClient(b, { ...b, name: 'Full Client B' });
  assert.equal(result.ok, true); assert.equal(result.confirmedClient.name, 'Full Client B');
  assert.equal(h.state.value[0].notes, 'Office A'); assert.equal(h.state.value[1].name, 'Full Client B');
  assert.ok(h.state.requests.at(-1).operations.every(operation => operation.entityId === 'b'));
  const pending = h.pending();
  assert.equal(JSON.parse(pending.baseValue)[0].notes, 'Before A');
  assert.equal(JSON.parse(pending.localValue)[0].notes, 'Phone A');
  assert.equal(JSON.parse(pending.baseValue)[1].name, 'Full Client B');
  assert.equal(JSON.parse(pending.localValue)[1].name, 'Full Client B');
  assert.equal(result.parsedValue[0].notes, 'Phone A');
  assert.equal((await store.flushKey(h.key)).conflict, true);
  assert.equal(h.state.value[0].notes, 'Office A');
});

test('targeted client retry after lost response preserves unrelated pending edits', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office A' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone A' }, b]), { baseValue: json([a, b]) });
  h.state.loseNextReply = true;
  const next = { ...b, name: 'Saved B' };
  assert.equal((await store.patchClient(b, next)).ok, false);
  const request = h.state.requests.at(-1);
  assert.equal((await store.patchClient(b, next)).ok, true);
  assert.deepEqual(h.state.requests.at(-1), request);
  assert.equal(h.state.writes, 1); assert.equal(JSON.parse(h.pending().localValue)[0].notes, 'Phone A');
});

test('another form cannot replace a different already-pending edit to the same client', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office A' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone A' }, b]), { baseValue: json([a, b]) });
  const before = h.pending();
  assert.equal((await store.patchClient(a, { ...a, name: 'Other form' })).ok, false);
  assert.deepEqual(h.pending(), before); assert.equal(h.state.writes, 0);
});

test('account switch during token retrieval prevents the mutation and preserves original account work', async () => {
  const h = await harness(); h.state.beforeSession = async () => store.setUser('other-account');
  const saved = await store.set(h.key, json([{ ...a, name: 'Never submitted' }, b]), { baseValue: json([a, b]) });
  assert.equal(saved.ok, false); assert.equal(h.state.requests.length, 0);
  assert.ok(local.has(`sps_pending_writes:${h.uid}`));
});

test('an old schedule move retains another device new stop and its billing backlink', async () => {
  const stop = { sid: 's1', clientId: 'a', service: 'Maintenance' };
  const base = [{ date: '2026-10-22', stops: [stop] }];
  const h = await harness(base, 'sps_schedule');
  h.replace([{ date: '2026-10-22', stops: [{ ...stop, linkedBillingReviewId: 'review1' }, { sid: 's2', clientId: 'b' }] }]);
  const result = await store.set(h.key, json([{ date: '2026-10-23', stops: [stop] }]), { baseValue: json(base) });
  assert.equal(result.ok, true);
  assert.equal(h.state.value.find(day => day.date === '2026-10-23').stops[0].linkedBillingReviewId, 'review1');
  assert.equal(h.state.value.find(day => day.date === '2026-10-22').stops[0].sid, 's2');
});

test('the client editor uses its original target intent while another client is pending', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office A' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone A' }, b]), { baseValue: json([a, b]) });
  const saved = await saveClientEditorChanges({ clients: [a, b], baselineClient: b, updated: { ...b, name: 'Editor B' },
    refreshClients: () => { throw new Error('Must not block on whole roster'); }, persistClients: () => { throw new Error('Must not write whole roster'); },
    persistClientIntent: ({ baselineClient, updated }) => store.patchClient(baselineClient, updated) });
  assert.equal(saved.name, 'Editor B'); assert.equal(h.state.value[0].notes, 'Office A');
});

test('targeted B save preserves A review immediately even when B sorts before A', async () => {
  const h = await harness([b, a]);
  h.replace([b, { ...a, notes: 'Office A' }]);
  await store.set(h.key, json([b, { ...a, notes: 'Phone A' }]), { baseValue: json([b, a]) });
  const priorReview = store.listConflicts();
  assert.equal(priorReview.length, 1);
  const saved = await store.patchClient(b, { ...b, name: 'Saved B' });
  assert.equal(saved.ok, true);
  assert.deepEqual(store.listConflicts(), priorReview, 'unrelated review must remain available without another sync');
  assert.equal(h.pending().status, 'conflict');
  assert.equal((await store.resolveConflict(h.key, 'local')).ok, true);
  assert.equal(h.state.value.find(client => client.id === 'a').notes, 'Phone A');
  assert.equal(h.state.value.find(client => client.id === 'b').name, 'Saved B');
});

test('a newer B edit queued during its first save keeps fresh remote fields and its typed change', async () => {
  const h = await harness(); let nextSave;
  h.state.beforeResponse = async () => {
    h.state.beforeResponse = null;
    h.replace([a, { ...b, name: 'First submitted', address: 'Office address' }]);
    nextSave = store.set(h.key, json([a, { ...b, name: 'Typed while saving' }]),
      { baseValue: json([a, { ...b, name: 'First submitted' }]) });
  };
  const first = await store.patchClient(b, { ...b, name: 'First submitted' });
  assert.equal(first.ok, true);
  const second = await nextSave;
  assert.equal(second.ok, true);
  assert.equal(h.state.value[1].name, 'Typed while saving');
  assert.equal(h.state.value[1].address, 'Office address');
  assert.equal(h.pending(), undefined);
});

test('failed target pending cleanup retains the original intent and replay confirms without another write', async () => {
  const h = await harness(); const normalDelete = idb.del, normalSet = idb.set;
  idb.del = async key => { if (key === `pending-v2:${h.uid}`) throw new Error('Disk temporarily unavailable'); return normalDelete(key); };
  idb.set = async (key, value) => { if (key === `pending-v2:${h.uid}` && !Object.keys(value.data).length) throw new Error('Cannot write cleanup tombstone'); return normalSet(key, value); };
  try {
    const result = await store.patchClient(b, { ...b, name: 'Durable B' });
    assert.equal(result.ok, false); assert.equal(result.serverConfirmed, true);
    assert.equal(JSON.parse(h.pending().baseValue)[1].name, b.name);
    assert.equal(JSON.parse(h.pending().localValue)[1].name, 'Durable B');
    assert.equal(h.state.writes, 1);
  } finally { idb.del = normalDelete; idb.set = normalSet; }
  const retry = await store.patchClient(b, { ...b, name: 'Durable B' });
  assert.equal(retry.ok, true); assert.equal(h.state.writes, 1); assert.equal(h.pending(), undefined);
});

test('account change during target cleanup never adopts the old account receipt', async () => {
  const h = await harness(); const normalDelete = idb.del;
  idb.del = async key => { await normalDelete(key); if (key === `pending-v2:${h.uid}`) store.setUser('account-after-cleanup'); };
  try {
    const result = await store.patchClient(b, { ...b, name: 'Saved old account' });
    assert.equal(result.ok, false); assert.equal(result.staleIdentity, true);
    assert.equal(local.has('sps_pending_writes:account-after-cleanup'), false);
  } finally { idb.del = normalDelete; }
});

test('a lost response to use saved changes retries the same durable reviewed choice', async () => {
  const h = await harness(); h.replace([{ ...a, notes: 'Office note' }, b]);
  await store.set(h.key, json([{ ...a, notes: 'Phone note' }, b]), { baseValue: json([a, b]) });
  h.state.loseNextReply = true;
  assert.equal((await store.resolveConflict(h.key, 'remote')).ok, false);
  assert.equal(h.pending().sharedResolutions[0].choice, 'remote');
  const first = h.state.requests.at(-1);
  assert.equal((await store.flushKey(h.key)).ok, true);
  assert.deepEqual(h.state.requests.at(-1), first);
  assert.equal(h.state.value[0].notes, 'Office note'); assert.equal(h.state.writes, 0);
  assert.equal(h.pending(), undefined);
});

test('a retained A review still resolves exactly after B changed its operation index', async () => {
  const h = await harness([b, a]); h.replace([b, { ...a, notes: 'Office A' }]);
  await store.set(h.key, json([b, { ...a, notes: 'Phone A' }]), { baseValue: json([b, a]) });
  assert.equal((await store.patchClient(b, { ...b, name: 'Saved B' })).ok, true);
  assert.equal((await store.resolveConflict(h.key, 'local')).ok, true);
  assert.equal(h.state.value[1].notes, 'Phone A'); assert.equal(h.state.value[0].name, 'Saved B');
  assert.equal(h.pending(), undefined);
});
