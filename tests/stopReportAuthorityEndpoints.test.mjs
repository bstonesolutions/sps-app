// Actual endpoint payloads execute the real migration inside isolated PostgreSQL, without network.
// SPS_SQL_TEST_PGLITE_PATH=/tmp/sps-stop-sql-harness/node_modules/@electric-sql/pglite/dist/index.js node --test tests/stopReportAuthorityEndpoints.test.mjs
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { applyStopCompletion } from "../stopCompletion.js";
import { stableReportJSON } from "../stopReport.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
const { default: complete } = await import("../api/stop-completion.js");
const { default: edit } = await import("../api/stop-report.js");
const runtime = process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite = runtime ? (await import(pathToFileURL(runtime).href)).PGlite : null;
const sqlTest = (name, fn) => test(name, { skip: !PGlite && "Set SPS_SQL_TEST_PGLITE_PATH to run real SQL" }, fn);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, ok = true, status = 200) => ({ ok, status, async json() { return body; }, async text() { return JSON.stringify(body); } });
const hash = entry => createHash("sha256").update(stableReportJSON(entry)).digest("hex");
const catalog = { locations: [], treatments: [], parts: [], products: [] };
const initial = [{ id: "c1", name: "Synthetic Client", phone: "111", history: [] }];

async function setup({ missingReport = false } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"fixture@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb $$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table public.app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on public.app_state to anon,authenticated,service_role;`);
  await db.exec(await readFile(new URL("../APP-STATE-CONCURRENCY-MIGRATION.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql", import.meta.url), "utf8"));
  const saved = applyStopCompletion({ clients: initial, completed: {}, catalog, clientId: "c1", sid: "s1", receiptId: "receipt-missing", idempotencyKey: "missing-report-key", completedAt: "2026-10-12T10:00:00.000Z", entry: { invoice: "$0", notes: "Original" }, postBalance: false });
  for (const [key, value] of Object.entries({
    sps_clients: initial, sps_completed: missingReport ? saved.completed : {}, sps_catalog: catalog,
    sps_schedule: [{ date: "10/12/2026", stops: [{ sid: "s1", clientId: "c1", type: "Pond cleaning" }] }],
    sps_invoices: [], sps_invoicing: {},
  })) await db.query("insert into public.app_state(key,value) values($1,$2::jsonb)", [key, JSON.stringify(JSON.stringify(value))]);
  await db.exec(await readFile(new URL("../supabase/migrations/20261012213546_stop_report_authority.sql", import.meta.url), "utf8"));
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  await db.exec("set role service_role");
  await db.query("select public.sps_activate_stop_report_guard()");
  const rpcErrors = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "owner", email: "owner@example.invalid" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ id: "owner", email: "owner@example.invalid", role: "owner" }]) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const names = href.match(/key=in\.\(([^)]*)\)/)?.[1].split(",").map(decodeURIComponent);
      assert.ok(names);
      return response((await db.query("select key,value,version,updated_at from public.app_state where key=any($1::text[])", [names])).rows);
    }
    assert.match(href, /\/rpc\/sps_stop_completion_batch_cas$/);
    const body = JSON.parse(options.body);
    try {
      return response((await db.query("select * from public.sps_stop_completion_batch_cas($1::jsonb,$2,$3,$4)", [JSON.stringify(body.p_operations), body.p_mode, body.p_sid, body.p_receipt_id])).rows);
    } catch (error) {
      rpcErrors.push(error.message);
      return response({ message: error.message }, false, 500);
    }
  };
  const state = async key => {
    const row = (await db.query("select value,version from public.app_state where key=$1", [key])).rows[0];
    return row ? { ...row, value: typeof row.value === "string" ? JSON.parse(row.value) : row.value } : null;
  };
  const invoke = async (route, body) => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
    await route({ method: "POST", headers: { authorization: "Bearer fixture-token" }, body }, res);
    return res;
  };
  return { db, state, invoke, rpcErrors };
}

sqlTest("actual completion edit reverse and retry APIs preserve reports through PostgreSQL authority", async () => {
  const f = await setup();
  try {
    const body = { mode: "complete", clientId: "c1", sid: "s1", idempotencyKey: "actual-api-attempt", entry: { invoice: "$20", notes: "Accepted notes", photos: [{ src: "fixture://photo" }] } };
    const saved = await f.invoke(complete, body);
    assert.equal(saved.statusCode, 200, JSON.stringify({ body: saved.body, errors: f.rpcErrors }));
    let clients = await f.state("sps_clients");
    const entry = clients.value[0].history[0];
    const editBody = { clientId: "c1", sid: "s1", receiptId: saved.body.receiptId, expectedHash: hash(entry), changes: { notes: "Corrected notes" } };
    const corrected = await f.invoke(edit, editBody);
    assert.equal(corrected.statusCode, 200, JSON.stringify({ body: corrected.body, errors: f.rpcErrors }));
    assert.equal((await f.invoke(edit, editBody)).body.alreadyApplied, true);
    // A stale whole-snapshot writer can update the phone but cannot discard the report.
    await f.db.query("update public.app_state set value=$1::jsonb where key='sps_clients'", [JSON.stringify(JSON.stringify([{ ...initial[0], phone: "222" }]))]);
    clients = await f.state("sps_clients");
    assert.equal(clients.value[0].phone, "222");
    assert.equal(clients.value[0].history[0].notes, "Corrected notes");
    const retry = await f.invoke(complete, body);
    assert.equal(retry.statusCode, 200); assert.equal(retry.body.receiptId, saved.body.receiptId);
    const reopened = await f.invoke(complete, { mode: "reverse", clientId: "c1", sid: "s1" });
    assert.equal(reopened.statusCode, 200, JSON.stringify({ body: reopened.body, errors: f.rpcErrors }));
    assert.equal((await f.state("sps_clients")).value[0].history.length, 0);
    assert.equal((await f.invoke(complete, body)).body.code, "completion-reversed");
    const fresh = await f.invoke(complete, { ...body, idempotencyKey: "actual-api-fresh-attempt" });
    assert.equal(fresh.statusCode, 200, JSON.stringify({ body: fresh.body, errors: f.rpcErrors }));
    assert.notEqual(fresh.body.receiptId, saved.body.receiptId);
    assert.deepEqual(f.rpcErrors, []);
  } finally { await f.db.close(); }
});

sqlTest("actual missing-report repair API and restricted SQL agree on the recovery contract", async () => {
  const f = await setup({ missingReport: true });
  try {
    const body = { clientId: "c1", sid: "s1", receiptId: "receipt-missing", expectedHash: null, changes: { notes: "Recovered visit notes", photos: [{ src: "fixture://recovered" }], date: "10/12/2026" } };
    const repaired = await f.invoke(edit, body);
    assert.equal(repaired.statusCode, 200, JSON.stringify({ body: repaired.body, errors: f.rpcErrors }));
    assert.equal(repaired.body.entry.recoveredFromSchedule, true);
    assert.equal((await f.state("sps_clients")).value[0].history[0].notes, "Recovered visit notes");
    assert.equal((await f.invoke(edit, body)).body.alreadyApplied, true);
    assert.deepEqual(f.rpcErrors, []);
  } finally { await f.db.close(); }
});
