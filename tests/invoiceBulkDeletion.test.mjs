import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deleteSelectedInvoiceDrafts, invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches, partitionInvoiceBulkDeletion, unlinkUnpaidInvoiceCoverage } from "../invoiceBulkDeletion.js";
import { emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger } from "../maintenancePaymentLedger.js";
import { findInvoiceDeletionReferences, invoiceDeletionBlockedMessage, unlinkInvoiceDeletionReferences } from "../invoiceDeletionGuard.js";
import { deleteInvoiceAndCompactSafeDrafts } from "../invoiceNumbering.js";

const draft = (id = "draft-1", extra = {}) => ({ id, number: `INV-${id.slice(-1)}`, status: "Draft", clientId: "sample-client", total: 100, lineItems: [{ desc: "Service", qty: 1, unitPrice: 100 }], ...extra });
const context = () => ({ ledger: emptyMaintenancePaymentLedger() });

test("only selected drafts are included and duplicate identifiers fail closed", () => {
  const first = draft();
  const second = draft("draft-2");
  const plan = partitionInvoiceBulkDeletion([first, second, { ...second }], [first.id, second.id, "missing"], context());
  assert.deepEqual(plan.ready.map((row) => row.invoice.id), [first.id]);
  assert.deepEqual(plan.skipped.map((row) => row.code), ["ambiguous-id", "missing"]);
  assert.equal(partitionInvoiceBulkDeletion([first, second], [first.id], context()).rows.length, 1);
});

test("QuickBooks, sent, paid, shared, and partially paid records cannot be bulk deleted", () => {
  for (const evidence of [
    { status: "Paid" }, { status: "Sent" }, { status: "Void" },
    { qbId: "qb-1", qbSpsOnly: true }, { qbSyncStatus: "pending", qbSpsOnly: true },
    { qbAuthoritative: true }, { qbPushed: true }, { qbPendingRemoteInvoice: { Id: "q" } },
    { source: "quickbooks", qbSpsOnly: true }, { sentDate: "2026-09-01" },
    { exportedAt: "2026-09-01" }, { paymentLink: "https://example.test/pay" },
    { payment: { amount: 100 } }, { payments: [{ id: "payment-1" }] },
    { paidDate: "2026-09-01" }, { balance: 50 }, { amountPaid: 1 }, { partial: true },
  ]) assert.equal(invoiceBulkDeleteEligibility(draft("draft-1", evidence), context()).eligible, false, JSON.stringify(evidence));
  assert.equal(invoiceBulkDeleteEligibility(draft("draft-1", { qbSpsOnly: true, qbSyncStatus: "sps-only" }), context()).eligible, true);
});

test("prepaid policy and month allocation references protect invoice identity and number", () => {
  const invoice = draft();
  for (const ledger of [
    { version: 1, policies: { "sample-client": { version: 1, mode: "prepaid", coveredFrom: "2026-01-01", coveredThrough: "2026-12-31", sourceInvoiceId: invoice.id } } },
    { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: invoice.id }] } } } },
    { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "prepaid", sources: [{ kind: "prepaid", invoiceNumber: invoice.number }] } } } },
  ]) assert.equal(invoiceBulkDeleteEligibility(invoice, { ledger }).code, "payment-coverage");
  assert.equal(invoiceBulkDeleteEligibility(invoice, {}).code, "coverage-unavailable");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ledger: { version: 2, allocations: "broken" } }).code, "coverage-unavailable");
});

test("linked jobs remain protected while unreferenced auto-generated drafts can be removed", () => {
  const invoice = draft("draft-1", { sourceStopId: "stop-1", autoDraftKey: "stop-1:completion" });
  assert.equal(invoiceBulkDeleteEligibility(invoice, context()).eligible, true);
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...context(), schedule: [{ stops: [{ sid: "stop-1", linkedInvoiceId: invoice.id }] }] }).code, "job-linked");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...context(), estimates: [{ id: "estimate-1", linkedInvoiceId: invoice.id }] }).code, "job-linked");
});

test("reviewed unpaid sent and overdue invoices can be deleted, with explicit QuickBooks inclusion", () => {
  for (const status of ["Draft", "Sent", "Overdue"]) {
    const linked = draft("draft-1", { status, qbId: "qb-1", balance: 100, qbEmailStatus: "EmailSent", paymentLink: "https://example.test/pay" });
    const options = { ...context(), includeQuickBooks: true, reviewedInvoice: linked };
    assert.equal(invoiceBulkDeleteEligibility(linked, options).eligible, true, status);
    assert.equal(invoiceBulkDeleteEligibility(linked, { ...options, includeQuickBooks: false }).code, "quickbooks");
    assert.equal(invoiceBulkDeleteEligibility(linked, { ...options, reviewedInvoice: { ...linked, total: 99 } }).code, "review-required");
    assert.equal(invoiceBulkDeleteEligibility({ ...linked, balance: 99 }, { ...options, reviewedInvoice: { ...linked, balance: 99 } }).code, "payment");
  }
  const local = draft("local-sent", { status: "Sent", sentAt: "2026-10-01", balance: 100 });
  assert.equal(invoiceBulkDeleteEligibility(local, { ...context(), reviewedInvoice: local }).eligible, true);
});

test("job unlinking is explicit and never bypasses payment coverage or pending QuickBooks review", () => {
  const invoice = draft("draft-1", { qbId: "qb-1", balance: 100 });
  const options = { ...context(), includeQuickBooks: true, reviewedInvoice: invoice, unlinkJobs: true, estimates: [{ id: "estimate-1", linkedInvoiceId: invoice.id }] };
  assert.equal(invoiceBulkDeleteEligibility(invoice, options).eligible, true);
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, unlinkJobs: false }).code, "job-linked");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, reviewedInvoice: null }).eligible, false);
  const protectedLedger = { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: invoice.id }] } } } };
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, ledger: protectedLedger }).code, "payment-coverage");
  const pending = { ...invoice, qbCreateOutcomeUnknown: true };
  assert.equal(invoiceBulkDeleteEligibility(pending, { ...options, reviewedInvoice: pending }).code, "quickbooks-review");
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, number: "CHANGED" }), false, "QB document numbers do not get draft-renumbering exemptions");
});

test("mixed reviewed deletion passes exact options and keeps a failed QuickBooks invoice selected", async () => {
  const local = draft();
  const linked = draft("draft-2", { status: "Sent", qbId: "qb-2", balance: 100 });
  const invoices = [local, linked];
  const result = await deleteSelectedInvoiceDrafts({ invoices, selectedIds: invoices.map((invoice) => invoice.id), context: { ...context(), includeQuickBooks: true, unlinkJobs: true, reviewedInvoices: invoices },
    onDelete: async (id, options) => {
      assert.equal(options.draftOnly, false);
      assert.equal(options.includeQuickBooks, true);
      assert.equal(options.unlinkJobs, true);
      assert.equal(options.reviewedInvoice, invoices.find((invoice) => invoice.id === id));
      return id === linked.id ? { ok: false, error: "QuickBooks rejected deletion" } : { ok: true };
    },
  });
  assert.deepEqual(result.deletedIds, [local.id]);
  assert.deepEqual(result.retainedIds, [linked.id]);
});

test("explicit unlinking removes unpaid maintenance matches but preserves all settled and uncertain evidence", () => {
  const invoice = draft("draft-1", { qbId: "qb-1", balance: 100 });
  const source = { kind: "invoice", invoiceId: invoice.id, amountCents: 10000 };
  const ledger = { version: 2, policies: {}, allocations: { "sample-client": {
    "2026-04": { status: "due", sources: [source] },
    "2026-05": { status: "due", sources: [source, { kind: "invoice", invoiceId: "keep", amountCents: 5000 }], allocatedCents: 15000 },
  } } };
  const options = { ledger, includeQuickBooks: true, reviewedInvoice: invoice };
  assert.equal(invoiceBulkDeleteEligibility(invoice, options).code, "payment-coverage");
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, unlinkJobs: true }).eligible, true);
  const unlinked = unlinkUnpaidInvoiceCoverage(invoice, ledger);
  assert.equal(unlinked.allocations["sample-client"]["2026-04"], undefined);
  assert.deepEqual(unlinked.allocations["sample-client"]["2026-05"].sources, [{ kind: "invoice", invoiceId: "keep", amountCents: 5000 }]);
  assert.equal(unlinked.allocations["sample-client"]["2026-05"].allocatedCents, 5000);
  assert.equal(ledger.allocations["sample-client"]["2026-04"].sources.length, 1);
  for (const status of ["paid", "partial", "prepaid", "waived", "review", "refunded"]) {
    const protectedLedger = { version: 2, policies: {}, allocations: { "sample-client": { "2026-04": { status, sources: [source] } } } };
    assert.deepEqual(unlinkUnpaidInvoiceCoverage(invoice, protectedLedger), protectedLedger);
    assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, unlinkJobs: true, ledger: protectedLedger }).code, "payment-coverage", status);
  }
  const policyLedger = { version: 2, policies: { "sample-client": { version: 1, mode: "prepaid", coveredFrom: "2026-04-01", coveredThrough: "2026-04-30", sourceInvoiceId: invoice.qbId } }, allocations: {} };
  assert.equal(invoiceBulkDeleteEligibility(invoice, { ...options, unlinkJobs: true, ledger: policyLedger }).code, "payment-coverage", "a policy can identify its source by QuickBooks ID");
});

test("review matching permits sequential draft renumbering but detects changed client or charges", () => {
  const invoice = draft();
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, number: "INV-0", previousDraftNumber: invoice.number, draftNumberAdjustedAt: "now" }), true);
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, lineItems: [{ desc: "Repair", qty: 1, unitPrice: 200 }] }), false);
  assert.equal(invoiceDeletionReviewMatches(invoice, { ...invoice, clientId: "different-client" }), false);
  assert.equal(invoiceDeletionReviewMatches(null, invoice), false);
});

test("batch deletion is sequential and retains failed, protected, and unconfirmed invoices", async () => {
  const invoices = [draft("draft-1"), draft("draft-2"), draft("draft-3"), draft("draft-4", { status: "Paid" }), draft("draft-5")];
  const calls = [];
  let active = 0;
  const result = await deleteSelectedInvoiceDrafts({
    invoices, selectedIds: invoices.map((invoice) => invoice.id), context: context(),
    onDelete: async (id, options) => {
      assert.equal(++active, 1);
      assert.equal(options.draftOnly, true);
      calls.push(id);
      await Promise.resolve();
      active -= 1;
      if (id === "draft-2") throw new Error("Offline");
      if (id === "draft-3") return undefined;
      if (id === "draft-5") return { ok: false, protected: true, error: "Now linked to QuickBooks" };
      return { ok: true };
    },
  });
  assert.deepEqual(calls, ["draft-1", "draft-2", "draft-3", "draft-5"]);
  assert.deepEqual(result.deletedIds, ["draft-1"]);
  assert.deepEqual(new Set(result.retainedIds), new Set(["draft-2", "draft-3", "draft-4", "draft-5"]));
});

// Exercise the actual app handler with versioned, in-memory sections. No API,
// database, or business records are accessed by these transaction tests.
async function deletionHarness(invoices, options = {}) {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("  const handleDeleteInvoice = async");
  const end = app.indexOf("\n  // Re-read the three authoritative sections", start);
  const rows = Object.fromEntries(Object.entries({ sps_invoices: invoices, sps_estimates: options.estimates || [], sps_schedule: options.schedule || [], sps_maintenance_billing: options.ledger || emptyMaintenancePaymentLedger() }).map(([key, value]) => [key, { ok: true, exists: true, value: JSON.stringify(value), version: 1 }]));
  const writes = [];
  const flushes = [];
  const qbCalls = [];
  const uiUpdates = [];
  let globalFlushes = 0;
  const store = {
    flush: async () => { globalFlushes += 1; if (options.globalFlushRejects) throw new Error("Unrelated section is offline"); return { ok: true }; },
    flushKey: async (key) => { flushes.push(key); return { ok: true }; },
    listConflicts: () => options.conflicts || [],
    refresh: async (key) => structuredClone(rows[key]),
    get: async (key) => options.invalidConfirmation ? { value: "invalid" } : structuredClone(rows[key]),
    replaceMany: async (changes) => {
      writes.push(changes);
      const override = options.beforeWrite ? await options.beforeWrite(rows, writes.length) : null;
      if (override) return override;
      if (changes.some((change) => change.expectedVersion !== rows[change.key].version)) return { ok: false, conflict: true };
      changes.forEach((change) => { rows[change.key] = { ...rows[change.key], value: change.value, version: rows[change.key].version + 1 }; });
      return { ok: true };
    },
  };
  const deps = { store, perms: { isAdmin: true, invoiceDelete: true }, emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger, invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches, findInvoiceDeletionReferences, invoiceDeletionBlockedMessage, unlinkInvoiceDeletionReferences, unlinkUnpaidInvoiceCoverage, deleteInvoiceAndCompactSafeDrafts, invoiceTotals: (invoice) => ({ total: invoice.total }), setInvoices: (value) => uiUpdates.push(structuredClone(value)), setEstimatesRaw: () => {}, setSchedule: () => {}, qbIsConnected: () => { throw new Error("Local draft deletion must never inspect QuickBooks connection"); }, QB_API: "https://mock.test/quickbooks", authHeaders: async (headers) => headers,
    fetch: async (url, init) => { qbCalls.push({ url, init }); if (!options.onQuickBooks) throw new Error("Unexpected QuickBooks request"); return options.onQuickBooks(qbCalls.length, { url, init }, rows); },
  };
  const handle = Function(...Object.keys(deps), `${app.slice(start, end)}\nreturn handleDeleteInvoice;`)(...Object.values(deps));
  return { handle, rows, writes, flushes, qbCalls, uiUpdates, globalFlushCount: () => globalFlushes };
}

test("bulk handler fences the unchanged authoritative ledger in the confirmed delete transaction", async () => {
  const invoice = draft();
  const harness = await deletionHarness([invoice]);
  const priorLedger = harness.rows.sps_maintenance_billing.value;
  assert.equal((await harness.handle(invoice.id, { draftOnly: true, reviewedInvoice: invoice })).ok, true);
  assert.deepEqual(harness.writes[0].find((operation) => operation.key === "sps_maintenance_billing"), { key: "sps_maintenance_billing", value: priorLedger, expectedVersion: 1 });
  assert.equal(harness.rows.sps_maintenance_billing.value, priorLedger);
});

test("a simultaneous payment allocation forces a recheck and preserves the draft", async () => {
  const invoice = draft();
  const harness = await deletionHarness([invoice], { beforeWrite: async (rows, attempt) => {
    if (attempt !== 1) return;
    rows.sps_maintenance_billing = { ...rows.sps_maintenance_billing, version: 2, value: JSON.stringify({ version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: invoice.id }] } } } }) };
  } });
  const result = await harness.handle(invoice.id, { draftOnly: true, reviewedInvoice: invoice });
  assert.equal(result.ok, false);
  assert.equal(result.protected, true);
  assert.match(result.error, /payment coverage/);
  assert.equal(harness.writes.length, 1);
  assert.equal(JSON.parse(harness.rows.sps_invoices.value).length, 1);
});

test("freshly synced or changed drafts and malformed confirmations never report deletion success", async () => {
  const reviewed = draft();
  for (const fresh of [draft("draft-1", { qbId: "qb-1" }), draft("draft-1", { clientId: "changed" })]) {
    const harness = await deletionHarness([fresh]);
    assert.equal((await harness.handle(fresh.id, { draftOnly: true, reviewedInvoice: reviewed })).ok, false);
    assert.equal(harness.writes.length, 0);
  }
  const harness = await deletionHarness([reviewed], { invalidConfirmation: true });
  assert.equal((await harness.handle(reviewed.id, { draftOnly: true, reviewedInvoice: reviewed })).ok, false);
});

test("actual handler leaves SPS records and the UI unchanged on every unconfirmed QuickBooks deletion", async () => {
  const invoice = draft("linked", { status: "Sent", qbId: "qb-1", balance: 100 });
  for (const onQuickBooks of [
    async () => ({ ok: false, json: async () => ({ error: "QuickBooks rejected deletion" }) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => { throw new Error("Connection closed before confirmation"); },
  ]) {
    const harness = await deletionHarness([invoice], { onQuickBooks });
    const before = structuredClone(harness.rows);
    const receipt = await harness.handle(invoice.id, { reviewedInvoice: invoice, includeQuickBooks: true });
    assert.equal(receipt.ok, false);
    assert.deepEqual(harness.rows, before);
    assert.equal(harness.writes.length, 0);
    assert.deepEqual(harness.uiUpdates, [], "the invoice is never optimistically hidden");
    assert.equal(harness.qbCalls.length, 1);
  }
});

test("QB success followed by local failure stays incomplete and retry checks already-gone before cleanup", async () => {
  const invoice = draft("linked", { status: "Overdue", qbId: "qb-1", balance: 100 });
  const harness = await deletionHarness([invoice], {
    onQuickBooks: async (attempt) => ({ ok: true, json: async () => ({ success: true, ...(attempt > 1 ? { alreadyGone: true } : {}) }) }),
    beforeWrite: async (_rows, attempt) => attempt === 1 ? { ok: false, error: { message: "Save unavailable" } } : null,
  });
  const options = { reviewedInvoice: invoice, includeQuickBooks: true };
  const first = await harness.handle(invoice.id, options);
  assert.equal(first.ok, false);
  assert.match(first.error, /QuickBooks confirmed deletion.*SPS cleanup/i);
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), [invoice]);
  assert.deepEqual(harness.uiUpdates, []);
  const retry = await harness.handle(invoice.id, options);
  assert.equal(retry.ok, true);
  assert.equal(harness.qbCalls.length, 2);
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), []);
  assert.deepEqual(harness.uiUpdates, [[]]);
  assert.equal(JSON.parse(harness.qbCalls[1].init.body).qb_id, "qb-1");
});

test("a thrown local save after QB success reports the known incomplete cleanup", async () => {
  const invoice = draft("linked", { status: "Sent", qbId: "qb-1", balance: 100 });
  const harness = await deletionHarness([invoice], {
    onQuickBooks: async () => ({ ok: true, json: async () => ({ success: true }) }),
    beforeWrite: async () => { throw new Error("Local save connection ended"); },
  });
  const receipt = await harness.handle(invoice.id, { reviewedInvoice: invoice, includeQuickBooks: true });
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /QuickBooks.*delet.*SPS|QuickBooks.*delet.*cleanup/i);
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), [invoice]);
  assert.deepEqual(harness.uiUpdates, []);
});

test("unrelated conflicts and a rejected global flush cannot block a related-key deletion", async () => {
  const invoice = draft();
  const harness = await deletionHarness([invoice], { globalFlushRejects: true, conflicts: [{ key: "sps_marketing", message: "Unrelated changes" }] });
  const receipt = await harness.handle(invoice.id, { reviewedInvoice: invoice });
  assert.equal(receipt.ok, true);
  assert.equal(harness.globalFlushCount(), 0);
  assert.deepEqual(harness.flushes, ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing"]);
});

test("confirmed unlink cleanup atomically removes due matches and invoice backlinks while preserving work and other evidence", async () => {
  const invoice = draft("linked", { status: "Sent", balance: 100, sourceEstimateId: "estimate-1" });
  const other = draft("keep", { status: "Sent", number: "KEEP" });
  const estimates = [{ id: "estimate-1", status: "Accepted", linkedInvoiceId: invoice.id }, { id: "estimate-2", linkedInvoiceId: other.id }];
  const schedule = [{ date: "10/05/2026", stops: [{ sid: "stop-1", sourceEstimateId: "estimate-1", linkedInvoiceId: invoice.id, completed: true }, { sid: "stop-2", linkedInvoiceId: other.id }] }];
  const ledger = { version: 2, policies: {}, allocations: { "sample-client": {
    "2026-10": { status: "due", sources: [{ kind: "invoice", invoiceId: invoice.id, amountCents: 10000 }] },
    "2026-11": { status: "paid", sources: [{ kind: "invoice", invoiceId: other.id, amountCents: 10000 }] },
  } } };
  const harness = await deletionHarness([invoice, other], { estimates, schedule, ledger });
  const receipt = await harness.handle(invoice.id, { reviewedInvoice: invoice, unlinkJobs: true });
  assert.equal(receipt.ok, true, receipt.error);
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.writes[0].map((change) => change.key), ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing"]);
  assert.ok(harness.writes[0].every((change) => change.expectedVersion === 1));
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), [other]);
  assert.deepEqual(JSON.parse(harness.rows.sps_estimates.value), [{ id: "estimate-1", status: "Accepted" }, estimates[1]]);
  assert.deepEqual(JSON.parse(harness.rows.sps_schedule.value)[0].stops, [{ sid: "stop-1", sourceEstimateId: "estimate-1", completed: true }, schedule[0].stops[1]]);
  assert.deepEqual(JSON.parse(harness.rows.sps_maintenance_billing.value), { version: 2, policies: {}, allocations: { "sample-client": { "2026-11": ledger.allocations["sample-client"]["2026-11"] } } });
});

test("reviewed deletion never renumbers another draft used by payment coverage", async () => {
  const first = draft("draft-1");
  const protectedDraft = draft("draft-2");
  const ledger = { version: 2, policies: {}, allocations: { "sample-client": { "2026-10": { status: "paid", sources: [{ kind: "invoice", invoiceId: protectedDraft.id, invoiceNumber: protectedDraft.number }] } } } };
  const harness = await deletionHarness([first, protectedDraft], { ledger });
  const receipt = await harness.handle(first.id, { reviewedInvoice: first, includeQuickBooks: true });
  assert.equal(receipt.ok, true);
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), [protectedDraft]);
  assert.deepEqual(receipt.renumbered, []);
});

test("a harmless local CAS retry after confirmed QB deletion does not repeat the remote delete", async () => {
  const invoice = draft("linked", { status: "Sent", qbId: "qb-1", balance: 100 });
  const harness = await deletionHarness([invoice], {
    onQuickBooks: async () => ({ ok: true, json: async () => ({ success: true }) }),
    beforeWrite: async (rows, attempt) => { if (attempt === 1) rows.sps_estimates.version += 1; },
  });
  const receipt = await harness.handle(invoice.id, { reviewedInvoice: invoice, includeQuickBooks: true });
  assert.equal(receipt.ok, true, receipt.error);
  assert.equal(harness.writes.length, 2);
  assert.equal(harness.qbCalls.length, 1);
  assert.deepEqual(JSON.parse(harness.rows.sps_invoices.value), []);
});
