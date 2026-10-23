import test, { after } from 'node:test';
import assert from 'node:assert/strict';

if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const disk = new Map(), local = new Map();
globalThis.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
const { idb } = await import('../idbStore.js');
const originalIdb = { ...idb };
idb.get = idb.getVerified = async key => structuredClone(disk.get(key));
idb.set = async (key, value) => { disk.set(key, structuredClone(value)); return key; };
idb.del = async key => disk.delete(key);
const { store, supabase } = await import('../supabaseClient.js');
const original = { from: supabase.from, rpc: supabase.rpc };
after(() => { Object.assign(idb, originalIdb); Object.assign(supabase, original); });
const key = 'sps_invoices', json = JSON.stringify;
const a = { id: 'a', qbId: '100', number: '1001', status: 'Sent', balance: 100, total: 100, notes: 'Original A' };
const b = { id: 'b', qbId: '200', number: '1002', status: 'Sent', balance: 200, total: 200, notes: 'Original B' };
const paidB = { ...b, status: 'Paid', balance: 0 };
const remoteA = { ...a, notes: 'Office A' }, localA = { ...a, notes: 'Field A' };
function database(rows = [a, b], version = 1) {
  const db = { value: json(rows), version, reads: 0, writes: 0 };
  supabase.from = () => ({ select() { const query = {
    eq() { return query; }, in() { return query; },
    async maybeSingle() { db.reads++; return { data: { key, value: db.value, version: db.version }, error: null }; },
    then(resolve, reject) { db.reads++; return Promise.resolve({ data: [{ key, value: db.value, version: db.version }], error: null }).then(resolve, reject); },
  }; return query; } });
  supabase.rpc = async (_name, args) => {
    db.writes++;
    if (args.p_expected_version !== db.version) return { data: [{ applied: false, current_version: db.version }], error: null };
    db.value = args.p_value; db.version++;
    return { data: [{ applied: true, current_version: db.version }], error: null };
  };
  return db;
}
async function setup(uid, rows, version) {
  const db = database(rows, version); store.setUser(uid); await store.initialize(); await store.get(key); return db;
}
const receipt = overrides => ({ ok: true, actorId: store.captureIdentity().uid, key, complete: true, invoices: [a, paidB], beforeVersion: 1, afterVersion: 2, ...overrides });
const accept = value => store.acceptInvoiceRefreshSnapshot(value || receipt(), store.captureIdentity());
const pending = uid => json(JSON.parse(local.get(`sps_pending_writes:${uid}`) || '{}')[key]);
const displayed = async () => JSON.parse((await store.get(key)).value);
async function conflict(uid) {
  const db = await setup(uid); db.value = json([remoteA, b]); db.version = 2;
  const result = await store.set(key, json([localA, b]), { baseValue: json([a, b]) });
  assert.equal(result.conflict, true); return db;
}

test('full confirmed refresh adopts exact server revision without a ledger write or extra read', async () => {
  const uid = 'refresh-snapshot-clean', db = await setup(uid), reads = db.reads;
  const result = await accept(receipt({ beforeVersion: 3, afterVersion: 7 }));
  assert.equal(result.ok, true); assert.equal(result.durable, true); assert.equal(result.version, 7);
  assert.deepEqual(result.parsedValue, [a, paidB]); assert.equal(db.writes, 0); assert.equal(db.reads, reads);
  assert.deepEqual(JSON.parse(disk.get(`snapshot-v2:${uid}`).data[key]), [a, paidB]);
  assert.equal(disk.get(`snapshot-v2:${uid}`).versions[key], 7);
});

test('invoice A conflict cannot block fresh B and its original durable intent remains byte-for-byte intact', async () => {
  const uid = 'refresh-snapshot-conflict', db = await conflict(uid), before = pending(uid), oldConflicts = store.listConflicts();
  db.value = json([remoteA, paidB]); db.version = 3;
  const reads = db.reads, writes = db.writes;
  const result = await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 2, afterVersion: 3 }));
  assert.equal(result.ok, true); assert.equal(result.pending, true); assert.equal(result.projectionBlocked, false);
  assert.deepEqual(result.parsedValue, [localA, paidB]); assert.equal(pending(uid), before);
  assert.deepEqual(store.listConflicts(), oldConflicts); assert.equal(db.reads, reads); assert.equal(db.writes, writes);
  const resolved = await store.resolveConflict(key, 'local'); assert.equal(resolved.ok, true);
  assert.deepEqual(JSON.parse(db.value), [localA, paidB], 'later A choice cannot undo server-confirmed B payment');
});

test('the persisted canonical refresh projects over the recovered offline draft after account restart', async () => {
  const uid = 'refresh-snapshot-restart', db = await conflict(uid);
  db.value = json([remoteA, paidB]); db.version = 3;
  await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 2, afterVersion: 3 }));
  const before = pending(uid);
  store.setUser('refresh-snapshot-away'); store.setUser(uid);
  assert.deepEqual(await displayed(), [localA, paidB]); assert.equal(pending(uid), before);
  assert.equal(store.listConflicts()[0].conflicts.length, 1);
});

test('newer confirmed snapshot wins over a late server refresh response', async () => {
  const newest = { ...paidB, notes: 'Newer paid invoice' };
  await setup('refresh-snapshot-stale', [a, newest], 10);
  const result = await accept(); assert.equal(result.ok, true); assert.equal(result.superseded, true);
  assert.deepEqual(result.parsedValue, [a, newest]); assert.equal(result.version, 10);
});

test('a same-version duplicate can confirm durability but different content is never accepted at that version', async () => {
  await setup('refresh-snapshot-same-version', [a, paidB], 2);
  const duplicate = await accept(receipt({ beforeVersion: 2, afterVersion: 2 })); assert.equal(duplicate.ok, true);
  const wrong = await accept(receipt({ invoices: [a, b], beforeVersion: 2, afterVersion: 2 }));
  assert.equal(wrong.ok, false); assert.deepEqual(await displayed(), [a, paidB]);
});

test('target-only receipt version floor prevents older full snapshots from reversing a reviewed invoice', async () => {
  await setup('refresh-snapshot-target-floor');
  const paidA = { ...a, status: 'Paid', balance: 0 };
  const target = await store.acceptInvoiceReviewResolution({ ok: true, invoice: paidA, beforeInvoice: a, beforeVersion: 8, afterVersion: 9 }, store.captureIdentity(), { expectedInvoice: a });
  assert.equal(target.ok, true); assert.equal(target.projected, true);
  const older = await accept(receipt({ beforeVersion: 7, afterVersion: 8 }));
  assert.equal(older.superseded, true); assert.deepEqual(older.parsedValue, [paidA, b]);
  const current = await accept(receipt({ invoices: [paidA, paidB], beforeVersion: 9, afterVersion: 9 }));
  assert.equal(current.ok, true); assert.deepEqual(current.parsedValue, [paidA, paidB]); assert.equal(current.version, 9);
});

test('malformed incomplete or wrong-section receipts never change the cache or canonical version', async () => {
  await setup('refresh-snapshot-invalid');
  for (const override of [{ ok: false }, { actorId: undefined }, { actorId: 'other-account' }, { key: 'sps_clients' }, { complete: false }, { invoices: {} }, { invoices: [{ ...a, id: '' }] }, { invoices: [a, a] }, { beforeVersion: -1 }, { beforeVersion: 3, afterVersion: 2 }, { afterVersion: NaN }, { afterVersion: '2' }, { beforeVersion: null }]) {
    assert.equal((await accept(receipt(override))).ok, false);
    assert.deepEqual(await displayed(), [a, b]); assert.equal((await store.get(key)).version, 1);
  }
});

test('an empty complete canonical ledger is valid and never invents an invoice', async () => {
  await setup('refresh-snapshot-empty');
  const result = await accept(receipt({ invoices: [] })); assert.equal(result.ok, true); assert.deepEqual(result.parsedValue, []);
});

test('account switch and switch-back reject the old request identity', async () => {
  await setup('refresh-snapshot-identity'); const identity = store.captureIdentity();
  store.setUser('refresh-snapshot-identity-other');
  assert.equal((await store.acceptInvoiceRefreshSnapshot(receipt(), identity)).staleIdentity, true);
  store.setUser('refresh-snapshot-identity');
  assert.equal((await store.acceptInvoiceRefreshSnapshot(receipt(), identity)).staleIdentity, true);
});

test('a response from another account is rejected even when the caller captured identity only after it arrived', async () => {
  await setup('refresh-actor-original'); const response = receipt();
  await setup('refresh-actor-current');
  const result = await accept(response);
  assert.equal(result.ok, false); assert.deepEqual(await displayed(), [a, b]);
});

test('generic invoice CAS adopts the guarded canonical reread instead of its submitted accounting candidate', async () => {
  const uid = 'refresh-protected-reread', db = await setup(uid);
  const candidate = { ...a, total: 175, balance: 175 };
  const canonical = { ...a, qbWriteReview: { candidateId: 'preserved-candidate', reason: 'different-finance', savedAt: '2026-10-22T18:00:00Z' } };
  const previous = supabase.rpc;
  supabase.rpc = async () => { db.writes++; db.version++; db.value = json([canonical, b]); return { data: [{ applied: true, current_version: db.version }], error: null }; };
  try {
    const saved = await store.set(key, json([candidate, b]), { baseValue: json([a, b]) });
    assert.equal(saved.ok, true); assert.deepEqual(JSON.parse(saved.value), [canonical, b]);
    assert.deepEqual(await displayed(), [canonical, b]); assert.equal(JSON.parse(saved.value)[0].qbWriteReview.candidateId, 'preserved-candidate');
  } finally { supabase.rpc = previous; }
});

test('a new local edit during snapshot persistence stays visible and remains durable', async () => {
  const uid = 'refresh-snapshot-edit-race', db = await conflict(uid);
  db.value = json([remoteA, paidB]); db.version = 3;
  const originalSet = idb.set; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  idb.set = async (storageKey, value) => { if (storageKey === `snapshot-v2:${uid}` && value.versions[key] === 3) { entered(); await gate; } return originalSet(storageKey, value); };
  try {
    const adopting = accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 2, afterVersion: 3 })); await reached;
    const newestA = { ...localA, notes: 'Typed while refreshing' };
    const saving = store.set(key, json([newestA, paidB]), { baseValue: json([a, b]) });
    release(); const result = await adopting; await saving;
    assert.equal(result.ok, true); assert.deepEqual(result.parsedValue, [newestA, paidB]);
    assert.deepEqual(JSON.parse(JSON.parse(pending(uid)).localValue), [newestA, paidB]);
    assert.deepEqual(await displayed(), [newestA, paidB]);
  } finally { release(); idb.set = originalSet; }
});

test('receipt adoption waits for an earlier queued save and captures an immutable receipt', async () => {
  const db = await setup('refresh-snapshot-queued-save');
  const editedA = { ...a, notes: 'Earlier queued edit' };
  const originalRpc = supabase.rpc; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  supabase.rpc = async (_name, args) => {
    db.writes++; entered(); await gate;
    assert.equal(args.p_expected_version, 1);
    // The first save committed at 2. The server refresh committed at 3 before
    // that first save response made its way back to this slow client.
    db.value = json([editedA, paidB]); db.version = 3;
    return { data: [{ applied: true, current_version: 2 }], error: null };
  };
  try {
    const saving = store.set(key, json([editedA, b]), { baseValue: json([a, b]) }); await reached;
    const payload = receipt({ invoices: [editedA, paidB], beforeVersion: 2, afterVersion: 3 });
    let completed = false;
    const adopting = accept(payload).then(value => { completed = true; return value; });
    payload.invoices[1] = b; payload.afterVersion = 99;
    await Promise.resolve(); assert.equal(completed, false);
    release(); assert.equal((await saving).ok, true);
    const result = await adopting;
    assert.equal(result.ok, true); assert.equal(result.version, 3); assert.deepEqual(result.parsedValue, [editedA, paidB]);
    assert.equal(db.writes, 1, 'adoption never flushes the complete refreshed ledger');
  } finally { release(); supabase.rpc = originalRpc; }
});

test('local deletion of one invoice stays local while unrelated payment updates are projected', async () => {
  const uid = 'refresh-snapshot-delete-record', db = await setup(uid);
  db.value = json([remoteA, b]); db.version = 2;
  assert.equal((await store.set(key, json([b]), { baseValue: json([a, b]) })).conflict, true);
  const before = pending(uid);
  const result = await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 2, afterVersion: 3 }));
  assert.equal(result.ok, true); assert.deepEqual(result.parsedValue, [paidB]); assert.equal(pending(uid), before);
});

test('account switch during persistence cannot leak the receipt into the new account', async () => {
  const uid = 'refresh-snapshot-account-race'; await setup(uid);
  const identity = store.captureIdentity(), originalSet = idb.set; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  idb.set = async (storageKey, value) => { if (storageKey === `snapshot-v2:${uid}` && value.versions[key] === 2) { entered(); await gate; } return originalSet(storageKey, value); };
  try {
    const adopting = store.acceptInvoiceRefreshSnapshot(receipt(), identity); await reached;
    store.setUser('refresh-snapshot-account-race-other'); release();
    assert.equal((await adopting).staleIdentity, true);
    assert.equal(disk.has('snapshot-v2:refresh-snapshot-account-race-other'), false);
  } finally { release(); idb.set = originalSet; }
});

test('failed disk writes or unverifiable reads do not report a durable refresh', async () => {
  const uid = 'refresh-snapshot-disk-failure'; await conflict(uid); const before = pending(uid);
  const originalSet = idb.set;
  idb.set = async storageKey => { if (storageKey === `snapshot-v2:${uid}`) throw new Error('Disk unavailable'); };
  try {
    const result = await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 2, afterVersion: 3 }));
    assert.equal(result.ok, false); assert.equal(result.durabilityFailed, true); assert.equal(result.serverConfirmed, true);
    assert.equal(pending(uid), before); assert.deepEqual(result.parsedValue, [localA, paidB]);
  } finally { idb.set = originalSet; }
  assert.equal((await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 3, afterVersion: 3 }))).ok, true);
  const originalRead = idb.getVerified;
  idb.getVerified = async storageKey => storageKey === `snapshot-v2:${uid}` ? { uid, versions: { [key]: 4 }, data: { [key]: json([a, b]) } } : originalRead(storageKey);
  try {
    const result = await accept(receipt({ invoices: [remoteA, paidB], beforeVersion: 3, afterVersion: 4 }));
    assert.equal(result.ok, false); assert.equal(result.durabilityFailed, true);
  } finally { idb.getVerified = originalRead; }
});

test('legacy local work is preserved for recovery while canonical fresh invoices remain visible', async () => {
  const uid = 'refresh-snapshot-legacy';
  local.set(`sps_pending_writes:${uid}`, json({ [key]: json([localA, b]) }));
  await setup(uid); const before = pending(uid);
  const result = await accept();
  assert.equal(result.ok, true); assert.equal(result.projectionBlocked, false); assert.equal(result.pending, true);
  assert.equal(result.recoveryPending, true);
  assert.deepEqual(result.parsedValue, [a, paidB]); assert.equal(pending(uid), before);
  assert.deepEqual(JSON.parse(disk.get(`snapshot-v2:${uid}`).data[key]), [a, paidB]);
});

test('editing after legacy canonical projection preserves the unknown accounting proposal for recovery', async () => {
  const uid = 'refresh-legacy-note', held = { ...localA, total: 150, balance: 150 };
  local.set(`sps_pending_writes:${uid}`, json({ [key]: json([held, b]) }));
  await setup(uid);
  const result = await accept();
  const edited = result.parsedValue.map(invoice => invoice.id === 'a' ? { ...invoice, visitNote: 'New note' } : invoice);
  await store.set(key, json(edited), { baseValue: result.value, projectedBaseValue: result.value });
  const recovered = JSON.parse(JSON.parse(pending(uid)).localValue);
  assert.equal(recovered[0].total, 150); assert.equal(recovered[0].visitNote, 'New note');
  assert.deepEqual((await displayed())[1], paidB);
});

test('pending retries survive refresh without being flushed or losing their backoff', async () => {
  const uid = 'refresh-snapshot-pending-retry', db = await setup(uid), originalRpc = supabase.rpc;
  supabase.rpc = async () => { db.writes++; return { data: null, error: { message: 'Network unavailable', status: 503 } }; };
  try {
    const failed = await store.set(key, json([localA, b]), { baseValue: json([a, b]) });
    assert.equal(failed.ok, false);
    const before = pending(uid), writes = db.writes;
    db.value = json([a, paidB]); db.version = 2;
    const result = await accept();
    assert.equal(result.ok, true); assert.equal(result.pending, true); assert.deepEqual(result.parsedValue, [localA, paidB]);
    assert.equal(pending(uid), before); assert.equal(db.writes, writes);
  } finally { supabase.rpc = originalRpc; }
});

test('forced replacement and whole-ledger deletion intents are never silently rebased by refresh', async () => {
  for (const deleteIntent of [false, true]) {
    const uid = `refresh-snapshot-destructive-${deleteIntent}`;
    const envelope = { v: 2, opId: 'held-destructive-intent', status: 'conflict',
      baseExists: true, baseVersion: 1, baseValue: json([a, b]), localValue: json([localA, b]),
      conflicts: [{ path: '$', kind: 'destructive-operation-interrupted' }], force: !deleteIntent,
      deleteIntent, updatedAt: Date.now() };
    local.set(`sps_pending_writes:${uid}`, json({ [key]: envelope }));
    await setup(uid); const before = pending(uid);
    const result = await accept();
    assert.equal(result.ok, true); assert.equal(result.projectionBlocked, false); assert.equal(result.recoveryPending, true);
    assert.deepEqual(result.parsedValue, [a, paidB]); assert.equal(pending(uid), before);
    assert.deepEqual(JSON.parse(disk.get(`snapshot-v2:${uid}`).data[key]), [a, paidB]);
  }
});
