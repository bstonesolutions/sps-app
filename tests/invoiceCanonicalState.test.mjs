import test from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
const { compareAndSetCanonicalInvoices } = await import("../api/_invoice-canonical-state.js");
const invoices = [{ id: "local-1", qbId: "qb-1", total: 50, balance: 0 }];
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("canonical invoice writes use only the service RPC with separate authority and proposal candidates", async () => {
  const candidate = { ...invoices[0], total: 75, locallyEdited: true };
  let calls = 0;
  const saved = await compareAndSetCanonicalInvoices(4, invoices, {
    actorId: "owner-1", action: "quickbooks-refresh", authority: { "local-1": invoices[0] }, candidates: { "local-1": candidate },
    fetchImpl: async (url, options) => {
      calls++;
      assert.ok(url.endsWith("/rpc/sps_invoice_canonical_cas"));
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer test-service-key");
      assert.deepEqual(JSON.parse(options.body), { p_expected_version: 4, p_value: JSON.stringify(invoices),
        p_actor_id: "owner-1", p_action: "quickbooks-refresh", p_authority: { "local-1": invoices[0] }, p_candidates: { "local-1": candidate } });
      return response([{ applied: true, outcome: "applied", current_version: 5, changed_at: "now", value: JSON.stringify(invoices) }]);
    },
  });
  assert.equal(calls, 1); assert.deepEqual(saved.value, invoices); assert.equal(saved.currentVersion, 5);
});

test("unchanged canonical anchors may return the same version and decoded full ledger", async () => {
  const saved = await compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-refresh",
    fetchImpl: async () => response({ applied: true, outcome: "unchanged", current_version: 4, value: invoices }) });
  assert.equal(saved.currentVersion, 4); assert.equal(saved.outcome, "unchanged"); assert.deepEqual(saved.value, invoices);
});

test("diagnostic-only refresh uses an exact target and separate limited patch", async () => {
  const diagnostics = { "local-1": { expected: invoices[0], patch: { qbNeedsReview: true, qbSyncStatus: "missing-remote", qbMissingSince: "2026-10-22T12:00:00Z" } } };
  await compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-refresh", diagnostics,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.p_diagnostics, diagnostics);
      assert.deepEqual(body.p_authority, {});
      return response({ applied: true, outcome: "unchanged", current_version: 4, value: invoices });
    } });
});

test("conflicts return the actual winning version without pretending to return a saved ledger", async () => {
  const saved = await compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-update",
    fetchImpl: async () => response([{ applied: false, outcome: "conflict", current_version: 6 }]) });
  assert.equal(saved.applied, false); assert.equal(saved.currentVersion, 6); assert.equal(saved.value, null);
});

test("invalid scope and malformed success receipts fail without generic fallback", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({}); };
  for (const overrides of [{ actorId: "" }, { action: "generic" }, { authority: [] }]) {
    await assert.rejects(compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-refresh", fetchImpl, ...overrides }), { code: "INVOICE_CANONICAL_SCOPE_INVALID" });
  }
  assert.equal(calls, 0);
  for (const body of [{}, [{ applied: true, current_version: 5 }], [{ applied: true, current_version: 3, value: invoices }]]) {
    await assert.rejects(compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-refresh",
      fetchImpl: async () => { calls++; return response(body); } }), { code: "INVOICE_CANONICAL_RESPONSE_INVALID" });
  }
  assert.equal(calls, 3);
  await assert.rejects(compareAndSetCanonicalInvoices(4, invoices, { actorId: "owner", action: "quickbooks-refresh",
    fetchImpl: async () => response({}, 503) }), { code: "INVOICE_CANONICAL_SAVE_FAILED", status: 503 });
});

test('database timeout is identified without exposing SQL details or accepting a save', async () => {
  await assert.rejects(compareAndSetCanonicalInvoices(4, invoices, { actorId: 'owner', action: 'quickbooks-refresh',
    fetchImpl: async () => response({ code: '57014', message: 'canceling statement due to statement timeout', details: 'PRIVATE INVOICE DATA', hint: 'PRIVATE QUERY' }, 500) }), error => {
      assert.equal(error.code, 'INVOICE_CANONICAL_TIMEOUT'); assert.equal(error.databaseCode, '57014'); assert.equal(error.status, 503);
      assert.ok(!JSON.stringify(error).includes('PRIVATE')); assert.ok(!error.message.includes('PRIVATE')); return true;
    });
});

test('database rejection diagnostics preserve only safe codes and named invariant reasons', async () => {
  await assert.rejects(compareAndSetCanonicalInvoices(4, invoices, { actorId: 'owner', action: 'quickbooks-refresh',
    fetchImpl: async () => response({ code: '40001', message: 'invoice_canonical_stale_revision', details: 'PRIVATE DATA' }, 500) }), error => {
      assert.equal(error.code, 'INVOICE_CANONICAL_SAVE_FAILED'); assert.equal(error.databaseCode, '40001');
      assert.equal(error.databaseReason, 'invoice_canonical_stale_revision'); assert.ok(!JSON.stringify(error).includes('PRIVATE')); return true;
    });
});
