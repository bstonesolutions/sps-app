import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261005183601_billing_reviews_server_only.sql", import.meta.url), "utf8");
const endpoint = readFileSync(new URL("../api/billing-review.js", import.meta.url), "utf8");
const create = readFileSync(new URL("../api/quickbooks/create-invoice.js", import.meta.url), "utf8");

test("review privacy migration excludes the key before owner/staff exceptions", () => {
  assert.match(migration, /p_key <> 'sps_billing_reviews'\s+and public\.sps_rls_is_staff\(\)/);
  assert.match(migration, /'sps_maintenance_billing'/);
  assert.match(migration, /security definer\s+set search_path = pg_catalog\s+set row_security = off/);
  assert.match(migration, /as restrictive for select to authenticated\s+using \(key <> 'sps_billing_reviews'\)/);
  assert.doesNotMatch(migration, /create or replace function public\.sps_app_state_(?:batch_)?cas/);
});

test("billing review accounting and edits are owner-only with no client delivery route", () => {
  assert.match(endpoint, /authorize: requireOwner/);
  assert.match(endpoint, /if \(!await deps\.authorize\(req, res, "billing reviews"\)\) return/);
  assert.doesNotMatch(endpoint, /send-invoice|send-sms|send-notification|sendEstimate|sendSms/);
  assert.match(create, /req\[BILLING_REVIEW_CREATE_CONTEXT\]/);
  assert.doesNotMatch(create, /req\.body\.?(?:billingReviewContext|trustedCanonicalInvoice)/);
});
