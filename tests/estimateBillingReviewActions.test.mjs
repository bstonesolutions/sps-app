import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { scheduleApprovedEstimate } from "../estimateScheduleLink.js";
import { findInvoiceForEstimate } from "../estimateInvoiceConversion.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
function action(name, next, dependencies) {
  const start = app.indexOf(`  const ${name} =`);
  const end = app.indexOf(`  const ${next} =`, start);
  assert.ok(start > 0 && end > start, `${name} source exists`);
  return new Function(...Object.keys(dependencies), `${app.slice(start, end)}; return ${name};`)(...Object.values(dependencies));
}
const estimate = { id: "estimate-1", number: "EST-1001", clientId: "client-1", clientName: "Example client", status: "approved", title: "Pond repair", taxEnabled: false, items: [{ id: "item-1", desc: "Repair pump", kind: "service", qty: "1", price: "225" }] };
const client = { id: "client-1", name: "Example client" };
const taxImpact = current => ({ requiresConfirmation: false, normalizedEstimate: current });

function conversionHarness({ receipt = { ok: true }, result = { ok: true, review: { id: "review-1", number: "", reviewState: "pending" } } } = {}) {
  const events = [];
  const handler = action("handleConvertEstimateToInvoice", "handleCompleteEstimate", {
    clients: [client], invoicing: {}, estimateTaxMigrationImpact: taxImpact,
    store: { flushKey: async key => { events.push(["flush", key]); return receipt; } },
    storeReceiptIssue: value => value.ok ? "" : "The estimate did not save.",
    requestBillingReview: async payload => { events.push(["request", payload]); return result; },
    refreshBillingInvoiceState: async () => { events.push(["refresh"]); },
  });
  return { handler, events };
}

test("preparing estimate billing saves the quote, asks for one unnumbered review, then refreshes confirmed links", async () => {
  const { handler, events } = conversionHarness();
  const result = await handler(estimate);
  assert.equal(result.review.number, "");
  assert.equal(result.existing, false);
  assert.deepEqual(events, [
    ["flush", "sps_estimates"],
    ["request", { action: "from-estimate", estimateId: estimate.id, taxMigrationConfirmed: false }],
    ["refresh"],
  ]);
  assert.equal("client" in events[1][1], false);
});

test("a canonical existing invoice reopens instead of becoming a new review", async () => {
  const invoice = { id: "invoice-1", number: "INV-300", qbId: "QB-88" };
  const { handler, events } = conversionHarness({ result: { ok: true, invoice } });
  const result = await handler(estimate);
  assert.equal(result.invoice, invoice);
  assert.equal(result.existing, true);
  assert.equal(events.filter(event => event[0] === "request").length, 1);
});

test("opening an actual linked invoice does not invoke owner review creation or change legacy tax", async () => {
  const invoice = { id: "invoice-1", number: "INV-300", clientId: client.id, sourceEstimateId: estimate.id };
  let apiCalls = 0;
  let refreshed = 0;
  const handler = action("handleConvertEstimateToInvoice", "handleCompleteEstimate", {
    clients: [client], invoicing: {}, findInvoiceForEstimate,
    estimateTaxMigrationImpact: () => { throw new Error("Opening a real invoice must not normalize estimate tax"); },
    store: {
      flushKey: async () => ({ ok: true }),
      refresh: async key => { assert.equal(key, "sps_invoices"); refreshed++; return { ok: true, exists: true, value: JSON.stringify([invoice]) }; },
    },
    storeReceiptIssue: () => "", setInvoices() {},
    requestBillingReview: async () => { apiCalls++; },
  });
  const result = await handler(estimate, { existingInvoiceId: invoice.id });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.invoice, invoice);
  assert.equal(result.existing, true);
  assert.equal(refreshed, 1);
  assert.equal(apiCalls, 0);
});

test("a failed estimate save cannot prepare billing from stale data", async () => {
  const { handler, events } = conversionHarness({ receipt: { ok: false } });
  const result = await handler(estimate);
  assert.equal(result.ok, false);
  assert.deepEqual(events, [["flush", "sps_estimates"]]);
});

function schedulingHarness({ invoice = null, source = estimate } = {}) {
  const writes = [];
  const invoices = invoice ? [invoice] : [];
  const initial = { sps_estimates: [source], sps_schedule: [], sps_invoices: invoices };
  const handler = action("handleScheduleApprovedEstimate", "handleResetData", {
    clients: [client], invoicing: {}, estimateTaxMigrationImpact: taxImpact,
    findInvoiceForEstimate, scheduleApprovedEstimate,
    store: {
      flush: async () => ({ ok: true }),
      refresh: async key => ({ ok: true, exists: true, value: JSON.stringify(initial[key]), version: 12 }),
      replaceMany: async operations => { writes.push(operations); return { ok: true }; },
    },
    setEstimatesRaw() {}, setSchedule() {}, setInvoices() {}, setScheduleEstimateSeed() {}, setScheduleFocus() {},
  });
  return { handler, writes, invoices };
}

test("scheduling approved work leaves invoices untouched and keeps any pending review linked", async () => {
  const { handler, writes } = schedulingHarness({ source: { ...estimate, linkedBillingReviewId: "review-1" } });
  const result = await handler(estimate, { date: "10/08/2026", tech: "Tech" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.invoiceCreated, false);
  assert.equal(result.stop.linkedBillingReviewId, "review-1");
  assert.equal(result.stop.estimateFulfillment.billingDisposition, "billing-review");
  assert.deepEqual(JSON.parse(writes[0].find(write => write.key === "sps_invoices").value), []);
  assert.equal(result.stop.linkedInvoiceId, undefined);
});

test("scheduling preserves an actual invoice link and its concurrency fence", async () => {
  const invoice = { id: "invoice-1", number: "INV-300", sourceEstimateId: estimate.id, clientId: client.id, status: "Sent" };
  const { handler, writes } = schedulingHarness({ invoice });
  const result = await handler(estimate, { date: "10/08/2026", tech: "Tech" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stop.linkedInvoiceId, invoice.id);
  assert.equal(result.invoiceCreated, false);
  const invoiceWrite = writes[0].find(write => write.key === "sps_invoices");
  assert.deepEqual(JSON.parse(invoiceWrite.value), [invoice]);
  assert.equal(invoiceWrite.expectedVersion, 12);
});

test("a stale linked invoice prevents scheduling instead of silently replacing its billing record", async () => {
  const { handler, writes } = schedulingHarness({ source: { ...estimate, linkedInvoiceId: "missing" } });
  const result = await handler(estimate, { date: "10/08/2026", tech: "Tech" });
  assert.equal(result.ok, false);
  assert.match(result.error, /linked invoice could not be found/);
  assert.equal(writes.length, 0);
});

test("editing an open quote preserves newly confirmed billing links and intentional link removals", () => {
  const start = app.indexOf("const ESTIMATE_BILLING_LINK_FIELDS");
  const end = app.indexOf("function EstimatesScreen", start);
  const retain = new Function(`${app.slice(start, end)}; return retainEstimateBillingLinks;`)();
  const stale = { ...estimate, title: "Updated work", linkedBillingReviewId: "old-review" };
  const canonical = { ...estimate, linkedInvoiceId: "invoice-1", linkedInvoiceNumber: "INV-300", billingDisposition: "linked-invoice" };
  const result = retain(stale, canonical);
  assert.equal(result.title, "Updated work");
  assert.equal(result.linkedInvoiceId, "invoice-1");
  assert.equal(result.linkedInvoiceNumber, "INV-300");
  assert.equal("linkedBillingReviewId" in result, false);
  assert.equal(stale.linkedBillingReviewId, "old-review");
});

test("opening estimate review waits for the edited quote's exact save receipt before the API reads it", async () => {
  const events = [];
  let finishSave;
  const savePromise = new Promise(resolve => { finishSave = resolve; });
  const edited = { ...estimate, title: "New quoted scope", items: [{ ...estimate.items[0], price: "450" }] };
  const handler = action("convertEstimateToInvoice", "mutateEstimateBillingReview", {
    estimates: [estimate], retainEstimateBillingLinks: record => record,
    store: { set: async (key, value, options) => { events.push(["save", key, JSON.parse(value), JSON.parse(options.baseValue)]); return savePromise; } },
    storeReceiptIssue: receipt => receipt.ok ? "" : "Save is pending.",
    onConvertEstimate: async saved => { events.push(["prepare", saved]); return { ok: true, review: { id: "review-1", number: "", reviewState: "pending" } }; },
    setEstimates() {}, setSelected() {}, setInvoiceEditor() {},
  });
  const pending = handler(edited);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "save");
  assert.deepEqual(events[0][2], [edited]);
  assert.deepEqual(events[0][3], [estimate]);
  const confirmed = { ...edited, linkedBillingReviewId: "review-1" };
  finishSave({ ok: true, value: JSON.stringify([confirmed]) });
  const result = await pending;
  assert.deepEqual(events[1], ["prepare", confirmed]);
  assert.deepEqual(result.estimate, confirmed);
});

test("a queued quote save keeps review creation blocked instead of using the old quote", async () => {
  let apiCalls = 0;
  const handler = action("convertEstimateToInvoice", "mutateEstimateBillingReview", {
    estimates: [estimate], retainEstimateBillingLinks: record => record,
    store: { set: async () => ({ ok: false, queued: true }) },
    storeReceiptIssue: () => "Save is pending.",
    onConvertEstimate: async () => { apiCalls++; },
    setEstimates() {}, setSelected() {}, setInvoiceEditor() {},
  });
  const result = await handler({ ...estimate, title: "Changed scope" });
  assert.equal(result.ok, false);
  assert.equal(apiCalls, 0);
});

test("a review save conflict preserves typed changes instead of replacing them with the server row", async () => {
  const failure = new Error("Review changed");
  const canonical = { id: "review-1", reviewState: "pending", reviewRevision: 9, lineItems: [{ desc: "Saved old text" }] };
  const handler = action("mutateEstimateBillingReview", "saveConvertedInvoice", {
    requestBillingReview: async payload => { if (payload) throw failure; return { reviews: [canonical] }; },
    setInvoiceEditor() { throw new Error("A save conflict must keep the editor state"); },
    refreshBillingInvoiceState() {},
  });
  await assert.rejects(handler("save", { id: canonical.id, reviewRevision: 8, lineItems: [{ desc: "Owner typed work" }] }), error => {
    assert.equal(error, failure);
    assert.equal(error.data?.review, undefined);
    return true;
  });
});

test("an interrupted confirmation reloads its approval while rejected approval remains editable", async () => {
  for (const canonical of [
    { id: "review-1", reviewState: "approving", reviewRevision: 9, approval: { state: "unknown" } },
    { id: "review-1", reviewState: "pending", reviewRevision: 9, approval: { state: "rejected" } },
  ]) {
    const failure = new Error("Confirmation interrupted");
    const handler = action("mutateEstimateBillingReview", "saveConvertedInvoice", {
      requestBillingReview: async payload => { if (payload) throw failure; return { reviews: [canonical] }; },
      setInvoiceEditor() {}, refreshBillingInvoiceState() {},
    });
    await assert.rejects(handler("confirm", { id: canonical.id, reviewRevision: 8 }), error => {
      assert.deepEqual(error.data.review, canonical);
      return true;
    });
  }
});

test("both review entry points include the chosen number only on a fresh confirmation request", async () => {
  for (const [name, next] of [["mutateEstimateBillingReview", "saveConvertedInvoice"], ["mutateBillingReview", "migrateBillingReviews"]]) {
    const requests = [];
    const handler = action(name, next, {
      requestBillingReview: async payload => { requests.push(payload); return { ok: true }; },
      setInvoiceEditor() {}, setBillingReviews() {}, setBillingReceipt() {}, setBillingReviewsError() {},
      refreshBillingInvoiceState: async () => {}, onRefreshBillingState: async () => {}, loadBillingReviews: async () => [],
    });
    const review = { id: "review-1", number: "", reviewRevision: 3 };
    for (const verb of ["save", "confirm", "retry", "discard"]) await handler(verb, review, { invoiceNumber: "SPS-2041" });
    assert.equal(requests[0].invoiceNumber, undefined);
    assert.equal(requests[0].review.number, "");
    assert.equal(requests[1].invoiceNumber, "SPS-2041");
    assert.equal(requests[1].expectedRevision, 3);
    assert.equal(requests[2].invoiceNumber, undefined);
    assert.equal(requests[3].invoiceNumber, undefined);
  }
});
