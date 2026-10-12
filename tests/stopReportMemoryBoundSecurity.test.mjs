// Adversarial real-SQL checks for the memory fast path; no production/network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyStopCompletion, reverseStopCompletion } from '../stopCompletion.js';

const runtime = process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite = runtime ? (await import(pathToFileURL(runtime).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && 'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL' }, fn);
const catalog = { treatments: [], products: [], parts: [] };
const encode = value => JSON.stringify(JSON.stringify(value));
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
function complete(clients, completed, { cid = 'c1', sid = 's1', rid = 'r1' } = {}) {
  const value = applyStopCompletion({ clients, completed, catalog, clientId: cid, sid,
    receiptId: rid, idempotencyKey: `request-${rid}-unique`, completedAt: '2026-10-12T20:00:00.000Z',
    entry: { sid, notes: `Report ${rid}`, photos: [{ src: `fixture://${rid}` }], invoice: '$0' }, postBalance: false });
  assert.equal(value.ok, true, value.code); return value;
}
async function role(db, name) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [name]);
  await db.exec(`set role ${name}`);
}
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table public.app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on public.app_state to anon,authenticated,service_role;`);
  for (const path of ['APP-STATE-CONCURRENCY-MIGRATION.sql', 'APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql']) {
    await db.exec(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  }
  const first = complete([{ id: 'c1', name: 'One', history: [{ sid: 'legacy', notes: 'Legacy report' }] },
    { id: 'c2', name: 'Two', history: [] }], { legacy: true });
  const seed = complete(first.clients, first.completed, { cid: 'c2', sid: 's2', rid: 'r2' });
  for (const [key, value] of Object.entries({ sps_clients: seed.clients, sps_completed: seed.completed,
    sps_catalog: catalog, sps_schedule: [] })) {
    await db.query('insert into public.app_state(key,value) values($1,$2::jsonb)', [key, encode(value)]);
  }
  for (const path of ['20261012213546_stop_report_authority.sql', '20261012215154_stop_report_memory_bound.sql', '20261012222135_stop_report_linear_replace.sql']) {
    const sql = await readFile(new URL(`../supabase/migrations/${path}`, import.meta.url), 'utf8');
    assert.ok(sql.trim(), `${path} must contain the migration`);
    await db.exec(sql);
  }
  await role(db, 'service_role');
  await db.query('select public.sps_activate_stop_report_guard()');
  const state = async key => {
    const row = (await db.query('select * from public.app_state where key=$1', [key])).rows[0];
    return { ...row, value: decode(row.value) };
  };
  const operations = async values => Promise.all(Object.entries(values).map(async ([key, value]) => ({
    key, expected_version: Number((await state(key)).version),
    ...(value === undefined ? { check_only: true } : { value: JSON.stringify(value) }),
  })));
  const rpc = async (values, mode, sid = 's1', rid = 'r1') => (await db.query(
    'select * from public.sps_stop_completion_batch_cas($1::jsonb,$2,$3,$4)',
    [JSON.stringify(await operations(values)), mode, sid, rid])).rows[0];
  const deltaRpc = async (values, mode, sid = 's1', rid = 'r1', clientId = 'c1') => (await db.query(
    'select * from public.sps_stop_completion_delta_cas($1::jsonb,$2,$3,$4,$5)',
    [JSON.stringify(await operations(values)), mode, sid, rid, clientId])).rows[0];
  return { db, seed, state, rpc, deltaRpc, operations };
}

sqlTest('installed stop-report functions expose only the explicit service-role entrypoints', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    await f.db.exec(await readFile(new URL('../supabase/migrations/20261012215738_stop_report_restore_cas.sql', import.meta.url), 'utf8'));
    const functions = (await f.db.query(`select p.proname as name,oidvectortypes(p.proargtypes) as args,
      pg_get_userbyid(p.proowner) as owner,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (left(p.proname,9)='sps_stop_'
        or p.proname in ('sps_guard_accepted_stop_reports','sps_activate_stop_report_guard','sps_restore_stop_report_cas'))
      order by p.proname,p.proargtypes`)).rows;
    // Enumerate the catalog, rather than only named helpers, so a future private helper
    // with PostgreSQL's default PUBLIC EXECUTE privilege fails this regression.
    const allowed = new Set([
      'sps_activate_stop_report_guard()',
      'sps_stop_completion_batch_cas(jsonb, text, text, text)',
      'sps_stop_completion_delta_cas(jsonb, text, text, text, text)',
      'sps_restore_stop_report_cas(text, text, bigint, bigint)',
    ]);
    assert.ok(functions.length > allowed.size, 'the catalog must include private helper functions');
    const actualEntrypoints = new Set();
    for (const row of functions) {
      const signature = `${row.name}(${row.args})`;
      assert.equal(row.owner, 'postgres', `${signature} must retain trusted ownership`);
      assert.equal(row.anon_execute, false, `${signature} must not be callable by anon or PUBLIC`);
      assert.equal(row.authenticated_execute, false, `${signature} must not be callable by authenticated or PUBLIC`);
      assert.equal(row.service_execute, allowed.has(signature), `${signature} must match the exact service-role allowlist`);
      if (row.service_execute) actualEntrypoints.add(signature);
    }
    assert.deepEqual(actualEntrypoints, allowed, 'every allowed RPC must exist with its reviewed signature');
  } finally { await f.db.close(); }
});

sqlTest('streaming client replacement preserves whitespace Unicode nested duplicates and all supported wire depths', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    const repeated = { id: 'nested', notes: 'Identical object inside another client' };
    const rows = [
      { id: 'one', notes: 'Quotes " brace } comma , bracket ] slash \\ newline\n', nested: repeated, history: [] },
      { ...repeated, id: 'nested', history: [{ completionReceiptId: 'receipt-fixture', sid: 'stop-fixture', notes: '雪 🪨 café\u2028finish' }] },
      { id: 'last', nested: repeated, history: [{ notes: '雪 🪨 café\u2028finish' }] },
    ];
    // Retain internal tabs/newlines, array separators, and leading/trailing JSON whitespace.
    const raw = ` \r\n[ \t${JSON.stringify(rows[0], null, '\t')} ,\r\n ${JSON.stringify(rows[1], null, '  ')}\t,\n${JSON.stringify(rows[2])} \r\n] \t`;
    assert.deepEqual(JSON.parse(raw), rows);
    for (const depth of [0, 1, 2]) {
      let input = raw;
      for (let i = 0; i < depth; i += 1) input = JSON.stringify(input);
      for (let index = 0; index < rows.length; index += 1) {
        const updated = { ...rows[index], notes: `Changed target ${index} 雪`, history: [{ notes: 'New "report" [safe]', completionReceiptId: 'replacement-fixture' }] };
        const result = (await f.db.query(`select
          public.sps_stop_client_target_wire($1::jsonb,$2,'receipt-fixture') as target,
          public.sps_stop_replace_client_value($1::jsonb,$3,$4::jsonb,public.sps_stop_state_wire_template($1::jsonb)) as replaced`,
        [input, rows[index].id, index, JSON.stringify(updated)])).rows[0];
        assert.equal(result.target.index, index); assert.equal(result.target.matches, 1); assert.equal(result.target.receipts, 1);
        assert.deepEqual(result.target.client, rows[index]);
        let output = result.replaced;
        for (let layer = 0; layer < depth; layer += 1) { assert.equal(typeof output, 'string'); output = JSON.parse(output); }
        assert.ok(Array.isArray(output), `wire depth ${depth} must be retained exactly`);
        const expected = structuredClone(rows); expected[index] = updated;
        assert.deepEqual(output, expected, `only top-level client ${index} at wire depth ${depth} can change`);
      }
    }
    let tooDeep = raw; for (let i = 0; i < 3; i += 1) tooDeep = JSON.stringify(tooDeep);
    await assert.rejects(f.db.query('select public.sps_stop_state_json_text($1::jsonb)', [tooDeep]), /stop_state_encoding_invalid/);
    for (const index of [-1, 3]) {
      await assert.rejects(f.db.query("select public.sps_stop_replace_client_value($1::jsonb,$2,'{}'::jsonb,$1::jsonb)", [JSON.stringify(raw), index]), /stop_client_index_missing/);
    }
    await role(f.db, 'service_role');
    await assert.rejects(f.db.query("select public.sps_stop_replace_client_value('[]'::jsonb,0,'{}'::jsonb,'[]'::jsonb)"), /permission denied/);
  } finally { await f.db.close(); }
});

sqlTest('validated completion cannot change another report client or modern receipt', async () => {
  const f = await setup();
  try {
    const next = complete(f.seed.clients, f.seed.completed, { sid: 's3', rid: 'r3' });
    for (const mutate of [
      clients => { clients[0].history.find(h => h.completionReceiptId === 'r1').notes = 'Overwrite'; },
      clients => { clients[1].history[0].photos = []; },
      clients => { clients[1].name = 'Unrelated edit'; },
      clients => { clients.splice(1, 1); },
    ]) {
      const altered = structuredClone(next.clients); mutate(altered);
      await assert.rejects(f.rpc({ sps_clients: altered, sps_completed: next.completed }, 'complete', 's3', 'r3'), /stop_/);
      assert.deepEqual((await f.state('sps_clients')).value, f.seed.clients);
    }
    assert.equal((await f.rpc({ sps_clients: next.clients, sps_completed: next.completed }, 'complete', 's3', 'r3')).applied, true);
    assert.deepEqual((await f.state('sps_clients')).value, next.clients);
  } finally { await f.db.close(); }
});

sqlTest('validated reversal cannot edit unrelated history and legacy report removal remains compatible', async () => {
  const f = await setup();
  try {
    const next = reverseStopCompletion({ ...f.seed, catalog, clientId: 'c1', sid: 's1' });
    assert.equal(next.ok, true, next.code);
    next.completed.__stopReversedRequests = { r1: { sid: 's1', clientId: 'c1', receiptId: 'r1',
      idempotencyKey: 'request-r1-unique', reversedAt: '2026-10-12T21:00:00.000Z' } };
    for (const mutate of [
      clients => { clients[0].history[0].notes = 'Overwrite legacy history'; },
      clients => { clients[1].history[0].notes = 'Overwrite other accepted report'; },
      clients => { clients[0].name = 'Unrelated profile change'; },
      clients => { clients[0].balance = '$999'; },
      clients => { clients[0].__spsCompletionBalanceReceipt = 'unrelated-owner'; },
    ]) {
      const altered = structuredClone(next.clients); mutate(altered);
      await assert.rejects(f.rpc({ sps_clients: altered, sps_completed: next.completed }, 'reverse'), /stop_/);
      assert.deepEqual((await f.state('sps_clients')).value, f.seed.clients);
    }
    assert.equal((await f.rpc({ sps_clients: next.clients, sps_completed: next.completed }, 'reverse')).applied, true);
    const legacy = reverseStopCompletion({ clients: next.clients, completed: next.completed, catalog,
      clientId: 'c1', sid: 'legacy', allowLegacy: true });
    assert.equal(legacy.ok, true, legacy.code);
    assert.equal((await f.rpc({ sps_clients: legacy.clients, sps_completed: legacy.completed }, 'reverse', 'legacy', '')).applied, true);
    assert.deepEqual((await f.state('sps_clients')).value, legacy.clients);
    assert.equal((await f.state('sps_clients')).value[1].history[0].completionReceiptId, 'r2');
  } finally { await f.db.close(); }
});

sqlTest('authenticated forged validated context is ignored and successful scoped edit leaves generic writes guarded', async () => {
  const f = await setup();
  try {
    await role(f.db, 'authenticated');
    await f.db.query("select set_config('sps.stop_report_write',$1,false)", [JSON.stringify({
      mode: 'edit', sid: 's1', receipt: 'r1', clientsValidated: true,
    })]);
    const malicious = structuredClone(f.seed.clients); malicious[0].history[0].notes = 'Forged';
    await f.db.query("update public.app_state set value=$1::jsonb where key='sps_clients'", [encode(malicious)]);
    assert.deepEqual((await f.state('sps_clients')).value, f.seed.clients);
    await f.db.query("select set_config('sps.stop_report_write','',false)");
    await role(f.db, 'service_role');
    await f.db.exec('begin');
    const changed = structuredClone(f.seed.clients); changed[0].history[0].notes = 'Reviewed correction';
    assert.equal((await f.rpc({ sps_clients: changed, sps_completed: undefined }, 'edit')).applied, true);
    assert.equal((await f.db.query("select coalesce(current_setting('sps.stop_report_write',true),'') as scope")).rows[0].scope, '');
    const stale = structuredClone(changed); stale[0].history[0].notes = 'Stale overwrite'; stale[1].history = [];
    await f.db.query('select * from public.sps_app_state_batch_cas($1::jsonb)', [JSON.stringify(await f.operations({ sps_clients: stale }))]);
    assert.deepEqual((await f.state('sps_clients')).value, changed);
    await f.db.exec('commit');
  } finally { await f.db.close(); }
});

sqlTest('failure after the validated client write rolls back it and cannot leak scope to a later generic writer', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    await f.db.exec(`create function public.reject_stop_fixture() returns trigger language plpgsql as $$begin raise exception 'injected_late_failure';end$$;
      create trigger zz_reject_stop_fixture before update on public.app_state for each row when(new.key='sps_completed') execute function public.reject_stop_fixture();`);
    await role(f.db, 'service_role');
    const next = complete(f.seed.clients, f.seed.completed, { sid: 's3', rid: 'r3' });
    await assert.rejects(f.rpc({ sps_clients: next.clients, sps_completed: next.completed }, 'complete', 's3', 'r3'), /injected_late_failure/);
    assert.deepEqual((await f.state('sps_clients')).value, f.seed.clients);
    assert.equal((await f.db.query("select coalesce(current_setting('sps.stop_report_write',true),'') as scope")).rows[0].scope, '');
    const stale = structuredClone(f.seed.clients); stale[0].history = []; stale[1].history[0].notes = 'Stale after failure';
    await f.db.query('select * from public.sps_app_state_batch_cas($1::jsonb)', [JSON.stringify(await f.operations({ sps_clients: stale }))]);
    const persisted = (await f.state('sps_clients')).value;
    assert.deepEqual(persisted[0].history.find(h => h.completionReceiptId === 'r1'), f.seed.clients[0].history[0]);
    assert.deepEqual(persisted[1].history, f.seed.clients[1].history);
  } finally { await f.db.close(); }
});

sqlTest('compact transactions reject whole-roster wrong-client and unrelated target edits while preserving all other clients', async () => {
  const f = await setup();
  try {
    const next = complete(f.seed.clients, f.seed.completed, { sid: 's3', rid: 'r3' });
    const before = await f.state('sps_clients');
    for (const target of [
      next.clients,
      { ...next.clients[0], id: 'c2' },
      { ...next.clients[0], balance: '$900' },
      { ...next.clients[0], history: next.clients[0].history.map(h => h.completionReceiptId === 'r1' ? { ...h, photos: [] } : h) },
    ]) {
      await assert.rejects(f.deltaRpc({ sps_clients: target, sps_completed: next.completed }, 'complete', 's3', 'r3'), /stop_/);
      assert.deepEqual(await f.state('sps_clients'), before);
    }
    await assert.rejects(f.deltaRpc({ sps_clients: next.clients[1], sps_completed: next.completed }, 'complete', 's3', 'r3', 'c2'), /client_mismatch/);
    const saved = await f.deltaRpc({ sps_clients: next.clients[0], sps_completed: next.completed }, 'complete', 's3', 'r3');
    assert.equal(saved.applied, true);
    assert.equal(Number(saved.current_versions.sps_clients), Number(before.version) + 1);
    assert.deepEqual((await f.state('sps_clients')).value, next.clients);
    const corrected = structuredClone(next.clients[0]); corrected.history[0].notes = 'Corrected by compact RPC';
    const wrong = structuredClone(corrected); wrong.history[1].notes = 'Unrelated old report edit';
    await assert.rejects(f.deltaRpc({ sps_clients: wrong, sps_completed: undefined }, 'edit', 's3', 'r3'), /changed_unrelated/);
    assert.equal((await f.deltaRpc({ sps_clients: corrected, sps_completed: undefined }, 'edit', 's3', 'r3')).applied, true);
    assert.deepEqual((await f.state('sps_clients')).value[1], f.seed.clients[1]);
  } finally { await f.db.close(); }
});

sqlTest('compact target index survives roster order changes and global duplicate receipts fail closed', async () => {
  const f = await setup();
  try {
    await f.db.query("update public.app_state set value=$1::jsonb where key='sps_clients'", [encode([...f.seed.clients].reverse())]);
    const corrected = structuredClone(f.seed.clients[0]); corrected.history[0].notes = 'Correct target at index one';
    assert.equal((await f.deltaRpc({ sps_clients: corrected, sps_completed: undefined }, 'edit')).applied, true);
    const saved = (await f.state('sps_clients')).value;
    assert.deepEqual(saved[0], f.seed.clients[1]);
    assert.deepEqual(saved[1], corrected);
    // Seed inconsistent legacy state directly, then re-enable the guard before calling the RPC.
    await f.db.exec('reset role');
    await f.db.query('update public.sps_stop_report_guard_config set enabled=false');
    const duplicate = structuredClone(saved); duplicate[0].history.push(structuredClone(corrected.history[0]));
    await f.db.query("update public.app_state set value=$1::jsonb where key='sps_clients'", [encode(duplicate)]);
    await f.db.query('update public.sps_stop_report_guard_config set enabled=true');
    await role(f.db, 'service_role');
    corrected.history[0].notes = 'Must not save over ambiguous receipt';
    await assert.rejects(f.deltaRpc({ sps_clients: corrected, sps_completed: undefined }, 'edit'), /existing_report_identity_invalid/);
    assert.deepEqual((await f.state('sps_clients')).value, duplicate);
  } finally { await f.db.close(); }
});

sqlTest('suppressed compact client update rolls back the already-written completion and clears mutation scope', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    await f.db.exec(`create function public.suppress_client_fixture() returns trigger language plpgsql as $$begin return null;end$$;
      create trigger zz_suppress_client_fixture before update on public.app_state for each row when(new.key='sps_clients') execute function public.suppress_client_fixture();`);
    await role(f.db, 'service_role');
    const beforeClients = await f.state('sps_clients');
    const beforeCompleted = await f.state('sps_completed');
    const next = complete(f.seed.clients, f.seed.completed, { sid: 's3', rid: 'r3' });
    await assert.rejects(f.deltaRpc({ sps_clients: next.clients[0], sps_completed: next.completed }, 'complete', 's3', 'r3'), /stop_/);
    assert.deepEqual(await f.state('sps_clients'), beforeClients);
    assert.deepEqual(await f.state('sps_completed'), beforeCompleted);
    assert.equal((await f.db.query("select coalesce(current_setting('sps.stop_report_write',true),'') as scope")).rows[0].scope, '');
  } finally { await f.db.close(); }
});
