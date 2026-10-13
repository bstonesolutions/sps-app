import assert from "node:assert/strict";
import test from "node:test";
import { invoiceVisitDetails } from "../invoiceVisitDetails.js";
import { appendCompletedVisitsToInvoice } from "../invoiceVisitImport.js";

const report = (overrides = {}) => ({
  sid: "stop-1", completionReceiptId: "receipt-1", date: "09/29/2026", type: "Repair visit", tech: "David",
  notes: "Cleared debris from the pump", officeNotes: "Warranty visit, review before charging",
  workPerformed: ["Cleared the intake"], services: [{ name: "Repair labor", price: 175 }],
  products: [{ name: "Stress Coat", qty: 2, unit: "oz", bill: false }],
  partsUsed: [{ name: "Filter", qty: 1, bill: true, retailPer: 25 }],
  productsPurchased: [{ name: "Pump", qty: 1, bill: false, price: 250 }],
  photos: [{ url: "https://example.com/saved-photo.jpg", caption: "Cleared pump intake" }],
  ...overrides,
});
const client = (history = [report()], overrides = {}) => ({ id: "client-1", qbId: "487", name: "Client", history, ...overrides });
const invoice = (overrides = {}) => ({ id: "invoice-1", clientId: "client-1", number: "2101", lineItems: [], ...overrides });
const resolve = (iv, history = [report()], options = {}) => invoiceVisitDetails({ invoice: iv, client: client(history), ...options });

test("a fresh invoice without a chosen client has no misleading missing-report warning", () => {
  for (const emptyInvoice of [undefined, null, { id: "new-local-invoice", clientId: "", lineItems: [] }]) {
    const result = invoiceVisitDetails({ invoice: emptyInvoice });
    assert.deepEqual(result.visits, []);
    assert.deepEqual(result.missing, []);
    assert.equal(result.clientMismatch, false);
  }
  const unresolvedClient = invoiceVisitDetails({ invoice: invoice({ sourceStopId: "stop-1" }) });
  assert.equal(unresolvedClient.clientMismatch, true);
});

test("exact stop and receipt resolve the complete unmodified report including included materials", () => {
  const entry = report();
  const iv = invoice({ sourceStopId: entry.sid, sourceCompletionReceiptId: entry.completionReceiptId });
  const before = JSON.stringify({ entry, iv });
  const result = resolve(iv, [entry]);
  assert.equal(result.visits.length, 1);
  assert.equal(result.visits[0].entry, entry);
  assert.equal(result.visits[0].entry.products[0].bill, false);
  assert.equal(result.visits[0].entry.partsUsed[0].bill, true);
  assert.equal(result.visits[0].entry.photos[0].caption, "Cleared pump intake");
  assert.equal(result.visits[0].entry.officeNotes, "Warranty visit, review before charging");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(JSON.stringify({ entry, iv }), before);
});

test("a different client cannot supply the linked report even when source ids and QB ids overlap", () => {
  const result = resolve(invoice({ clientId: "other", qbCustomerId: "487", sourceStopId: "stop-1" }));
  assert.equal(result.clientMismatch, true);
  assert.deepEqual(result.visits, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.missing[0].code, "client-mismatch");
  const sourceMismatch = resolve(invoice({ sourceVisitClientId: "other", sourceStopId: "stop-1" }));
  assert.equal(sourceMismatch.clientMismatch, true);
});

test("QuickBooks customer identity verifies a raw import but a matching name alone does not", () => {
  const rawImport = invoice({ clientId: undefined, clientName: "Client", qbCustomerId: "487" });
  const result = resolve(rawImport);
  assert.equal(result.clientMismatch, false);
  assert.equal(result.visits.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.equal(resolve({ ...rawImport, qbCustomerId: "different" }).clientMismatch, true);
  assert.equal(resolve({ ...rawImport, qbCustomerId: undefined }).clientMismatch, true);
});

test("explicit ownership on a line source or saved report cannot cross clients", () => {
  const wrongSource = resolve(invoice({ lineSources: [{ stopId: "stop-1", clientId: "other" }] }));
  assert.equal(wrongSource.clientMismatch, true);
  assert.deepEqual(wrongSource.candidates, []);
  const wrongReport = resolve(invoice({ sourceStopId: "stop-1" }), [report({ clientId: "other" })]);
  assert.equal(wrongReport.visits.length, 0);
  assert.equal(wrongReport.candidates.length, 0);
  assert.equal(wrongReport.missing[0].code, "missing-report");
});

test("a valid linked report remains visible while a different linked report is missing", () => {
  const result = resolve(invoice({ sourceStopIds: ["stop-1", "missing-stop"], sourceCompletionReceiptIds: ["receipt-1", "missing-receipt"] }));
  assert.equal(result.visits.length, 1);
  assert.equal(result.missing.length, 2);
  assert.ok(result.missing.every(issue => issue.code === "missing-report"));
  assert.equal(result.hasSources, true);
});

test("a receipt and stop that point to different reports cannot be silently combined", () => {
  const other = report({ sid: "stop-2", completionReceiptId: "receipt-2" });
  const result = resolve(invoice({ sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-2" }), [report(), other]);
  assert.equal(result.visits.length, 0);
  assert.equal(result.ambiguous, true);
  assert.ok(result.missing.every(issue => issue.code === "source-mismatch"));
  assert.equal(result.candidates.length, 2);
});

test("the same report on invoice and multiple lines appears once", () => {
  const result = resolve(invoice({ sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-1", lineItems: [
    { sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-1", desc: "Repair visit" },
    { sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-1", desc: "Stress Coat" },
  ] }));
  assert.equal(result.visits.length, 1);
  assert.deepEqual(result.missing, []);
});

test("exact duplicate saved copies are collapsed but different versions are flagged", () => {
  const entry = report();
  const iv = invoice({ sourceCompletionReceiptId: "receipt-1" });
  const duplicate = JSON.parse(JSON.stringify(entry));
  assert.equal(resolve(iv, [entry, duplicate]).visits.length, 1);
  const conflicting = resolve(iv, [entry, { ...duplicate, officeNotes: "Charge additional labor" }]);
  assert.equal(conflicting.visits.length, 0);
  assert.equal(conflicting.ambiguous, true);
  assert.equal(conflicting.missing[0].code, "ambiguous-report");
  assert.equal(conflicting.candidates.length, 2);
});

test("stop-only references do not choose between multiple completion receipts", () => {
  const result = resolve(invoice({ sourceStopId: "stop-1" }), [report(), report({ completionReceiptId: "receipt-revised" })]);
  assert.equal(result.visits.length, 0);
  assert.equal(result.missing[0].code, "ambiguous-report");
  const exact = resolve(invoice({ sourceStopId: "stop-1", sourceCompletionReceiptId: "receipt-revised" }), [report(), report({ completionReceiptId: "receipt-revised" })]);
  assert.equal(exact.visits.length, 1);
  assert.equal(exact.visits[0].entry.completionReceiptId, "receipt-revised");
});

test("monthly invoice shows each sourced visit, regardless of invoice issue date", () => {
  const first = report({ date: "08/03/2026" });
  const second = report({ sid: "stop-2", completionReceiptId: "receipt-2", date: "08/25/2026" });
  const unrelated = report({ sid: "stop-3", completionReceiptId: "receipt-3", date: "08/28/2026" });
  const iv = invoice({ date: "10/13/2026", source: "monthly-maintenance", autoPeriod: "2026-08", sourceStopIds: ["stop-1", "stop-2"], sourceCompletionReceiptIds: ["receipt-1", "receipt-2"] });
  const result = resolve(iv, [first, second, unrelated]);
  assert.deepEqual(result.visits.map(row => row.entry.sid), ["stop-2", "stop-1"]);
  assert.deepEqual(result.candidates.map(row => row.entry.sid), ["stop-3"]);
  assert.equal(result.period, "2026-08");
});

test("monthly period, description, price and issue date cannot invent a linked source", () => {
  const result = resolve(invoice({ date: "09/29/2026", autoPeriod: "2026-09", source: "monthly-maintenance", lineItems: [{ desc: "Repair visit", unitPrice: 175 }] }));
  assert.deepEqual(result.visits, []);
  assert.equal(result.hasSources, false);
  assert.equal(result.candidates.length, 1);
});

test("legacy autoDraftKey resolves an exact stop key without parsing an arbitrary description", () => {
  for (const key of ["stop-1", "stop:stop-1", "stop-1:completion"]) {
    const result = resolve(invoice({ autoDraftKey: key }));
    assert.equal(result.visits.length, 1);
    assert.equal(result.visits[0].match, "legacy-key");
  }
  const missing = resolve(invoice({ autoDraftKey: "Repair visit:09/29/2026" }));
  assert.equal(missing.visits.length, 0);
  assert.equal(missing.missing[0].code, "missing-report");
});

test("lineSources supports saved source objects without relying on visible line wording", () => {
  const result = resolve(invoice({ lineSources: [{ stopId: "stop-1", receiptId: "receipt-1" }], lineItems: [{ desc: "Stress Coat" }] }));
  assert.equal(result.visits.length, 1);
  assert.equal(result.visits[0].entry.type, "Repair visit");
  const mapped = resolve(invoice({ lineSources: { "line-1": { sourceStopId: "stop-1" } } }));
  assert.equal(mapped.visits.length, 1);
});

test("safe reverse invoice links locate history and never synthesize a report from schedule", () => {
  const reverse = resolve(invoice(), [report({ linkedInvoiceId: "invoice-1" })]);
  assert.equal(reverse.visits[0].match, "report-link");
  const schedule = [{ date: "09/29/2026", stops: [{ sid: "stop-1", clientId: "client-1", linkedInvoiceId: "invoice-1", type: "Planned different work" }] }];
  assert.equal(resolve(invoice(), [report()], { schedule }).visits[0].entry.type, "Repair visit");
  const absent = resolve(invoice(), [], { schedule });
  assert.deepEqual(absent.visits, []);
  assert.equal(absent.missing[0].code, "missing-report");
  const wrongClientSchedule = [{ stops: [{ ...schedule[0].stops[0], clientId: "other" }] }];
  assert.equal(resolve(invoice(), [report()], { schedule: wrongClientSchedule }).visits.length, 0);
});

test("billing reviews find their linked saved reports before an invoice number exists", () => {
  const result = resolve(invoice({ id: "review-1", number: "", recordType: "billing-review" }), [report({ linkedBillingReviewId: "review-1" })]);
  assert.equal(result.visits.length, 1);
});

test("old From a visit imports with generated history identities still find their exact report", () => {
  const legacy = report({ sid: undefined, completionReceiptId: undefined });
  const imported = appendCompletedVisitsToInvoice(invoice(), [legacy], { clientId: "client-1" }).invoice;
  const result = resolve(imported, [legacy]);
  assert.equal(result.visits.length, 1);
  assert.equal(result.visits[0].entry, legacy);
});

test("invoice 2101 can show separate client reports without pretending either is its source", () => {
  const older = report({ sid: "june-repair", completionReceiptId: undefined, date: "06/26/2026", services: [{ name: "Repair visit", price: 200 }] });
  const recent = report({ sid: "august-maintenance", completionReceiptId: "august-receipt", date: "08/18/2026", type: "Monthly service" });
  const result = resolve(invoice({ id: "qb_5359", qbCustomerId: "487", source: "quickbooks", lineItems: [{ desc: "Repair visit", unitPrice: 175 }], date: "09/29/2026" }), [older, recent]);
  assert.equal(result.visits.length, 0);
  assert.equal(result.hasSources, false);
  assert.deepEqual(result.candidates.map(row => row.entry.sid), ["august-maintenance", "june-repair"]);
});
