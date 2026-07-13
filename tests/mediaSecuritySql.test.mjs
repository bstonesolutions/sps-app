import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../MEDIA-STORAGE-SECURITY-MIGRATION.sql", import.meta.url), "utf8");

test("media migration makes client-media private and guards legacy broad policies", () => {
  assert.match(sql, /insert into storage\.buckets[\s\S]*'client-media'[\s\S]*false/i);
  assert.match(sql, /on conflict \(id\) do update[\s\S]*public\s*=\s*false/i);
  assert.match(sql, /'authenticated'\s*=\s*any\s*\(roles\)/i);
  assert.match(sql, /policyname not in[\s\S]*client media staff read/i);
  assert.match(sql, /cmd\)\s+in\s+\('ALL', 'SELECT', 'DELETE'\)[\s\S]*qual[\s\S]*not ilike '%bucket_id%'/i);
  assert.match(sql, /cmd\)\s*=\s*'INSERT'[\s\S]*with_check[\s\S]*not ilike '%bucket_id%'/i);
  assert.match(sql, /raise exception 'Remove or narrow these extra client-media Storage policies/i);
});

test("media policies grant staff signed access and owner-only deletion", () => {
  assert.match(sql, /create policy "client media staff read"[\s\S]*for select[\s\S]*sps_rls_is_staff\(\)/i);
  assert.match(sql, /create policy "client media staff upload"[\s\S]*for insert[\s\S]*foldername\(name\)[\s\S]*= 'media'/i);
  assert.match(sql, /create policy "client media owner delete"[\s\S]*for delete[\s\S]*sps_rls_is_owner\(\)/i);
});

test("restrictive authenticated and anonymous boundaries prevent permissive policies from OR-opening client-media", () => {
  assert.match(sql, /create policy "client media read boundary"[\s\S]*as restrictive[\s\S]*for select[\s\S]*to authenticated[\s\S]*bucket_id <> 'client-media'[\s\S]*sps_rls_is_staff\(\)/i);
  assert.match(sql, /create policy "client media upload boundary"[\s\S]*as restrictive[\s\S]*for insert[\s\S]*to authenticated[\s\S]*foldername\(name\)[\s\S]*sps_rls_is_staff\(\)/i);
  assert.match(sql, /create policy "client media update boundary"[\s\S]*as restrictive[\s\S]*for update[\s\S]*to authenticated[\s\S]*sps_rls_is_staff\(\)/i);
  assert.match(sql, /create policy "client media delete boundary"[\s\S]*as restrictive[\s\S]*for delete[\s\S]*to authenticated[\s\S]*sps_rls_is_owner\(\)/i);
  assert.match(sql, /create policy "client media anonymous read boundary"[\s\S]*as restrictive[\s\S]*for select[\s\S]*to anon[\s\S]*bucket_id <> 'client-media'/i);
  assert.match(sql, /create policy "client media anonymous upload boundary"[\s\S]*as restrictive[\s\S]*for insert[\s\S]*to anon[\s\S]*bucket_id <> 'client-media'/i);
});
