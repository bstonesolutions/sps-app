// Real PostgreSQL behavior in an isolated PGlite database. No live access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { mergeStoredState } from '../stateMerge.js';
import { reconcileQuickBooksInvoice } from '../quickbooksInvoiceReconciliation.js';

const runtime = process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite = runtime ? (await import(pathToFileURL(runtime).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && 'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL' }, fn);
const base = await readFile(new URL('../APP-STATE-CONCURRENCY-MIGRATION.sql', import.meta.url), 'utf8');
const batch = await readFile(new URL('../APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql', import.meta.url), 'utf8');
const review = await readFile(new URL('../supabase/migrations/20261023001232_invoice_review_targeted_resolution.sql', import.meta.url), 'utf8');
const authority = await readFile(new URL('../supabase/migrations/20261023010217_invoice_accounting_authority.sql', import.meta.url), 'utf8');
const stopMemoryBound = await readFile(new URL('../supabase/migrations/20261012215154_stop_report_memory_bound.sql', import.meta.url), 'utf8');
const installedStopGuard = stopMemoryBound.slice(stopMemoryBound.indexOf('create or replace function public.sps_guard_accepted_stop_reports()'), stopMemoryBound.indexOf('create or replace function public.sps_stop_completion_batch_cas('));
const decode = value => { while (typeof value === 'string') value = JSON.parse(value); return value; };
const encode = (value, depth = 1) => { while (depth--) value = JSON.stringify(value); return JSON.stringify(value); };
const initial = () => ({ id: 'one', qbId: '123', qbCustomerId: 'c1', number: '2001', status: 'Overdue', dueDate: '2020-01-01',
  total: 100, balance: 100, lineItems: [{ id: 'line1', desc: 'Service', qty: '1', unitPrice: '100' }],
  qbAuthoritative: true, qbSyncStatus: 'synced', locallyEdited: false, qbPendingLocalEdits: false, qbLocalChangesPending: false,
  qbContentFingerprint: 'old-content', qbSyncToken: '1', notes: 'Internal note' });
const paid = () => ({ ...initial(), status: 'Paid', balance: 0, qbSyncToken: '2',
  qbReviewResolution: { reviewedInvoiceHash: 'fixture-source', confirmedResultHash: 'fixture-confirmed', resolvedAt: '2026-10-23T00:00:00Z' } });
async function setup({ entries = [initial(), { id: 'two', notes: 'Untouched', total: 50 }], depth = 1, seedAudit = false } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql stable as $$select '11111111-1111-1111-1111-111111111111'::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"test@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
  await db.exec(base); await db.exec(batch);
  await db.query("insert into app_state(key,value) values('sps_invoices',$1::jsonb),('sps_clients','[]'::jsonb)", [encode(entries, depth)]);
  await db.exec(review);
  const role = async name => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role',$2,false)", [JSON.stringify({ role: name }), name]); await db.exec(`set role ${name}`); };
  const state = async () => (await db.query("select value,version,updated_at from app_state where key='sps_invoices'")).rows[0];
  const invoice = async id => decode((await state()).value).find(row => row?.id === id);
  const patch = async (expected = initial(), next = paid()) => (await db.query('select * from sps_invoice_review_patch($1,$2::jsonb,$3::jsonb,$4,$5)', [expected.id, JSON.stringify(expected), JSON.stringify(next), 'fixture-actor', 'retry-linked'])).rows[0];
  if (seedAudit) { await role('service_role'); await patch(); await db.exec('reset role'); }
  await db.exec(authority); await role('service_role');
  const cas = async (rows, expected) => (await db.query("select * from sps_app_state_cas('sps_invoices',$1,$2::jsonb)", [expected ?? (await state()).version, encode(rows, depth)])).rows[0];
  const canonical = async (rows, authorities = {}, { candidates = {}, metadataCandidates = {}, diagnostics = {}, action = 'quickbooks-refresh', expected } = {}) => (await db.query(
    'select * from sps_invoice_canonical_cas($1,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
    [expected ?? (await state()).version, encode(rows, depth), 'fixture-actor', action, JSON.stringify(authorities), JSON.stringify(candidates), JSON.stringify(metadataCandidates), JSON.stringify(diagnostics)],
  )).rows[0];
  const candidates = async (id = 'one') => (await db.query('select * from sps_invoice_write_candidates_read($1)', [id])).rows;
  const resolve = async (id, candidateId, expectedInvoice) => (await db.query('select * from sps_invoice_write_candidate_resolve($1,$2,$3::jsonb,$4,$5)',
    [id, candidateId, JSON.stringify(expectedInvoice), 'fixture-actor', 'kept-quickbooks'])).rows[0];
  const authorizeDelete = async expectedInvoice => (await db.query('select * from sps_invoice_authorize_delete($1,$2::jsonb,$3)', [expectedInvoice.id, JSON.stringify(expectedInvoice), 'fixture-actor'])).rows[0];
  return { db, role, state, invoice, patch, cas, canonical, candidates, resolve, authorizeDelete, close: () => db.close() };
}

sqlTest('review receipts survive current-version legacy ledger replay while unrelated edits commit at every wire depth', async () => {
  for (const depth of [0, 1, 2]) {
    const f = await setup({ entries: [initial(), null, 'legacy', 9, { id: 'two', notes: 'Before' }], depth });
    try {
      const before = await f.state(); assert.equal((await f.patch()).applied, true);
      const unrelated = { id: 'two', notes: 'Saved on another device', extra: { future: true } };
      await f.role('authenticated');
      assert.equal((await f.cas([initial(), null, 'legacy', 9, unrelated], before.version)).applied, false);
      assert.equal((await f.cas([initial(), null, 'legacy', 9, unrelated])).applied, true);
      assert.deepEqual(decode((await f.state()).value), [paid(), null, 'legacy', 9, unrelated]);
      await f.role('service_role'); assert.deepEqual(await f.candidates(), []);
    } finally { await f.close(); }
  }
});

sqlTest('migration seeds only trusted matching review evidence, never a browser authoritative flag', async () => {
  const f = await setup({ seedAudit: true });
  try {
    await f.role('authenticated'); await f.cas([initial(), { id: 'two', total: 60 }]);
    assert.deepEqual(await f.invoice('one'), paid());
  } finally { await f.close(); }
  const unseeded = await setup();
  try {
    await unseeded.role('authenticated'); await unseeded.cas([{ ...initial(), total: 150 }]);
    assert.equal((await unseeded.invoice('one')).total, 150);
    await unseeded.db.exec('reset role'); assert.equal((await unseeded.db.query('select count(*)::int n from sps_invoice_authority')).rows[0].n, 0);
  } finally { await unseeded.close(); }
});

sqlTest('the exact old native late-fee function cannot recreate a paid invoice review conflict', async () => {
  const f = await setup();
  try {
    const source = execFileSync('git', ['show', '9261cdc:App.jsx'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const begin = source.indexOf('function applyLateFees('), end = source.indexOf('\nconst nextInvoiceNumber', begin);
    const applyLateFees = vm.runInNewContext(source.slice(begin, end) + '; applyLateFees', { Date, hasLateFeeLine: () => false,
      effectiveStatus: invoice => invoice.status, parseDueDate: date => new Date(date + 'T00:00:00'), invoiceTotals: invoice => ({ subtotal: invoice.total }) });
    const old = applyLateFees([initial()], { lateFee: { enabled: true, graceDays: 30, pct: 10, label: 'Late Fee' } }, '2026-10-23').invoices[0];
    assert.equal(old.lineItems.length, 2);
    await f.patch();
    const merged = mergeStoredState('sps_invoices', JSON.stringify([initial()]), JSON.stringify([old]), JSON.stringify([paid()]));
    assert.equal(merged.conflicts.length, 0);
    await f.role('authenticated'); await f.cas(JSON.parse(merged.value));
    const restored = await f.invoice('one'); assert.equal(restored.lineItems.length, 1); assert.equal(restored.balance, 0);
    assert.equal(restored.qbSyncStatus, 'synced'); assert.equal(restored.locallyEdited, false); assert.equal(restored.qbWriteReview, undefined);
    assert.notEqual(reconcileQuickBooksInvoice(restored, paid()).qbSyncStatus, 'conflict');
  } finally { await f.close(); }
});

sqlTest('genuine financial edits and local paid fallbacks are recoverable proposals, not silent loss', async () => {
  for (const changes of [{ lineItems: [{ id: 'line1', desc: 'Added service', qty: '1', unitPrice: '150' }], total: 150, locallyEdited: true },
    { status: 'Paid', balance: 0, locallyEdited: true }]) {
    const f = await setup();
    try {
      await f.canonical([initial(), { id: 'two' }], { one: initial() });
      const candidate = { ...initial(), ...changes, notes: 'New internal note' };
      await f.role('authenticated'); await f.cas([candidate, { id: 'two', notes: 'Saved independently' }]);
      const stored = await f.invoice('one'); assert.equal(stored.total, 100); assert.equal(stored.balance, 100);
      assert.equal(stored.notes, 'New internal note'); assert.equal(stored.qbWriteReview.reason, 'unconfirmed-accounting-change');
      assert.equal((await f.invoice('two')).notes, 'Saved independently');
      await f.role('service_role'); const [saved] = await f.candidates(); assert.deepEqual(saved.candidate_invoice, candidate);
      assert.equal(String(saved.id), stored.qbWriteReview.candidateId);
    } finally { await f.close(); }
  }
});

sqlTest('a near-miss legacy fee or another changed line is a visible recoverable edit', async () => {
  const f = await setup();
  try {
    await f.patch();
    const candidate = { ...paid(), lateFeeAppliedAt: '2026-10-23', locallyEdited: true,
      lineItems: [...paid().lineItems, { id: 'lf_one_2026-10-23', desc: 'Late Fee', qty: '1', unitPrice: '10.00', amount: 10, taxable: false, isLateFee: true, kind: 'lateFee', manual: true }] };
    await f.role('authenticated'); await f.cas([candidate]);
    assert.equal((await f.invoice('one')).qbWriteReview.reason, 'unconfirmed-accounting-change');
  } finally { await f.close(); }
});

sqlTest('canonical update advances authority, and generic lower-revision or receipt-erasing writes cannot undo it', async () => {
  const f = await setup();
  try {
    await f.patch(); const updated = { ...paid(), total: 125, qbSyncToken: '3', lineItems: [{ id: 'line1', desc: 'Service', qty: '1', unitPrice: '125' }] };
    const saved = await f.canonical([updated], { one: updated }, { action: 'quickbooks-update' });
    assert.equal(saved.applied, true); assert.deepEqual(decode(saved.value), [updated]);
    await f.role('authenticated'); await f.cas([paid()]);
    assert.deepEqual(await f.invoice('one'), updated);
    const withoutReceipt = { ...updated }; delete withoutReceipt.qbReviewResolution;
    await f.cas([withoutReceipt]); assert.deepEqual(await f.invoice('one'), updated);
  } finally { await f.close(); }
});

sqlTest('a no-op fresh pull registers authority without bumping the ledger version', async () => {
  const f = await setup();
  try {
    const before = await f.state(); const saved = await f.canonical(decode(before.value), { one: initial() });
    assert.equal(saved.applied, true); assert.equal(saved.outcome, 'unchanged'); assert.equal(saved.current_version, before.version);
    assert.deepEqual(await f.state(), before);
    await f.role('authenticated'); await f.cas([{ ...initial(), qbSyncToken: '0', total: 20 }]);
    assert.equal((await f.invoice('one')).total, 100);
  } finally { await f.close(); }
});

sqlTest('fresh refresh accounts win while genuine earlier pending intent remains recoverable', async () => {
  const dirty = { ...initial(), locallyEdited: true, qbAuthoritative: false, qbSyncStatus: 'pending-push', total: 150,
    lineItems: [{ id: 'line1', desc: 'Real extra work', qty: '1', unitPrice: '150' }] };
  const f = await setup({ entries: [dirty, { id: 'two', notes: 'Keep' }] });
  try {
    const saved = await f.canonical([dirty, { id: 'two', notes: 'Keep' }], { one: paid() }, { candidates: { one: dirty } });
    const stored = decode(saved.value)[0]; assert.equal(stored.total, 100); assert.equal(stored.balance, 0); assert.equal(stored.qbSyncStatus, 'synced');
    const [proposal] = await f.candidates(); assert.deepEqual(proposal.candidate_invoice, dirty);
    assert.equal(String(proposal.id), stored.qbWriteReview.candidateId);
    assert.equal((await f.invoice('two')).notes, 'Keep');
  } finally { await f.close(); }
});

sqlTest('cost/provenance and internal notes remain editable without proposing false charge changes', async () => {
  const f = await setup();
  try {
    await f.patch();
    const edited = { ...paid(), notes: 'Owner note', lineItems: [{ ...paid().lineItems[0], unitCost: '12', costKnown: true, sourceStopId: 'stop-2', bundleNote: 'Internal supply detail' }] };
    await f.role('authenticated'); await f.cas([edited]);
    assert.deepEqual(await f.invoice('one'), edited);
  } finally { await f.close(); }
});

sqlTest('stale deletion is proposed, explicit exact deletion works, and stale re-addition is blocked', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated'); await f.cas([{ id: 'two', notes: 'Still saves' }]);
    let target = await f.invoice('one'); assert.equal(target.qbWriteReview.reason, 'unconfirmed-delete');
    await f.role('service_role'); assert.equal((await f.authorizeDelete(target)).authorized, true);
    await f.role('authenticated'); await f.cas([{ id: 'two', notes: 'Delete finished' }]);
    assert.equal(await f.invoice('one'), undefined);
    await f.cas([paid(), { id: 'two', notes: 'Reconnection' }]); assert.equal(await f.invoice('one'), undefined);
    await f.cas([{ ...paid(), id: 'qb_123' }, { id: 'two' }]); assert.equal(await f.invoice('qb_123'), undefined);
  } finally { await f.close(); }
});

sqlTest('delete authorization cannot silently delete a subsequently edited invoice', async () => {
  const f = await setup();
  try {
    await f.patch(); assert.equal((await f.authorizeDelete(paid())).authorized, true);
    await f.role('authenticated'); await f.cas([{ ...paid(), notes: 'New work after confirmation' }]); await f.cas([]);
    const target = await f.invoice('one'); assert.equal(target.notes, 'New work after confirmation'); assert.equal(target.qbWriteReview.reason, 'unconfirmed-delete');
  } finally { await f.close(); }
});

sqlTest('proposal resolution is exact and cannot erase a later device proposal', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated'); await f.cas([{ ...paid(), total: 130, locallyEdited: true }]);
    const first = await f.invoice('one'); await f.cas([{ ...first, total: 160, locallyEdited: true }]);
    const latest = await f.invoice('one'); assert.notEqual(latest.qbWriteReview.candidateId, first.qbWriteReview.candidateId);
    await f.role('service_role'); assert.equal((await f.resolve('one', first.qbWriteReview.candidateId, first)).outcome, 'target_changed');
    assert.equal((await f.resolve('one', latest.qbWriteReview.candidateId, latest)).applied, true);
    assert.equal((await f.invoice('one')).qbWriteReview.candidateId, first.qbWriteReview.candidateId);
    assert.equal((await f.candidates()).length, 1, 'resolving the selected candidate must retain the older proposal');
  } finally { await f.close(); }
});

sqlTest('private RPCs and tables reject direct clients and forged trusted context', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated');
    await assert.rejects(f.canonical([initial()], { one: initial() }), /permission denied/);
    await assert.rejects(f.authorizeDelete(paid()), /permission denied/);
    await assert.rejects(f.candidates(), /permission denied/);
    await f.db.query("select set_config('sps.invoice_canonical_write',$1,false)", [JSON.stringify({ action: 'quickbooks-update', actor: 'forged', authority: { one: initial() } })]);
    await f.cas([initial()]); assert.equal((await f.invoice('one')).balance, 0);
    await f.db.query("select set_config('request.jwt.claims',$1,false),set_config('request.jwt.claim.role','service_role',false)", [JSON.stringify({ role: 'service_role' })]);
    assert.equal((await f.db.query("select current_setting('role') r")).rows[0].r, 'authenticated');
    await f.cas([initial()]); assert.equal((await f.invoice('one')).balance, 0, 'forged JWT/context GUCs must not grant the authenticated database role authority');
    await assert.rejects(f.canonical([initial()], { one: initial() }), /permission denied/);
    await assert.rejects(f.db.query('select * from sps_invoice_authority'), /permission denied/);
    await f.db.exec('reset role');
    const grants = (await f.db.query(`select proname,has_function_privilege('authenticated',p.oid,'execute') client,
      has_function_privilege('service_role',p.oid,'execute') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (proname like 'sps_invoice_%' or proname='sps_guard_invoice_authority')`)).rows;
    const allowed = new Set(['sps_invoice_canonical_cas','sps_invoice_authority_owners','sps_invoice_authorize_delete','sps_invoice_write_candidates_read','sps_invoice_write_candidate_resolve','sps_invoice_review_patch']);
    for (const row of grants) { assert.equal(row.client, false, row.proname); assert.equal(row.service, allowed.has(row.proname), row.proname); }
  } finally { await f.close(); }
});

sqlTest('a verified canonical writer cannot regress a newer QB revision or seed dirty authority', async () => {
  const f = await setup();
  try {
    await f.patch(); const before = await f.state();
    await assert.rejects(f.canonical([initial()], { one: initial() }), /invoice_canonical_stale_revision/);
    await assert.rejects(f.canonical([{ ...paid(), locallyEdited: true }], { one: { ...paid(), locallyEdited: true } }), /invoice_canonical_authority_invalid/);
    assert.deepEqual(await f.state(), before);
  } finally { await f.close(); }
});

sqlTest('an explicit refresh candidate with the exact generated fee does not become a new proposal', async () => {
  const f = await setup();
  try {
    await f.patch();
    const fee = { ...paid(), lateFeeAppliedAt: '2026-10-23', locallyEdited: true, qbAuthoritative: false, qbPendingLocalEdits: true, qbSyncStatus: 'pending-push',
      lineItems: [...paid().lineItems, { id: 'lf_one_2026-10-23', desc: 'Late Fee', qty: '1', unitPrice: '10.00', amount: 10, taxable: false, isLateFee: true, kind: 'lateFee' }] };
    // Simulate an old pending record already stored before the guard rollout.
    await f.db.exec('reset role'); await f.db.exec('alter table app_state disable trigger sps_guard_invoice_authority');
    await f.db.query("update app_state set value=$1::jsonb where key='sps_invoices'", [encode([fee])]);
    await f.db.exec('alter table app_state enable trigger sps_guard_invoice_authority'); await f.role('service_role');
    const saved = await f.canonical([fee], { one: paid() }, { candidates: { one: fee } });
    assert.equal(decode(saved.value)[0].qbWriteReview, undefined); assert.deepEqual(await f.candidates(), []);
  } finally { await f.close(); }
});

sqlTest('fresh authority preserves earlier review receipt and transaction context cannot leak into generic saves', async () => {
  const f = await setup();
  try {
    await f.patch(); const updated = { ...paid(), qbSyncToken: '3', total: 125, lineItems: [{ id: 'line1', desc: 'Service', qty: '1', unitPrice: '125' }] };
    delete updated.qbReviewResolution;
    await f.db.exec('begin');
    const saved = await f.canonical([updated], { one: updated }, { action: 'quickbooks-update' });
    assert.deepEqual(decode(saved.value)[0].qbReviewResolution, paid().qbReviewResolution);
    assert.equal((await f.db.query("select coalesce(current_setting('sps.invoice_canonical_write',true),'') scope")).rows[0].scope, '');
    await f.cas([initial()]); assert.equal((await f.invoice('one')).total, 125);
    await f.db.exec('rollback');
  } finally { await f.close(); }
});

sqlTest('old qb-id aliases cannot bypass authority through a new local invoice identity', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated');
    await f.cas([{ ...initial(), id: 'qb_123' }, { id: 'two', notes: 'Unrelated still saved' }]);
    assert.equal(await f.invoice('qb_123'), undefined);
    const current = await f.invoice('one'); assert.equal(current.balance, 0); assert.equal(current.qbWriteReview.reason, 'duplicate-invoice-identity');
    await f.role('service_role'); assert.equal((await f.candidates())[0].candidate_invoice.id, 'qb_123');
    await assert.rejects(f.canonical([{ ...paid(), id: 'qb_123' }], { qb_123: { ...paid(), id: 'qb_123' } }), /invoice_canonical_identity_conflict/);
  } finally { await f.close(); }
});

sqlTest('dirty sync flags and cost-only refresh candidates do not create financial proposals', async () => {
  const dirty = { ...initial(), locallyEdited: true, qbAuthoritative: false, qbSyncStatus: 'pending-push', lineItems: [{ ...initial().lineItems[0], unitCost: '12' }] };
  const f = await setup({ entries: [dirty] });
  try {
    const saved = await f.canonical([dirty], { one: initial() }, { candidates: { one: dirty } });
    assert.equal(decode(saved.value)[0].qbWriteReview, undefined); assert.equal(decode(saved.value)[0].lineItems[0].unitCost, '12');
    assert.deepEqual(await f.candidates(), []);
  } finally { await f.close(); }
});

sqlTest('conflicting submitted metadata is durably held without replacing the newer internal note', async () => {
  const f = await setup();
  try {
    await f.patch(); const latest = { ...paid(), notes: 'Newer office note' };
    await f.role('authenticated'); await f.cas([latest]); await f.role('service_role');
    const proposed = { ...paid(), notes: 'Submitted device note', lineItems: [{ ...paid().lineItems[0], unitCost: '18' }] };
    const saved = await f.canonical([latest], { one: latest }, { action: 'quickbooks-update', metadataCandidates: { one: { expected: latest, proposed } } });
    const target = decode(saved.value)[0]; assert.equal(target.notes, latest.notes); assert.equal(target.qbWriteReview.reason, 'concurrent-sps-metadata');
    assert.deepEqual((await f.candidates())[0].candidate_invoice, proposed);
    await assert.rejects(f.canonical([latest], { one: latest }, { metadataCandidates: { one: { expected: paid(), proposed } } }), /invoice_canonical_metadata_candidate_changed/);
  } finally { await f.close(); }
});

sqlTest('Use QuickBooks atomically resolves its exact proposal, promotes the next, and preserves the hashed result', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated');
    await f.cas([{ ...paid(), total: 130, locallyEdited: true }]);
    await f.cas([{ ...paid(), total: 160, locallyEdited: true }]);
    const current = await f.invoice('one'); await f.role('service_role');
    const pending = await f.candidates(); assert.equal(pending.length, 2);
    const nextRow = pending.find(row => String(row.id) !== current.qbWriteReview.candidateId);
    const planned = { ...current, qbWriteReview: { candidateId: String(nextRow.id), reason: nextRow.reason, savedAt: new Date(nextRow.created_at).toISOString() },
      qbReviewResolution: { ...current.qbReviewResolution, confirmedResultHash: 'hash-of-planned-marker' } };
    const before = await f.state();
    const saved = await f.patch(current, planned);
    assert.equal(saved.applied, true); assert.equal(saved.current_version, before.version + 1);
    assert.deepEqual(saved.invoice, planned); assert.deepEqual(await f.invoice('one'), planned); assert.equal((await f.candidates()).length, 1);
    const last = { ...planned, qbReviewResolution: { ...planned.qbReviewResolution, confirmedResultHash: 'hash-without-marker' } }; delete last.qbWriteReview;
    assert.equal((await f.patch(planned, last)).applied, true); assert.deepEqual(await f.candidates(), []);
  } finally { await f.close(); }
});

sqlTest('exact historical record replay retains later notes and costs while genuine metadata edits remain editable', async () => {
  const f = await setup();
  try {
    await f.patch(); await f.role('authenticated');
    const latest = { ...paid(), notes: 'New office note', lineItems: [{ ...paid().lineItems[0], unitCost: '19', bundleNote: 'Current costing' }] };
    await f.cas([latest]); await f.cas([initial()]);
    assert.deepEqual(await f.invoice('one'), latest);
    const newEdit = { ...paid(), notes: 'Explicit new note', lineItems: [{ ...paid().lineItems[0], unitCost: '21' }] };
    await f.cas([newEdit]); assert.deepEqual(await f.invoice('one'), newEdit);
  } finally { await f.close(); }
});

sqlTest('installed accepted-stop guard coexists with invoice no-op registration and one-version canonical updates', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    await f.db.exec(`create table sps_stop_report_guard_config(singleton boolean primary key,enabled boolean not null);
      insert into sps_stop_report_guard_config values(true,true);`);
    await f.db.exec(installedStopGuard);
    await f.db.exec(`create trigger sps_guard_accepted_stop_reports before insert or update or delete on app_state
      for each row execute function sps_guard_accepted_stop_reports();`);
    await f.role('service_role');
    const before = await f.state();
    const noop = await f.canonical(decode(before.value), { one: initial() });
    assert.equal(noop.outcome, 'unchanged'); assert.equal(noop.current_version, before.version);
    const next = await f.canonical([paid()], { one: paid() });
    assert.equal(next.current_version, before.version + 1); assert.deepEqual(await f.invoice('one'), paid());
    await f.role('authenticated'); await f.cas([initial()]);
    assert.equal((await f.state()).version, before.version + 2); assert.deepEqual(await f.invoice('one'), paid());
  } finally { await f.close(); }
});

sqlTest('trusted missing diagnostics persist through generic saves and clear after fresh QB evidence', async () => {
  const f = await setup();
  try {
    await f.patch();
    const patch = { qbNeedsReview: true, qbSyncStatus: 'missing-remote', qbMissingSince: '2026-10-23T00:00:00Z' };
    const missing = { ...paid(), ...patch };
    const saved = await f.canonical([missing], {}, { diagnostics: { one: { expected: paid(), patch } } });
    assert.deepEqual(decode(saved.value), [missing]);
    await f.role('authenticated'); await f.cas([{ ...paid(), notes: 'Saved after missing warning' }]);
    assert.equal((await f.invoice('one')).qbSyncStatus, 'missing-remote');
    assert.equal((await f.invoice('one')).qbMissingSince, patch.qbMissingSince);
    await f.role('service_role');
    const fresh = { ...paid(), notes: 'Saved after missing warning', qbSyncToken: '3' };
    await f.canonical([fresh], { one: fresh });
    assert.deepEqual(await f.invoice('one'), fresh);
  } finally { await f.close(); }
});

sqlTest('diagnostics cannot authorize financial edits, wrong target snapshots, or arbitrary QB fields', async () => {
  const f = await setup();
  try {
    await f.patch();
    const patch = { qbNeedsReview: true, qbSyncStatus: 'missing-remote', qbMissingSince: '2026-10-23T00:00:00Z' };
    await assert.rejects(f.canonical([{ ...paid(), total: 999 }], {}, { diagnostics: { one: { expected: paid(), patch } } }), /invoice_canonical_diagnostic_changed/);
    await assert.rejects(f.canonical([paid()], {}, { diagnostics: { one: { expected: initial(), patch } } }), /invoice_canonical_diagnostic_changed/);
    await assert.rejects(f.canonical([paid()], {}, { diagnostics: { one: { expected: paid(), patch: { ...patch, qbCustomerId: 'other' } } } }), /invoice_canonical_diagnostic_changed/);
    await f.role('authenticated');
    await assert.rejects(f.db.query('select * from sps_invoice_authority_owners()'), /permission denied/);
  } finally { await f.close(); }
});

sqlTest('existing duplicate ids remain review context in either order while fresh authority follows its anchored owner', async () => {
  for (const aliasFirst of [true, false]) {
    const alias = { ...initial(), id: 'legacy-alias', source: 'sps', sourceStopId: 'linked-stop' };
    const owner = { ...initial(), source: 'quickbooks' };
    const rows = aliasFirst ? [alias, owner] : [owner, alias];
    const f = await setup({ entries: rows });
    try {
      const canonical = { ...paid(), source: 'quickbooks' };
      const patch = { qbNeedsReview: true, qbSyncStatus: 'duplicate-local-qb-id', qbDuplicateOfId: 'one' };
      const next = rows.map(item => item.id === 'one' ? canonical : { ...item, ...patch });
      await f.canonical(next, { one: canonical }, { diagnostics: { 'legacy-alias': { expected: alias, patch } } });
      assert.equal(decode((await f.state()).value).length, 2);
      assert.equal((await f.invoice('legacy-alias')).sourceStopId, 'linked-stop');
      assert.equal((await f.invoice('legacy-alias')).qbDuplicateOfId, 'one');
      assert.equal((await f.invoice('one')).balance, 0);
      assert.deepEqual((await f.db.query('select * from sps_invoice_authority_owners()')).rows, [{ invoice_id: 'one', qb_id: '123' }]);
      await f.role('authenticated'); await f.cas(rows);
      assert.equal((await f.invoice('legacy-alias')).qbSyncStatus, 'duplicate-local-qb-id');
      assert.equal((await f.invoice('one')).balance, 0);
      await f.role('service_role'); assert.deepEqual(await f.candidates(), []);
    } finally { await f.close(); }
  }
});

sqlTest('1092 realistic invoice records refresh and stale-write protection execute at the SQL boundary', async () => {
  const count = 1092;
  const entries = Array.from({ length: count }, (_, index) => ({ ...initial(), id: `scale-${index}`, qbId: String(10000 + index), number: String(3000 + index),
    clientId: `client-${index % 180}`, clientName: `Synthetic client ${index % 180}`, notes: 'Synthetic service visit with equipment, supplies, and internal completion notes '.repeat(2),
    lineItems: Array.from({ length: 3 }, (_, line) => ({ id: `line-${index}-${line}`, qbLineId: String(line + 1), desc: `Monthly pond service and inspection line ${line + 1}`,
      qty: '1', unitPrice: '33.33', amount: 33.33, taxable: false, kind: 'service', unitCost: '10', costKnown: true, sourceStopId: `stop-${index}`, qbItemRef: { value: '42', name: 'Service' } })) }));
  const f = await setup({ entries });
  try {
    const next = entries.map(invoice => ({ ...invoice, status: 'Paid', balance: 0, qbSyncToken: '2' }));
    const authority = Object.fromEntries(next.map(invoice => [invoice.id, invoice]));
    let start = performance.now(); const saved = await f.canonical(next, authority); const canonicalMs = performance.now() - start;
    assert.equal(saved.applied, true); assert.equal(saved.current_version, 2);
    await f.role('authenticated'); start = performance.now(); const stale = await f.cas(entries); const genericMs = performance.now() - start;
    assert.equal(stale.applied, true); assert.equal(stale.current_version, 3);
    const stored = decode((await f.state()).value); assert.equal(stored.length, count); assert.ok(stored.every(invoice => invoice.balance === 0 && !invoice.qbWriteReview));
    console.log(JSON.stringify({ sqlBenchmark: true, count, jsonBytes: Buffer.byteLength(JSON.stringify(entries)), canonicalMs: Math.round(canonicalMs), genericMs: Math.round(genericMs) }));
  } finally { await f.close(); }
});
