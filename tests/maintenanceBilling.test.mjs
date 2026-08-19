import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyMaintenanceBillingStore,
  isRecurringMaintenanceStop,
  maintenanceBillingPolicyForClient,
  normalizeMaintenanceBillingPolicy,
  normalizeMaintenanceBillingStore,
  prepaidMaintenanceCoverage,
  preparePrepaidMaintenanceEntry,
  setMaintenanceBillingPolicyInStore,
} from "../maintenanceBilling.js";

const client = (overrides = {}) => ({
  id: "client-prepaid",
  planFreq: "Weekly",
  maintenanceBilling: {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-01",
    coveredThrough: "2026-08-31",
    sourceInvoiceId: "invoice-prepaid",
  },
  ...overrides,
});

test("prepaid maintenance coverage is inclusive and zeroes balance-facing invoice value", () => {
  for (const scheduledDate of ["08/01/2026", "2026-08-31"]) {
    const stop = { sid: `weekly-${scheduledDate}`, clientId: "client-prepaid", type: "Weekly Service" };
    const entry = { invoice: "$175.00", services: [{ name: "Maintenance", price: 175 }] };
    const prepared = preparePrepaidMaintenanceEntry({ client: client(), stop, entry, scheduledDate });

    assert.equal(prepared.decision.covered, true);
    assert.equal(prepared.entry.invoice, "$0");
    assert.equal(prepared.entry.quoted_price, 175);
    assert.equal(prepared.entry.billingDisposition, "prepaid-maintenance");
    assert.deepEqual(prepared.entry.maintenanceBillingSnapshot, {
      version: 1,
      mode: "prepaid",
      coveredFrom: "2026-08-01",
      coveredThrough: "2026-08-31",
      sourceInvoiceId: "invoice-prepaid",
    });
    assert.equal(entry.invoice, "$175.00", "the caller entry is not mutated");
  }
});

test("missing, malformed, reversed, and out-of-range policies fail open", () => {
  const stop = { sid: "monthly-fail-open", clientId: "client-prepaid", type: "Monthly Service" };
  const policies = [
    null,
    { mode: "prepaid", coveredFrom: "2026-08-01", coveredThrough: "2026-08-31" },
    { version: 1, mode: "prepaid", coveredFrom: "2026-02-31", coveredThrough: "2026-08-31" },
    { version: 1, mode: "prepaid", coveredFrom: "2026-09-01", coveredThrough: "2026-08-31" },
    { version: 1, mode: "standard", coveredFrom: "2026-08-01", coveredThrough: "2026-08-31" },
  ];
  for (const maintenanceBilling of policies) {
    const result = prepaidMaintenanceCoverage({
      client: client({ maintenanceBilling }),
      stop,
      entry: { invoice: "$175" },
      scheduledDate: "08/15/2026",
    });
    assert.equal(result.covered, false);
  }
  assert.equal(prepaidMaintenanceCoverage({
    client: client(), stop, entry: { invoice: "$175" }, scheduledDate: "09/01/2026",
  }).covered, false);
});

test("repairs, projects, one-off work, and estimate-linked work remain billable", () => {
  for (const stop of [
    { sid: "repair", type: "Repair Visit" },
    { sid: "project", type: "Pond Project" },
    { sid: "service-call", type: "Service Call" },
    { sid: "pump", type: "Pump issue", frequency: "Weekly" },
    { sid: "leak", type: "Leak check", frequency: "Weekly" },
    { sid: "diagnostic", type: "Diagnostic visit", frequency: "Weekly" },
    { sid: "treatment", type: "Algae treatment", frequency: "Weekly" },
    { sid: "single", type: "Weekly Service", billingMode: "one-off" },
    { sid: "estimate", type: "Weekly Service", sourceEstimateId: "estimate-1" },
  ]) {
    const candidate = { ...stop, clientId: "client-prepaid" };
    assert.equal(isRecurringMaintenanceStop(candidate, client(), {}), false, stop.sid);
    assert.equal(prepaidMaintenanceCoverage({
      client: client(), stop: candidate, entry: {}, scheduledDate: "08/15/2026",
    }).covered, false, stop.sid);
  }
});

test("legacy blank-type recurring route rows use the same maintenance classification", () => {
  const stop = { sid: "legacy-weekly", clientId: "client-prepaid", type: "" };
  assert.equal(isRecurringMaintenanceStop(stop, client(), {}), true);
  assert.equal(prepaidMaintenanceCoverage({
    client: client(), stop, entry: {}, scheduledDate: "08/15/2026",
  }).covered, true);
});

test("new prepaid policies must span complete calendar months", () => {
  const partial = {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-15",
    coveredThrough: "2026-09-14",
  };
  assert.equal(normalizeMaintenanceBillingPolicy(partial), null);
  assert.deepEqual(prepaidMaintenanceCoverage({
    client: client({ maintenanceBilling: partial }),
    stop: { sid: "partial", clientId: "client-prepaid", type: "Weekly Service" },
    entry: {},
    scheduledDate: "08/15/2026",
  }), {
    covered: false,
    blocked: true,
    reason: "coverage-must-span-whole-months",
  });

  assert.deepEqual(normalizeMaintenanceBillingPolicy({
    ...partial,
    coveredFrom: "2026-08-01",
    coveredThrough: "2026-09-30",
  }), {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-01",
    coveredThrough: "2026-09-30",
  });
});

test("an idempotent replay uses the stored coverage snapshot instead of a later client policy", () => {
  const stop = { sid: "weekly-replay", clientId: "client-prepaid", type: "Weekly Service" };
  const storedEntry = {
    invoice: "$0",
    billingDisposition: "prepaid-maintenance",
    maintenanceBillingSnapshot: {
      version: 1,
      mode: "prepaid",
      coveredFrom: "2026-08-01",
      coveredThrough: "2026-08-31",
    },
  };
  assert.equal(prepaidMaintenanceCoverage({
    client: client({ maintenanceBilling: null }),
    stop,
    entry: storedEntry,
    scheduledDate: "08/15/2026",
    policySource: "entry",
  }).covered, true);
  assert.equal(prepaidMaintenanceCoverage({
    client: client({ maintenanceBilling: null }),
    stop: { ...stop, type: "Repair Visit" },
    entry: storedEntry,
    scheduledDate: "09/15/2026",
    policySource: "entry",
  }).covered, true, "renaming or rescheduling a completed stop cannot change its stored disposition");
  assert.equal(prepaidMaintenanceCoverage({
    client: client(),
    stop,
    entry: { invoice: "$175", completionReceiptId: "old-receipt" },
    scheduledDate: "08/15/2026",
    policySource: "entry",
  }).covered, false, "a later client policy cannot retroactively suppress an old completion");
});

test("prepaid preparation snapshots the covered service date", () => {
  const prepared = preparePrepaidMaintenanceEntry({
    client: client(),
    stop: { sid: "dated", clientId: "client-prepaid", type: "Weekly Service" },
    entry: { invoice: "$175" },
    scheduledDate: "08/05/2026",
  });
  assert.equal(prepared.entry.maintenanceBillingServiceDate, "2026-08-05");
});

test("the protected maintenance billing ledger is strict and updates one client at a time", () => {
  const policy = normalizeMaintenanceBillingPolicy(client().maintenanceBilling);
  const first = setMaintenanceBillingPolicyInStore(null, "client-prepaid", policy);
  assert.deepEqual(first, {
    version: 1,
    policies: { "client-prepaid": policy },
  });
  const secondPolicy = { ...policy, coveredFrom: "2026-09-01", coveredThrough: "2026-09-30" };
  const second = setMaintenanceBillingPolicyInStore(first, "client-two", secondPolicy);
  assert.deepEqual(maintenanceBillingPolicyForClient(second, "client-prepaid"), policy);
  assert.deepEqual(maintenanceBillingPolicyForClient(second, "client-two"), secondPolicy);

  const removed = setMaintenanceBillingPolicyInStore(second, "client-prepaid", null);
  assert.equal(maintenanceBillingPolicyForClient(removed, "client-prepaid"), null);
  assert.deepEqual(maintenanceBillingPolicyForClient(removed, "client-two"), secondPolicy);
  assert.deepEqual(emptyMaintenanceBillingStore(), { version: 1, policies: {} });
});

test("a malformed protected ledger fails closed instead of dropping another client's policy", () => {
  assert.equal(normalizeMaintenanceBillingStore(null), null);
  assert.equal(normalizeMaintenanceBillingStore({ version: 1, policies: [] }), null);
  assert.equal(normalizeMaintenanceBillingStore({
    version: 1,
    policies: {
      good: normalizeMaintenanceBillingPolicy(client().maintenanceBilling),
      bad: { mode: "prepaid", coveredFrom: "2026-08-01", coveredThrough: "2026-08-31" },
    },
  }), null);
  assert.equal(setMaintenanceBillingPolicyInStore({ version: 1, policies: [] }, "client-prepaid", null), null);
});
