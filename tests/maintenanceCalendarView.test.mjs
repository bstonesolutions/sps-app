import assert from "node:assert/strict";
import test from "node:test";

import {
  filterMaintenanceCalendarRows,
  maintenanceCalendarPrepaidCount,
} from "../maintenanceCalendarView.js";

const APRIL = "2026-04";
const MAY = "2026-05";
const JUNE = "2026-06";
const query = (rows, options = {}) => filterMaintenanceCalendarRows(rows, {
  monthKeys: [APRIL, MAY, JUNE], asOfMonth: MAY, ...options,
});
const ids = (rows) => rows.map((row) => row.clientId);
const row = (clientId, { name = clientId, price = 17500, types = ["pond"], statuses = {} } = {}) => ({
  clientId, clientName: name, expectedMonthlyCents: price, maintenanceTypes: types,
  byMonth: Object.fromEntries(Object.entries(statuses).map(([month, status]) => [month, { payment: { status } }])),
});

test("name search, service and payment filters combine without changing their input", () => {
  const rows = [
    row("pond", { name: "Maple Property", types: ["pond"], statuses: { [APRIL]: "paid" } }),
    row("pool", { name: "Maple Pool", types: ["pool", "leaf"], statuses: { [APRIL]: "prepaid" } }),
    row("other", { name: "Other Pool", types: ["pool"], statuses: { [APRIL]: "due" } }),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(ids(query(rows, { search: "  MAPLE ", serviceType: "pool", paymentStatus: "paid", monthKey: APRIL })), ["pool"]);
  assert.deepEqual(ids(query(rows, { serviceType: "leaf" })), ["pool"]);
  assert.deepEqual(rows, before);
  assert.notEqual(query(rows), rows);
});

test("search tolerates accents and empty or missing inputs", () => {
  const rows = [row("a", { name: "José Garcia" }), row("b", { name: "River Stone" })];
  assert.deepEqual(ids(query(rows, { search: "jose" })), ["a"]);
  assert.deepEqual(filterMaintenanceCalendarRows(null), []);
  assert.deepEqual(ids(query([null, ...rows, undefined], { serviceType: "unknown", paymentStatus: "unknown" })), ["a", "b"]);
});

test("a selected month decides paid status, with prepayments included and waived excluded", () => {
  const rows = [
    row("april-paid", { statuses: { [APRIL]: "paid", [MAY]: "due" } }),
    row("may-paid", { statuses: { [APRIL]: "due", [MAY]: "paid" } }),
    row("prepaid", { statuses: { [APRIL]: "prepaid" } }),
    row("waived", { statuses: { [APRIL]: "waived" } }),
  ];
  assert.deepEqual(ids(query(rows, { paymentStatus: "paid", monthKey: APRIL })), ["april-paid", "prepaid"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "paid", monthKey: MAY })), ["may-paid"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "paid", monthKey: "all" })), ["april-paid", "may-paid", "prepaid"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "waived", monthKey: APRIL })), ["waived"]);
});

test("unpaid includes only current or past known unpaid statuses", () => {
  const statuses = ["paid", "prepaid", "waived", "due", "partial", "missing", "refunded", "review", "plan_history_needed", "not_expected", "unrecognized"];
  const rows = statuses.map((status) => row(status, { statuses: { [APRIL]: status } }));
  rows.push(row("future-missing", { statuses: { [JUNE]: "missing" } }));
  rows.push(row("future-due", { statuses: { [JUNE]: "due" } }));
  rows.push(row("future-partial", { statuses: { [JUNE]: "partial" } }));
  rows.push(row("no-data"));
  assert.deepEqual(ids(query(rows, { paymentStatus: "unpaid" })), ["due", "missing", "partial", "refunded"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "review" })), ["plan_history_needed", "review", "unrecognized"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "upcoming" })), ["future-missing"]);
  assert.deepEqual(ids(query(rows, { paymentStatus: "open", monthKey: JUNE })), ["future-due"]);
});

test("all-visible scope excludes hidden months and can be intentionally empty", () => {
  const rows = [row("hidden", { statuses: { "2026-01": "paid" } }), row("shown", { statuses: { [APRIL]: "paid" } })];
  assert.deepEqual(ids(query(rows, { paymentStatus: "paid" })), ["shown"]);
  assert.deepEqual(query(rows, { paymentStatus: "paid", monthKeys: [] }), []);
  assert.equal(query(rows, { monthKeys: [] }).length, 2);
  assert.deepEqual(ids(filterMaintenanceCalendarRows(rows, { paymentStatus: "paid", asOfMonth: MAY })), ["hidden", "shown"]);
});

test("each specific status filter returns the matching month only", () => {
  const rows = ["prepaid", "partial", "due", "missing"].map((status) => row(status, { statuses: { [APRIL]: status } }));
  for (const [filter, expected] of [["prepaid", "prepaid"], ["partial", "partial"], ["open", "due"], ["missing", "missing"]]) {
    assert.deepEqual(ids(query(rows, { paymentStatus: filter, monthKey: APRIL })), [expected]);
  }
});

test("names sort both ways with deterministic client ID ties", () => {
  const rows = [row("10", { name: "Maple" }), row("2", { name: "Maple" }), row("a", { name: "Cedar" }), row("z", { name: "Willow" })];
  assert.deepEqual(ids(query(rows)), ["a", "2", "10", "z"]);
  assert.deepEqual(ids(query(rows, { sortDirection: "desc" })), ["z", "2", "10", "a"]);
});

test("price sorting preserves zero and keeps all unknown prices last in either direction", () => {
  const rows = [
    row("unknown", { price: null }), row("empty", { price: "" }), row("invalid", { price: Number.NaN }),
    row("zero", { price: 0 }), row("high", { price: 25000 }), row("low", { price: "10000" }),
  ];
  assert.deepEqual(ids(query(rows, { sortKey: "price" })), ["zero", "low", "high", "empty", "invalid", "unknown"]);
  assert.deepEqual(ids(query(rows, { sortKey: "price", sortDirection: "desc" })), ["high", "low", "zero", "empty", "invalid", "unknown"]);
});

test("assigned service prices override historical rate, including explicit unknown or zero", () => {
  const rows = [
    { ...row("unknown", { price: 1 }), maintenancePriceCents: null },
    { ...row("zero", { price: 50000 }), maintenancePriceCents: 0 },
    { ...row("assigned", { price: 50000 }), maintenancePriceCents: 10000 },
    row("legacy", { price: 17500 }),
  ];
  assert.deepEqual(ids(query(rows, { sortKey: "price" })), ["zero", "assigned", "legacy", "unknown"]);
  assert.deepEqual(ids(query(rows, { sortKey: "price", sortDirection: "desc" })), ["legacy", "assigned", "zero", "unknown"]);
});

test("prepaid sorting counts only unique visible months, independently of selected status month", () => {
  const rows = [
    row("long", { statuses: { [APRIL]: "prepaid", [MAY]: "prepaid", [JUNE]: "paid" } }),
    row("one", { statuses: { [APRIL]: "prepaid" } }),
    row("hidden", { statuses: { "2026-01": "prepaid" } }),
  ];
  assert.equal(maintenanceCalendarPrepaidCount(rows[0], [APRIL, APRIL, MAY]), 2);
  assert.deepEqual(ids(query(rows, { sortKey: "prepaid", sortDirection: "desc", monthKey: APRIL })), ["long", "one", "hidden"]);
  assert.deepEqual(ids(query(rows, { sortKey: "prepaid" })), ["hidden", "one", "long"]);
});

test("month sorting groups unpaid first or covered first, with uncertain and inactive cells always last", () => {
  const statuses = ["not_expected", "review", "paid", "missing", "waived", "prepaid", "refunded", "partial", "due", "plan_history_needed", "unrecognized"];
  const rows = statuses.map((status) => row(status, { statuses: { [APRIL]: status } }));
  assert.deepEqual(ids(query(rows, { sortKey: APRIL })), [
    "due", "partial", "missing", "refunded", "paid", "prepaid", "waived", "plan_history_needed", "review", "unrecognized", "not_expected",
  ]);
  assert.deepEqual(ids(query(rows, { sortKey: APRIL, sortDirection: "desc" })), [
    "waived", "prepaid", "paid", "refunded", "missing", "partial", "due", "plan_history_needed", "review", "unrecognized", "not_expected",
  ]);
});

test("future-month sorting keeps incoming charges below settled evidence and uncertain history", () => {
  const rows = ["not_expected", "missing", "due", "review", "prepaid", "paid"].map((status) => row(status, { statuses: { [JUNE]: status } }));
  assert.deepEqual(ids(query(rows, { sortKey: JUNE })), ["paid", "prepaid", "review", "due", "missing", "not_expected"]);
  assert.deepEqual(ids(query(rows, { sortKey: JUNE, sortDirection: "desc" })), ["prepaid", "paid", "review", "due", "missing", "not_expected"]);
});
