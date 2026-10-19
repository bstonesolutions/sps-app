// Isolated PostgreSQL semantics. No production access or customer data.
// SPS_SQL_TEST_PGLITE_PATH=/tmp/sps-client-guard-sql-harness/node_modules/@electric-sql/pglite/dist/index.js node --test tests/scheduledClientIdentityGuardSql.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyStopCompletion } from '../stopCompletion.js';

const PGlite = process.env.SPS_SQL_TEST_PGLITE_PATH
  ? (await import(pathToFileURL(process.env.SPS_SQL_TEST_PGLITE_PATH).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && 'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL' }, fn);
const migrations = await Promise.all([
  'APP-STATE-CONCURRENCY-MIGRATION.sql',
  'APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql',
  'supabase/migrations/20261012213546_stop_report_authority.sql',
  'supabase/migrations/20261012215154_stop_report_memory_bound.sql',
  'supabase/migrations/20261012222135_stop_report_linear_replace.sql',
  'supabase/migrations/20261019205512_scheduled_client_identity_guard.sql',
].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
const original = () => [
  { id: 'existing', name: 'Existing client', notes: 'Original note', history: [] },
  { id: 12345, name: 'Scheduled client', address: 'Saved address', history: [] },
  { id: 'not-scheduled', name: 'Unreferenced client', history: [] },
];
const schedule = () => [{ date: '2026-10-19', stops: [{ sid: 'new-stop', clientId: 12345, name: 'Saved stop name' }] }];
function encode(value, depth = 1) { while (depth--) value = JSON.stringify(value); return value; }
function decode(value) { for (let i = 0; i < 2 && typeof value === 'string'; i++) value = JSON.parse(value); return value; }

async function setup({ clients = original(), days = schedule(), depth = 1, enabled = true, omitSchedule = false } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql stable as $$select '11111111-1111-1111-1111-111111111111'::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"fixture@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
  for (const sql of migrations.slice(0, 2)) await db.exec(sql);
  for (const [key, value] of Object.entries({ sps_clients: clients, sps_completed: {},
    sps_catalog: { treatments: [], parts: [], products: [] }, sps_invoices: [{ id: 'invoice-evidence', total: 20 }],
    ...(!omitSchedule ? { sps_schedule: days } : {}) })) {
    await db.query('insert into app_state(key,value) values($1,$2::jsonb)', [key, JSON.stringify(encode(value, depth))]);
  }
  for (const sql of migrations.slice(2)) await db.exec(sql);
  async function role(name) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.role',$1,false)", [name]);
    await db.exec(`set role ${name}`);
  }
  await role('service_role');
  if (enabled) await db.query('select sps_activate_stop_report_guard()');
  const state = async key => {
    const row = (await db.query('select key,value,version from app_state where key=$1', [key])).rows[0];
    return row ? { ...row, raw: row.value, value: decode(row.value) } : null;
  };
  const write = async (key, value, wireDepth = depth) => (await db.query(
    'update app_state set value=$2::jsonb where key=$1 returning value,version',
    [key, JSON.stringify(encode(value, wireDepth))],
  )).rows[0];
  return { db, role, state, write, close: () => db.close() };
}

sqlTest('legacy whole-roster writes retain scheduled clients with no history and leave stops and invoices unchanged', async () => {
  const f = await setup();
  try {
    const beforeSchedule = await f.state('sps_schedule'), beforeInvoices = await f.state('sps_invoices');
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await f.role(role);
      await f.write('sps_clients', [{ ...original()[0], notes: `Edited by ${role}` }]);
      const saved = (await f.state('sps_clients')).value;
      assert.equal(saved[0].notes, `Edited by ${role}`);
      assert.deepEqual(saved[1], original()[1]);
      assert.equal(saved.some(c => c.id === 'not-scheduled'), false);
      assert.deepEqual(await f.state('sps_schedule'), beforeSchedule);
      assert.deepEqual(await f.state('sps_invoices'), beforeInvoices);
    }
  } finally { await f.close(); }
});

sqlTest('normal and double-encoded schedule references use clientId and the legacy id fallback', async () => {
  for (const depth of [0, 1, 2]) {
    const days = [{ date: '2026-10-19', stops: [{ sid: 's1', clientId: '12345' }, { sid: 's2', id: 'existing' }] }];
    const f = await setup({ days, depth });
    try {
      await f.write('sps_clients', []);
      assert.deepEqual((await f.state('sps_clients')).value, original().slice(0, 2));
      let raw = (await f.state('sps_clients')).raw;
      for (let i = 0; i < depth; i++) { assert.equal(typeof raw, 'string'); raw = JSON.parse(raw); }
      assert.ok(Array.isArray(raw));
    } finally { await f.close(); }
  }
});

sqlTest('current CAS metadata refers to the guarded saved row and stale versions cannot overwrite it', async () => {
  const f = await setup();
  try {
    await f.role('authenticated');
    const before = await f.state('sps_clients');
    const cas = (await f.db.query('select * from sps_app_state_cas($1,$2,$3::jsonb)',
      ['sps_clients', before.version, JSON.stringify(encode([original()[0]]))])).rows[0];
    const saved = await f.state('sps_clients');
    assert.equal(cas.applied, true);
    assert.equal(cas.current_version, saved.version);
    assert.deepEqual(saved.value, original().slice(0, 2));
    const stale = (await f.db.query('select * from sps_app_state_cas($1,$2,$3::jsonb)',
      ['sps_clients', before.version, JSON.stringify(encode([]))])).rows[0];
    assert.equal(stale.applied, false);
    assert.deepEqual(await f.state('sps_clients'), saved);
  } finally { await f.close(); }
});

sqlTest('missing null whitespace and malformed names retain the saved nonblank name while other changes persist', async () => {
  const f = await setup();
  try {
    for (const name of [undefined, null, '', ' \t\n ', 123, {}, []]) {
      const edited = { ...original()[1], phone: '555-test', name };
      await f.write('sps_clients', [original()[0], edited]);
      const saved = (await f.state('sps_clients')).value[1];
      assert.equal(saved.name, 'Scheduled client');
      assert.equal(saved.phone, '555-test');
    }
    await f.write('sps_clients', [{ ...original()[0], name: '' }, { ...original()[1], name: 'Corrected Name' }]);
    assert.equal((await f.state('sps_clients')).value[0].name, 'Existing client');
    assert.equal((await f.state('sps_clients')).value[1].name, 'Corrected Name');
  } finally { await f.close(); }
});

sqlTest('unchanged valid profiles preserve exact serialized bytes and duplicate identities still reject', async () => {
  const f = await setup();
  try {
    const rows = original().map(c => ({ history: c.history, name: c.name, id: c.id, notes: 'New note' }));
    const bytes = JSON.stringify(rows);
    const saved = await f.write('sps_clients', rows);
    assert.equal(saved.value, bytes);
    const before = await f.state('sps_clients');
    await assert.rejects(f.write('sps_clients', [rows[0], rows[0]]), /identity_ambiguous/);
    assert.deepEqual(await f.state('sps_clients'), before);
  } finally { await f.close(); }
});

sqlTest('scheduled-client preservation and accepted-report protection remain independent', async () => {
  const accepted = { sid: 'completed-stop', completionReceiptId: 'accepted-receipt', notes: 'Saved notes', photos: [{ src: 'fixture://photo' }] };
  const clients = original(); clients[0].history = [accepted];
  const f = await setup({ clients });
  try {
    await f.write('sps_clients', []);
    const saved = (await f.state('sps_clients')).value;
    assert.deepEqual(saved, clients.slice(0, 2));
    await f.write('sps_clients', [{ ...saved[0], history: [], name: '' }]);
    assert.deepEqual((await f.state('sps_clients')).value, clients.slice(0, 2));
  } finally { await f.close(); }
});

sqlTest('the guard never invents a missing client from stop labels or tries to repair unrelated stored orphans', async () => {
  const f = await setup({ clients: [original()[0]], days: schedule() });
  try {
    await f.write('sps_clients', [{ ...original()[0], notes: 'Changed' }]);
    const saved = (await f.state('sps_clients')).value;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'existing');
  } finally { await f.close(); }
});

sqlTest('a saved schedule removal permits existing unreferenced deletion behavior without a reverse lock order', async () => {
  const f = await setup();
  try {
    await f.write('sps_schedule', []);
    await f.write('sps_clients', [original()[0]]);
    assert.deepEqual((await f.state('sps_clients')).value, [original()[0]]);
  } finally { await f.close(); }
});

sqlTest('a stale roster after a committed schedule addition preserves the referenced original client', async () => {
  const f = await setup({ days: [] });
  try {
    const before = await f.state('sps_clients');
    await f.write('sps_schedule', schedule());
    const result = (await f.db.query('select * from sps_app_state_cas($1,$2,$3::jsonb)',
      ['sps_clients', before.version, JSON.stringify(encode([original()[0]]))])).rows[0];
    assert.equal(result.applied, true);
    assert.deepEqual((await f.state('sps_clients')).value, original().slice(0, 2));
  } finally { await f.close(); }
});

sqlTest('missing schedule keeps legacy deletion behavior and malformed schedule cannot silently erase omitted clients', async () => {
  const absent = await setup({ omitSchedule: true });
  try {
    await absent.write('sps_clients', [original()[0]]);
    assert.deepEqual((await absent.state('sps_clients')).value, [original()[0]]);
  } finally { await absent.close(); }
  const invalid = await setup({ days: {} });
  try {
    const before = await invalid.state('sps_clients');
    await assert.rejects(invalid.write('sps_clients', []), /client_reference_schedule_invalid/);
    assert.deepEqual(await invalid.state('sps_clients'), before);
  } finally { await invalid.close(); }
});

sqlTest('restricted stop completion keeps its compact validated path and cannot change the client name', async () => {
  const f = await setup();
  try {
    const before = await f.state('sps_clients'), completed = await f.state('sps_completed'), catalog = await f.state('sps_catalog');
    const planned = applyStopCompletion({ clients: before.value, completed: completed.value, catalog: catalog.value,
      clientId: 12345, sid: 'new-stop', receiptId: 'receipt-new-stop', idempotencyKey: 'attempt-new-stop',
      completedAt: '2026-10-19T12:00:00.000Z', postBalance: false,
      entry: { sid: 'new-stop', notes: 'Completed visit', invoice: '$0', photos: [{ src: 'fixture://photo' }] } });
    assert.equal(planned.ok, true, planned.code);
    const target = planned.clients.find(c => c.id === 12345);
    const operations = [
      { key: 'sps_clients', expected_version: before.version, value: encode(target) },
      { key: 'sps_completed', expected_version: completed.version, value: encode(planned.completed) },
      { key: 'sps_catalog', expected_version: catalog.version, value: encode(planned.catalog) },
    ];
    const commit = async ops => (await f.db.query('select * from sps_stop_completion_delta_cas($1::jsonb,$2,$3,$4,$5)',
      [JSON.stringify(ops), 'complete', 'new-stop', 'receipt-new-stop', '12345'])).rows[0];
    await assert.rejects(commit(operations.map(op => op.key === 'sps_clients' ? { ...op, value: encode({ ...target, name: '' }) } : op)), /changed_unrelated_client_data/);
    assert.equal((await commit(operations)).applied, true);
    const saved = (await f.state('sps_clients')).value;
    assert.deepEqual(saved, planned.clients);
    assert.equal(saved[1].name, 'Scheduled client');
    assert.deepEqual(saved[0], original()[0]);
  } finally { await f.close(); }
});

sqlTest('installation retains the existing activation switch and private function permissions', async () => {
  const f = await setup({ enabled: false });
  try {
    await f.write('sps_clients', []);
    assert.deepEqual((await f.state('sps_clients')).value, []);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.role(role);
      await assert.rejects(f.db.query("select * from sps_stop_guard_client_items('[]'::jsonb,'[]'::jsonb,'{}'::jsonb)"), /permission denied/);
    }
  } finally { await f.close(); }
});
