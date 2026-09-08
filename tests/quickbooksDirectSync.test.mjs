import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { applyConfirmedQuickBooksSync, confirmQuickBooksSyncCandidate, quickBooksInvoiceSyncEligibility, quickBooksInvoiceUrl, syncInvoiceToQuickBooks } from "../quickbooksDirectSync.js";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";
import { mapQuickBooksInvoice } from "../api/quickbooks/invoice-mapper.js";

const client = { id: "sample-client", name: "Sample Client", email: "sample@example.com" };
const draft = () => ({ id: "sample-invoice", number: "INV-100", clientId: client.id, clientName: client.name, date: "9/7/2026", dueDate: "10/7/2026", status: "Draft", lineItems: [{ id: "line-1", desc: "Service", qty: 1, unitPrice: 100, unitCost: 25 }], sourceVisitId: "sample-visit" });
const linked = () => ({ ...draft(), status: "Sent", sentDate: "9/7/2026", qbId: "QB-100", qbContentFingerprint: "revision-1", qbBaseContentFingerprint: "revision-1" });
const success = (invoice = draft()) => ({ response: { ok: true, status: 200 }, data: { success: true, qbId: "QB-100", qbContentFingerprint: "revision-2", invoice: { ...invoice, qbId: "QB-100", qbContentFingerprint: "revision-2", status: "Draft" } } });
function harness(original = draft(), options = {}) {
  let current = structuredClone(original);
  let saves = 0;
  const calls = [];
  const run = (extra = {}) => syncInvoiceToQuickBooks({
    invoice: original, client, invoicing: {},
    persistInvoice: async (id, mutate) => {
      saves += 1;
      assert.equal(id, original.id);
      if (options.failSave?.(saves)) throw new Error("Shared save unavailable");
      current = mutate(structuredClone(current));
      return structuredClone(current);
    },
    request: async (endpoint, payload) => {
      calls.push({ endpoint, payload });
      if (options.duringRequest) current = options.duringRequest(structuredClone(current));
      if (options.throwRequest) throw new Error("Network interrupted");
      return options.reply || success(original);
    },
    ...extra,
  });
  return { run, calls, get current() { return current; }, get saves() { return saves; }, setCurrent(value) { current = value; } };
}

test("direct action permits unsent drafts and revision-checked linked invoices", () => {
  assert.equal(quickBooksInvoiceSyncEligibility(draft(), client).eligible, true);
  assert.equal(quickBooksInvoiceSyncEligibility(linked(), client).eligible, true);
  assert.equal(quickBooksInvoiceSyncEligibility({ ...draft(), status: "Sent" }, client).eligible, true);
  assert.equal(quickBooksInvoiceSyncEligibility({ ...draft(), qbId: "QB-100" }, client).eligible, false);
});

test("direct action blocks paid, partial, void, protected and unresolved records", () => {
  for (const patch of [
    { status: "Paid" }, { status: "Void" }, { payment: { amount: 20 } }, { partial: true }, { payments: [{ amount: 20 }] }, { paidDate: "9/8/2026" },
    { qbSpsOnly: true }, { qbSyncStatus: "sps-only" }, { qbCreateOutcomeUnknown: true },
    { qbNeedsReview: true }, { qbReviewRequired: true }, { qbSyncConflict: {} },
    { qbRemoteChangesPending: true }, { qbPendingRemote: true }, { qbDuplicate: true }, { qbAccountingExcluded: true }, { lineItems: [] }, { number: "" },
  ]) assert.equal(quickBooksInvoiceSyncEligibility({ ...linked(), ...patch }, client).eligible, false, JSON.stringify(patch));
});

test("preflight rejects newer accounting, cost, client and status edits but ignores table-only fields", () => {
  const reviewed = draft();
  assert.deepEqual(confirmQuickBooksSyncCandidate(reviewed, { ...reviewed, _total: 100, _client: client }, client, {}), reviewed);
  for (const patch of [
    { status: "Sent" }, { clientId: "another-client" }, { notes: "Changed" },
    { lineItems: [{ ...reviewed.lineItems[0], unitPrice: 125 }] },
    { lineItems: [{ ...reviewed.lineItems[0], unitCost: 50 }] },
  ]) assert.throws(() => confirmQuickBooksSyncCandidate({ ...reviewed, ...patch }, reviewed, client, {}), /changed since you opened/);
});

test("draft create is preceded by confirmed SPS preflight and keeps delivery and visit evidence", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, "synced");
  assert.equal(h.saves, 2);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].endpoint, "create-invoice");
  assert.equal(h.calls[0].payload.spsInvoiceId, "sample-invoice");
  assert.equal(h.current.status, "Draft");
  assert.equal(h.current.sentDate, undefined);
  assert.equal(h.current.sourceVisitId, "sample-visit");
  assert.equal(h.current.qbId, "QB-100");
});

test("linked invoice updates its existing twin and retains customer-send evidence", async () => {
  const h = harness(linked());
  const result = await h.run();
  assert.equal(result.status, "synced");
  assert.equal(h.calls[0].endpoint, "update-invoice");
  assert.equal(h.calls[0].payload.qbId, "QB-100");
  assert.equal(h.calls[0].payload.qbBaseContentFingerprint, "revision-1");
  assert.equal(h.current.status, "Sent");
  assert.equal(h.current.sentDate, "9/7/2026");
});

test("production QuickBooks response normalization preserves line names through direct sync", async () => {
  const original = { ...draft(), taxRate: 6, lineItems: [
    { id: "line-1", desc: "Pond maintenance visit", qty: 1, unitPrice: 185, unitCost: 50, taxable: false },
    { id: "line-2", desc: "Filter supplies", qty: 2, unitPrice: 24, unitCost: 10, taxable: true },
  ] };
  const payload = buildQuickBooksInvoicePayload(original, client, {});
  const canonical = mapQuickBooksInvoice({
    Id: "QB-100", SyncToken: "1", DocNumber: original.number,
    CustomerRef: { value: "QB-client", name: client.name },
    TxnDate: payload.date, DueDate: payload.dueDate, TotalAmt: 235.88, Balance: 235.88, EmailStatus: "NotSet",
    TxnTaxDetail: { TotalTax: 2.88, TxnTaxCodeRef: { value: "PA" }, TaxLine: [{ TaxLineDetail: { TaxPercent: 6 } }] },
    Line: payload.lineItems.map((line, index) => ({
      Id: String(index + 1), DetailType: "SalesItemLineDetail", Description: line.description,
      Amount: Number(line.qty) * Number(line.unitPrice),
      SalesItemLineDetail: { ItemRef: { value: String(index + 1), name: "Services" }, Qty: Number(line.qty), UnitPrice: Number(line.unitPrice), TaxCodeRef: { value: line.taxable ? "TAX" : "NON" } },
    })),
  });
  const h = harness(original, { reply: { response: { ok: true, status: 200 }, data: { success: true, qbId: "QB-100", qbContentFingerprint: canonical.qbContentFingerprint, invoice: canonical } } });
  assert.equal((await h.run()).status, "synced");
  assert.deepEqual(h.current.lineItems.map((line) => line.desc), ["Pond maintenance visit", "Filter supplies"]);
  assert.deepEqual(h.current.lineItems.map((line) => line.unitCost), [50, 10]);
  assert.equal(h.current.total, 235.88);
  assert.equal(h.current.status, "Draft");
});

test("missing, failed, stale or unconfirmed SPS preflight prevents all QuickBooks requests", async () => {
  for (const mode of ["missing", "failed", "stale", "unconfirmed", "linked"]) {
    const h = harness(draft(), { failSave: () => mode === "failed" });
    if (mode === "stale") h.setCurrent({ ...h.current, notes: "Another device's edit" });
    if (mode === "linked") h.setCurrent(linked());
    const result = await h.run(mode === "missing" ? { persistInvoice: undefined } : mode === "unconfirmed" ? { persistInvoice: async () => null } : {});
    assert.equal(result.status, "failed", mode);
    assert.equal(h.calls.length, 0, mode);
  }
});

test("bulk queue continues to reject linked or sent invoices even though direct sync supports them", async () => {
  for (const invoice of [linked(), { ...draft(), status: "Sent" }]) {
    const h = harness(invoice);
    assert.equal((await h.run({ draftsOnly: true })).status, "failed");
    assert.equal(h.calls.length, 0);
  }
});

test("concurrent same-invoice edits survive a successful QuickBooks response and require review", async () => {
  for (const original of [draft(), linked()]) {
    const h = harness(original, { duringRequest: (current) => ({ ...current, notes: "Saved on another device", lineItems: [{ ...current.lineItems[0], unitPrice: 225, unitCost: 70 }] }) });
    const result = await h.run();
    assert.equal(result.status, "uncertain");
    assert.equal(h.current.notes, "Saved on another device");
    assert.equal(h.current.lineItems[0].unitPrice, 225);
    assert.equal(h.current.lineItems[0].unitCost, 70);
    assert.equal(h.current.qbPendingRemoteInvoice.lineItems[0].unitPrice, 100);
    assert.equal(h.current.qbNeedsReview, true);
    assert.equal(h.current.qbId, "QB-100");
  }
});

test("a newer QuickBooks link is never overwritten with the response's link", async () => {
  const h = harness(draft(), { duringRequest: (current) => ({ ...current, qbId: "QB-OTHER", qbContentFingerprint: "other-revision" }) });
  assert.equal((await h.run()).status, "uncertain");
  assert.equal(h.current.qbId, "QB-OTHER");
});

test("a later QuickBooks conflict survives an older in-flight response even when SPS content is unchanged", async () => {
  const pendingRemote = { ...linked(), qbContentFingerprint: "revision-3", qbSyncToken: "3", lineItems: [{ ...draft().lineItems[0], unitPrice: 150 }] };
  const pendingConflict = { type: "quickbooks-remote-update", reason: "pending-local-edits", currentFingerprint: "revision-3" };
  for (const localEdit of [false, true]) {
    const h = harness(linked(), { duringRequest: (current) => ({
      ...current,
      ...(localEdit ? { lineItems: [{ ...current.lineItems[0], unitPrice: 225 }] } : {}),
      qbNeedsReview: true,
      qbRemoteChangesPending: true,
      qbSyncStatus: "conflict",
      qbSyncConflict: pendingConflict,
      qbPendingRemoteInvoice: pendingRemote,
    }) });
    const result = await h.run();
    assert.equal(result.status, "uncertain");
    assert.equal(h.current.qbNeedsReview, true);
    assert.equal(h.current.qbRemoteChangesPending, true);
    assert.equal(h.current.qbSyncStatus, "conflict");
    assert.equal(h.current.lineItems[0].unitPrice, localEdit ? 225 : 100);
    assert.deepEqual(h.current.qbPendingRemoteInvoice, pendingRemote);
    assert.deepEqual(h.current.qbSyncConflict, pendingConflict);
    assert.equal(h.current.qbBaseContentFingerprint, "revision-1");
  }
});

test("a review flag appearing during sync cannot be cleared even before its remote snapshot arrives", async () => {
  const h = harness(linked(), { duringRequest: (current) => ({ ...current, qbNeedsReview: true }) });
  assert.equal((await h.run()).status, "uncertain");
  assert.equal(h.current.qbNeedsReview, true);
  assert.equal(h.current.qbSyncConflict.reason, "new-review-during-sync");
});

test("unknown creates and incomplete success cannot be blindly retried", async () => {
  for (const options of [
    { throwRequest: true },
    { reply: { response: { ok: true, status: 200 }, data: { success: true } } },
    { reply: { response: { ok: false, status: 500 }, data: { error: "Interrupted", createOutcomeUnknown: true } } },
  ]) {
    const h = harness(draft(), options);
    assert.equal((await h.run()).status, "uncertain");
    assert.equal(h.current.qbCreateOutcomeUnknown, true);
    assert.ok(h.current.qbCreateIntentSignature);
    assert.equal((await h.run({ invoice: h.current })).status, "failed");
    assert.equal(h.calls.length, 1);
  }
});

test("unknown linked updates require review without switching to create", async () => {
  const h = harness(linked(), { throwRequest: true });
  assert.equal((await h.run()).status, "uncertain");
  assert.equal(h.current.qbNeedsReview, true);
  assert.equal(h.current.qbCreateOutcomeUnknown, undefined);
  assert.equal(h.current.qbId, "QB-100");
  assert.deepEqual(h.calls.map((call) => call.endpoint), ["update-invoice"]);
});

test("QuickBooks conflict or deleted twin requires review instead of automatic recreation", async () => {
  for (const reply of [
    { response: { ok: false, status: 409 }, data: { error: "Changed", code: "quickbooks_invoice_changed", currentFingerprint: "new" } },
    { response: { ok: true, status: 200 }, data: { recreate: true } },
  ]) {
    const h = harness(linked(), { reply });
    assert.equal((await h.run()).status, "uncertain");
    assert.equal(h.current.qbNeedsReview, true);
    assert.deepEqual(h.calls.map((call) => call.endpoint), ["update-invoice"]);
  }
});

test("expired auth reports reconnect and known rejection leaves a retryable draft", async () => {
  const expired = harness(draft(), { reply: { response: { ok: false, status: 401 }, data: {} } });
  const result = await expired.run();
  assert.equal(result.reconnect, true);
  assert.equal(expired.current.qbCreateOutcomeUnknown, undefined);
  const rejected = harness(draft(), { reply: { response: { ok: false, status: 500 }, data: { error: "Invalid invoice date" } } });
  assert.equal((await rejected.run()).status, "failed");
  assert.equal(quickBooksInvoiceSyncEligibility(rejected.current, client).eligible, true);
});

test("QuickBooks success followed by failed SPS confirmation remains visibly uncertain", async () => {
  const h = harness(draft(), { failSave: (count) => count === 2 });
  const result = await h.run();
  assert.equal(result.status, "uncertain");
  assert.match(result.message, /Saved in QuickBooks/);
  assert.equal(h.current.qbId, "QB-100");
  assert.equal(h.current.qbSyncStatus, "local-save-unconfirmed");
  assert.equal(h.current.qbNeedsReview, true);
});

test("payment history created during a sync is retained for review", () => {
  const original = draft();
  const current = { ...original, status: "Paid", paidDate: "9/8/2026", payment: { amount: 100, reference: "sample-reference" } };
  const result = applyConfirmedQuickBooksSync(current, original, success(original).data, client, {});
  assert.equal(result.status, "Paid");
  assert.deepEqual(result.payment, current.payment);
  assert.equal(result.paidDate, "9/8/2026");
  assert.equal(result.qbNeedsReview, true);
  const paymentOnly = { ...original, payment: { amount: 20, reference: "recorded-before-status-change" } };
  const paymentResult = applyConfirmedQuickBooksSync(paymentOnly, original, success(original).data, client, {});
  assert.deepEqual(paymentResult.payment, paymentOnly.payment);
  assert.equal(paymentResult.qbNeedsReview, true);
});

test("QuickBooks link opens staff accounting with an encoded invoice ID", () => {
  assert.equal(quickBooksInvoiceUrl({}), "");
  assert.equal(quickBooksInvoiceUrl({ qbId: "100&other=1" }), "https://app.qbo.intuit.com/app/invoice?txnId=100%26other%3D1");
});

test("every preview receives confirmed persistence and both direct entry points enforce invoice permissions", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const tags = app.match(/<InvoicePreview\b[^\n]*\/>/g) || [];
  assert.ok(tags.length >= 2);
  tags.forEach((tag) => assert.match(tag, /onPersistInvoice=\{onPersistInvoice\}/));
  assert.match(app, /const canSyncQuickBooks = canManage && perms\.canInvoice && perms\.invoiceCreate/);
  assert.match(app, /if \(running \|\| !perms\.canInvoice \|\| !perms\.invoiceCreate\) return/);
  assert.match(app, /"Not recorded as sent"/);
  const helper = await readFile(new URL("../quickbooksDirectSync.js", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /sendSms|send-invoice|postToPortal|postClientMessage|supabase|store\./);
});
