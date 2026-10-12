// Real PostgreSQL semantics via isolated PGlite; no database or app network calls.
// npm install --prefix /tmp/sps-stop-sql-harness --no-save @electric-sql/pglite@0.3.14
// SPS_SQL_TEST_PGLITE_PATH=/tmp/sps-stop-sql-harness/node_modules/@electric-sql/pglite/dist/index.js node --test tests/stopReportAuthoritySql.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyStopCompletion, reverseStopCompletion } from '../stopCompletion.js';

const runtime = process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite = runtime ? (await import(pathToFileURL(runtime).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && 'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL' }, fn);
const migration = await readFile(new URL('../supabase/migrations/20261012213546_stop_report_authority.sql', import.meta.url), 'utf8');
const memoryMigration = await readFile(new URL('../supabase/migrations/20261012215154_stop_report_memory_bound.sql', import.meta.url), 'utf8');
const linearMigration = await readFile(new URL('../supabase/migrations/20261012222135_stop_report_linear_replace.sql', import.meta.url), 'utf8');
const baseSql = await readFile(new URL('../APP-STATE-CONCURRENCY-MIGRATION.sql', import.meta.url), 'utf8');
const batchSql = await readFile(new URL('../APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql', import.meta.url), 'utf8');
const catalog = { treatments: [], parts: [], products: [] };
const sid = 'stop-one';
const cid = 'client-one';
const rid = 'receipt-one';
const key = 'completion-key-one';
const initialClients = [{ id: cid, name: 'Synthetic Client', notes: 'Office note', history: [{ date: '2026-01-01', notes: 'Legacy report' }] }, { id: 'client-two', name: 'Other Client', history: [] }];
const makeCompletion = (clients = initialClients, completed = {}, options = {}) => {
  const result = applyStopCompletion({ clients, completed, catalog, clientId: cid,
    entry: { sid, date: '2026-10-12', notes: 'Accepted report', photos: [{ src: 'fixture://photo-one', label: 'After' }], invoice: '$0' },
    sid, receiptId: rid, idempotencyKey: key, completedAt: '2026-10-12T20:00:00.000Z', postBalance: false, ...options });
  assert.equal(result.ok, true, result.code); return result;
};
function encoded(value, depth = 1) { while (depth--) value = JSON.stringify(value); return value; }
function decoded(value) { for (let i = 0; i < 2 && typeof value === 'string'; i++) value = JSON.parse(value); return value; }
async function as(db, role) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.exec(`set role ${role}`);
}
async function state(db, name) {
  const rows = (await db.query('select * from public.app_state where key=$1', [name])).rows;
  return rows[0] ? { ...rows[0], value: decoded(rows[0].value) } : null;
}
async function write(db, name, value, depth = 1) {
  return db.query('update public.app_state set value=$2::jsonb where key=$1 returning version,value', [name, JSON.stringify(encoded(value, depth))]);
}
async function setup({ completed = true, depth = 1, activate = true } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"fixture@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb $$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table public.app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on public.app_state to anon,authenticated,service_role;`);
  await db.exec(baseSql); await db.exec(batchSql);
  const completion = makeCompletion();
  for (const [name, value] of Object.entries({ sps_clients: completed ? completion.clients : initialClients,
    sps_completed: completed ? completion.completed : {}, sps_catalog: catalog, sps_schedule: [], sps_billing_reviews: [], sps_invoices: [] })) {
    await db.query('insert into public.app_state(key,value) values($1,$2::jsonb)', [name, JSON.stringify(encoded(value, depth))]);
  }
  await db.exec(migration); await db.exec(memoryMigration); await db.exec(linearMigration); await as(db, 'service_role');
  if (activate) await db.query('select public.sps_activate_stop_report_guard()');
  return { db, completion };
}
async function ops(db, changes) {
  const result = [];
  for (const [name, value] of Object.entries(changes)) {
    const prior = await state(db, name);
    result.push({ key: name, expected_version: Number(prior?.version || 0), ...(value === undefined ? { check_only: true } : { value: encoded(value) }) });
  }
  return result;
}
async function rpc(db, operations, mode, receipt = rid, stop = sid) {
  return (await db.query('select * from public.sps_stop_completion_batch_cas($1::jsonb,$2,$3,$4)', [JSON.stringify(operations), mode, stop, receipt])).rows[0];
}
function reverseWithTombstone(clients, completed) {
  const result = reverseStopCompletion({ clients, completed, catalog, clientId: cid, sid });
  assert.equal(result.ok, true, result.code);
  result.completed.__stopReversedRequests = { ...(result.completed.__stopReversedRequests || {}), [rid]: {
    sid, clientId: cid, receiptId: rid, idempotencyKey: key, reversedAt: '2026-10-12T21:00:00.000Z',
  } }; return result;
}

sqlTest('installation leaves existing endpoint writes enabled and activation takes exact raw backup', async () => {
  const { db } = await setup({ activate: false });
  try {
    await write(db, 'sps_clients', initialClients);
    assert.deepEqual((await state(db, 'sps_clients')).value, initialClients);
    await db.query('select public.sps_activate_stop_report_guard()');
    await assert.rejects(db.query('select * from public.sps_stop_report_guard_backups'), /permission denied/);
    await db.exec('reset role');
    const backup = (await db.query("select rows from public.sps_stop_report_guard_backups where reason='activation'")).rows[0].rows;
    assert.equal(backup.length, 4); assert.equal(typeof backup.find(r => r.key === 'sps_clients').value, 'string');
    assert.deepEqual(decoded(backup.find(r => r.key === 'sps_clients').value), initialClients);
  } finally { await db.close(); }
});

sqlTest('legacy direct writes preserve accepted report and marker while unrelated edits save', async () => {
  const { db, completion } = await setup();
  try {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await as(db, role);
      const stale = structuredClone(initialClients); stale[0].notes = `Changed by ${role}`;
      stale[0].history[0].notes = 'Edited legacy report';
      await write(db, 'sps_clients', stale);
      const saved = (await state(db, 'sps_clients')).value;
      assert.equal(saved[0].notes, `Changed by ${role}`);
      assert.deepEqual(saved[0].history.find(h => h.completionReceiptId === rid), completion.clients[0].history[0]);
      assert.equal(saved[0].history.find(h => !h.completionReceiptId).notes, 'Edited legacy report');
      await write(db, 'sps_completed', { [sid]: true });
      assert.deepEqual((await state(db, 'sps_completed')).value, completion.completed);
    }
  } finally { await db.close(); }
});

sqlTest('generic CAS and service batch cannot erase or edit protected reports or forge another receipt', async () => {
  const { db, completion } = await setup();
  try {
    await as(db, 'authenticated');
    let current = await state(db, 'sps_clients');
    await db.query('select * from public.sps_app_state_cas($1,$2,$3::jsonb)', ['sps_clients', current.version, JSON.stringify(encoded([]))]);
    assert.deepEqual((await state(db, 'sps_clients')).value, [completion.clients[0]]);
    const tampered = structuredClone(completion.clients); tampered[0].history[0].notes = 'Stale edited report';
    tampered[0].history.push({ sid: 'fake', completionReceiptId: 'forged', notes: 'Fake report' });
    await as(db, 'service_role');
    const operations = await ops(db, { sps_clients: tampered, sps_completed: {} });
    await db.query('select * from public.sps_app_state_batch_cas($1::jsonb)', [JSON.stringify(operations)]);
    assert.deepEqual((await state(db, 'sps_clients')).value[0].history, completion.clients[0].history);
    assert.deepEqual((await state(db, 'sps_completed')).value, completion.completed);
  } finally { await db.close(); }
});

sqlTest('delete key rename and forged privileged context cannot bypass the guard', async () => {
  const { db } = await setup();
  try {
    await as(db, 'authenticated');
    await assert.rejects(db.query("delete from public.app_state where key='sps_clients'"), /require_server_mutation/);
    await assert.rejects(db.query("update public.app_state set key='renamed' where key='sps_completed'"), /key_is_immutable/);
    await assert.rejects(db.query('select public.sps_activate_stop_report_guard()'), /permission denied/);
    await assert.rejects(rpc(db, [], 'complete'), /permission denied/);
    await db.query("select set_config('sps.stop_report_write',$1,false)", [JSON.stringify({ mode: 'reverse', sid, receipt: rid })]);
    await write(db, 'sps_clients', initialClients);
    assert.ok((await state(db, 'sps_clients')).value[0].history.some(h => h.completionReceiptId === rid));
  } finally { await db.close(); }
});

sqlTest('restricted complete saves once and accepts empty maintenance ledger initialization', async () => {
  const { db, completion } = await setup({ completed: false });
  try {
    const operations = await ops(db, { sps_clients: completion.clients, sps_completed: completion.completed,
      sps_schedule: undefined, sps_billing_reviews: undefined, sps_invoices: undefined,
      sps_maintenance_billing: { version: 2, policies: {}, allocations: {} } });
    assert.equal((await rpc(db, operations, 'complete')).applied, true);
    assert.deepEqual((await state(db, 'sps_clients')).value, completion.clients);
    const stale = await rpc(db, operations, 'complete'); assert.equal(stale.applied, false); assert.equal(stale.outcome, 'conflict');
    assert.equal((await db.query("select current_setting('sps.stop_report_write',true) context")).rows[0].context, '');
  } finally { await db.close(); }
});

sqlTest('restricted edit updates only identified report and cannot change other client fields or ledger', async () => {
  const { db, completion } = await setup();
  try {
    const edited = structuredClone(completion.clients); edited[0].history[0].notes = 'Reviewed correction';
    const operations = await ops(db, { sps_clients: edited, sps_completed: undefined });
    assert.equal((await rpc(db, operations, 'edit')).applied, true);
    assert.equal((await state(db, 'sps_clients')).value[0].history[0].notes, 'Reviewed correction');
    edited[0].name = 'Unrelated change';
    await assert.rejects(rpc(db, await ops(db, { sps_clients: edited, sps_completed: undefined }), 'edit'), /changed_unrelated_data/);
    await assert.rejects(rpc(db, await ops(db, { sps_clients: edited, sps_completed: {} }), 'edit'), /required_rows_missing/);
    assert.deepEqual((await state(db, 'sps_completed')).value, completion.completed);
  } finally { await db.close(); }
});

sqlTest('missing report recovery is explicit exact prepend beneath a valid active receipt', async () => {
  const { db, completion } = await setup({ activate: false });
  try {
    await write(db, 'sps_clients', initialClients);
    await db.query('select public.sps_activate_stop_report_guard()');
    const recovered = structuredClone(initialClients);
    // A trusted restore can preserve exact archived bytes without adding synthetic metadata.
    const report = { ...completion.clients[0].history[0] };
    recovered[0].history.unshift(report);
    const invalid = structuredClone(recovered); invalid[0].history[0].notes = ''; invalid[0].history[0].photos = [];
    await assert.rejects(rpc(db, await ops(db, { sps_clients: invalid, sps_completed: undefined }), 'edit'), /recovery_invalid/);
    assert.equal((await rpc(db, await ops(db, { sps_clients: recovered, sps_completed: undefined }), 'edit')).applied, true);
    assert.deepEqual((await state(db, 'sps_clients')).value, recovered);
    await write(db, 'sps_clients', initialClients);
    assert.deepEqual((await state(db, 'sps_clients')).value[0].history.find(h => h.completionReceiptId === rid), report);
  } finally { await db.close(); }
});

sqlTest('unchanged protected content retains the exact caller serialization and private helpers have no public grants', async () => {
  const { db, completion } = await setup();
  try {
    for (const depth of [1, 2]) {
      const clients = structuredClone(completion.clients); clients[0].notes = `Changed ${depth}`;
      const value = encoded(clients, depth);
      const result = await write(db, 'sps_clients', clients, depth);
      assert.equal(result.rows[0].value, value);
    }
    await db.exec('reset role');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const helper of ['public.sps_stop_state_decode(jsonb)', 'public.sps_stop_guard_clients(jsonb,jsonb,jsonb)', 'public.sps_stop_guard_completed(jsonb,jsonb,jsonb)']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed', [role, helper, 'EXECUTE'])).rows[0].allowed, false);
      }
      assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed', [role, 'public.sps_stop_completion_batch_cas(jsonb,text,text,text)', 'EXECUTE'])).rows[0].allowed, role === 'service_role');
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed', [role, 'public.sps_stop_report_guard_config', 'UPDATE'])).rows[0].allowed, false);
    }
  } finally { await db.close(); }
});

sqlTest('legacy reverse is allowed explicitly and an old true snapshot cannot restore its marker', async () => {
  const { db } = await setup({ completed: false, activate: false });
  try {
    await write(db, 'sps_completed', { [sid]: true });
    await db.query('select public.sps_activate_stop_report_guard()');
    const reversed = reverseStopCompletion({ clients: initialClients, completed: { [sid]: true }, catalog, clientId: cid, sid, allowLegacy: true });
    assert.equal(reversed.ok, true, reversed.code);
    assert.equal((await rpc(db, await ops(db, { sps_clients: reversed.clients, sps_completed: reversed.completed }), 'reverse', '')).applied, true);
    await write(db, 'sps_completed', { [sid]: true });
    assert.equal((await state(db, 'sps_completed')).value[sid], undefined);
  } finally { await db.close(); }
});

sqlTest('trusted out-of-order reversal keeps valid later balance receipt compaction', async () => {
  const { db } = await setup({ completed: false, activate: false });
  try {
    const original = structuredClone(initialClients); original[0].balance = '$125';
    const first = makeCompletion(original, {}, { postBalance: true, entry: { sid, invoice: '$50', notes: 'First report' } });
    const second = makeCompletion(first.clients, first.completed, { postBalance: true, sid: 'stop-two', receiptId: 'receipt-two', idempotencyKey: 'completion-key-two', entry: { sid: 'stop-two', invoice: '$80', notes: 'Second report' } });
    await write(db, 'sps_clients', second.clients); await write(db, 'sps_completed', second.completed);
    await db.query('select public.sps_activate_stop_report_guard()');
    const reversed = reverseWithTombstone(second.clients, second.completed);
    assert.notDeepEqual(reversed.completed.__stopReversalReceipts['receipt-two'].balance.before, second.completed.__stopReversalReceipts['receipt-two'].balance.before);
    assert.equal((await rpc(db, await ops(db, { sps_clients: reversed.clients, sps_completed: reversed.completed }), 'reverse')).applied, true);
    assert.deepEqual((await state(db, 'sps_completed')).value, reversed.completed);
    const later = reverseStopCompletion({ clients: (await state(db, 'sps_clients')).value, completed: (await state(db, 'sps_completed')).value,
      catalog, sid: 'stop-two', clientId: cid });
    assert.equal(later.ok, true, later.code); assert.equal(later.clients[0].balance, '$125');
  } finally { await db.close(); }
});

sqlTest('reverse archives report then blocks stale report marker true and original request resurrection', async () => {
  const { db, completion } = await setup();
  try {
    const reversed = reverseWithTombstone(completion.clients, completion.completed);
    assert.equal((await rpc(db, await ops(db, { sps_clients: reversed.clients, sps_completed: reversed.completed }), 'reverse')).applied, true);
    await as(db, 'authenticated');
    await write(db, 'sps_clients', completion.clients);
    await write(db, 'sps_completed', { ...completion.completed, otherLegacy: true });
    assert.ok(!(await state(db, 'sps_clients')).value[0].history.some(h => h.completionReceiptId === rid));
    assert.equal((await state(db, 'sps_completed')).value[sid], undefined);
    assert.equal((await state(db, 'sps_completed')).value.otherLegacy, true);
    await write(db, 'sps_completed', { [sid]: true });
    assert.equal((await state(db, 'sps_completed')).value[sid], undefined);
    assert.equal((await state(db, 'sps_completed')).value.__stopReversedRequests[rid].idempotencyKey, key);
    await as(db, 'service_role');
    const currentClients = (await state(db, 'sps_clients')).value;
    const currentCompleted = (await state(db, 'sps_completed')).value;
    const staleRequest = makeCompletion(currentClients, currentCompleted, { receiptId: 'replacement-for-old-key' });
    await assert.rejects(rpc(db, await ops(db, { sps_clients: staleRequest.clients, sps_completed: staleRequest.completed }), 'complete', 'replacement-for-old-key'), /already_reversed/);
    const fresh = makeCompletion(currentClients, currentCompleted, { receiptId: 'fresh-receipt', idempotencyKey: 'fresh-completion-key' });
    assert.equal((await rpc(db, await ops(db, { sps_clients: fresh.clients, sps_completed: fresh.completed }), 'complete', 'fresh-receipt')).applied, true);
    await db.exec('reset role');
    const tombstone = (await db.query('select * from public.sps_stop_report_reversals')).rows[0];
    assert.deepEqual(tombstone.report, completion.clients[0].history[0]);
  } finally { await db.close(); }
});

sqlTest('failed reverse CAS creates no tombstone and keeps every original report', async () => {
  const { db, completion } = await setup();
  try {
    const reversed = reverseWithTombstone(completion.clients, completion.completed);
    const operations = await ops(db, { sps_clients: reversed.clients, sps_completed: reversed.completed });
    operations[1].expected_version += 1;
    const result = await rpc(db, operations, 'reverse'); assert.equal(result.applied, false);
    assert.deepEqual((await state(db, 'sps_clients')).value, completion.clients);
    await db.exec('reset role'); assert.equal((await db.query('select count(*)::integer n from public.sps_stop_report_reversals')).rows[0].n, 0);
  } finally { await db.close(); }
});

sqlTest('late database failure rolls back report marker tombstone and restricted write context', async () => {
  const { db, completion } = await setup();
  try {
    const reversed = reverseWithTombstone(completion.clients, completion.completed);
    await db.exec('reset role');
    await db.exec(`create function public.fail_stop_schedule_fixture() returns trigger language plpgsql as $$ begin raise exception 'fixture_late_failure'; end $$;
      create trigger fixture_late_failure before update on public.app_state for each row when (new.key='sps_schedule') execute function public.fail_stop_schedule_fixture();`);
    await as(db, 'service_role');
    await assert.rejects(rpc(db, await ops(db, { sps_clients: reversed.clients, sps_completed: reversed.completed, sps_schedule: [] }), 'reverse'), /fixture_late_failure/);
    assert.deepEqual((await state(db, 'sps_clients')).value, completion.clients);
    assert.deepEqual((await state(db, 'sps_completed')).value, completion.completed);
    assert.equal((await db.query("select coalesce(current_setting('sps.stop_report_write',true),'') context")).rows[0].context, '');
    await db.exec('reset role'); assert.equal((await db.query('select count(*)::integer n from public.sps_stop_report_reversals')).rows[0].n, 0);
  } finally { await db.close(); }
});

sqlTest('object and double-string values preserve wire shape and inconsistent older rows do not block ordinary edits', async () => {
  for (const depth of [0, 2]) {
    const { db, completion } = await setup({ depth });
    try {
      await as(db, 'authenticated');
      await write(db, 'sps_clients', initialClients, depth);
      const raw = (await db.query("select value from public.app_state where key='sps_clients'")).rows[0].value;
      assert.equal(typeof raw, depth ? 'string' : 'object');
      if (depth === 2) assert.equal(typeof JSON.parse(raw), 'string');
      assert.deepEqual(decoded(raw)[0].history.find(h => h.completionReceiptId === rid), completion.clients[0].history[0]);
    } finally { await db.close(); }
  }
  const { db } = await setup({ activate: false });
  try {
    await write(db, 'sps_clients', initialClients);
    await db.query('select public.sps_activate_stop_report_guard()');
    await as(db, 'authenticated');
    await write(db, 'sps_clients', initialClients.map(c => ({ ...c, notes: 'Updated safely' })));
    assert.equal((await state(db, 'sps_clients')).value[0].notes, 'Updated safely');
    assert.equal((await state(db, 'sps_completed')).value[sid].receiptId, rid);
  } finally { await db.close(); }
});

sqlTest('269 clients with 19MB inline photos can preserve missing reports without quadratic whole-document concatenation', async t => {
  const { db } = await setup({ activate: false });
  try {
    const photos = 'x'.repeat(120_000);
    const large = Array.from({ length: 269 }, (_, i) => ({ id: `perf-${i}`, name: `Synthetic ${i}`, history: i < 164 ? [{ sid: `perf-stop-${i}`, completionReceiptId: `perf-receipt-${i}`, notes: 'Accepted', photos: [photos] }] : [] }));
    await write(db, 'sps_clients', large);
    await db.query('select public.sps_activate_stop_report_guard()');
    const started = performance.now();
    await write(db, 'sps_clients', large.map(c => ({ ...c, history: [], notes: 'New office note' })));
    const elapsed = performance.now() - started;
    t.diagnostic(`Synthetic 19.7MB / 269-client guarded UPDATE: ${elapsed.toFixed(0)}ms in PGlite`);
    const saved = (await state(db, 'sps_clients')).value;
    assert.equal(saved.length, 269); assert.equal(saved.filter(c => c.history.length).length, 164);
    assert.equal(saved[0].history[0].photos[0].length, 120_000);
    assert.ok(elapsed < 15_000, `Guard took ${elapsed}ms`);
  } finally { await db.close(); }
});

sqlTest('compact wire helpers replace only the top-level indexed client across whitespace Unicode and historical wire depths', async () => {
  const { db } = await setup();
  try {
    await db.exec('reset role');
    const target = { id: 9, name: 'Renée 池', history: [{ sid: 'quoted-stop', completionReceiptId: 'quoted-receipt', notes: 'Brackets ],[ and a quoted "client"', photos: [] }] };
    const values = [{ id: 'nested', embedded: target, text: 'Newline\n and tab\t' }, { id: 'middle', history: [] }, target];
    const raw = ` \n[\t${JSON.stringify(values[0])},\r\n ${JSON.stringify(values[1])},\n\t${JSON.stringify(target)} \r\n] `;
    const replacement = { ...target, name: 'Renée 更新', history: [{ ...target.history[0], notes: 'Corrected' }] };
    for (const depth of [0, 1, 2]) {
      const wire = depth === 0 ? values : depth === 1 ? raw : JSON.stringify(raw);
      const actual = (await db.query(`select public.sps_stop_client_target_wire($1::jsonb,'9','quoted-receipt') target,
        public.sps_stop_replace_client_value($1::jsonb,2,$2::jsonb,public.sps_stop_state_wire_template($1::jsonb)) replaced`,
        [JSON.stringify(wire), JSON.stringify(replacement)])).rows[0];
      assert.equal(actual.target.index, 2); assert.equal(actual.target.matches, 1); assert.equal(actual.target.receipts, 1);
      assert.deepEqual(actual.target.client, target);
      assert.deepEqual(decoded(actual.replaced), [values[0], values[1], replacement]);
      assert.equal(typeof actual.replaced, depth === 0 ? 'object' : 'string');
      if (depth === 2) assert.equal(typeof JSON.parse(actual.replaced), 'string');
    }
    await assert.rejects(db.query('select public.sps_stop_replace_client_value($1::jsonb,20,$2::jsonb,$3::jsonb)',
      [JSON.stringify(raw), JSON.stringify(replacement), JSON.stringify('[]')]), /stop_client_index_missing/);
    await assert.rejects(db.query('select public.sps_stop_state_json_text($1::jsonb)', [JSON.stringify(encoded(values, 3))]), /stop_state_encoding_invalid/);
  } finally { await db.close(); }
});
