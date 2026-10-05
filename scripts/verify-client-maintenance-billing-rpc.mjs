// Disposable, in-memory PostgreSQL verification. This script cannot target a remote database.
// Install outside the repository, then run:
// npm install --prefix /tmp/sps-prepaid-sql-check --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.5.8
// node scripts/verify-client-maintenance-billing-rpc.mjs /tmp/sps-prepaid-sql-check/node_modules/@electric-sql/pglite/dist/index.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const modulePath = process.argv[2];
if (!modulePath || !path.isAbsolute(modulePath)) throw new Error('Pass the absolute local PGlite module path.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20261005120855_client_maintenance_billing_rpc.sql', root), 'utf8');
const batch = await readFile(new URL('APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql', root), 'utf8');
const concurrency = await readFile(new URL('APP-STATE-CONCURRENCY-MIGRATION.sql', root), 'utf8');
const trigger = concurrency.match(/create or replace function public\.sps_app_state_set_version\(\)[\s\S]*?\$function\$;/)?.[0];
assert.ok(trigger, 'Use the real production version trigger.');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const decode = value => { for (let i = 0; i < 2 && typeof value === 'string'; i++) value = JSON.parse(value); return value; };
const encode = (value, depth) => { for (let i = 0; i < depth; i++) value = JSON.stringify(value); return value; };
const roster = [{ id: 'other', name: 'Keep Profile', notes: 'Retain this value', maintenanceBilling: { mode: 'prepaid', coveredFrom: '2026-01-01' } }, { id: 73, name: 'Cedar House', notes: 'keep notes', photo: 'synthetic-large-photo'.repeat(400000), plans: { Pool: 'Essential' }, monthlyRate: '250' }];
const ledger = { version: 2, policies: {}, allocations: { other: { '2026-04': { status: 'paid', allocatedCents: 25000, sources: [{ kind: 'manual', recordId: 'keep' }] } } } };
const policy = { version: 1, mode: 'prepaid', coveredFrom: '2026-04-01', coveredThrough: '2026-12-31', sourceInvoiceId: 'historical', sourceInvoiceNumber: 'INV-2025-718' };
const nextLedger = { ...ledger, policies: { '73': policy } };
const snap = async () => (await db.query('select public.sps_client_maintenance_billing_snapshot($1) as snapshot', ['73'])).rows[0].snapshot;
const cas = async (clientsVersion = 1, billingVersion = 1, p = policy, l = nextLedger) => (await db.query('select * from public.sps_client_maintenance_billing_cas($1,$2,$3,$4::jsonb,$5::jsonb)', ['73', clientsVersion, billingVersion, JSON.stringify(p), JSON.stringify(l)])).rows[0];
const rows = async () => (await db.query('select key,value,version from public.app_state order by key')).rows;
const reset = async (rosterDepth = 1, billingDepth = 1, sourceRoster = roster, sourceLedger = ledger) => {
  await db.exec('reset role; truncate public.app_state;');
  await db.query('insert into public.app_state(key,value) values ($1,$2::jsonb)', ['sps_clients', JSON.stringify(encode(sourceRoster, rosterDepth))]);
  if (sourceLedger !== null) await db.query('insert into public.app_state(key,value) values ($1,$2::jsonb)', ['sps_maintenance_billing', JSON.stringify(encode(sourceLedger, billingDepth))]);
  await db.exec("set role service_role; set request.jwt.claim.role = 'service_role';");
};
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function public.sps_rls_is_owner() returns boolean language sql stable as $$ select false $$;
    create function public.sps_rls_team_has_owner(jsonb) returns boolean language sql stable as $$ select true $$;
    create function public.sps_rls_app_state_write_allowed(text,jsonb) returns boolean language sql stable as $$ select false $$;
    create table public.app_state(key text primary key,value jsonb not null,version bigint not null default 1,updated_at timestamptz default now());
    alter table public.app_state enable row level security;
    grant all on public.app_state to service_role;
    grant usage on schema auth to service_role;
    ${trigger}
    create trigger app_state_set_version before insert or update on public.app_state for each row execute function public.sps_app_state_set_version();
  `);
  await db.exec(batch);
  await db.exec(migration);
  await db.exec(migration); // Reapplying the local migration remains safe.
  for (const depth of [0, 1, 2]) {
    await reset(depth, depth);
    const snapshot = await snap();
    check(snapshot.match_count === 1 && snapshot.client.id === 73, `depth ${depth}: exact typed client identity`);
    check(!('photo' in snapshot.client) && JSON.stringify(snapshot).length < 2000, `depth ${depth}: large roster stays inside database`);
    assert.deepEqual(snapshot.ledger, ledger); checks++;
    const receipt = await cas();
    check(receipt.applied && receipt.current_versions.sps_clients === 2 && receipt.current_versions.sps_maintenance_billing === 2, `depth ${depth}: atomic version receipt`);
    assert.deepEqual(receipt.client.maintenanceBilling, policy); checks++;
    const after = await rows();
    assert.deepEqual(decode(after[0].value), [roster[0], { ...roster[1], maintenanceBilling: policy }]); checks++;
    assert.deepEqual(decode(after[1].value), nextLedger); checks++;
    check(typeof after[0].value === (depth ? 'string' : 'object'), `depth ${depth}: original roster envelope retained`);
    if (depth === 2) check(typeof JSON.parse(after[0].value) === 'string', 'double encoded envelope retained');
    const stale = await cas();
    check(!stale.applied && stale.outcome === 'conflict' && stale.client === null, `depth ${depth}: stale snapshots rejected`);
    assert.deepEqual(await rows(), after); checks++;
    const cleared = await cas(2, 2, null, ledger);
    check(cleared.applied && !('maintenanceBilling' in cleared.client), `depth ${depth}: clearing prepaid is durable`);
    assert.deepEqual(decode((await rows())[0].value), roster); checks++;
  }
  await reset(1, 1, roster, null);
  const missing = await snap();
  check(!missing.billing_exists && missing.billing_version === 0 && missing.ledger === null, 'missing ledger is explicit');
  check((await cas(1, 0)).applied, 'missing ledger created atomically');
  check(typeof (await rows())[1].value === 'string', 'new ledger uses expected encoded envelope');

  await reset(1, 1, [roster[0]]);
  check((await snap()).match_count === 0 && (await snap()).client === null, 'unknown client has no projection');
  await assert.rejects(cas(), /client_match_count_invalid/); checks++;
  await reset(1, 1, [roster[1], { ...roster[1], id: '73' }]);
  check((await snap()).match_count === 2 && (await snap()).client === null, 'numeric/string duplicate identity rejected');
  await assert.rejects(cas(), /client_match_count_invalid/); checks++;
  await reset();
  await assert.rejects(cas(1, 1, policy, ledger), /maintenance_ledger_invalid/); checks++;
  await db.exec('reset role;');
  await db.query('update public.app_state set value=$1::jsonb where key=$2', [JSON.stringify('not JSON'), 'sps_clients']);
  await db.exec("set role service_role;");
  await assert.rejects(snap(), /shared_clients_invalid/); checks++;
  await reset();
  await db.exec('reset role;');
  await db.query('update public.app_state set value=$1::jsonb where key=$2', [JSON.stringify('not JSON'), 'sps_maintenance_billing']);
  await db.exec('set role service_role;');
  await assert.rejects(snap(), /shared_maintenance_billing_invalid/); checks++;

  await reset();
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`reset role; set role ${role};`);
    await assert.rejects(snap(), /permission denied for function sps_client_maintenance_billing_snapshot/); checks++;
    await assert.rejects(cas(), /permission denied for function sps_client_maintenance_billing_cas/); checks++;
  }
  await db.exec('reset role;');
  const permissions = await db.query("select proname,prosecdef from pg_proc where proname like 'sps_client_maintenance_billing_%'");
  check(permissions.rows.length === 2 && permissions.rows.every(row => !row.prosecdef), 'both functions SECURITY INVOKER');

  await reset();
  await db.exec(`reset role;
    create function public.test_conflicting_writer() returns trigger language plpgsql as $$ begin
      if new.key='sps_clients' and current_setting('sps.test_conflict',true)='on' then
        update public.app_state set value=value where key='sps_maintenance_billing';
      end if; return new; end; $$;
    create trigger test_conflict before update on public.app_state for each row execute function public.test_conflicting_writer();
    set role service_role; set sps.test_conflict='on';`);
  const beforeRace = await rows();
  const race = await cas();
  check(!race.applied && race.conflict_key === 'sps_maintenance_billing', 'concurrent ledger version change detected inside batch CAS');
  assert.deepEqual(await rows(), beforeRace); checks++;
  console.log(`${checks} PostgreSQL assertions passed in a disposable in-memory database. No remote database accessed.`);
} finally { await db.close(); }
