import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

function assertDoBlocksTerminate(sql, filename) {
  const starts = [...sql.matchAll(/\bdo\s+\$([A-Za-z_][A-Za-z0-9_]*)\$/gi)];
  const blocks = [...sql.matchAll(/\bdo\s+\$([A-Za-z_][A-Za-z0-9_]*)\$([\s\S]*?)\$\1\$;/gi)];
  assert.equal(blocks.length, starts.length, `${filename} has an unterminated DO block`);
  for (const block of blocks) {
    assert.match(block[2].trim(), /end\s*;$/i, `${filename} DO $${block[1]}$ must end with END;`);
  }
}

test("every deployment SQL DO block has a PL/pgSQL END semicolon", async () => {
  for (const filename of [
    "APP-STATE-CONCURRENCY-MIGRATION.sql",
    "APP-STATE-CONCURRENCY-ENFORCE.sql",
    "SECURITY-RLS-MIGRATION.sql",
    "MEDIA-STORAGE-SECURITY-MIGRATION.sql",
  ]) {
    assertDoBlocksTerminate(await read(filename), filename);
  }
});

test("security migration protects full and legacy backup tables as owner-only", async () => {
  const sql = await read("SECURITY-RLS-MIGRATION.sql");

  assert.match(sql, /create table if not exists public\.app_state_backups/i);
  assert.match(sql, /create table if not exists public\.sps_backups/i);
  assert.match(sql, /alter table public\.app_state_backups enable row level security/i);
  assert.match(sql, /alter table public\.sps_backups enable row level security/i);
  assert.match(sql, /app_state_backups[\s\S]*sps_backups[\s\S]*\$policy_cleanup\$/i);
  assert.match(sql, /revoke all on table public\.app_state_backups from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.sps_backups from public, anon, authenticated/i);
  assert.match(sql, /create policy "app_state_backups owner read"[\s\S]*sps_rls_is_owner\(\)/i);
  assert.match(sql, /create policy "sps_backups owner read"[\s\S]*sps_rls_is_owner\(\)/i);
  assert.match(sql, /app_state_backups', 'sps_backups'[\s\S]*RLS lockdown incomplete/i);
  assert.match(sql, /Backup lockdown incomplete: expected eight owner-only policies/i);
});

test("same-project lead intake is anonymous insert-only and service managed", async () => {
  const sql = await read("SECURITY-RLS-MIGRATION.sql");

  assert.match(sql, /to_regclass\('public\.leads'\) is not null/i);
  assert.match(sql, /revoke all on table public\.leads from public, anon, authenticated/i);
  assert.match(sql, /grant insert on table public\.leads to anon/i);
  assert.match(sql, /grant all on table public\.leads to service_role/i);
  assert.match(sql, /create policy "leads anonymous intake"[\s\S]*for insert to anon with check \(true\)/i);
  assert.match(sql, /anonymous privileges are not INSERT-only/i);
  assert.doesNotMatch(sql, /grant\s+select[^;]*public\.leads\s+to\s+anon/i);
});

test("phase-zero concurrency migration installs CAS without changing table access", async () => {
  const sql = await read("APP-STATE-CONCURRENCY-MIGRATION.sql");
  const executable = sql.replace(/--.*$/gm, "");

  assert.match(sql, /standalone phase-zero migration/i);
  assert.match(sql, /create or replace function public\.sps_rls_is_staff\(\)/i);
  assert.match(sql, /create or replace function public\.sps_rls_is_owner\(\)/i);
  assert.match(sql, /create or replace function public\.sps_app_state_cas/i);
  assert.doesNotMatch(executable, /\bcreate policy\b/i);
  assert.doesNotMatch(executable, /\bdrop policy\b/i);
  assert.doesNotMatch(executable, /\brevoke\s+(?:insert|update|delete|all)[\s\S]{0,120}\bon table public\.app_state\b/i);
  assert.doesNotMatch(executable, /\bgrant\s+(?:insert|update|delete|all)[\s\S]{0,120}\bon table public\.app_state\b/i);
});
