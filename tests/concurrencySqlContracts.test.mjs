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
  assert.match(sql, /Batch check_only operations may not include a value/);
  assert.match(sql, /where state\.key = operation_key\s+for update/s);
});

test("focused batch upgrade checks unchanged fences without writing and rolls back every mutation on conflict", async () => {
  const sql = await read("APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql");

  assert.match(sql, /create or replace function public\.sps_app_state_batch_cas\(p_operations jsonb\)/);
  assert.match(sql, /Batch check_only requires an existing positive version/);
  assert.match(sql, /Batch check_only operations may not include a value/);
  assert.match(sql, /Every batch write operation requires a value/);
  assert.match(sql, /order by item ->> 'key'/);
  assert.match(
    sql,
    /begin\s+-- Every referenced row is locked[\s\S]*if coalesce\(\(operation ->> 'check_only'\)::boolean, false\) then[\s\S]*select state\.version[\s\S]*for update;[\s\S]*elsif expected_version = 0 then[\s\S]*insert into public\.app_state[\s\S]*else[\s\S]*update public\.app_state[\s\S]*end loop;\s+exception when sqlstate 'P0B01'/,
  );
  assert.match(sql, /The nested block rolls back every earlier update before returning the conflict/);
  assert.match(sql, /revoke all on function public\.sps_app_state_batch_cas\(jsonb\)[\s\S]*grant execute on function public\.sps_app_state_batch_cas\(jsonb\)\s+to authenticated, service_role/);
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
