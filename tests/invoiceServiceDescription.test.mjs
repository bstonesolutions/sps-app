import assert from "node:assert/strict";
import test from "node:test";

import {
  formatInvoiceServiceLineDescription,
  invoiceHasMaintenanceServiceLines,
  invoiceServiceDescriptionIssue,
  invoiceServiceLineMonths,
} from "../invoiceServiceDescription.js";

const invoice = (line, fields = {}) => ({ date: "10/01/2026", dueDate: "10/15/2026", ...fields, lineItems: [line] });
const issue = (line, fields) => invoiceServiceDescriptionIssue(invoice(line, fields));
const format = (line, fields) => formatInvoiceServiceLineDescription(invoice(line, fields), line);
const months = (line, fields) => invoiceServiceLineMonths(invoice(line, fields), line);

test("maintenance without a performed month cannot borrow invoice, due or current dates", () => {
  for (const desc of ["Monthly service", "Weekly Pool Service", "Bi-weekly pond service", "Leaf maintenance"]) {
    assert.equal(issue({ desc }).code, "maintenance-service-month-missing");
    assert.equal(format({ desc }), desc);
    assert.deepEqual(months({ desc }), []);
  }
  assert.equal(invoiceHasMaintenanceServiceLines(invoice({ desc: "Monthly service" })), true);
});

test("explicit service metadata adds performed month and year while preserving custom wording", () => {
  const line = { desc: "Signature pond maintenance", serviceMonth: "2026-09" };
  assert.equal(issue(line), null);
  assert.equal(format(line), "Signature pond maintenance - September 2026");
  assert.deepEqual(months(line), ["2026-09"]);
  assert.equal(format({ desc: "Monthly Service", serviceDate: "9/17/2026" }), "Monthly Service - September 2026");
});

test("invoice serviceMonth and autoPeriod are explicit fallback evidence", () => {
  assert.equal(format({ desc: "Monthly service" }, { serviceMonth: "2026-09" }), "Monthly service - September 2026");
  assert.equal(format({ desc: "Service" }, { source: "monthly-maintenance", autoPeriod: "2025-12" }), "Service - December 2025");
  assert.equal(issue({ desc: "Monthly service" }, { serviceMonth: "2026-10", autoPeriod: "2026-09" }).code, "maintenance-service-month-conflict");
});

test("per-line evidence wins over invoice defaults for mixed-month work", () => {
  const line = { desc: "Monthly service", serviceDate: "2026-09-15" };
  assert.equal(format(line, { serviceMonth: "2026-10" }), "Monthly service - September 2026");
  const mixed = { serviceMonth: "2026-10", lineItems: [line, { desc: "Monthly service", serviceMonth: "2026-10" }] };
  assert.equal(invoiceServiceDescriptionIssue(mixed), null);
  assert.deepEqual(mixed.lineItems.map((item) => invoiceServiceLineMonths(mixed, item)), [["2026-09"], ["2026-10"]]);
});

test("already explicit names and dates are sufficient and remain unchanged", () => {
  for (const desc of ["Monthly service - September 2026", "Monthly service Sep. 2026", "Monthly service Sep-2026", "Monthly service September 17, 2026", "Monthly service 2026-09-17", "Monthly service 09/17/2026", "Monthly service 9/2026", "Monthly service 2026-09"]) {
    assert.equal(issue({ desc }), null, desc);
    assert.equal(format({ desc }), desc);
    assert.deepEqual(months({ desc }), ["2026-09"], desc);
  }
});

test("explicit ranges and month lists are preserved with their complete months", () => {
  const range = { desc: "Pond maintenance April to September 2026" };
  assert.equal(issue(range), null);
  assert.equal(format(range), range.desc);
  assert.deepEqual(months(range), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(months({ desc: "Monthly service December 2025 through February 2026" }), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(months({ desc: "Monthly service April, May and June 2026" }), ["2026-04", "2026-05", "2026-06"]);
  assert.deepEqual(months({ desc: "Monthly service 2026-04 to 2026-06" }), ["2026-04", "2026-05", "2026-06"]);
  assert.deepEqual(months({ desc: "Monthly service 04/01/2026 - 06/30/2026" }), ["2026-04", "2026-05", "2026-06"]);
});

test("source visit dates retain distinct performed months without inventing coverage gaps", () => {
  const line = { desc: "Monthly service", sourceVisitDates: ["2026-09-10", "09/24/2026", "2026-11-10"] };
  assert.equal(issue(line), null);
  assert.deepEqual(months(line), ["2026-09", "2026-11"]);
  assert.equal(format(line), "Monthly service - September 2026, November 2026");
  assert.equal(format({ ...line, desc: format(line) }), format(line));
});

test("a month name without a year requires metadata and avoids duplicate suffixes", () => {
  assert.equal(issue({ desc: "Monthly service September" }).code, "maintenance-service-month-missing");
  assert.equal(format({ desc: "Monthly service September" }, { serviceMonth: "2026-09" }), "Monthly service September 2026");
  assert.equal(issue({ desc: "Monthly service September" }, { serviceMonth: "2026-10" }).code, "maintenance-service-month-conflict");
});

test("contradictory or invalid line dates block instead of relabeling service", () => {
  for (const line of [
    { desc: "Monthly service September 2026", serviceMonth: "2026-10" },
    { desc: "Monthly service", serviceMonth: "2026-09", serviceDate: "2026-10-01" },
    { desc: "Monthly service", serviceMonth: "2026-09", sourceVisitDates: ["2026-09-10", "2026-10-10"] },
    { desc: "Monthly service", serviceDate: "2026-02-30" },
    { desc: "Monthly service", sourceVisitDates: ["not a date"] },
    { desc: "Monthly service February 30, 2026" },
  ]) {
    assert.equal(issue(line).code, "maintenance-service-month-conflict", JSON.stringify(line));
    assert.deepEqual(months(line), []);
    assert.equal(format(line), line.desc);
  }
});

test("repairs, opening services, physical purchases and fees do not require maintenance months", () => {
  const lines = [
    { desc: "Pump repair" }, { desc: "Pool opening maintenance" }, { desc: "Pool closing" },
    { desc: "Monthly maintenance filter", kind: "part" }, { desc: "Monthly maintenance", kind: "product" },
    { desc: "Maintenance treatment", kind: "treatment" }, { desc: "Maintenance supplies", kind: "bundle" },
    { desc: "Maintenance late fee", isLateFee: true }, { desc: "Maintenance", billSeparately: true },
  ];
  for (const line of lines) {
    assert.equal(issue(line, { source: "monthly-maintenance" }), null, JSON.stringify(line));
    assert.equal(format(line, { source: "monthly-maintenance" }), line.desc);
  }
  assert.equal(invoiceHasMaintenanceServiceLines({ lineItems: lines }), false);
});

test("explicit source maintenance marker dates generic service but cannot classify extras", () => {
  assert.equal(format({ desc: "Services", maintenanceService: true, serviceDate: "2026-04-18" }), "Services - April 2026");
  assert.equal(issue({ desc: "Services", maintenanceService: true }).code, "maintenance-service-month-missing");
  for (const line of [
    { desc: "Repair labor" }, { desc: "Pool opening" }, { desc: "Filter", kind: "part" },
    { desc: "Services", billSeparately: true },
  ]) assert.equal(issue({ ...line, maintenanceService: true }), null);
});

test("issue points to all affected zero-based lines and accepts payload description fields", () => {
  const value = { lineItems: [
    { description: "Monthly service September 2026" },
    { description: "Monthly service" },
    { description: "Repair" },
    { description: "Monthly service September 2026", serviceMonth: "2026-10" },
  ] };
  assert.deepEqual(invoiceServiceDescriptionIssue(value).lineIndexes, [1, 3]);
  assert.equal(formatInvoiceServiceLineDescription(value, value.lineItems[0]), "Monthly service September 2026");
});

test("helpers do not mutate source descriptions or date evidence", () => {
  const value = invoice({ desc: "Monthly service", sourceVisitDates: ["2026-09-20", "2026-09-03"] });
  const before = structuredClone(value);
  invoiceServiceDescriptionIssue(value);
  invoiceServiceLineMonths(value, value.lineItems[0]);
  formatInvoiceServiceLineDescription(value, value.lineItems[0]);
  assert.deepEqual(value, before);
});
