import assert from "node:assert/strict";
import test from "node:test";

import {
  assignMaintenanceInvoiceMonths,
  assignMaintenancePaymentSourceAcrossMonths,
  buildMaintenancePaymentLedgerRows,
  clearMaintenancePaymentMonths,
  emptyMaintenancePaymentLedger,
  maintenancePaymentAllocationForMonth,
  maintenancePaymentDisplayStatus,
  moneyToCents,
  normalizeMaintenancePaymentLedger,
  normalizeMonthKey,
  reconcileMaintenancePaymentHistory,
  setMaintenancePaymentMonthOverride,
} from "../maintenancePaymentLedger.js";

const recurringClient = (overrides = {}) => ({
  id: "client-1",
  name: "Jamie Price",
  status: "Active",
  planFreq: "Monthly",
  monthlyRate: "229.00",
  qbId: "qb-customer-1",
  ...overrides,
});

const invoice = (overrides = {}) => ({
  id: "invoice-1",
  qbId: "qb-invoice-1",
  number: "2050",
  clientId: "client-1",
  date: "2026-04-15",
  total: 229,
  balance: 0,
  status: "Paid",
  lineItems: [{ desc: "Monthly maintenance", amount: 229 }],
  ...overrides,
});

const paidQuickBooksSeriesInvoice = (month, overrides = {}) => {
  const amount = overrides.total ?? 175;
  return invoice({
    id: `invoice-${month}`,
    qbId: `qb-invoice-${month}`,
    number: `series-${month}`,
    date: `${month}-15`,
    total: amount,
    balance: 0,
    status: "Paid",
    taxAmount: 0,
    taxRate: 0,
    discountType: "",
    discount: "",
    qbHasUnsupportedLines: false,
    qbUnsupportedLineTypes: [],
    lineItems: [{
      desc: "Services",
      qty: "1",
      unitPrice: String(amount),
      taxable: false,
      kind: "service",
      qbItemRef: { value: "qb-service-item-1", name: "Services" },
    }],
    ...overrides,
  });
};

const cell = (rows, month, clientId = "client-1") => (
  rows.find((row) => row.clientId === clientId)?.byMonth?.[month]
);

test("money and month normalization are deterministic", () => {
  assert.equal(moneyToCents("$1,229.95"), 122995);
  assert.equal(moneyToCents(2.345), 235);
  assert.equal(normalizeMonthKey("2026-04-30"), "2026-04");
  assert.equal(normalizeMonthKey("07/10/2025"), "2025-07");
  assert.equal(normalizeMonthKey("02/29/2024"), "2024-02");
  assert.equal(normalizeMonthKey("02/29/2025"), "");
  assert.equal(normalizeMonthKey("7/10/2025"), "2025-07");
  assert.equal(normalizeMonthKey("8/3/2026"), "2026-08");
  assert.equal(normalizeMonthKey("7/40/2025"), "");
  assert.equal(normalizeMonthKey("2026-13"), "");
});

test("future uncovered months stay upcoming instead of inflating missing-payment work", () => {
  assert.equal(maintenancePaymentDisplayStatus("missing", "2026-09", "2026-08"), "upcoming");
  assert.equal(maintenancePaymentDisplayStatus("missing", "2026-08", "2026-08"), "missing");
  assert.equal(maintenancePaymentDisplayStatus("due", "2026-09", "2026-08"), "due");
});

test("the v2 ledger is strict and starts empty", () => {
  assert.deepEqual(emptyMaintenancePaymentLedger(), { version: 2, policies: {}, allocations: {} });
  assert.equal(normalizeMaintenancePaymentLedger(null), null);
  assert.equal(normalizeMaintenancePaymentLedger({ version: 2, policies: {}, allocations: [] }), null);
  assert.equal(normalizeMaintenancePaymentLedger({
    version: 2,
    policies: {},
    allocations: {
      "client-1": {
        "2026-04": { status: "paid", sources: [{ kind: "invoice" }] },
      },
    },
  }), null, "an allocation without traceable evidence fails closed");
});

test("a protected v1 prepaid policy store upgrades without trusting the client mirror", () => {
  const v1 = {
    version: 1,
    policies: {
      "client-1": {
        version: 1,
        mode: "prepaid",
        coveredFrom: "2026-04-01",
        coveredThrough: "2026-06-30",
        sourceInvoiceId: "annual-prepay",
      },
    },
  };
  const upgraded = normalizeMaintenancePaymentLedger(v1);
  assert.equal(upgraded.version, 2);
  assert.deepEqual(Object.keys(upgraded.allocations["client-1"]), ["2026-04", "2026-05", "2026-06"]);
  assert.equal(upgraded.allocations["client-1"]["2026-05"].status, "prepaid");
  assert.equal(upgraded.policies["client-1"].sourceInvoiceId, "annual-prepay");

  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({
      maintenanceBilling: {
        version: 1,
        mode: "prepaid",
        coveredFrom: "2026-01-01",
        coveredThrough: "2026-12-31",
      },
    })],
    invoices: [],
    payments: [],
    ledger: upgraded,
    year: 2026,
  });
  assert.equal(cell(rows, "2026-05").payment.status, "prepaid");
  assert.equal(cell(rows, "2026-07").payment.status, "plan_history_needed", "the client mirror cannot extend protected coverage");
});

test("a current recurring plan does not retroactively manufacture missing months", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice()],
    payments: [],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").expectedCents, 22900);
  assert.equal(cell(rows, "2026-04").payment.status, "paid");
  assert.equal(cell(rows, "2026-04").payment.appliedCents, 22900);
  assert.equal(cell(rows, "2026-03").payment.status, "not_expected");
  assert.equal(cell(rows, "2026-05").payment.status, "plan_history_needed");
  assert.equal(cell(rows, "2026-05").payment.evidenceState, "plan_history_needed");
});

test("an open or partly settled invoice remains due or partial", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [
      invoice({ id: "due", qbId: "due", date: "2026-04-01", balance: 229, status: "Sent" }),
      invoice({ id: "partial", qbId: "partial", date: "2026-05-01", balance: 100, status: "Sent" }),
    ],
    payments: [],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").payment.status, "due");
  assert.equal(cell(rows, "2026-05").payment.status, "partial");
});

test("linked QuickBooks payment evidence can settle an otherwise open invoice", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice({ balance: 229, status: "Sent" })],
    payments: [{
      id: "payment-local",
      qbId: "qb-payment-1",
      total: 229,
      invoiceAllocations: [{ qbInvoiceId: "qb-invoice-1", amount: 229 }],
    }],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").payment.status, "paid");
});

test("an ambiguous multi-month amount is review instead of auto-paid", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice({ total: 687, balance: 0 })],
    payments: [],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").payment.status, "review");
  assert.match(cell(rows, "2026-04").payment.reasons.join(" "), /more than one maintenance month/i);
  assert.equal(cell(rows, "2026-05").payment.status, "plan_history_needed");
});

test("explicit invoice months let one paid invoice cover several months", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice({
      total: 687,
      maintenanceMonths: ["2026-04", "2026-05", "2026-06"],
    })],
    payments: [],
    year: 2026,
  });
  for (const month of ["2026-04", "2026-05", "2026-06"]) {
    assert.equal(cell(rows, month).payment.status, "paid");
    assert.equal(cell(rows, month).payment.appliedCents, 22900);
  }
});

test("the assignment helper distributes an invoice exactly and replaces stale month assignments", () => {
  const first = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2026-04", "2026-05", "2026-06"],
    invoice: invoice({ total: 687 }),
    expectedCents: 22900,
    status: "paid",
    note: "Spring prepayment",
    actor: "owner-1",
    updatedAt: "2026-04-01T12:00:00Z",
  });
  assert.equal(maintenancePaymentAllocationForMonth(first, "client-1", "2026-04").allocatedCents, 22900);
  assert.equal(maintenancePaymentAllocationForMonth(first, "client-1", "2026-05").updatedBy, "owner-1");

  const moved = assignMaintenanceInvoiceMonths(first, {
    clientId: "client-1",
    monthKeys: ["2026-05", "2026-06", "2026-07"],
    invoice: invoice({ total: 687 }),
    expectedCents: 22900,
  });
  assert.equal(maintenancePaymentAllocationForMonth(moved, "client-1", "2026-04"), null);
  assert.equal(maintenancePaymentAllocationForMonth(moved, "client-1", "2026-07").allocatedCents, 22900);
});

test("month allocations can be cleared without touching protected policies or other months", () => {
  const assigned = assignMaintenanceInvoiceMonths({
    version: 2,
    policies: {
      "client-1": {
        version: 1,
        mode: "prepaid",
        coveredFrom: "2025-04-01",
        coveredThrough: "2025-04-30",
      },
    },
    allocations: {},
  }, {
    clientId: "client-1",
    monthKeys: ["2026-04", "2026-05"],
    invoice: invoice({ total: 458 }),
  });
  const cleared = clearMaintenancePaymentMonths(assigned, {
    clientId: "client-1",
    monthKeys: ["2026-04"],
  });
  assert.equal(maintenancePaymentAllocationForMonth(cleared, "client-1", "2026-04"), null);
  assert.ok(maintenancePaymentAllocationForMonth(cleared, "client-1", "2026-05"));
  assert.equal(cleared.policies["client-1"].coveredFrom, "2025-04-01");
});

test("manual month allocation wins only while its invoice or payment source still exists", () => {
  const ledger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2026-05"],
    invoice: invoice(),
    expectedCents: 22900,
  });
  const valid = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice({ date: "2026-04-15" })],
    payments: [],
    ledger,
    year: 2026,
  });
  assert.equal(cell(valid, "2026-05").payment.status, "paid");
  assert.equal(cell(valid, "2026-05").payment.manual, true);
  assert.equal(cell(valid, "2026-06").payment.status, "plan_history_needed");

  const stale = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [],
    payments: [],
    ledger,
    year: 2026,
  });
  assert.equal(cell(stale, "2026-05").payment.status, "review");
  assert.match(cell(stale, "2026-05").payment.reasons[0], /no longer points to a valid/i);
});

test("SPS and QuickBooks payment identifiers never match across namespaces", () => {
  const cases = [
    {
      source: { kind: "payment", paymentId: "shared-id" },
      payment: { id: "other-sps-id", qbId: "shared-id", total: 229 },
    },
    {
      source: { kind: "payment", qbPaymentId: "shared-id" },
      payment: { id: "shared-id", qbId: "other-qb-id", total: 229 },
    },
  ];

  for (const { source, payment } of cases) {
    const ledger = assignMaintenancePaymentSourceAcrossMonths(emptyMaintenancePaymentLedger(), {
      clientId: "client-1",
      months: ["2026-04"],
      source,
      status: "paid",
      totalCents: 22900,
      expectedCents: 22900,
    });
    const rows = buildMaintenancePaymentLedgerRows({
      clients: [recurringClient()],
      invoices: [],
      payments: [payment],
      ledger,
      year: 2026,
    });

    assert.equal(cell(rows, "2026-04").payment.status, "review");
    assert.match(cell(rows, "2026-04").payment.reasons[0], /no longer points to a valid/i);
  }
});

test("a protected prepaid month remains prepaid and flags an overlapping invoice", () => {
  const billingStore = {
    version: 1,
    policies: {
      "client-1": {
        version: 1,
        mode: "prepaid",
        coveredFrom: "2026-04-01",
        coveredThrough: "2026-06-30",
        sourceInvoiceNumber: "PREPAY-2026",
      },
    },
  };
  const clean = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [],
    payments: [],
    billingStore,
    year: 2026,
  });
  assert.equal(cell(clean, "2026-04").payment.status, "prepaid");

  const duplicate = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice()],
    payments: [],
    billingStore,
    year: 2026,
  });
  assert.equal(cell(duplicate, "2026-04").payment.status, "review");
  assert.match(cell(duplicate, "2026-04").payment.reasons[0], /overlaps/i);
});

test("waived and refunded are explicit, source-backed states", () => {
  const waived = setMaintenancePaymentMonthOverride(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKey: "2026-04",
    status: "waived",
    source: { kind: "waiver", waiverId: "owner-waiver-2026-04" },
    note: "Courtesy month",
  });
  const waivedRows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()], invoices: [], payments: [], ledger: waived, year: 2026,
  });
  assert.equal(cell(waivedRows, "2026-04").payment.status, "waived");

  const refunded = setMaintenancePaymentMonthOverride(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKey: "2026-05",
    status: "refunded",
    source: { kind: "refund", refundId: "refund-1", invoiceId: "invoice-1" },
  });
  const refundedRows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()], invoices: [invoice()], payments: [], ledger: refunded, year: 2026,
  });
  assert.equal(cell(refundedRows, "2026-05").payment.status, "refunded");
});

test("payment and service schedule state stay separate", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice()],
    payments: [],
    schedule: [
      { id: "visit-1", clientId: "client-1", date: "2026-04-03", status: "Completed" },
      { id: "visit-2", clientId: "client-1", date: "2026-04-17", status: "Scheduled" },
    ],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").payment.status, "paid");
  assert.deepEqual(cell(rows, "2026-04").schedule, {
    expected: true,
    visitCount: 2,
    completedCount: 1,
    openCount: 1,
    serviceDates: ["2026-04-03", "2026-04-17"],
  });
});

test("a recurring schedule row can establish expectation for a legacy client without profile cadence", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({ planFreq: "" })],
    invoices: [],
    payments: [],
    schedule: [{ clientId: "client-1", date: "2026-04-03", frequency: "Monthly", status: "Scheduled" }],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").payment.status, "missing");
  assert.equal(cell(rows, "2026-04").schedule.expected, true);
  assert.equal(cell(rows, "2026-05").payment.status, "plan_history_needed");
});

test("inactive and out-of-window months are not expected", () => {
  const inactive = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({ status: "Inactive" })], invoices: [], payments: [], year: 2026,
  });
  assert.equal(cell(inactive, "2026-04").payment.status, "not_expected");

  const bounded = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({ serviceStartDate: "2026-05-01", serviceEndDate: "2026-09-30" })],
    invoices: [], payments: [], year: 2026,
  });
  assert.equal(cell(bounded, "2026-04").payment.status, "not_expected");
  assert.equal(cell(bounded, "2026-05").payment.status, "missing");
  assert.equal(cell(bounded, "2026-10").payment.status, "not_expected");
});

test("per-division planRates roll up to the expected monthly amount", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({ monthlyRate: "", planRates: { Pond: "175", Pool: "54" } })],
    invoices: [], payments: [], year: 2026,
  });
  assert.equal(rows[0].expectedMonthlyCents, 22900);
  assert.equal(cell(rows, "2026-04").expectedCents, 22900);
});

test("invalid assignment inputs fail closed without changing another month", () => {
  const ledger = assignMaintenancePaymentSourceAcrossMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    months: ["not-a-month"],
    source: { kind: "invoice", invoiceId: "invoice-1" },
    status: "paid",
  });
  assert.equal(ledger, null);
});

test("historical maintenance rates do not block a one-month reconciliation", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({ date: "2024-06-15", total: 175, lineItems: [{ desc: "Monthly maintenance", amount: 175 }] })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
    actor: "owner-1",
    updatedAt: "2026-08-29T12:00:00Z",
  });
  assert.equal(result.receipt.counts.assignedMonths, 1);
  assert.equal(result.receipt.counts.ambiguousInvoices, 0);
  assert.equal(result.ledger.allocations["client-1"]["2024-06"].status, "paid");
  assert.equal(result.ledger.allocations["client-1"]["2024-06"].allocatedCents, 17500);
});

test("a unique QuickBooks client name with an appended street address reconciles safely", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient({
      id: "client-eleanor",
      name: "Eleanor Michinoc",
      qbId: "",
    })],
    invoices: [invoice({
      id: "invoice-eleanor",
      qbId: "qb-invoice-eleanor",
      clientId: "",
      qbCustomerId: "",
      clientName: "Eleanor Michinoc - 604 Whiteland Hunt Rd.",
      date: "2025-06-15",
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.unmatchedClientInvoices, 0);
  assert.equal(result.receipt.counts.assignedMonths, 1);
  assert.equal(result.ledger.allocations["client-eleanor"]["2025-06"].status, "paid");
});

test("an appended address does not bypass duplicate client-name protection", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [
      recurringClient({ id: "client-eleanor-a", name: "Eleanor Michinoc", qbId: "" }),
      recurringClient({ id: "client-eleanor-b", name: "Eleanor Michinoc", qbId: "" }),
    ],
    invoices: [invoice({
      id: "invoice-eleanor",
      qbId: "qb-invoice-eleanor",
      clientId: "",
      qbCustomerId: "",
      clientName: "Eleanor Michinoc - 604 Whiteland Hunt Rd.",
      date: "2025-06-15",
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.unmatchedClientInvoices, 1);
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.deepEqual(result.ledger.allocations, {});
});

test("a non-address QuickBooks name suffix is not stripped for client matching", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient({
      id: "client-eleanor",
      name: "Eleanor Michinoc",
      qbId: "",
    })],
    invoices: [invoice({
      id: "invoice-eleanor",
      qbId: "qb-invoice-eleanor",
      clientId: "",
      qbCustomerId: "",
      clientName: "Eleanor Michinoc - Commercial Project",
      date: "2025-06-15",
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.unmatchedClientInvoices, 1);
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.deepEqual(result.ledger.allocations, {});
});

test("explicit historical month lists safely reconcile a multi-month invoice", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-04-01",
      total: 687,
      maintenanceMonths: ["2025-04", "2025-05", "2025-06"],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 3);
  assert.deepEqual(Object.keys(result.ledger.allocations["client-1"]), ["2025-04", "2025-05", "2025-06"]);
  assert.equal(result.ledger.allocations["client-1"]["2025-05"].allocatedCents, 22900);
});

test("dated QuickBooks maintenance lines allocate exact amounts across multiple months", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-04-01",
      total: 404,
      notes: "Spring maintenance prepayment",
      lineItems: [
        { desc: "Monthly maintenance", serviceDate: "2025-04-10", amount: 175 },
        { desc: "Monthly maintenance", serviceDate: "2025-05-10", amount: 229 },
      ],
      lines: [
        { description: "Monthly maintenance", serviceDate: "2025-04-10", amount: 175 },
        { description: "Monthly maintenance", serviceDate: "2025-05-10", amount: 229 },
      ],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.assignedMonths, 2);
  assert.equal(result.receipt.counts.ambiguousInvoices, 0);
  assert.equal(result.ledger.allocations["client-1"]["2025-04"].allocatedCents, 17500);
  assert.equal(result.ledger.allocations["client-1"]["2025-05"].allocatedCents, 22900);
});

test("dated lines with an invoice-total mismatch stay in owner review", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-04-01",
      total: 428.24,
      notes: "Spring maintenance prepayment including tax",
      lineItems: [
        { desc: "Monthly maintenance", serviceDate: "2025-04-10", amount: 175 },
        { desc: "Monthly maintenance", serviceDate: "2025-05-10", amount: 229 },
      ],
      lines: [
        { description: "Monthly maintenance", serviceDate: "2025-04-10", amount: 175 },
        { description: "Monthly maintenance", serviceDate: "2025-05-10", amount: 229 },
      ],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /more than one service month/i);
  assert.deepEqual(result.ledger.allocations, {});
});

test("dated non-maintenance lines never become maintenance coverage", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-04-01",
      total: 404,
      notes: "Equipment repair project",
      lineItems: [
        { desc: "Pump repair", serviceDate: "2025-04-10", amount: 175 },
        { desc: "Replacement material", serviceDate: "2025-05-10", amount: 229 },
      ],
      lines: [
        { description: "Pump repair", serviceDate: "2025-04-10", amount: 175 },
        { description: "Replacement material", serviceDate: "2025-05-10", amount: 229 },
      ],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 0);
  assert.deepEqual(result.ledger.allocations, {});
});

test("a likely prepayment without explicit months remains auditable and unallocated", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({ date: "2025-04-01", total: 687, notes: "Spring maintenance prepayment" })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /multi-month prepayment/i);
  assert.deepEqual(result.ledger.allocations, {});
});

test("a generic service invoice reconciles with recurring visit evidence even when the amount changed", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-07-12",
      total: 190,
      lineItems: [{ desc: "Services", amount: 190 }],
    })],
    payments: [],
    schedule: [{
      date: "2025-07-10",
      stops: [{
        id: "client-1",
        sid: "visit-2025-07",
        type: "Monthly Service",
        frequency: "Monthly",
        status: "Completed",
      }],
    }],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 1);
  assert.equal(result.ledger.allocations["client-1"]["2025-07"].allocatedCents, 19000);
});

test("a single generic recurring-service invoice stays reviewable without SPS visit history", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [paidQuickBooksSeriesInvoice("2024-07", { total: 229 })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });

  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /three matching months/i);
  assert.deepEqual(result.ledger.allocations, {});
});

test("calendar rows expose QuickBooks invoice evidence independently from SPS visits and coverage", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice({
      id: "repair-invoice",
      qbId: "qb-repair-invoice",
      number: "1046",
      date: "2024-07-12",
      total: 750,
      balance: 0,
      status: "Paid",
      lineItems: [{ desc: "Pond repair and cleaning", amount: 750 }],
    })],
    payments: [],
    schedule: undefined,
    ledger: emptyMaintenancePaymentLedger(),
    year: 2024,
  });

  const july = cell(rows, "2024-07");
  assert.equal(july.payment.status, "not_expected");
  assert.equal(july.schedule, null);
  assert.equal(july.invoiceEvidence.length, 1);
  assert.equal(july.invoiceEvidence[0].invoiceNumber, "1046");
  assert.equal(july.invoiceEvidence[0].status, "paid");
  assert.equal(july.invoiceEvidence[0].coverageKind, "other_work");
});

test("duplicate document numbers never link the wrong QuickBooks invoice to coverage", () => {
  const maintenanceInvoice = invoice({
    id: "invoice-maintenance",
    qbId: "qb-maintenance",
    number: "2050",
    date: "2026-04-15",
    lineItems: [{ desc: "Monthly maintenance", amount: 229 }],
  });
  const unrelatedInvoice = invoice({
    id: "invoice-repair",
    qbId: "qb-repair",
    number: "2050",
    date: "2026-04-16",
    total: 700,
    lineItems: [{ desc: "Pond repair", amount: 700 }],
  });
  const ledger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2026-04"],
    invoice: maintenanceInvoice,
    expectedCents: 22900,
  });
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [unrelatedInvoice, maintenanceInvoice],
    payments: [],
    schedule: undefined,
    ledger,
    year: 2026,
  });

  const april = cell(rows, "2026-04");
  assert.equal(april.payment.status, "paid");
  assert.equal(april.invoiceEvidence.length, 2);
  assert.equal(april.invoiceEvidence.find((entry) => entry.qbInvoiceId === "qb-maintenance")?.linkedToCoverage, true);
  assert.equal(april.invoiceEvidence.find((entry) => entry.qbInvoiceId === "qb-repair")?.linkedToCoverage, undefined);
});

test("raw QuickBooks invoice aliases remain visible and linkable without SPS visit history", () => {
  const rawInvoice = {
    Id: "raw-qb-2051",
    DocNumber: "2051",
    TxnDate: "2026-05-15",
    TotalAmt: 229,
    Balance: 0,
    CustomerRef: { value: "qb-customer-1", name: "Jamie Price" },
    Line: [{
      DetailType: "SalesItemLineDetail",
      Description: "Monthly maintenance",
      Amount: 229,
      SalesItemLineDetail: {
        ItemRef: { value: "qb-maintenance-item", name: "Monthly maintenance" },
        Qty: 1,
        UnitPrice: 229,
      },
    }],
  };
  const ledger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2026-05"],
    invoice: rawInvoice,
    expectedCents: 22900,
  });
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [rawInvoice],
    payments: [],
    schedule: undefined,
    ledger,
    year: 2026,
  });

  const may = cell(rows, "2026-05");
  assert.equal(may.payment.status, "paid");
  assert.equal(may.schedule, null);
  assert.equal(may.invoiceEvidence.length, 1);
  assert.equal(may.invoiceEvidence[0].qbInvoiceId, "raw-qb-2051");
  assert.equal(may.invoiceEvidence[0].invoiceNumber, "2051");
  assert.equal(may.invoiceEvidence[0].amountCents, 22900);
  assert.equal(may.invoiceEvidence[0].linkedToCoverage, true);
});

test("a generic service amount that differs from the saved maintenance price stays in review without SPS visit evidence", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2024-07-12",
      total: 190,
      lineItems: [{ desc: "Services", amount: 190 }],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });

  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /saved maintenance rate/i);
  assert.deepEqual(result.ledger.allocations, {});
});

test("three exact paid QuickBooks service invoices establish only their observed historical months", () => {
  const invoices = [
    paidQuickBooksSeriesInvoice("2024-01"),
    paidQuickBooksSeriesInvoice("2024-03"),
    paidQuickBooksSeriesInvoice("2024-05", {
      lineItems: [],
      items: [{
        description: "Services",
        quantity: "1",
        price: "175",
        taxable: false,
        type: "service",
        quickBooksItemRef: { value: "qb-service-item-1", name: "Services" },
      }],
    }),
  ];
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient({ monthlyRate: "175.00" })],
    invoices,
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });

  assert.equal(result.receipt.counts.assignedMonths, 3);
  assert.equal(result.receipt.counts.ambiguousInvoices, 0);
  assert.deepEqual(Object.keys(result.ledger.allocations["client-1"]), ["2024-01", "2024-03", "2024-05"]);
  assert.equal(result.ledger.allocations["client-1"]["2024-01"].allocatedCents, 17500);
  assert.equal(result.ledger.allocations["client-1"]["2024-02"], undefined);
  assert.equal(result.ledger.allocations["client-1"]["2024-04"], undefined);
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient({ monthlyRate: "175.00" })], invoices, payments: [], schedule: undefined, ledger: result.ledger, year: 2024,
  });
  assert.equal(cell(rows, "2024-03").invoiceEvidence[0].coverageKind, "review");
  assert.equal(cell(rows, "2024-03").invoiceEvidence[0].linkedToCoverage, true);
});

test("an exact paid QuickBooks series establishes historical evidence without current cadence metadata", () => {
  const historicalClient = recurringClient({
    status: "Inactive",
    planFreq: "",
    monthlyRate: "175.00",
  });
  const invoices = [
    paidQuickBooksSeriesInvoice("2024-01"),
    paidQuickBooksSeriesInvoice("2024-03"),
    paidQuickBooksSeriesInvoice("2024-05"),
  ];
  const result = reconcileMaintenancePaymentHistory({
    clients: [historicalClient],
    invoices,
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });

  assert.equal(result.receipt.counts.assignedMonths, 3);
  assert.equal(result.receipt.counts.ambiguousInvoices, 0);
  assert.deepEqual(Object.keys(result.ledger.allocations["client-1"]), ["2024-01", "2024-03", "2024-05"]);

  const rows = buildMaintenancePaymentLedgerRows({
    clients: [historicalClient],
    invoices,
    payments: [],
    schedule: [],
    ledger: result.ledger,
    year: 2024,
  });
  assert.equal(cell(rows, "2024-01").payment.status, "paid");
  assert.equal(cell(rows, "2024-02").payment.status, "plan_history_needed");
  assert.deepEqual(cell(rows, "2024-02").invoiceEvidence, []);
  assert.equal(cell(rows, "2024-03").schedule.visitCount, 0);
  assert.deepEqual(cell(rows, "2024-03").schedule.serviceDates, []);
});

test("a repeated generic service series that differs from the saved maintenance rate stays in review", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient({ monthlyRate: "229.00" })],
    invoices: [
      paidQuickBooksSeriesInvoice("2024-01"),
      paidQuickBooksSeriesInvoice("2024-03"),
      paidQuickBooksSeriesInvoice("2024-05"),
    ],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 3);
  assert.deepEqual(result.ledger.allocations, {});
  assert.match(result.receipt.ambiguousInvoices[0].reason, /saved maintenance rate/i);
});

test("SPS and QuickBooks invoice identifiers never match across namespaces", () => {
  const selected = invoice({
    id: "sps-selected",
    qbId: "shared-id",
    number: "SELECTED",
    date: "2026-04-15",
  });
  const colliding = invoice({
    id: "shared-id",
    qbId: "qb-colliding",
    number: "COLLIDING",
    date: "2026-04-15",
    total: 700,
    lineItems: [{ desc: "Pond repair", amount: 700 }],
  });
  const ledger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2026-04"],
    invoice: selected,
    expectedCents: 22900,
  });
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [colliding, selected],
    payments: [],
    schedule: undefined,
    ledger,
    year: 2026,
  });
  const april = cell(rows, "2026-04");
  assert.equal(april.payment.status, "paid");
  assert.equal(april.invoiceEvidence.find((entry) => entry.qbInvoiceId === "shared-id")?.linkedToCoverage, true);
  assert.equal(april.invoiceEvidence.find((entry) => entry.invoiceId === "shared-id")?.linkedToCoverage, undefined);
});

test("two invoices or a six-month span never establish a generic QuickBooks series", () => {
  for (const invoices of [
    [paidQuickBooksSeriesInvoice("2024-01"), paidQuickBooksSeriesInvoice("2024-03")],
    [
      paidQuickBooksSeriesInvoice("2024-01"),
      paidQuickBooksSeriesInvoice("2024-04"),
      paidQuickBooksSeriesInvoice("2024-06"),
    ],
  ]) {
    const result = reconcileMaintenancePaymentHistory({
      clients: [recurringClient()],
      invoices,
      payments: [],
      schedule: [],
      ledger: emptyMaintenancePaymentLedger(),
      fromYear: 2024,
      toYear: 2024,
    });
    assert.equal(result.receipt.counts.assignedMonths, 0);
    assert.equal(result.receipt.counts.ambiguousInvoices, invoices.length);
    assert.deepEqual(result.ledger.allocations, {});
  }
});

test("generic series matching rejects tax, repair wording, partial payment, and unstable item identity", () => {
  const unsafeCases = [
    paidQuickBooksSeriesInvoice("2024-03", { taxAmount: 10.5, taxRate: 6 }),
    paidQuickBooksSeriesInvoice("2024-03", {
      lineItems: [{
        desc: "Repair service",
        qty: "1",
        unitPrice: "175",
        taxable: false,
        kind: "service",
        qbItemRef: { value: "qb-service-item-1", name: "Services" },
      }],
    }),
    paidQuickBooksSeriesInvoice("2024-03", { balance: 50, status: "Sent" }),
    paidQuickBooksSeriesInvoice("2024-03", {
      lineItems: [{ desc: "Services", qty: "1", unitPrice: "175", taxable: false, kind: "service", qbItemRef: { name: "Services" } }],
    }),
  ];
  for (const unsafe of unsafeCases) {
    const result = reconcileMaintenancePaymentHistory({
      clients: [recurringClient()],
      invoices: [paidQuickBooksSeriesInvoice("2024-01"), unsafe, paidQuickBooksSeriesInvoice("2024-05")],
      payments: [],
      schedule: [],
      ledger: emptyMaintenancePaymentLedger(),
      fromYear: 2024,
      toYear: 2024,
    });
    assert.equal(result.receipt.counts.assignedMonths, 0);
    assert.deepEqual(result.ledger.allocations, {});
  }
});

test("duplicate QuickBooks customer ids never auto-assign an invoice by list order", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [
      recurringClient({ id: "client-a", name: "Jamie Price" }),
      recurringClient({ id: "client-b", name: "Jamie Price Second Property" }),
    ],
    invoices: [invoice({
      clientId: "",
      qbCustomerId: "qb-customer-1",
      clientName: "Jamie Price",
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2026,
    toYear: 2026,
  });

  assert.equal(result.receipt.counts.unmatchedClientInvoices, 1);
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.deepEqual(result.ledger.allocations, {});
});

test("a large generic recurring-service invoice without explicit months remains unallocated", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2024-01-12",
      total: 2290,
      lineItems: [{ desc: "Services", amount: 2290 }],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });

  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /multi-month prepayment/i);
});

test("a generic service invoice recognizes the app's canonical MDY schedule date", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-07-12",
      total: 190,
      lineItems: [{ desc: "Services", amount: 190 }],
    })],
    payments: [],
    schedule: [{
      date: "07/10/2025",
      stops: [{
        id: "client-1",
        sid: "visit-2025-07-mdy",
        type: "Monthly Service",
        frequency: "Monthly",
        status: "Completed",
      }],
    }],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });

  assert.equal(result.receipt.counts.assignedMonths, 1);
  assert.equal(result.ledger.allocations["client-1"]["2025-07"].allocatedCents, 19000);
});

test("a linked source visit maps an otherwise generic invoice to its recurring service month", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      id: "linked-invoice",
      qbId: "linked-qb",
      date: "2025-08-02",
      total: 180,
      sourceVisitId: "recurring-visit-august",
      lineItems: [{ desc: "Service", amount: 180 }],
    })],
    payments: [],
    schedule: [{
      id: "recurring-visit-august",
      clientId: "client-1",
      date: "2025-07-29",
      type: "Monthly Service",
      frequency: "Monthly",
      status: "Completed",
    }],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 1);
  assert.equal(result.ledger.allocations["client-1"]["2025-07"].allocatedCents, 18000);
  assert.equal(result.ledger.allocations["client-1"]["2025-08"], undefined);
});

test("repair evidence is never backfilled as maintenance", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-07-12",
      sourceVisitId: "visit-2025-07",
      lineItems: [{ desc: "Emergency pump repair service", amount: 229 }],
    })],
    payments: [],
    schedule: [{
      id: "visit-2025-07",
      clientId: "client-1",
      date: "2025-07-10",
      type: "Monthly Service",
      frequency: "Monthly",
      status: "Completed",
    }],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.skippedNonMaintenance, 1);
  assert.match(result.receipt.skippedNonMaintenance[0].reason, /repair/i);
});

test("one-time pond cleaning evidence is never backfilled as recurring maintenance", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2025-07-12",
      sourceVisitId: "visit-2025-07",
      lineItems: [{ desc: "Pond Services: Pond Cleaning", amount: 750 }],
    })],
    payments: [],
    schedule: [{
      id: "visit-2025-07",
      clientId: "client-1",
      date: "2025-07-10",
      type: "Monthly Service",
      frequency: "Monthly",
      status: "Completed",
    }],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.skippedNonMaintenance, 1);
  assert.match(result.receipt.skippedNonMaintenance[0].reason, /cleaning/i);
});

test("non-maintenance wording overrides untrusted invoice month fields", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [
      invoice({
        id: "repair-months",
        qbId: "repair-months-qb",
        number: "REPAIR-MONTHS",
        serviceMonths: ["2025-07"],
        lineItems: [{ desc: "Emergency pump repair", amount: 229 }],
      }),
      invoice({
        id: "cleaning-allocation",
        qbId: "cleaning-allocation-qb",
        number: "CLEANING-ALLOCATION",
        maintenanceAllocations: [{ month: "2025-08", amount: 229 }],
        lineItems: [{ desc: "Pond cleaning", amount: 229 }],
      }),
    ],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.skippedNonMaintenance, 2);
});

test("a historical client with only QuickBooks maintenance evidence remains visible", () => {
  const historicalClient = recurringClient({
    id: "historical-client",
    qbId: "historical-qb-client",
    planFreq: "",
    monthlyRate: "",
    status: "Inactive",
  });
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [historicalClient],
    invoices: [invoice({
      id: "historical-maintenance",
      qbId: "historical-maintenance-qb",
      clientId: "historical-client",
      date: "2024-06-15",
      lineItems: [{ desc: "Monthly maintenance", amount: 229 }],
    })],
    payments: [],
    schedule: [],
    year: 2024,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientId, "historical-client");
  assert.equal(rows[0].byMonth["2024-06"].invoiceEvidence.length, 1);
  assert.equal(rows[0].byMonth["2024-06"].schedule?.visitCount || 0, 0);
});

test("reconciliation preserves an existing manual month allocation", () => {
  const manualInvoice = invoice({ id: "manual-invoice", qbId: "manual-qb", number: "MANUAL", date: "2025-04-02" });
  const manualLedger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2025-04"],
    invoice: manualInvoice,
    expectedCents: 22900,
    note: "Owner confirmed",
    actor: "owner-1",
  });
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [manualInvoice, invoice({ id: "history", qbId: "history-qb", number: "HISTORY", date: "2025-04-15" })],
    payments: [],
    schedule: [],
    ledger: manualLedger,
    fromYear: 2025,
    toYear: 2025,
  });
  const allocation = result.ledger.allocations["client-1"]["2025-04"];
  assert.equal(allocation.note, "Owner confirmed");
  assert.equal(allocation.sources.length, 1);
  assert.equal(allocation.sources[0].invoiceId, "manual-invoice");
  assert.equal(result.receipt.counts.assignedMonths, 0);
});

test("a real scheduled historical month remains expected without manufacturing adjacent missing months", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [],
    payments: [],
    schedule: [{
      id: "first-known-visit",
      clientId: "client-1",
      date: "2025-04-03",
      type: "Monthly Service",
      frequency: "Monthly",
      status: "Completed",
    }],
    year: 2025,
  });
  assert.equal(rows[0].coverageStartMonth, "2025-04");
  assert.equal(cell(rows, "2025-03").payment.status, "not_expected");
  assert.equal(cell(rows, "2025-03").payment.evidenceState, "not_expected");
  assert.equal(cell(rows, "2025-04").payment.status, "missing");
  assert.equal(cell(rows, "2025-04").payment.evidenceState, "no_matching_payment");
  assert.equal(cell(rows, "2025-05").payment.status, "plan_history_needed");
  assert.equal(cell(rows, "2025-05").payment.evidenceState, "plan_history_needed");
});

test("a recurring client without dated evidence does not manufacture a full year of missing months", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [],
    payments: [],
    schedule: [],
    year: 2025,
  });
  assert.equal(rows[0].coverageStartMonth, "");
  assert.equal(rows[0].months.every((entry) => entry.payment.status === "not_expected"), true);
});

test("an amount-only invoice is not maintenance without recurring schedule evidence", () => {
  const unrelated = invoice({
    date: "2025-04-15",
    lineItems: [{ desc: "Consulting", amount: 229 }],
  });
  const reconciled = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [unrelated],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2025,
    toYear: 2025,
  });
  assert.equal(reconciled.receipt.counts.assignedMonths, 0);
  assert.equal(reconciled.receipt.counts.skippedNonMaintenance, 1);

  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [unrelated],
    payments: [],
    schedule: [],
    year: 2025,
  });
  assert.equal(rows[0].coverageStartMonth, "");
  assert.equal(cell(rows, "2025-04").payment.status, "not_expected");
});

test("an obvious historical maintenance lump sum stays ambiguous despite a changed monthly rate", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [invoice({
      date: "2024-06-15",
      total: 2100,
      lineItems: [{ desc: "Maintenance", amount: 2100 }],
    })],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });
  assert.equal(result.receipt.counts.assignedMonths, 0);
  assert.equal(result.receipt.counts.ambiguousInvoices, 1);
  assert.match(result.receipt.ambiguousInvoices[0].reason, /multi-month prepayment/i);
});

test("historical invoices accept issueDate and created_at aliases", () => {
  const result = reconcileMaintenancePaymentHistory({
    clients: [recurringClient()],
    invoices: [
      invoice({ id: "issue-date", qbId: "issue-date-qb", number: "ISSUE", date: undefined, issueDate: "2024-03-15" }),
      invoice({ id: "created-at", qbId: "created-at-qb", number: "CREATED", date: undefined, created_at: "2024-05-15" }),
    ],
    payments: [],
    schedule: [],
    ledger: emptyMaintenancePaymentLedger(),
    fromYear: 2024,
    toYear: 2024,
  });
  assert.equal(result.receipt.counts.assignedMonths, 2);
  assert.equal(result.ledger.allocations["client-1"]["2024-03"].status, "paid");
  assert.equal(result.ledger.allocations["client-1"]["2024-05"].status, "paid");
});

test("manual duplicate resolution produces an idempotent receipt", () => {
  const selected = invoice({ id: "selected", qbId: "selected-qb", number: "SELECTED", date: "2025-04-02" });
  const duplicate = invoice({ id: "duplicate", qbId: "duplicate-qb", number: "DUPLICATE", date: "2025-04-18" });
  const manualLedger = assignMaintenanceInvoiceMonths(emptyMaintenancePaymentLedger(), {
    clientId: "client-1",
    monthKeys: ["2025-04"],
    invoice: selected,
    expectedCents: 22900,
    note: "Owner selected this invoice",
  });
  const input = {
    clients: [recurringClient()],
    invoices: [selected, duplicate],
    payments: [],
    schedule: [],
    ledger: manualLedger,
    fromYear: 2025,
    toYear: 2025,
  };
  const first = reconcileMaintenancePaymentHistory(input);
  const second = reconcileMaintenancePaymentHistory({ ...input, ledger: first.ledger });
  assert.equal(first.receipt.counts.alreadyAssigned, 1);
  assert.equal(first.receipt.counts.ambiguousInvoices, 1);
  assert.equal(first.receipt.ambiguousInvoices[0].invoiceId, "duplicate");
  assert.deepEqual(second, first);
});
