import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceMaintenanceCoverageIssue,
  maintenanceCoverageForService,
  prepareCoveredMaintenanceEntry,
  savedMaintenanceCoverage,
} from "../maintenanceInvoiceCoverage.js";
import { completedVisitLineItems, appendCompletedVisitsToInvoice } from "../invoiceVisitImport.js";
import { planCompletionInvoice } from "../completionInvoice.js";

const client = { id: "demo-client", name: "Demo Client", monthlyRate: "175", planFreq: "Monthly", history: [] };
const stop = { sid: "demo-stop", clientId: client.id, type: "Monthly Service" };
const sourceInvoice = { id: "paid-source", number: "INV-1", clientId: client.id, status: "Paid", total: 350, balance: 0, date: "09/01/2026" };
const paidCell = () => ({ status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: sourceInvoice.id, amountCents: 17500 }] });
const ledger = () => ({ version: 2, policies: {}, allocations: { [client.id]: { "2026-10": paidCell(), "2026-11": paidCell() } } });
const fixture = () => ({ client, clients: [client], stop, scheduledDate: "10/01/2026", ledger: ledger(), invoices: [sourceInvoice] });
const service = { name: "Monthly maintenance", price: 175 };
const extra = { name: "Replacement valve", qty: 1, retailPer: 25, bill: true };
const draft = () => ({ id: "new-draft", clientId: client.id, date: "10/01/2026", serviceMonth: "2026-10", lineItems: [{ id: "line", desc: "Monthly maintenance", qty: 1, unitPrice: 175, kind: "service" }] });

test("allocated prepaid months use settled canonical invoice evidence without relying on the client mirror", () => {
  const result = maintenanceCoverageForService(fixture());
  assert.equal(result.covered, true);
  assert.equal(result.invoiceEvidenceRequired, true);
  assert.equal(result.snapshot.month, "2026-10");
  assert.equal(result.snapshot.status, "paid");
  assert.equal(maintenanceCoverageForService({ ...fixture(), scheduledDate: "12/01/2026" }).covered, false);
});

test("an exact paid monthly QuickBooks invoice prevents a duplicate before allocations are saved", () => {
  const currentPaid = { ...sourceInvoice, qbId: "qb-paid", date: "10/01/2026", total: 175, lineItems: [{ desc: "Monthly maintenance - October 2026", qty: 1, unitPrice: 175 }] };
  const noAllocations = { version: 2, policies: {}, allocations: {} };
  const result = maintenanceCoverageForService({ ...fixture(), ledger: noAllocations, invoices: [currentPaid] });
  assert.equal(result.covered, true);
  assert.equal(result.invoiceEvidenceRequired, true);
  assert.deepEqual(noAllocations.allocations, {}, "derived coverage does not write ledger allocations");
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: noAllocations, invoices: [currentPaid, { ...currentPaid, id: "duplicate", qbId: "qb-duplicate" }] }).blocked, true);
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: noAllocations, invoices: [{ ...currentPaid, clientId: "other-client" }] }).covered, false);
  const entry = { sid: stop.sid, type: stop.type, date: "10/01/2026", invoice: "$175", services: [service], partsUsed: [extra] };
  const prepared = prepareCoveredMaintenanceEntry({ ...fixture(), ledger: noAllocations, invoices: [currentPaid], entry });
  const plan = planCompletionInvoice({ invoices: [currentPaid], client, stop, entry: prepared.entry, schedule: [{ date: "10/01/2026", stops: [stop] }], completed: { [stop.sid]: true }, completedAt: "2026-10-01T12:00:00Z", maintenanceBillingDecision: prepared.decision });
  assert.deepEqual(plan.invoices[0].lineItems.map(line => line.desc), ["Replacement valve"]);
});

test("coverage rejects wrong owners, ambiguous source IDs, revoked payments, and partial allocations", () => {
  const cases = [
    { invoices: [{ ...sourceInvoice, clientId: "other-client" }] },
    { invoices: [sourceInvoice, { ...sourceInvoice }] },
    { invoices: [{ ...sourceInvoice, status: "Void" }] },
    { invoices: [{ ...sourceInvoice, status: "Draft" }] },
    { invoices: [{ ...sourceInvoice, balance: 1 }] },
    { invoices: [{ ...sourceInvoice, balance: "invalid" }] },
    { invoices: [{ ...sourceInvoice, qbPendingLocalEdits: true }] },
    { invoices: [] },
    { ledger: { version: 2, policies: {}, allocations: { [client.id]: { "2026-10": { ...paidCell(), allocatedCents: 17501 } } } } },
    { ledger: { version: 2, policies: {}, allocations: { [client.id]: { "2026-10": { ...paidCell(), expectedCents: 18000 } } } } },
  ];
  for (const overrides of cases) {
    const result = maintenanceCoverageForService({ ...fixture(), ...overrides });
    assert.equal(result.covered, false, JSON.stringify(overrides));
    assert.equal(result.blocked, true, JSON.stringify(overrides));
  }
});

test("one settled payment cannot be allocated to more service months than it pays for", () => {
  const overallocated = ledger();
  overallocated.allocations[client.id]["2026-12"] = paidCell();
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: overallocated }).reason, "maintenance-payment-overallocated");
});

test("QuickBooks-only ownership must identify exactly one client", () => {
  const qbClient = { ...client, qbId: "qb-client" };
  const invoice = { ...sourceInvoice, clientId: undefined, qbCustomerId: "qb-client" };
  assert.equal(maintenanceCoverageForService({ ...fixture(), client: qbClient, clients: [qbClient], invoices: [invoice] }).covered, true);
  assert.equal(maintenanceCoverageForService({ ...fixture(), client: qbClient, clients: [qbClient, { ...qbClient, id: "other" }], invoices: [invoice] }).blocked, true);
});

test("every supplied source reference must identify the same canonical invoice", () => {
  const conflicting = ledger();
  conflicting.allocations[client.id]["2026-10"].sources[0].qbInvoiceId = "other-qb-invoice";
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: conflicting }).blocked, true);
});

test("waived months are covered, while partial, due, review, refunded, and unverified months are held", () => {
  const waived = ledger();
  waived.allocations[client.id]["2026-10"] = { status: "waived", sources: [{ kind: "waiver", waiverId: "approved-waiver" }] };
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: waived }).snapshot.status, "waived");
  for (const status of ["review", "refunded", "prepaid"]) {
    const pending = ledger();
    pending.allocations[client.id]["2026-10"].status = status;
    assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: pending }).blocked, true, status);
  }
});

test("QuickBooks settlement updates previously due or partial allocations without assigning months again", () => {
  for (const status of ["due", "partial"]) {
    const pending = ledger();
    pending.allocations[client.id]["2026-10"].status = status;
    assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: pending }).covered, true);
    assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: pending, invoices: [{ ...sourceInvoice, balance: 25 }] }).blocked, true);
  }
});

test("repairs, projects, and estimate work remain billable for a prepaid client", () => {
  for (const change of [{ type: "Repair Visit" }, { type: "Pond Project" }, { sourceEstimateId: "estimate" }, { billingMode: "one-off" }]) {
    assert.equal(maintenanceCoverageForService({ ...fixture(), stop: { ...stop, ...change } }).covered, false);
  }
});

test("recorded covered visits stay covered on retry and import, retaining purchased extras", () => {
  const prepared = prepareCoveredMaintenanceEntry({ ...fixture(), entry: { sid: stop.sid, date: "10/01/2026", invoice: "$175", services: [service], partsUsed: [extra] } });
  assert.equal(prepared.entry.invoice, "$0");
  assert.equal(prepared.entry.quoted_price, 175);
  assert.equal(prepared.entry.billingDisposition, "covered-maintenance");
  assert.equal(savedMaintenanceCoverage(prepared.entry).covered, true);
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: null, invoices: [], entry: prepared.entry }).covered, true);
  assert.deepEqual(completedVisitLineItems(prepared.entry, { clientId: client.id }).map(line => line.desc), ["Replacement valve"]);
  const noExtras = { ...prepared.entry, partsUsed: [] };
  assert.equal(appendCompletedVisitsToInvoice({ lineItems: [] }, [noExtras], { clientId: client.id }).addedLineCount, 0);
  const plan = planCompletionInvoice({ invoices: [sourceInvoice], client, stop, entry: prepared.entry, schedule: [{ date: "10/01/2026", stops: [stop] }], completed: { [stop.sid]: true }, completedAt: "2026-10-01T12:00:00Z" });
  assert.deepEqual(plan.invoices[0].lineItems.map(line => line.desc), ["Replacement valve"]);
});

test("policy snapshots also suppress imported maintenance and invalid snapshots cannot rebill it", () => {
  const entry = { billingDisposition: "prepaid-maintenance", maintenanceBillingSnapshot: { version: 1, mode: "prepaid", coveredFrom: "2026-10-01", coveredThrough: "2026-10-31" }, services: [service], partsUsed: [extra] };
  assert.deepEqual(completedVisitLineItems(entry).map(line => line.desc), ["Replacement valve"]);
  assert.equal(savedMaintenanceCoverage({ ...entry, maintenanceBillingSnapshot: null }).blocked, true);
  assert.deepEqual(completedVisitLineItems({ ...entry, maintenanceBillingSnapshot: null }).map(line => line.desc), ["Replacement valve"]);
});

test("covered visits keep separately billable repair labor in imports, completion drafts, and send checks", () => {
  const entry = { sid: stop.sid, type: stop.type, date: "10/01/2026", invoice: "$265", services: [service, { name: "Pump repair labor", price: 90 }], partsUsed: [extra] };
  const prepared = prepareCoveredMaintenanceEntry({ ...fixture(), entry });
  assert.equal(prepared.entry.invoice, "$90.00");
  assert.equal(prepared.entry.quoted_price, 265);
  assert.deepEqual(completedVisitLineItems(prepared.entry, { clientId: client.id }).map(line => [line.desc, line.unitPrice]), [["Pump repair labor", "90"], ["Replacement valve", "25"]]);
  const plan = planCompletionInvoice({ invoices: [sourceInvoice], client, stop, entry: prepared.entry, schedule: [{ date: "10/01/2026", stops: [stop] }], completed: { [stop.sid]: true }, completedAt: "2026-10-01T12:00:00Z" });
  assert.deepEqual(plan.invoices[0].lineItems.map(line => [line.desc, line.unitPrice]), [["Pump repair labor", "90"], ["Replacement valve", "25"]]);
  const repairInvoice = { ...draft(), sourceStopId: stop.sid, lineItems: [{ desc: "Pump repair labor", kind: "service", qty: 1, unitPrice: 90 }] };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...fixture(), client: { ...client, history: [prepared.entry] }, invoice: repairInvoice }), null);
});

test("a billing review preserves work completion and extras without rebilling maintenance on retry", () => {
  const pending = ledger();
  pending.allocations[client.id]["2026-10"].status = "review";
  const entry = { sid: stop.sid, type: stop.type, date: "10/01/2026", invoice: "$265", services: [service, { name: "Pump repair labor", price: 90 }] };
  const prepared = prepareCoveredMaintenanceEntry({ ...fixture(), ledger: pending, entry });
  assert.equal(prepared.entry.billingDisposition, "maintenance-review");
  assert.equal(prepared.entry.invoice, "$90.00");
  assert.equal(savedMaintenanceCoverage(prepared.entry).blocked, true);
  const plan = planCompletionInvoice({ invoices: [sourceInvoice], client, stop, entry: prepared.entry, schedule: [{ date: "10/01/2026", stops: [stop] }], completed: { [stop.sid]: true }, completedAt: "2026-10-01T12:00:00Z" });
  assert.equal(plan.outcome.status, "review_required");
  assert.equal(plan.outcome.maintenanceChargeHeld, true);
  assert.deepEqual(plan.invoices[0].lineItems.map(line => [line.desc, line.unitPrice]), [["Pump repair labor", "90"]]);
  assert.deepEqual(completedVisitLineItems(prepared.entry).map(line => line.desc), ["Pump repair labor"]);
});

test("invoice checks block covered service, permit original payment evidence and unrelated charges", () => {
  const original = { ...sourceInvoice, lineItems: [{ ...draft().lineItems[0], desc: "Monthly maintenance - October and November 2026", qty: 2 }] };
  const options = { client, clients: [client], ledger: ledger(), invoices: [original] };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, invoice: draft() }).code, "maintenance-already-covered");
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, invoice: original }), null);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, invoice: { ...draft(), id: sourceInvoice.id } }).covered, true);
  for (const line of [{ desc: "Pump repair", kind: "service" }, { desc: "Maintenance kit", kind: "product" }, { desc: "Replacement part", kind: "part" }]) {
    assert.equal(invoiceMaintenanceCoverageIssue({ ...options, invoice: { ...draft(), lineItems: [{ ...line, qty: 1, unitPrice: 50 }] } }), null);
  }
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: null, invoice: draft() }).code, "maintenance-coverage-review");
});

test("invoice coverage follows the service month rather than a later invoice issue date", () => {
  const invoice = { ...draft(), date: "12/01/2026", autoPeriod: "2026-10" };
  assert.deepEqual(invoiceMaintenanceCoverageIssue({ ...fixture(), invoice }).months, ["2026-10"]);
  const repair = { sid: "repair", type: "Repair Visit", date: "10/02/2026" };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...fixture(), client: { ...client, history: [repair] }, invoice: { ...invoice, sourceStopId: repair.sid, lineItems: [{ desc: "Pump repair", kind: "service", qty: 1, unitPrice: 50 }] } }), null);
});

test("explicit monthly periods respect protected prepaid policies and exempt their source invoice", () => {
  const invoice = { ...draft(), autoPeriod: "2026-10", date: "12/01/2026" };
  const original = { ...sourceInvoice, ...invoice, id: sourceInvoice.id, number: sourceInvoice.number };
  const options = { ...fixture(), invoices: [original] };
  const policyLedger = { version: 1, policies: { [client.id]: { version: 1, mode: "prepaid", coveredFrom: "2026-10-01", coveredThrough: "2026-10-31", sourceInvoiceId: sourceInvoice.id } } };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: policyLedger, invoice }).covered, true);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: policyLedger, invoice: original }), null);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: policyLedger, invoice: { ...invoice, number: sourceInvoice.number, qbId: sourceInvoice.id } }).covered, true);
  const numberOnlyPolicy = structuredClone(policyLedger);
  delete numberOnlyPolicy.policies[client.id].sourceInvoiceId;
  numberOnlyPolicy.policies[client.id].sourceInvoiceNumber = sourceInvoice.number;
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: numberOnlyPolicy, invoice: { ...invoice, number: sourceInvoice.number } }).covered, true);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, ledger: numberOnlyPolicy, invoice: original }), null);
});

test("candidate service dates and dated descriptions override the invoice issue month", () => {
  for (const change of [
    { serviceMonth: "2026-10" },
    { serviceDate: "2026-10-15" },
    { desc: "October 2026 maintenance" },
    { desc: "Monthly service 10/15/2026" },
  ]) {
    const invoice = { ...draft(), date: "12/01/2026", serviceMonth: undefined, lineItems: [{ ...draft().lineItems[0], ...change }] };
    const result = invoiceMaintenanceCoverageIssue({ ...fixture(), invoice });
    assert.equal(result.code, "maintenance-already-covered", JSON.stringify(change));
    assert.deepEqual(result.months, ["2026-10"]);
  }
});

test("candidate maintenance never borrows its issue date when the service month is missing or conflicting", () => {
  const invoice = { ...draft(), serviceMonth: undefined };
  const missing = invoiceMaintenanceCoverageIssue({ ...fixture(), invoice });
  assert.equal(missing.code, "maintenance-service-month-missing");
  assert.equal(missing.covered, false);
  assert.deepEqual(missing.months, []);
  assert.deepEqual(missing.lineIndexes, [0]);
  const conflicting = { ...invoice, lineItems: [{ ...invoice.lineItems[0], serviceMonth: "2026-11", desc: "October 2026 maintenance" }] };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...fixture(), invoice: conflicting }).code, "maintenance-service-month-conflict");
});

test("each maintenance line checks its own service month on a mixed-month invoice", () => {
  const invoice = { ...draft(), serviceMonth: "2026-12", lineItems: [
    { ...draft().lineItems[0], serviceMonth: "2026-10" },
    { ...draft().lineItems[0], id: "second", desc: "November 2026 maintenance" },
  ] };
  assert.deepEqual(invoiceMaintenanceCoverageIssue({ ...fixture(), invoice }).months, ["2026-10", "2026-11"]);
});

test("completed visit dates override supplied month metadata and a moved schedule", () => {
  const completed = { ...stop, date: "12/01/2026", maintenanceBillingServiceDate: "2026-10-15" };
  const linkedClient = { ...client, history: [completed] };
  const invoice = { ...draft(), date: "12/01/2026", serviceMonth: "2026-12", sourceStopId: stop.sid,
    lineItems: [{ ...draft().lineItems[0], desc: "Services", serviceMonth: "2026-12", sourceVisitDates: ["2026-12-01"] }] };
  const options = { ...fixture(), client: linkedClient, clients: [linkedClient], invoice, schedule: [{ date: "12/01/2026", stops: [stop] }] };
  assert.deepEqual(invoiceMaintenanceCoverageIssue(options).months, ["2026-10"]);
  const conflicting = { ...invoice, lineItems: [{ ...invoice.lineItems[0], desc: "December 2026 maintenance" }] };
  assert.equal(invoiceMaintenanceCoverageIssue({ ...options, invoice: conflicting }).code, "maintenance-service-month-conflict");
});

test("line-specific visit sources do not inherit other invoice months", () => {
  const otherStop = { ...stop, sid: "november-stop" };
  const linkedClient = { ...client, history: [{ ...stop, date: "10/15/2026" }, { ...otherStop, date: "11/15/2026" }] };
  const invoice = { ...draft(), sourceStopIds: [stop.sid, otherStop.sid], lineItems: [
    { ...draft().lineItems[0], desc: "October 2026 maintenance", sourceStopId: stop.sid },
    { ...draft().lineItems[0], id: "november-line", desc: "November 2026 maintenance", sourceStopId: otherStop.sid },
  ] };
  const result = invoiceMaintenanceCoverageIssue({ ...fixture(), client: linkedClient, clients: [linkedClient], invoice });
  assert.equal(result.code, "maintenance-already-covered");
  assert.deepEqual(result.months, ["2026-10", "2026-11"]);
  assert.equal(result.decisions.some(decision => decision.serviceIssue), false);
});

test("owned scheduled maintenance supplies a service date only when completed history is absent", () => {
  const invoice = { ...draft(), serviceMonth: undefined, date: "12/01/2026", sourceStopId: stop.sid,
    lineItems: [{ ...draft().lineItems[0], desc: "Services" }] };
  const result = invoiceMaintenanceCoverageIssue({ ...fixture(), invoice, schedule: [{ date: "10/15/2026", stops: [stop] }] });
  assert.deepEqual(result.months, ["2026-10"]);
  const explicit = { ...invoice, lineItems: draft().lineItems };
  const otherOwner = invoiceMaintenanceCoverageIssue({ ...fixture(), invoice: explicit, schedule: [{ date: "10/15/2026", stops: [{ ...stop, clientId: "someone-else" }] }] });
  assert.equal(otherOwner.code, "maintenance-service-month-missing");
});

test("seasonal work and repairs do not acquire maintenance coverage or require a service month", () => {
  for (const desc of ["Pool opening", "Pool closing", "Winterizing service", "Maintenance equipment replacement", "Pump repair"]) {
    const invoice = { ...draft(), serviceMonth: undefined, source: "monthly-maintenance", sourceStopId: stop.sid,
      lineItems: [{ ...draft().lineItems[0], desc }] };
    assert.equal(invoiceMaintenanceCoverageIssue({ ...fixture(), invoice, ledger: null, client: { ...client, history: [{ ...stop, date: "10/15/2026" }] } }), null, desc);
  }
});

const ownerDecisionLedger = (decision = 'unpaid') => ({ version: 2, policies: {}, allocations: {
  [client.id]: { '2026-10': { status: decision === 'paid' ? 'paid' : 'due',
    sources: [{ kind: 'manual', recordId: `manual:${client.id}:2026-10`, decision }],
    expectedCents: 17500, allocatedCents: decision === 'paid' ? 17500 : 0,
    note: 'Owner checked the maintenance record', updatedAt: '2026-10-05T12:00:00Z', updatedBy: 'owner@example.test' } },
} });

test('an explicit owner unpaid month permits a new invoice despite uncertain history', () => {
  const uncertain = { ...sourceInvoice, qbId: 'uncertain', status: 'Partial', balance: 250,
    lineItems: [{ desc: 'Maintenance prepayment', qty: 1, unitPrice: 350 }] };
  const args = { ...fixture(), ledger: ownerDecisionLedger(), invoices: [uncertain] };
  assert.equal(maintenanceCoverageForService(args).reason, 'maintenance-month-owner-unpaid');
  assert.equal(invoiceMaintenanceCoverageIssue({ ...args, invoice: draft() }), null);
});

test('owner unpaid cannot override a prepaid policy, actual dated payment, or immutable paid completion', () => {
  const manual = ownerDecisionLedger();
  const policy = { ...manual, policies: { [client.id]: { version: 1, mode: 'prepaid', coveredFrom: '2026-10-01', coveredThrough: '2026-10-31' } } };
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: policy }).covered, true);
  const actualPaid = { ...sourceInvoice, qbId: 'dated-paid', total: 175,
    lineItems: [{ desc: 'Monthly maintenance - October 2026', qty: 1, unitPrice: 175 }] };
  const paid = maintenanceCoverageForService({ ...fixture(), ledger: manual, invoices: [actualPaid] });
  assert.equal(paid.covered, true);
  const partlyPaid = { ...actualPaid, status: 'Partial', balance: 25 };
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: manual, invoices: [partlyPaid] }).blocked, true);
  const completed = prepareCoveredMaintenanceEntry({ ...fixture(), entry: { ...stop, invoice: '$175', services: [service] } }).entry;
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: manual, invoices: [], entry: completed }).covered, true);
});

test('owner paid protects a month and later owner unpaid resolves only stored review holds', () => {
  const manuallyPaid = ownerDecisionLedger('paid');
  const paid = prepareCoveredMaintenanceEntry({ ...fixture(), ledger: manuallyPaid, invoices: [], entry: { ...stop, invoice: '$175', services: [service] } });
  assert.equal(paid.decision.covered, true);
  assert.equal(savedMaintenanceCoverage(paid.entry).covered, true);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...fixture(), ledger: manuallyPaid, invoice: draft() }).code, 'maintenance-already-covered');

  const reviewed = { sid: stop.sid, type: stop.type, date: '10/01/2026', billingDisposition: 'maintenance-review',
    maintenanceBillingServiceDate: '2026-10-01', maintenanceBillingSnapshot: { version: 1, mode: 'review', clientId: client.id, month: '2026-10', reason: 'maintenance-payment-evidence-unverified' } };
  const linkedClient = { ...client, history: [reviewed] };
  const args = { ...fixture(), client: linkedClient, clients: [linkedClient], ledger: ownerDecisionLedger(), invoices: [] };
  assert.equal(maintenanceCoverageForService({ ...args, entry: reviewed }).blocked, undefined);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...args, invoice: { ...draft(), sourceStopId: stop.sid } }), null);
});

test('an unchanged matched unpaid invoice can be sent without declaring its month paid', () => {
  const original = { ...draft(), status: 'Sent', balance: 175, total: 175 };
  const matched = { version: 2, policies: {}, allocations: { [client.id]: { '2026-10': {
    status: 'due', expectedCents: 17500, allocatedCents: 17500,
    sources: [{ kind: 'invoice', invoiceId: original.id, amountCents: 17500 }],
  } } } };
  const args = { ...fixture(), ledger: matched, invoices: [original] };
  assert.equal(maintenanceCoverageForService(args).covered, false);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...args, invoice: original }), null);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...args, invoice: { ...original, id: 'duplicate' } }).covered, false);
  assert.equal(invoiceMaintenanceCoverageIssue({ ...args, invoice: { ...original, id: 'duplicate' } }).code, 'maintenance-coverage-review');
});

test('automatic coverage never turns an invoice issue date into a service month', () => {
  const undated = { ...sourceInvoice, qbId: 'undated-paid', date: '10/01/2026', total: 175,
    lineItems: [{ desc: 'Monthly maintenance', qty: 1, unitPrice: 175 }] };
  const empty = { version: 2, policies: {}, allocations: {} };
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: empty, invoices: [undated] }).covered, false);
  assert.equal(maintenanceCoverageForService({ ...fixture(), ledger: empty, invoices: [{ ...undated,
    lineItems: [{ desc: 'Monthly maintenance - September 2026', qty: 1, unitPrice: 175 }] }] }).covered, false);
});
