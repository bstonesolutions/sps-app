import assert from "node:assert/strict";
import test from "node:test";
import {
  maintenanceAssignedPriceCents,
  maintenanceClientAssignments,
  maintenanceClientTypes,
} from "../maintenanceClientAssignment.js";
import {
  buildMaintenanceCalendarRows,
  buildMaintenancePaymentLedgerRows,
  emptyMaintenancePaymentLedger,
} from "../maintenancePaymentLedger.js";

const assigned = (overrides = {}) => ({
  id: "assigned-client", name: "Maple Property", status: "Active", division: "Pond",
  plan: "Essential", planFreq: "Monthly", monthlyRate: "175", ...overrides,
});
const paidInvoice = (clientId, overrides = {}) => ({
  id: `invoice-${clientId}`, clientId, date: "2026-04-15", total: 175, balance: 0,
  status: "Paid", lineItems: [{ desc: "Monthly maintenance", amount: 175 }], ...overrides,
});

test("calendar assignments support primary, legacy, and per-division pool, pond, and leaf plans", () => {
  assert.deepEqual(maintenanceClientTypes(assigned()), ["pond"]);
  assert.deepEqual(maintenanceClientTypes(assigned({ division: undefined })), ["pond"]);
  assert.deepEqual(maintenanceClientTypes(assigned({
    plans: { Pond: "Essential", Pool: "Premium", Seasonal: "Signature" },
    servicePool: true, serviceSeasonal: true, seasonalType: "Leaf Removal",
  })), ["pool", "pond", "leaf"]);
  assert.deepEqual(maintenanceClientTypes(assigned({ division: "Leaf", plan: "Signature" })), ["leaf"]);
  assert.deepEqual(maintenanceClientTypes(assigned({ division: "Leaf Removal", plan: "Premium" })), ["leaf"]);
  assert.deepEqual(maintenanceClientTypes(assigned({ division: "Seasonal", seasonalType: "Leaf Removal" })), ["leaf"]);
  assert.deepEqual(maintenanceClientTypes(assigned({
    plans: { Pond: "", Pool: "Premium" }, plan: "Essential", servicePool: true,
  })), ["pool"]);
});

test("explicit None and disabled assignments override stale tier and frequency fields", () => {
  for (const plan of ["", "None", " none ", "Off", "Disabled", "Inactive", false, null, { tier: "Essential", active: false }, { name: "Essential", enabled: false }]) {
    assert.deepEqual(maintenanceClientTypes(assigned({ plans: { Pond: plan } })), [], `plan ${JSON.stringify(plan)}`);
  }
  assert.deepEqual(maintenanceClientTypes(assigned({
    plans: { Pond: "", Pool: "Premium" }, servicePool: false,
  })), []);
  assert.deepEqual(maintenanceClientTypes(assigned({
    division: "Pool", plans: { Pond: "Essential", Pool: "Premium" },
  })), ["pool"], "switching a legacy primary division must not reactivate an old plan whose extra service is off");
  assert.deepEqual(maintenanceClientTypes(assigned({
    plans: { Pond: "", Pool: "Premium" },
  })), [], "a stored extra tier does not replace the Services & Plans toggle");
  assert.deepEqual(maintenanceClientTypes(assigned({ servicePond: false })), ["pond"], "the client editor always keeps its primary division on");
  assert.deepEqual(maintenanceClientTypes(assigned({ plans: { Pond: { tier: "Essential" } } })), ["pond"]);
});

test("calendar does not confuse service category, cadence, price, or other seasonal work with assignment", () => {
  for (const client of [
    { id: "unassigned", division: "Pond", planFreq: "Monthly", monthlyRate: 175 },
    { id: "toggle-only", division: "Pond", servicePool: true },
    assigned({ plan: "", plans: { undefined: "Essential", null: "Premium" } }),
    assigned({ division: "Seasonal", seasonalType: "Gutter Cleaning" }),
    assigned({ division: "Seasonal", seasonalType: "Full Property" }),
    assigned({ division: "Seasonal", seasonalType: "Snow Removal" }),
    assigned({ division: "Construction" }),
  ]) assert.deepEqual(maintenanceClientTypes(client), []);
  for (const inactive of [{ status: "Inactive" }, { active: false }, { status: "Archived" }]) {
    assert.deepEqual(maintenanceClientTypes(assigned(inactive)), []);
  }
});

test("calendar excludes unassigned invoice, prepaid, and old recurring visit history without losing accounting evidence", () => {
  const clients = [assigned(), ...["invoice-only", "prepaid-only", "old-visit", "cadence-only"].map((id) => ({
    id, name: id, division: "Pond", plan: "", planFreq: "Monthly", monthlyRate: "175",
  })), assigned({ id: "inactive", status: "Inactive" })];
  const ledger = { ...emptyMaintenancePaymentLedger(), policies: {
    "prepaid-only": { version: 1, mode: "prepaid", coveredFrom: "2026-04-01", coveredThrough: "2026-12-31" },
  } };
  const options = {
    clients, invoices: [paidInvoice("invoice-only")], ledger, year: 2026,
    schedule: [{ clientId: "old-visit", date: "2026-04-03", type: "Monthly Service", frequency: "Monthly" }],
  };
  const before = structuredClone(options);
  const rows = buildMaintenanceCalendarRows(options);
  assert.deepEqual(rows.map((row) => row.clientId), ["assigned-client"]);
  assert.deepEqual(rows[0].maintenanceTypes, ["pond"]);
  assert.equal(rows[0].maintenancePriceCents, 17500);
  const history = buildMaintenancePaymentLedgerRows(options);
  assert.equal(history.find((row) => row.clientId === "invoice-only").byMonth["2026-04"].payment.status, "paid");
  assert.equal(history.find((row) => row.clientId === "prepaid-only").byMonth["2026-04"].payment.status, "prepaid");
  assert.deepEqual(options, before, "filtering does not erase invoices, coverage, or client records");
});

test("explicit plans without stored cadence still appear and retain matching QuickBooks coverage", () => {
  const clients = [assigned({ planFreq: "" }), assigned({
    id: "leaf-client", name: "Willow Property", division: "Seasonal", seasonalType: "Leaf Removal", planFreq: "",
  })];
  const rows = buildMaintenanceCalendarRows({ clients, invoices: clients.map((client) => paidInvoice(client.id)), year: 2026 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((row) => row.clientId === "leaf-client").maintenanceTypes, ["leaf"]);
  for (const row of rows) assert.equal(row.byMonth["2026-04"].payment.status, "paid");
});

test("hiding an unassigned client does not falsely resolve an invoice with an ambiguous name", () => {
  const clients = [assigned({ name: "Shared Property", serviceStartDate: "2026-04-01", serviceEndDate: "2026-12-31" }), {
    id: "unassigned", name: "Shared Property", plan: "",
  }];
  const rows = buildMaintenanceCalendarRows({ clients, invoices: [paidInvoice(undefined, { clientName: "Shared Property" })], year: 2026 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].byMonth["2026-04"].payment.status, "missing");
});

test("leaf coverage honors explicit service months and saved allocations without guessing season prepayment", () => {
  const client = assigned({ division: "Seasonal", seasonalType: "Leaf Removal" });
  const dated = paidInvoice(client.id, {
    id: "leaf-october", date: "2026-09-15", maintenanceMonths: ["2026-10"],
    lineItems: [{ desc: "Leaf Removal", amount: 175 }],
  });
  const stored = paidInvoice(client.id, {
    id: "leaf-prepaid", date: "2026-08-15", lineItems: [{ desc: "Leaf Removal", amount: 175 }],
  });
  const unknown = paidInvoice(client.id, {
    id: "leaf-season", date: "2026-07-15", total: 525,
    lineItems: [{ desc: "Leaf Removal", amount: 525 }],
  });
  const ledger = { ...emptyMaintenancePaymentLedger(), allocations: { [client.id]: {
    "2026-11": { status: "paid", expectedCents: 17500, allocatedCents: 17500, sources: [{ kind: "invoice", invoiceId: stored.id, amountCents: 17500 }] },
  } } };
  const [row] = buildMaintenanceCalendarRows({ clients: [client], invoices: [dated, stored, unknown], ledger, year: 2026 });
  assert.deepEqual(row.maintenanceTypes, ["leaf"]);
  assert.equal(row.byMonth["2026-10"].payment.status, "paid");
  assert.equal(row.byMonth["2026-11"].payment.status, "paid");
  assert.equal(row.byMonth["2026-07"].payment.status, "not_expected");
  assert.notEqual(row.byMonth["2026-12"].payment.status, "prepaid");
});

test("calendar price follows the current saved invoice rate after a bulk price change", () => {
  const beforeBulkChange = assigned({ plans: { Pond: "Essential" }, planRates: { Pond: "175" } });
  const afterBulkChange = { ...beforeBulkChange, monthlyRate: "200" };
  assert.equal(maintenanceAssignedPriceCents(afterBulkChange), 20000);
  assert.equal(buildMaintenanceCalendarRows({ clients: [afterBulkChange], year: 2026 })[0].maintenancePriceCents, 20000);
  assert.equal(maintenanceAssignedPriceCents({ ...afterBulkChange, monthlyRate: "0" }), 0);
});

test("calendar fallback prices use only assigned service rates and keep unknown amounts unknown", () => {
  const client = assigned({
    plans: { Pond: "Essential", Pool: "Premium", Seasonal: "Signature" },
    servicePool: false, serviceSeasonal: true, seasonalType: "Gutter Cleaning",
    planRates: { Pond: "175", Pool: "200", Seasonal: "50" }, monthlyRate: "",
  });
  assert.equal(maintenanceAssignedPriceCents(client), 17500);
  assert.equal(maintenanceAssignedPriceCents(assigned({ monthlyRate: "" })), null);
  assert.equal(maintenanceAssignedPriceCents(assigned({ monthlyRate: "0" })), 0);
  assert.equal(maintenanceAssignedPriceCents(assigned({
    plans: { Pond: "Essential", Pool: "Premium" }, servicePool: true, planRates: { Pond: "175" }, monthlyRate: "",
  })), null);
  assert.equal(maintenanceAssignedPriceCents(assigned({
    plans: { Pond: "Essential", Pool: "Premium" }, servicePool: true, planRates: { Pond: "175", Pool: "54" }, monthlyRate: "invalid",
  })), 22900);
  assert.equal(maintenanceAssignedPriceCents(assigned({ monthlyRate: "", maintenanceRate: "150", price: "175" })), 15000);
  assert.equal(maintenanceAssignedPriceCents(assigned({ monthlyRate: "invalid", maintenanceRate: "", price: "175" })), 17500);
  assert.equal(maintenanceAssignedPriceCents(assigned({
    plans: { Pond: "Essential", Pool: "Premium" }, servicePool: true, planRates: { Pond: "175" }, monthlyRate: "", maintenanceRate: "250",
  })), 25000, "an incomplete per-service total can use an explicit legacy total instead");
  assert.deepEqual(maintenanceClientAssignments(client), [{ type: "pond", division: "Pond", plan: "Essential" }]);
});
