import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("additive SQL exposes the browser CAS contracts and database-owned versions", async () => {
  const sql = await read("APP-STATE-CONCURRENCY-MIGRATION.sql");

  assert.match(sql, /create or replace function public\.sps_app_state_cas\s*\(\s*p_key text,\s*p_expected_version bigint,\s*p_value jsonb/s);
  assert.match(sql, /create or replace function public\.sps_app_state_delete_cas\s*\(\s*p_key text,\s*p_expected_version bigint/s);
  assert.match(sql, /create or replace function public\.sps_app_state_batch_cas\s*\(p_operations jsonb\)/);
  assert.match(sql, /current_versions jsonb/);
  assert.match(sql, /new\.version := old\.version \+ 1/);
  assert.match(sql, /before insert or update on public\.app_state/);
  assert.match(sql, /grant execute on function public\.sps_app_state_batch_cas\(jsonb\)\s+to authenticated, service_role/s);
});

test("enforcement closes direct authenticated writes only after all CAS RPCs exist", async () => {
  const sql = await read("APP-STATE-CONCURRENCY-ENFORCE.sql");

  assert.match(sql, /sps_app_state_cas\(text,bigint,jsonb\)/);
  assert.match(sql, /sps_app_state_delete_cas\(text,bigint\)/);
  assert.match(sql, /sps_app_state_batch_cas\(jsonb\)/);
  assert.match(sql, /revoke insert, update, delete\s+on table public\.app_state\s+from authenticated/s);
});

test("main security reruns preserve an already-enforced app_state grant state", async () => {
  const sql = await read("SECURITY-RLS-MIGRATION.sql");

  assert.match(sql, /app_state_authenticated_insert/);
  assert.match(sql, /app_state_authenticated_update/);
  assert.match(sql, /app_state_authenticated_delete/);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on table public\.app_state to authenticated/);
});
