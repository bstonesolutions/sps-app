import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PGlite = process.env.SPS_SQL_TEST_PGLITE_PATH
  ? (await import(pathToFileURL(process.env.SPS_SQL_TEST_PGLITE_PATH).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && "Set SPS_SQL_TEST_PGLITE_PATH to run real SQL" }, fn);
const [baseMigration, reviewMigration] = await Promise.all([
  "APP-STATE-CONCURRENCY-MIGRATION.sql",
  "supabase/migrations/20261023001232_invoice_review_targeted_resolution.sql",
].map(file => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
const before = () => ({ id: "target", qbId: "123", total: "90", notes: "SPS-only note", qbSyncStatus: "conflict" });
const after = () => ({ ...before(), total: 110, balance: 25, qbSyncStatus: "synced", qbAuthoritative: true });
const encode = (value, depth) => { while (depth--) value = JSON.stringify(value); return value; };
const decode = value => { while (typeof value === "string") value = JSON.parse(value); return value; };

async function setup({ entries = [before(), { id: "unrelated", nested: { old: true }, total: 500 }], depth = 1 } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql stable as $$select '11111111-1111-1111-1111-111111111111'::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"test@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
  await db.exec(baseMigration);
  await db.query("insert into app_state(key,value) values('sps_invoices',$1::jsonb),('sps_clients','[]')", [JSON.stringify(encode(entries, depth))]);
  await db.exec(reviewMigration);
  const role = async name => { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: name })]); await db.exec(`set role ${name}`); };
  await role("service_role");
  const state = async () => (await db.query("select value,version,updated_at from app_state where key='sps_invoices'")).rows[0];
  const patch = async (expected = before(), next = after(), id = "target") => (await db.query(
    "select * from sps_invoice_review_patch($1,$2::jsonb,$3::jsonb,$4,$5)", [id, JSON.stringify(expected), JSON.stringify(next), "actor-1", "retry-linked"],
  )).rows[0];
  return { db, role, state, patch, close: () => db.close() };
}

sqlTest("targeted invoice RPC preserves every unrelated entry and historical JSON encoding depth", async () => {
  for (const depth of [0, 1, 2]) {
    const entries = [{ id: "first", nested: { unknown: [1, 2, { futureField: true }] } }, null, "legacy primitive", 9, false, before(), { id: "last", total: 800 }];
    const f = await setup({ entries, depth });
    try {
      const original = await f.state();
      const clients = (await f.db.query("select value,version,updated_at from app_state where key='sps_clients'")).rows[0];
      const receipt = await f.patch();
      assert.equal(receipt.applied, true); assert.equal(receipt.before_version, original.version);
      assert.equal(receipt.current_version, original.version + 1); assert.deepEqual(receipt.before_invoice, before()); assert.deepEqual(receipt.invoice, after());
      const saved = await f.state(); let raw = saved.value;
      for (let i = 0; i < depth; i++) { assert.equal(typeof raw, "string"); raw = JSON.parse(raw); }
      assert.ok(Array.isArray(raw)); assert.deepEqual(raw, entries.map(row => row?.id === "target" ? after() : row));
      assert.deepEqual((await f.db.query("select value,version,updated_at from app_state where key='sps_clients'")).rows[0], clients);
      await f.db.exec("reset role");
      const audit = (await f.db.query("select * from sps_invoice_review_audit")).rows;
      assert.equal(audit.length, 1); assert.deepEqual(audit[0].before_invoice, before()); assert.deepEqual(audit[0].after_invoice, after());
    } finally { await f.close(); }
  }
});

sqlTest("unrelated concurrent invoice changes survive without a target retry", async () => {
  const f = await setup();
  try {
    const changed = decode((await f.state()).value).map(row => row.id === "unrelated" ? { ...row, notes: "Written by another device", total: 777 } : row);
    await f.db.query("update app_state set value=$1::jsonb where key='sps_invoices'", [JSON.stringify(JSON.stringify(changed))]);
    const intervening = await f.state();
    const receipt = await f.patch();
    assert.equal(receipt.applied, true); assert.equal(receipt.before_version, intervening.version);
    assert.deepEqual(decode((await f.state()).value)[1], changed[1]);
  } finally { await f.close(); }
});

sqlTest("changed removed and duplicated targets are rejected without writes or audit entries", async () => {
  for (const [entries, expected] of [[[{ ...before(), notes: "New note" }], "target_changed"], [[], "missing"], [[before(), before()], "ambiguous"]]) {
    const f = await setup({ entries });
    try {
      const prior = await f.state(); const receipt = await f.patch();
      assert.equal(receipt.applied, false); assert.equal(receipt.outcome, expected); assert.deepEqual(await f.state(), prior);
      await f.db.exec("reset role"); assert.equal((await f.db.query("select count(*)::int n from sps_invoice_review_audit")).rows[0].n, 0);
    } finally { await f.close(); }
  }
});

sqlTest("a repeated exact saved invoice returns an unchanged receipt without a version bump", async () => {
  const f = await setup();
  try {
    await f.patch(); const saved = await f.state();
    const receipt = await f.patch(after(), after());
    assert.equal(receipt.applied, false); assert.equal(receipt.outcome, "unchanged");
    assert.equal(receipt.before_version, saved.version); assert.equal(receipt.current_version, saved.version); assert.deepEqual(await f.state(), saved);
    await f.db.exec("reset role"); assert.equal((await f.db.query("select count(*)::int n from sps_invoice_review_audit")).rows[0].n, 1);
  } finally { await f.close(); }
});

sqlTest("a QuickBooks identity claimed concurrently by another invoice is rejected under the lock", async () => {
  const f = await setup({ entries: [before(), { id: "other", qbId: "456" }] });
  try {
    const saved = await f.state(); const receipt = await f.patch(before(), { ...after(), qbId: "456" });
    assert.equal(receipt.applied, false); assert.equal(receipt.outcome, "duplicate_quickbooks_id"); assert.deepEqual(await f.state(), saved);
  } finally { await f.close(); }
});

sqlTest("invoice identities cannot be changed and malformed array storage fails closed", async () => {
  const f = await setup();
  try {
    const original = await f.state();
    await assert.rejects(f.patch(before(), { ...after(), id: "other" }), /invoice_review_input_invalid/);
    assert.deepEqual(await f.state(), original);
    await f.db.query("update app_state set value='{}'::jsonb where key='sps_invoices'");
    const malformed = await f.state();
    await assert.rejects(f.patch(), /invoice_review_state_invalid/); assert.deepEqual(await f.state(), malformed);
  } finally { await f.close(); }
});

sqlTest("RPC and audit grants remain private to the narrow server path", async () => {
  const f = await setup();
  try {
    await f.db.exec("reset role");
    const grants = (await f.db.query(`select
      has_function_privilege('anon','sps_invoice_review_patch(text,jsonb,jsonb,text,text)','execute') anon,
      has_function_privilege('authenticated','sps_invoice_review_patch(text,jsonb,jsonb,text,text)','execute') authenticated,
      has_function_privilege('service_role','sps_invoice_review_patch(text,jsonb,jsonb,text,text)','execute') service,
      has_table_privilege('service_role','sps_invoice_review_audit','select') service_audit,
      has_table_privilege('authenticated','sps_invoice_review_audit','select') authenticated_audit,
      (select relrowsecurity from pg_class where oid='sps_invoice_review_audit'::regclass) rls`)).rows[0];
    assert.deepEqual(grants, { anon: false, authenticated: false, service: true, service_audit: false, authenticated_audit: false, rls: true });
    for (const role of ["anon", "authenticated"]) { await f.role(role); await assert.rejects(f.patch(), /permission denied/); }
    await f.role("service_role");
    await f.db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: "authenticated" })]);
    await assert.rejects(f.patch(), /invoice_review_service_only/);
  } finally { await f.close(); }
});
