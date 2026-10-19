// Compact client creation runs against isolated PostgreSQL semantics only.
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
  'supabase/migrations/20261019205940_compact_client_create.sql',
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

const newId = 'client-11111111-2222-4333-8444-555555555555';
const profile = (overrides = {}) => ({ id: newId, name: 'New client', address: 'Saved address', ...overrides });
const canonical = (value) => ({ ...value, name: value.name.trim(), status: value.status || 'Active', history: [], equipment: [], balance: '$0.00' });
const create = async (f, value = profile(), allowBilling = false, requestId = value.id) =>
  (await f.db.query('select * from sps_client_create($1,$2::jsonb,$3)', [requestId, JSON.stringify(value), allowBilling])).rows[0];

sqlTest('compact creation appends one canonical profile with exact versions and no schedule or accounting changes', async () => {
  const f = await setup();
  try {
    const before = await f.state('sps_clients');
    const untouched = await Promise.all(['sps_schedule', 'sps_completed', 'sps_invoices'].map(f.state));
    const requested = profile({ name: '  New client  ', serviceLeaf: true, leafType: 'Fall cleanups', plans: { Leaf: 'Essential' }, planRates: { Leaf: '' }, monthlyRate: 0, autoInvoice: 'Off' });
    const saved = await create(f, requested);
    assert.equal(saved.applied, true); assert.equal(saved.replayed, false); assert.equal(saved.client_projection, false);
    assert.equal(saved.outcome, 'created'); assert.equal(saved.request_id, newId);
    assert.equal(saved.before_version, before.version); assert.equal(saved.current_version, before.version + 1);
    assert.deepEqual(saved.client, canonical(requested));
    assert.deepEqual((await f.state('sps_clients')).value, [...before.value, saved.client]);
    assert.deepEqual(await Promise.all(['sps_schedule', 'sps_completed', 'sps_invoices'].map(f.state)), untouched);
    await f.db.exec('reset role');
    const receipt = (await f.db.query('select * from sps_client_creation_registry')).rows[0];
    assert.deepEqual(receipt.requested_client, saved.client);
    assert.deepEqual(receipt.created_client, saved.client);
    assert.equal(receipt.created_version, saved.current_version);
  } finally { await f.close(); }
});

sqlTest('lost-response replay returns current compact profile without creating again or overwriting later edits or photos', async () => {
  const f = await setup();
  try {
    const initial = await create(f);
    const laterClients = (await f.state('sps_clients')).value.map(c => c.id === newId ? {
      ...c, name: 'Corrected client name', phone: '555-later', balance: '$100',
      history: [{ sid: 'legacy-report', notes: 'Later work', photos: [{ src: 'data:image/jpeg;base64,' + 'A'.repeat(50000) }] }],
      equipment: [{ name: 'Later equipment' }],
    } : c);
    await f.write('sps_clients', laterClients);
    const beforeReplay = await f.state('sps_clients');
    const replayed = await create(f, canonical(profile()));
    assert.equal(replayed.applied, false); assert.equal(replayed.replayed, true); assert.equal(replayed.client_projection, true);
    assert.equal(replayed.outcome, 'replayed'); assert.equal(replayed.before_version, beforeReplay.version);
    assert.equal(replayed.current_version, beforeReplay.version);
    assert.equal(replayed.client.name, 'Corrected client name'); assert.equal(replayed.client.phone, '555-later');
    assert.equal(Object.hasOwn(replayed.client, 'history'), false);
    assert.equal(Object.hasOwn(replayed.client, 'equipment'), false);
    assert.equal(Object.hasOwn(replayed.client, 'balance'), false);
    assert.ok(JSON.stringify(replayed).length < 1000);
    assert.deepEqual(await f.state('sps_clients'), beforeReplay);
    await f.db.exec('reset role');
    const rows = (await f.db.query('select * from sps_client_creation_registry')).rows;
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].created_client, initial.client);
  } finally { await f.close(); }
});

sqlTest('changed retry cannot reuse the original creation identity', async () => {
  const f = await setup();
  try {
    await create(f);
    const before = await f.state('sps_clients');
    await assert.rejects(create(f, profile({ phone: 'changed request' })), /client_create_request_mismatch/);
    await assert.rejects(create(f, profile({ name: 'Changed request' })), /client_create_request_mismatch/);
    assert.deepEqual(await f.state('sps_clients'), before);
  } finally { await f.close(); }
});

sqlTest('registered identities survive legacy snapshot omissions before the first scheduled stop', async () => {
  const f = await setup({ days: [] });
  try {
    const saved = await create(f);
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await f.role(role);
      await f.write('sps_clients', original().map(c => ({ ...c, notes: `Other work by ${role}` })));
      const roster = (await f.state('sps_clients')).value;
      assert.deepEqual(roster.find(c => c.id === newId), saved.client);
      assert.equal(roster.find(c => c.id === 'existing').notes, `Other work by ${role}`);
    }
    assert.deepEqual((await f.state('sps_schedule')).value, []);
  } finally { await f.close(); }
});

sqlTest('all historical JSON wire depths survive compact appends and an empty roster remains valid', async () => {
  for (const depth of [0, 1, 2]) {
    const f = await setup({ clients: [], days: [], depth });
    try {
      const saved = await create(f);
      const state = await f.state('sps_clients');
      assert.deepEqual(state.value, [saved.client]);
      let raw = state.raw;
      for (let i = 0; i < depth; i++) { assert.equal(typeof raw, 'string'); raw = JSON.parse(raw); }
      assert.ok(Array.isArray(raw));
    } finally { await f.close(); }
  }
});

sqlTest('historical JSON text with trailing newlines remains a valid roster after append', async () => {
  const f = await setup();
  try {
    const pretty = JSON.stringify(original(), null, 2) + '\n\t  ';
    await f.db.query("update app_state set value=$1::jsonb where key='sps_clients'", [JSON.stringify(pretty)]);
    const saved = await create(f);
    assert.deepEqual((await f.state('sps_clients')).value, [...original(), saved.client]);
  } finally { await f.close(); }
});

sqlTest('unregistered existing IDs reject and a registry replay with a missing saved record does not fabricate a replacement', async () => {
  const existing = await setup({ clients: [canonical(profile())] });
  try { await assert.rejects(create(existing), /client_create_identity_exists/); }
  finally { await existing.close(); }
  const f = await setup();
  try {
    await create(f);
    await f.db.exec('reset role');
    await f.db.exec('alter table app_state disable trigger sps_guard_accepted_stop_reports');
    await f.write('sps_clients', original());
    await f.db.exec('alter table app_state enable trigger sps_guard_accepted_stop_reports');
    await f.role('service_role');
    const before = await f.state('sps_clients');
    await assert.rejects(create(f), /client_create_saved_client_missing/);
    assert.deepEqual(await f.state('sps_clients'), before);
  } finally { await f.close(); }
});

sqlTest('SQL independently rejects arbitrary history accounting links prepaid policy and nonzero balance', async () => {
  const f = await setup();
  try {
    const before = await f.state('sps_clients');
    for (const extra of [
      { history: [{ sid: 'forged', completionReceiptId: 'forged' }] }, { equipment: [{ name: 'forged' }] },
      { balance: '$1.00' }, { maintenanceBilling: { mode: 'prepaid' } }, { quickbooksCustomerId: '123' },
      { completionReceiptId: 'forged' }, { documents: [] }, { unknown: true },
    ]) await assert.rejects(create(f, profile(extra), true), /client_create_protected_field/);
    assert.deepEqual(await f.state('sps_clients'), before);
    await f.db.exec('reset role');
    assert.equal((await f.db.query('select count(*)::int n from sps_client_creation_registry')).rows[0].n, 0);
  } finally { await f.close(); }
});

sqlTest('finance capability is explicit and zero profile defaults do not require billing permission', async () => {
  const f = await setup();
  try {
    for (const extra of [{ monthlyRate: '25' }, { planRates: { Pond: 20 } }, { autoInvoice: 'Monthly' }, { autoInvoice: 'Weekly' }]) {
      await assert.rejects(create(f, profile(extra)), /client_create_billing_forbidden/);
    }
    const saved = await create(f, profile({ monthlyRate: '1.', planRates: { Pond: '.5', Pool: 0 }, autoInvoice: 'Bi-Weekly' }), true);
    assert.equal(saved.client.monthlyRate, '1.'); assert.equal(saved.client.planRates.Pond, '.5');
    const replay = await create(f, profile({ monthlyRate: '1.', planRates: { Pond: '.5', Pool: 0 }, autoInvoice: 'Bi-Weekly' }), true);
    assert.equal(replay.client.autoInvoice, 'Bi-Weekly');
  } finally { await f.close(); }
});

sqlTest('profile bounds and type validation fail before changing shared state', async () => {
  const f = await setup();
  try {
    const before = await f.state('sps_clients');
    for (const requested of [profile({ name: ' '.repeat(201) }), profile({ name: '\t\n' }),
      profile({ notes: 'x'.repeat(2001) }), profile({ servicePond: 'yes' }), profile({ monthlyRate: -1 }),
      profile({ planRates: { Pond: 'Infinity' } }), profile({ monthlyRate: '1e3' }),
      profile({ planRates: { Pond: '1'.repeat(161) } }), profile({ plans: { constructor: 'Bad' } }),
      profile({ plans: { Pond: 5 } }), profile({ autoInvoice: 'On' }), profile({ history: null }),
      profile({ equipment: {} }), profile({ id: 'old-timestamp' }), profile({ name: null }),
    ]) await assert.rejects(create(f, requested, true), /client_create_/);
    await assert.rejects(create(f, profile(), true, 'client-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), /client_create_identity_invalid/);
    assert.deepEqual(await f.state('sps_clients'), before);
  } finally { await f.close(); }
});

sqlTest('the normal report guard runs during creation even when a privileged caller has a stale bypass context', async () => {
  const report = { sid: 'saved-stop', completionReceiptId: 'saved-receipt', notes: 'Accepted report', photos: [{ src: 'fixture://saved' }] };
  const clients = original(); clients[0].history = [report];
  const f = await setup({ clients });
  try {
    await f.db.query("select set_config('sps.stop_report_write',$1,false)", [JSON.stringify({ mode: 'complete', clientsValidated: true })]);
    await f.db.exec('reset role');
    await f.db.exec(`create function assert_creation_guard() returns trigger language plpgsql as $$begin
      if current_setting('sps.stop_report_write',true)<>'' then raise exception 'creation_bypassed_guard'; end if;
      return new;end$$;
      create trigger zz_assert_creation_guard before update on app_state for each row when (new.key='sps_clients') execute function assert_creation_guard();`);
    await f.role('service_role');
    const created = await create(f);
    assert.equal(created.applied, true);
    assert.deepEqual((await f.state('sps_clients')).value[0].history, [report]);
  } finally { await f.close(); }
});

sqlTest('receipt insertion failure rolls back the appended client and version atomically', async () => {
  const f = await setup();
  try {
    const before = await f.state('sps_clients');
    await f.db.exec('reset role');
    await f.db.exec(`create function reject_creation_receipt() returns trigger language plpgsql as $$begin
      raise exception 'fixture_receipt_failure';end$$;
      create trigger reject_creation_receipt before insert on sps_client_creation_registry for each row execute function reject_creation_receipt();`);
    await f.role('service_role');
    await assert.rejects(create(f), /fixture_receipt_failure/);
    assert.deepEqual(await f.state('sps_clients'), before);
  } finally { await f.close(); }
});

sqlTest('only service role can execute creation and no application role can access the private registry', async () => {
  const f = await setup();
  try {
    for (const role of ['anon', 'authenticated']) {
      await f.role(role);
      await assert.rejects(create(f), /permission denied/);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.role(role);
      await assert.rejects(f.db.query('select * from sps_client_creation_registry'), /permission denied/);
      await assert.rejects(f.db.query('delete from sps_client_creation_registry'), /permission denied/);
    }
    await f.role('service_role');
    assert.equal((await create(f)).applied, true);
    await f.db.exec('reset role');
    const privileges = (await f.db.query(`select relrowsecurity as rls from pg_class where oid='public.sps_client_creation_registry'::regclass`)).rows[0];
    assert.equal(privileges.rls, true);
  } finally { await f.close(); }
});

