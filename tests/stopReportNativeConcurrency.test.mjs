// Opt-in integration test against the isolated local PostgreSQL diagnostic cluster.
// SPS_SQL_TEST_NATIVE_PG_PATH=/tmp/sps-stop-sql-harness/node_modules/pg/lib/index.js node --test tests/stopReportNativeConcurrency.test.mjs
// The host/port are deliberately fixed; this test cannot target a hosted database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { applyStopCompletion } from '../stopCompletion.js';

const runtime = process.env.SPS_SQL_TEST_NATIVE_PG_PATH;
const pg = runtime ? (await import(pathToFileURL(runtime).href)).default : null;
const nativeTest = (name, fn) => test(name, { skip: !pg && 'Set SPS_SQL_TEST_NATIVE_PG_PATH for isolated local PostgreSQL', timeout: 30000 }, fn);
const config = { host: '127.0.0.1', port: 65439, user: 'postgres' };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const encode = value => JSON.stringify(JSON.stringify(value));
const clients = [
  { id: 'c1', name: 'Synthetic One', balance: '$25', history: [] },
  { id: 'c2', name: 'Synthetic Two', balance: '$75', history: [] },
];
const catalog = {
  locations: [{ id: 'truck', name: 'Truck' }],
  treatments: [{ id: 't1', name: 'Treatment', unit: 'oz', stockByLoc: { truck: 10 }, inventoryOz: '10' }],
  products: [], parts: [],
};

nativeTest('two real concurrent devices preserve both reports and deduct shared stock exactly once', async () => {
  const name = `sps_concurrency_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ ...config, database: 'postgres' });
  const connected = [];
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create database ${name}`); created = true;
    async function connection(applicationName) {
      const db = new pg.Client({ ...config, database: name, application_name: applicationName });
      await db.connect(); connected.push(db); return db;
    }
    const setup = await connection('sps-concurrency-setup');
    await setup.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
      end $$;
      create schema auth;
      create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      grant usage on schema auth to anon,authenticated,service_role;
      create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
      grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
    for (const path of ['APP-STATE-CONCURRENCY-MIGRATION.sql', 'APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql']) {
      await setup.query(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    }
    for (const [key, value] of Object.entries({ sps_clients: clients, sps_catalog: catalog, sps_completed: {} })) {
      await setup.query('insert into app_state(key,value) values($1,$2::jsonb)', [key, encode(value)]);
    }
    for (const migration of ['20261012213546_stop_report_authority.sql', '20261012215154_stop_report_memory_bound.sql']) {
      await setup.query(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
    }
    await setup.query("select set_config('request.jwt.claim.role','service_role',false)");
    await setup.query('select sps_activate_stop_report_guard()');
    const first = await connection('sps-concurrency-first');
    const second = await connection('sps-concurrency-second');
    for (const db of [first, second]) {
      await db.query("select set_config('request.jwt.claim.role','service_role',false)");
      await db.query('set role service_role');
      await db.query("set statement_timeout='10s'");
    }
    const snapshot = async db => Object.fromEntries((await db.query('select key,value,version from app_state')).rows
      .map(row => [row.key, { value: decode(row.value), version: Number(row.version) }]));
    const plan = (base, clientId, sid, qty) => {
      const result = applyStopCompletion({ clients: base.sps_clients.value, completed: base.sps_completed.value,
        catalog: base.sps_catalog.value, clientId, sid, receiptId: `receipt-${sid}`, idempotencyKey: `attempt-${sid}-unique`,
        completedAt: '2026-10-12T20:00:00.000Z', postBalance: false,
        entry: { sid, invoice: '$50', notes: `Report for ${sid}`, photos: [{ src: `fixture://${sid}` }],
          treatmentsUsed: [{ id: 't1', name: 'Treatment', unit: 'oz', oz: qty, locId: 'truck' }], usageLoc: 'truck' } });
      assert.equal(result.ok, true, result.code);
      return { result, clientId, sid, ops: [
        { key: 'sps_clients', expected_version: base.sps_clients.version, value: JSON.stringify(result.clients.find(c => c.id === clientId)) },
        { key: 'sps_catalog', expected_version: base.sps_catalog.version, value: JSON.stringify(result.catalog) },
        { key: 'sps_completed', expected_version: base.sps_completed.version, value: JSON.stringify(result.completed) },
      ] };
    };
    const commit = async (db, planned) => (await db.query('select * from sps_stop_completion_delta_cas($1::jsonb,$2,$3,$4,$5)',
      [JSON.stringify(planned.ops), 'complete', planned.sid, `receipt-${planned.sid}`, planned.clientId])).rows[0];
    const base = await snapshot(first);
    const firstPlan = plan(base, 'c1', 'stop-one', 3);
    const staleSecondPlan = plan(base, 'c2', 'stop-two', 4);
    await first.query('begin');
    assert.equal((await commit(first, firstPlan)).applied, true);
    const pendingSecond = commit(second, staleSecondPlan);
    // Observe a real PostgreSQL lock wait, rather than merely sequencing two stale writes.
    const pid = second.processID;
    let waited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') { waited = true; break; }
      await delay(10);
    }
    await first.query('commit');
    const conflict = await pendingSecond;
    assert.equal(waited, true, 'second connection must contend on the first transaction');
    assert.equal(conflict.applied, false);
    assert.equal(conflict.outcome, 'conflict');
    let after = await snapshot(second);
    assert.equal(after.sps_clients.value[0].history.length, 1);
    assert.equal(after.sps_clients.value[1].history.length, 0);
    assert.equal(after.sps_catalog.value.treatments[0].stockByLoc.truck, 7);
    const refreshedSecondPlan = plan(after, 'c2', 'stop-two', 4);
    assert.equal((await commit(second, refreshedSecondPlan)).applied, true);
    after = await snapshot(second);
    assert.deepEqual(after.sps_clients.value.map(c => c.history.map(h => h.completionReceiptId)), [['receipt-stop-one'], ['receipt-stop-two']]);
    assert.deepEqual(after.sps_clients.value.map(c => c.balance), ['$25', '$75']);
    assert.equal(after.sps_catalog.value.treatments[0].stockByLoc.truck, 3);
    assert.equal(after.sps_catalog.value.treatments[0].inventoryOz, '3');
    assert.deepEqual(Object.keys(after.sps_completed.value.__stopReversalReceipts).sort(), ['receipt-stop-one', 'receipt-stop-two']);
    for (const key of ['sps_clients', 'sps_catalog', 'sps_completed']) assert.equal(after[key].version, base[key].version + 2);
    // An older device can update a profile from its old whole-roster snapshot,
    // but the database must retain both server-accepted report bodies.
    const staleClients = structuredClone(clients); staleClients[0].phone = '555-fixture';
    await second.query('update app_state set value=$1::jsonb where key=$2', [encode(staleClients), 'sps_clients']);
    const protectedState = await snapshot(second);
    assert.equal(protectedState.sps_clients.value[0].phone, '555-fixture');
    assert.deepEqual(protectedState.sps_clients.value.map(c => c.history), after.sps_clients.value.map(c => c.history));
    assert.deepEqual(protectedState.sps_catalog, after.sps_catalog);
    assert.deepEqual(protectedState.sps_completed, after.sps_completed);
    // A lost response does not make the domain plan deduct another four ounces.
    const retry = plan(protectedState, 'c2', 'stop-two', 4).result;
    assert.equal(retry.alreadyCompleted, true); assert.equal(retry.sameRequest, true);
    assert.deepEqual(retry.catalog, protectedState.sps_catalog.value);
  } finally {
    await Promise.allSettled(connected.map(db => db.end()));
    if (created) await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  }
});
