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

const cell = (rows, month, clientId = "client-1") => (
  rows.find((row) => row.clientId === clientId)?.byMonth?.[month]
);

test("money and month normalization are deterministic", () => {
  assert.equal(moneyToCents("$1,229.95"), 122995);
  assert.equal(moneyToCents(2.345), 235);
  assert.equal(normalizeMonthKey("2026-04-30"), "2026-04");
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
  assert.equal(cell(rows, "2026-07").payment.status, "missing", "the client mirror cannot extend protected coverage");
});

test("a single paid maintenance invoice covers its unambiguous transaction month", () => {
  const rows = buildMaintenancePaymentLedgerRows({
    clients: [recurringClient()],
    invoices: [invoice()],
    payments: [],
    year: 2026,
  });
  assert.equal(cell(rows, "2026-04").expectedCents, 22900);
  assert.equal(cell(rows, "2026-04").payment.status, "paid");
  assert.equal(cell(rows, "2026-04").payment.appliedCents, 22900);
  assert.equal(cell(rows, "2026-05").payment.status, "missing");
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
  assert.equal(cell(rows, "2026-05").payment.status, "missing");
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
  assert.equal(cell(rows, "2026-05").payment.status, "not_expected");
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
