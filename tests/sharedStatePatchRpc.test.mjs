import test from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
const { compareAndSetSharedStatePatch, compareAndSetSharedStatePatchBatch, mutateSharedStatePatch } = await import("../api/_shared-state-patch.js");
const reply = value => ({ ok: true, status: 200, json: async () => value });
const before = [{ id: "c1", name: "Before" }], after = [{ id: "c1", name: "After" }];

test("single protected CAS sends exact current and retains legacy stored representation", async () => {
  const result = await compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async (url, options) => {
    assert.equal(url, "https://supabase.test/rest/v1/rpc/sps_shared_state_patch_cas");
    assert.equal(options.headers.Authorization, "Bearer test-service");
    assert.deepEqual(JSON.parse(options.body), { p_key: "sps_clients", p_expected_version: 7, p_expected_current: before, p_proposed: JSON.stringify(after), p_actor_id: "actor" });
    return reply([{ applied: true, outcome: "updated", current_version: 8, value: JSON.stringify(after) }]);
  } });
  assert.deepEqual(result.value, after); assert.equal(result.currentVersion, 8);
});

test("a malformed successful RPC cannot be treated as a saved canonical snapshot", async () => {
  for (const response of [{ applied: true, current_version: 8 }, { applied: true, current_version: 6, value: after }, { nonsense: true }]) {
    await assert.rejects(compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async () => reply(response) }), { code: "SHARED_STATE_PATCH_RECEIPT_INVALID" });
  }
});

test("protected report and deleted-identity refusals are actionable conflicts rather than retries forever", async () => {
  for (const [message, code] of [["shared_deleted_identity_reused", "SHARED_STATE_DELETED_IDENTITY"], ["shared_state_protected_change_rejected", "SHARED_STATE_PATCH_PROTECTED_CHANGE"]]) {
    await assert.rejects(compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message }) }) }), { code, status: 409 });
  }
});

test("service transaction retains exact protected scope and the other atomic operations", async () => {
  const schedule = [{ date: "10/22/2026", stops: [{ sid: "s1", linkedBillingReviewId: "review" }] }];
  const next = [{ date: "10/22/2026", stops: [{ sid: "s1", linkedInvoiceId: "invoice" }] }];
  const operations = [{ key: "sps_schedule", expectedVersion: 2, value: next }, { key: "sps_invoices", expectedVersion: 9, value: [] }];
  const result = await compareAndSetSharedStatePatchBatch(operations, { actorId: "actor", expectedCurrent: { sps_schedule: schedule }, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith("/sps_shared_state_patch_batch_cas"));
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.p_expected_current, { sps_schedule: schedule });
    assert.deepEqual(payload.p_operations, [{ key: "sps_schedule", expected_version: 2, value: JSON.stringify(next) }, { key: "sps_invoices", expected_version: 9, value: "[]" }]);
    return reply([{ applied: true, outcome: "applied", current_versions: { sps_schedule: 3, sps_invoices: 10 }, values: { sps_schedule: JSON.stringify(next), sps_invoices: "[]" } }]);
  } });
  assert.deepEqual(result.values.sps_schedule, next);
  assert.equal(result.currentVersions.sps_invoices, 10);
});

test("batch scope cannot omit or add a protected baseline", async () => {
  const operations = [{ key: "sps_clients", expectedVersion: 7, value: after }, { key: "sps_officeAlerts", expectedVersion: 1, value: [] }];
  for (const expectedCurrent of [{}, { sps_clients: before, sps_schedule: [] }]) {
    await assert.rejects(compareAndSetSharedStatePatchBatch(operations, { actorId: "actor", expectedCurrent, fetchImpl: () => { throw new Error("must not call"); } }), { code: "SHARED_STATE_PATCH_SCOPE_INVALID" });
  }
});

test("a narrow portal mutation rechecks ownership inside updater on each CAS retry", async () => {
  let count = 0;
  const result = await mutateSharedStatePatch("sps_clients", (current) => current.map(client => ({ ...client, notifyPrefs: { onMyWay: true } })), {
    actorId: "portal-user", read: async () => ({ exists: true, version: ++count, value: [{ id: "c1", name: count === 1 ? "Before" : "Newer name" }] }),
    cas: async (_key, version, original, proposed, options) => {
      assert.equal(options.actorId, "portal-user");
      if (version === 1) return { applied: false, outcome: "conflict" };
      assert.equal(original[0].name, "Newer name");
      return { applied: true, currentVersion: 3, value: proposed };
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.value[0].name, "Newer name");
  assert.deepEqual(result.value[0].notifyPrefs, { onMyWay: true });
});
