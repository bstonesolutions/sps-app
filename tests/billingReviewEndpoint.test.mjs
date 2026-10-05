import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReviewHandler, sanitizeBillingReviewEdit } from "../api/billing-review.js";
import { BILLING_REVIEW_CREATE_CONTEXT } from "../api/_billing-review-context.js";
import { firstUnusedInvoiceNumber } from "../api/_billing-review-numbering.js";
import { makeBillingReview } from "../billingReview.js";

const clone = value => structuredClone(value);
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const draft = (id = "review-1", clientId = "client-1") => makeBillingReview({ id, clientId, clientName: "Example Client", date: "10/05/2026", dueDate: "10/20/2026", source: "completed-stop", taxRate: "0", lineItems: [{ id: "line-1", desc: "Pump repair", kind: "service", qty: "1", unitPrice: "100", taxable: false }] }, { now: "2026-10-05T14:00:00Z" });

function harness({ reviews = [draft()], invoices = [], customCreate, inventoryNumbers = [], state = {}, authorized = true } = {}) {
  const values = {
    sps_billing_reviews: reviews, sps_invoices: invoices, sps_estimates: [], sps_schedule: [],
    sps_clients: [{ id: "client-1", name: "Example Client", qbId: "customer-1", history: [] }], sps_completed: {},
    sps_invoicing: { nextNumber: 1001, numberPrefix: "INV-", dueDays: 15 }, sps_maintenance_billing: { version: 2, policies: {}, allocations: {} }, ...state,
  };
  const rows = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { key, exists: true, version: 1, value: clone(value) }]));
  const calls = { posts: [], inventories: 0, writes: [], auth: 0, reads: [] };
  let now = Date.parse("2026-10-05T14:00:00Z");
  let counter = 0;
  let failPromote = false;
  let commitThenThrow = false;
  const apply = async operations => {
    if (failPromote && operations.some(op => op.key === "sps_invoices" && !op.checkOnly)) throw new Error("SPS unavailable after QB committed");
    if (operations.some(op => rows[op.key]?.version !== op.expectedVersion)) return { applied: false, outcome: "conflict" };
    for (const op of operations) if (!op.checkOnly) {
      rows[op.key] = { key: op.key, exists: true, version: op.expectedVersion + 1, value: clone(op.value) };
      calls.writes.push(op.key);
    }
    if (commitThenThrow && operations.some(op => op.key === "sps_invoices" && !op.checkOnly)) { commitThenThrow = false; throw new Error("response lost after commit"); }
    return { applied: true, currentVersions: Object.fromEntries(operations.map(op => [op.key, rows[op.key].version])) };
  };
  const handler = createBillingReviewHandler({
    authorize: async (_req, res) => { calls.auth += 1; if (authorized) return { id: "owner" }; res.status(403).json({ error: "Owner access required" }); return null; },
    read: async keys => { calls.reads.push([...keys]); return Object.fromEntries(keys.map(key => [key, clone(rows[key] || { key, exists: false, version: 0, value: null })])); },
    cas: (key, version, value) => apply([{ key, expectedVersion: version, value }]), batch: apply,
    inventory: async () => { calls.inventories += 1; return { realmId: "realm-1", numbers: inventoryNumbers, checkedAt: new Date(now).toISOString() }; },
    guard: async () => null, now: () => now, uuid: () => `attempt-${++counter}`,
    createInvoice: async (req, res) => {
      const context = req[BILLING_REVIEW_CREATE_CONTEXT];
      const payload = clone(req.body.invoice);
      const wire = context.frozenQuickBooksInvoice || { DocNumber: payload.number, Line: clone(payload.lineItems) };
      await context.beforeInvoiceWrite(wire, { realmId: "realm-1", qbRequestId: payload.qbCreateRequestKey });
      context.writeStarted = true;
      calls.posts.push(payload);
      if (customCreate) return customCreate(req, res, calls);
      return res.status(200).json({ success: true, qbId: `qb-${payload.spsInvoiceId}`, qbContentFingerprint: "fp", invoice: {
        qbId: `qb-${payload.spsInvoiceId}`, number: payload.number, status: "Draft", qbEmailStatus: "NotSet", total: 100, balance: 100,
        lineItems: [{ id: "qb-line", desc: "Pump repair", qty: "1", unitPrice: "100", kind: "service", taxable: false }],
      } });
    },
  });
  return {
    calls, rows, handler, advance: ms => { now += ms; }, failPromotion: flag => { failPromote = flag; }, ambiguousPromotion: () => { commitThenThrow = true; },
    async call(body) { const res = response(); await handler({ method: body == null ? "GET" : "POST", headers: {}, body }, res); return res; },
  };
}

test("owner authorization happens before reads, migration, or QB work", async () => {
  const h = harness({ authorized: false });
  const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 403); assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 0); assert.equal(h.calls.writes.length, 0);
});

test("review edits are unnumbered and discard never calls QB", async () => {
  const h = harness();
  const saved = await h.call({ action: "save", reviewId: "review-1", expectedRevision: 1, review: { ...draft(), number: "9999", qbId: "fake", clientId: "other", notes: "Owner reviewed", lineItems: [{ ...draft().lineItems[0], unitPrice: "125", sourceStopId: "injected" }] } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.review.number, ""); assert.equal(saved.body.review.qbId, undefined); assert.equal(saved.body.review.clientId, "client-1"); assert.equal(saved.body.review.lineItems[0].sourceStopId, undefined);
  const removed = await h.call({ action: "discard", reviewId: "review-1", expectedRevision: 2 });
  assert.equal(removed.body.review.reviewState, "discarded"); assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 0);
  const rejected = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 3 });
  assert.equal(rejected.statusCode, 409); assert.equal(h.calls.posts.length, 0);
});

test("listing, saving and discarding never download the client roster", async () => {
  const h = harness();
  await h.call();
  await h.call({ action: "save", reviewId: "review-1", expectedRevision: 1, review: { notes: "Saved" } });
  await h.call({ action: "discard", reviewId: "review-1", expectedRevision: 2 });
  assert.ok(h.calls.reads.every(keys => keys.length === 1 && keys[0] === "sps_billing_reviews"));
});

test("available invoice numbers include full QB and SPS claims without reserving or numbering a review", async () => {
  const h = harness({ invoices: [{ id: "existing", number: "INV-1001" }], inventoryNumbers: ["1003", "INV-1050"], reviews: [draft(), { id: "reserved", recordType: "invoice-number-claim", reviewState: "synced", approval: { number: "INV-1004" } }] });
  const result = await h.call({ action: "available-numbers", reviewId: "review-1" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.nextNumber, "INV-1002");
  assert.deepEqual(result.body.availableNumbers.slice(0, 3), ["INV-1002", "INV-1005", "INV-1006"]);
  assert.equal(result.body.availableNumbers.length, 20);
  assert.equal(result.body.highestNumber, 1050);
  assert.equal(result.body.highestInvoiceNumber, "INV-1050");
  assert.equal(h.rows.sps_billing_reviews.value[0].number, "");
  assert.equal(h.rows.sps_billing_reviews.value[0].approval, undefined);
  assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.posts.length, 0);
  assert.deepEqual(h.calls.reads[0], ["sps_billing_reviews", "sps_invoices", "sps_invoicing"]);
});

test("manual invoice number is assigned only on confirmation and preserved exactly", async () => {
  const h = harness();
  const saved = await h.call({ action: "save", reviewId: "review-1", expectedRevision: 1, invoiceNumber: "SPS-2042", review: { number: "SPS-2042", notes: "Reviewed" } });
  assert.equal(saved.body.review.number, ""); assert.equal(saved.body.review.approval, undefined);
  const confirmed = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 2, invoiceNumber: " SPS-2042 " });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.invoice.number, "SPS-2042");
  assert.equal(h.calls.posts[0].number, "SPS-2042");
});

test("manual numbers reject QB, SPS, and reservation collisions before creating an invoice", async () => {
  for (const options of [{ inventoryNumbers: ["1007"] }, { invoices: [{ id: "old", number: "old-001007" }] }, { reviews: [draft(), { id: "reserved", recordType: "invoice-number-claim", reviewState: "synced", approval: { number: "INV-1007" } }] }]) {
    const h = harness(options);
    const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1, invoiceNumber: "INV-1007" });
    assert.equal(result.statusCode, 409); assert.equal(result.body.code, "billing_review_number_unavailable");
    assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.writes.length, 0);
  }
});

test("manual invoice numbers reject invalid, reserved and oversized values", async () => {
  for (const invoiceNumber of ["AUTO_GENERATE", "auto_generate", "a".repeat(22), "a\nb", "<1001>", 1001]) {
    const h = harness();
    const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1, invoiceNumber });
    assert.equal(result.statusCode, 422); assert.equal(result.body.code, "billing_review_number_invalid");
    assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.writes.length, 0);
  }
});

test("two reviews choosing one number cannot both create accounting records", async () => {
  const h = harness({ reviews: [draft("one"), draft("two")] });
  const results = await Promise.all(["one", "two"].map(reviewId => h.call({ action: "confirm", reviewId, expectedRevision: 1, invoiceNumber: "INV-2000" })));
  assert.equal(results.filter(result => result.statusCode === 200).length, 1);
  assert.equal(results.filter(result => result.statusCode === 409).length, 1);
  assert.equal(h.calls.posts.length, 1);
});

test("unknown approval rejects a changed number choice but retries its frozen chosen number", async () => {
  const h = harness({ customCreate: async (req, res, calls) => calls.posts.length === 1
    ? res.status(502).json({ createOutcomeUnknown: true, error: "Response lost" })
    : res.status(200).json({ success: true, qbId: "synthetic-qb", invoice: { number: req.body.invoice.number, status: "Draft", total: 100, balance: 100 } }) });
  const pending = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1, invoiceNumber: "SPS-2042" });
  assert.equal(pending.statusCode, 202);
  const changed = await h.call({ action: "retry", reviewId: "review-1", invoiceNumber: "SPS-2043" });
  assert.equal(changed.statusCode, 409); assert.equal(changed.body.code, "billing_review_number_locked");
  assert.equal(h.calls.posts.length, 1);
  const recovered = await h.call({ action: "retry", reviewId: "review-1" });
  assert.equal(recovered.statusCode, 200); assert.equal(h.calls.posts[1].number, "SPS-2042");
});

test("known rejected review can be re-confirmed with a new manual choice", async () => {
  const h = harness({ customCreate: async (req, res, calls) => calls.posts.length === 1
    ? res.status(400).json({ createRejected: true, error: "Invalid line" })
    : res.status(200).json({ success: true, qbId: "synthetic-qb", invoice: { number: req.body.invoice.number, status: "Draft", total: 100, balance: 100 } }) });
  const rejected = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1, invoiceNumber: "SPS-2042" });
  const confirmed = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: rejected.body.review.reviewRevision, invoiceNumber: "SPS-2043" });
  assert.equal(confirmed.statusCode, 200); assert.equal(h.calls.posts[1].number, "SPS-2043");
  assert.deepEqual(confirmed.body.review.numberClaims, ["SPS-2042", "SPS-2043"]);
});

test("migration protects QB document numbers even when SPS lost the link", async () => {
  const h = harness({ reviews: [], invoices: [
    { ...draft("migrate"), recordType: undefined, status: "Draft", number: "INV-1001", sourceStopId: "stop-a" },
    { ...draft("remote"), recordType: undefined, status: "Draft", number: "INV-1002", sourceStopId: "stop-b" },
  ], inventoryNumbers: ["INV-1002"] });
  const result = await h.call({ action: "migrate" });
  assert.equal(result.statusCode, 200); assert.deepEqual(result.body.migratedIds, ["migrate"]);
  assert.equal(h.rows.sps_invoices.value.length, 1); assert.equal(h.rows.sps_invoices.value[0].id, "remote");
  assert.equal(h.rows.sps_billing_reviews.value[0].number, ""); assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 1);
});

test("explicit estimate preparation is unnumbered, idempotent, and can reopen a discarded review", async () => {
  const estimate = { id: "estimate-a", clientId: "client-1", number: "EST-10", status: "approved", title: "Pump repair", taxEnabled: false, taxModel: "line-item-v1", items: [{ id: "item-a", name: "Repair", kind: "service", qty: "1", price: "100", taxable: false }] };
  const h = harness({ reviews: [], state: { sps_estimates: [estimate] } });
  const first = await h.call({ action: "from-estimate", estimateId: estimate.id });
  assert.equal(first.statusCode, 200); assert.equal(first.body.review.number, ""); assert.equal(first.body.review.reviewState, "pending");
  const repeat = await h.call({ action: "from-estimate", estimateId: estimate.id });
  assert.equal(repeat.body.review.id, first.body.review.id); assert.equal(h.rows.sps_billing_reviews.value.length, 1);
  await h.call({ action: "discard", reviewId: first.body.review.id, expectedRevision: 1 });
  const reopened = await h.call({ action: "from-estimate", estimateId: estimate.id });
  assert.equal(reopened.body.review.reviewState, "pending"); assert.equal(reopened.body.review.reviewRevision, 3); assert.equal(reopened.body.review.id, first.body.review.id);
  assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 0);
});

test("known QB rejection returns to editable review while preserving its number claim", async () => {
  const h = harness({ customCreate: async (_req, res) => res.status(500).json({ createRejected: true, error: "Invalid line" }) });
  const rejected = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(rejected.statusCode, 422); assert.equal(rejected.body.review.reviewState, "pending"); assert.equal(rejected.body.review.number, "");
  const edited = await h.call({ action: "save", reviewId: "review-1", expectedRevision: rejected.body.review.reviewRevision, review: { notes: "Corrected" } });
  assert.equal(edited.statusCode, 200); assert.equal(edited.body.review.approval.number, "INV-1001"); assert.equal(h.rows.sps_invoices.value.length, 0);
});

test("re-confirming a rejected review avoids a newly occupied QB number and retains the old claim", async () => {
  const inventoryNumbers = [];
  const h = harness({ inventoryNumbers, customCreate: async (req, res, calls) => {
    if (calls.posts.length === 1) return res.status(400).json({ createRejected: true, error: "Invalid line" });
    return res.status(200).json({ success: true, qbId: "synthetic-qb", invoice: { number: req.body.invoice.number, status: "Draft", total: 100, balance: 100 } });
  } });
  const rejected = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(rejected.body.review.approval.number, "INV-1001");
  inventoryNumbers.push("1001");
  const retried = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: rejected.body.review.reviewRevision });
  assert.equal(retried.statusCode, 200, JSON.stringify(retried.body));
  assert.equal(h.calls.posts[1].number, "INV-1002");
  assert.deepEqual(retried.body.review.numberClaims, ["INV-1001", "INV-1002"]);
});

test("stale review revision cannot overwrite or confirm another device's edits", async () => {
  const h = harness();
  await h.call({ action: "save", reviewId: "review-1", expectedRevision: 1, review: { notes: "Newer" } });
  const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 409); assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 0);
});

test("first confirmed invoice fills the first gap after full QB and SPS number claims", async () => {
  const h = harness({ invoices: [{ id: "old", number: "INV-1001", qbId: "old" }], inventoryNumbers: ["1001", "1003", "1004"] });
  const result = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(result.statusCode, 200); assert.equal(result.body.invoice.number, "INV-1002"); assert.equal(result.body.invoice.status, "Draft");
  assert.equal(result.body.invoice.sentDate, undefined); assert.equal(result.body.invoice.recordType, undefined); assert.equal(result.body.review.number, "");
  assert.equal(result.body.review.reviewState, "synced"); assert.equal(h.calls.posts.length, 1);
  const retry = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(retry.body.invoice.qbId, result.body.invoice.qbId); assert.equal(h.calls.posts.length, 1);
});

test("two reviews confirming together reserve distinct numbers with CAS", async () => {
  const h = harness({ reviews: [draft("a"), draft("b")] });
  const outcomes = await Promise.all([h.call({ action: "confirm", reviewId: "a", expectedRevision: 1 }), h.call({ action: "confirm", reviewId: "b", expectedRevision: 1 })]);
  assert.deepEqual(outcomes.map(result => result.statusCode), [200, 200]);
  assert.deepEqual(new Set(h.calls.posts.map(payload => payload.number)), new Set(["INV-1001", "INV-1002"]));
  assert.equal(h.rows.sps_invoices.value.length, 2);
});

test("double confirmation of one review cannot issue a second QB write", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ customCreate: async (req, res) => { await blocked; res.status(200).json({ success: true, qbId: "qb-one" }); } });
  const first = h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  while (!h.calls.posts.length) await new Promise(resolve => setImmediate(resolve));
  const second = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(second.statusCode, 202); assert.equal(h.calls.posts.length, 1);
  release(); assert.equal((await first).statusCode, 200); assert.equal(h.calls.posts.length, 1);
});

test("uncertain QB create locks editing and retries only the frozen request", async () => {
  const h = harness({ customCreate: async (req, res, calls) => calls.posts.length === 1
    ? res.status(502).json({ createOutcomeUnknown: true, error: "socket lost" })
    : res.status(200).json({ success: true, qbId: "qb-recovered" }) });
  const first = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(first.statusCode, 202); assert.equal(first.body.review.reviewState, "approving");
  for (const action of ["save", "discard"]) assert.equal((await h.call({ action, reviewId: "review-1", expectedRevision: first.body.review.reviewRevision, review: { notes: "changed" } })).statusCode, 409);
  const retry = await h.call({ action: "retry", reviewId: "review-1", review: { number: "EVIL", lineItems: [] } });
  assert.equal(retry.statusCode, 200); assert.deepEqual(h.calls.posts[1], h.calls.posts[0]); assert.equal(h.calls.inventories, 1);
  assert.equal(h.rows.sps_invoices.value.length, 1);
});

test("QB success then SPS promotion failure retries the saved result without another POST", async () => {
  const h = harness(); h.failPromotion(true);
  const first = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(first.statusCode, 202); assert.equal(h.rows.sps_invoices.value.length, 0);
  assert.equal(h.rows.sps_billing_reviews.value[0].approval.qbResult.qbId, "qb-review-1");
  h.failPromotion(false);
  const result = await h.call({ action: "retry", reviewId: "review-1" });
  assert.equal(result.statusCode, 200); assert.equal(h.calls.posts.length, 1); assert.equal(h.rows.sps_invoices.value.length, 1);
});

test("promotion commit with lost response recovers canonical result without resending", async () => {
  const h = harness(); h.ambiguousPromotion();
  const first = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(first.statusCode, 202); assert.equal(h.rows.sps_invoices.value.length, 1);
  const recovered = await h.call({ action: "retry", reviewId: "review-1" });
  assert.equal(recovered.statusCode, 200); assert.equal(h.calls.posts.length, 1); assert.equal(h.rows.sps_invoices.value.length, 1);
});

test("reopened work and already-claimed completed visits cannot be billed", async () => {
  const review = { ...draft(), sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-1", sourceVisitClientId: "client-1", sourceVisitClientIds: ["client-1"] };
  for (const state of [{ sps_completed: {} }, { sps_completed: { "stop-1": { receiptId: "different" } } }]) {
    const h = harness({ reviews: [review], state });
    assert.equal((await h.call({ action: "confirm", reviewId: review.id, expectedRevision: 1 })).statusCode, 409); assert.equal(h.calls.posts.length, 0);
  }
  const h = harness({ reviews: [review, { ...review, id: "other-review" }], state: { sps_completed: { "stop-1": { receiptId: "receipt-1" } } } });
  assert.equal((await h.call({ action: "confirm", reviewId: review.id, expectedRevision: 1 })).statusCode, 409); assert.equal(h.calls.posts.length, 0);
});

test("a direct-create source claim that won CAS blocks review confirmation", async () => {
  const review = { ...draft(), sourceEstimateId: "estimate-a" };
  const claim = { id: "direct", clientId: "client-1", recordType: "invoice-number-claim", reviewState: "synced", sourceEstimateId: "estimate-a", approval: { number: "INV-1005" } };
  const h = harness({ reviews: [review, claim], state: { sps_estimates: [{ id: "estimate-a", clientId: "client-1" }] } });
  const blocked = await h.call({ action: "confirm", reviewId: "review-1", expectedRevision: 1 });
  assert.equal(blocked.statusCode, 409); assert.equal(h.calls.posts.length, 0); assert.equal(h.calls.inventories, 0);
});

test("promotion replaces estimate and scheduled review backlinks atomically", async () => {
  const review = { ...draft(), sourceEstimateId: "est-1" };
  const h = harness({ reviews: [review], state: {
    sps_estimates: [{ id: "est-1", clientId: "client-1", linkedBillingReviewId: review.id }],
    sps_schedule: [{ date: "10/05/2026", stops: [{ sid: "stop", linkedBillingReviewId: review.id }] }],
  } });
  const result = await h.call({ action: "confirm", reviewId: review.id, expectedRevision: 1 });
  assert.equal(result.statusCode, 200);
  assert.equal(h.rows.sps_estimates.value[0].linkedInvoiceId, review.id); assert.equal(h.rows.sps_estimates.value[0].linkedBillingReviewId, undefined);
  assert.equal(h.rows.sps_schedule.value[0].stops[0].linkedInvoiceId, review.id);
});

test("number claims include approval tombstones and normalize historic prefixes", () => {
  assert.equal(firstUnusedInvoiceNumber(["INV-1001", "1002", "old-1004"], { nextNumber: 1001, numberPrefix: "" }), "1003");
});

test("saved canonical service provenance cannot be replaced through edited lines", () => {
  const review = { ...draft(), lineItems: [{ ...draft().lineItems[0], sourceStopId: "real", maintenanceService: true }] };
  const edited = sanitizeBillingReviewEdit(review, { lineItems: [{ ...review.lineItems[0], sourceStopId: "fake", maintenanceService: false }] });
  assert.equal(edited.lineItems[0].sourceStopId, "real"); assert.equal(edited.lineItems[0].maintenanceService, true);
});
