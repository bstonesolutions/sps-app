import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeMaintenanceBillingPolicy } from "../maintenanceBilling.js";
import { maintenanceCoverageMonthDate, prepaymentInvoiceLabel, prepaymentInvoiceSummary } from "../clientMaintenanceBillingForm.js";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const start = app.indexOf("  const saveClient = async () => {") + "  const saveClient = ".length;
const end = app.indexOf("\n\n  // ── Per-division service plan helpers", start);
assert.ok(start > 0 && end > start, "the real client editor save handler must exist");
const saveSource = app.slice(start, end).trim().replace(/;$/, "");
const prepaid = { version: 1, mode: "prepaid", coveredFrom: "2026-01-01", coveredThrough: "2026-12-31", sourceInvoiceId: "old-invoice", sourceInvoiceNumber: "INV-2025" };

function saveHarness(overrides = {}) {
  const state = { saving: false, error: "", posts: [], saves: [] };
  const deps = {
    formSavingRef: { current: false },
    initialFormRef: { current: { id: "c1", name: "Original contact" } },
    form: { id: "c1", name: "Edited contact", maintenanceBilling: { ...prepaid } },
    client: { id: "c1", name: "Original contact" },
    manageClientAutoInvoice: true,
    hasPersistedClient: true,
    prepaidMaintenance: true,
    normalizeMaintenanceBillingPolicy,
    setFormError: error => { state.error = error; },
    setFormSaving: saving => { state.saving = saving; },
    PROD_URL: "https://example.test",
    authHeaders: async headers => headers,
    fetch: async (_url, options) => {
      state.posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, maintenanceBilling: prepaid, client: { id: "c1", name: "Server contact" } }) };
    },
    onSave: async (client, options) => { state.saves.push({ client, options }); return client; },
    ...overrides,
  };
  return { state, deps, save: new Function(...Object.keys(deps), `return (${saveSource});`)(...Object.values(deps)) };
}

test("client editor keeps the old invoice reference and edited contact fields through both confirmed save stages", async () => {
  const { state, save } = saveHarness();
  await save();
  assert.deepEqual(state.posts, [{ clientId: "c1", maintenanceBilling: prepaid }]);
  assert.equal(state.saves[0].client.name, "Edited contact", "server billing mirror must not replace in-progress profile edits");
  assert.equal(state.saves[0].client.maintenanceBilling.sourceInvoiceId, "old-invoice");
  assert.deepEqual(state.saves[0].options, { clientEdit: true, baselineClient: { id: "c1", name: "Original contact" }, billingConfirmed: prepaid });
  assert.equal(state.error, "");
  assert.equal(state.saving, false);
});

test("the editor waits for the final client save and blocks duplicate clicks while it is pending", async () => {
  let finish;
  let calls = 0;
  const { state, save } = saveHarness({ onSave: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  let settled = false;
  const pending = save().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.saving, true);
  assert.equal(settled, false);
  await save();
  assert.equal(calls, 1);
  assert.equal(state.posts.length, 1);
  finish({ id: "c1" });
  await pending;
  assert.equal(state.saving, false);
});

test("a billing timeout keeps the selected invoice and reports the server failure without calling profile save", async () => {
  const { state, deps, save } = saveHarness({ fetch: async () => ({ ok: false, json: async () => ({ error: "The server could not confirm this billing change. Try again." }) }) });
  await save();
  assert.match(state.error, /could not confirm this billing change/);
  assert.equal(state.saves.length, 0);
  assert.equal(deps.form.maintenanceBilling.sourceInvoiceId, "old-invoice");
  assert.equal(state.saving, false);
});

test("a failed final client receipt stays in the editor instead of claiming the profile is saved", async () => {
  const { state, save } = saveHarness({ onSave: async () => { throw new Error("Billing is saved. Review the client conflict before saving the other changes."); } });
  await save();
  assert.match(state.error, /Billing is saved.*client conflict/);
  assert.equal(state.saving, false);
});

test("standard billing passes an explicit cleared policy to the confirmed profile save", async () => {
  const { state, save } = saveHarness({
    prepaidMaintenance: false,
    form: { id: "c1", name: "Edited contact" },
    client: { id: "c1", name: "Original contact", maintenanceBilling: prepaid },
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(options.body).maintenanceBilling, null);
      return { ok: true, json: async () => ({ ok: true, maintenanceBilling: null }) };
    },
  });
  await save();
  assert.equal(Object.hasOwn(state.saves[0].client, "maintenanceBilling"), false);
  assert.equal(state.saves[0].options.billingConfirmed, null);
});

test("nonaccounting client editors await profile persistence and keep the original policy", async () => {
  const { state, save } = saveHarness({ manageClientAutoInvoice: false, client: { id: "c1", maintenanceBilling: prepaid }, form: { id: "c1", name: "Edited" }, onSave: async (client, options) => {
    assert.deepEqual(client.maintenanceBilling, prepaid);
    assert.equal(Object.hasOwn(options, "billingConfirmed"), false);
    throw new Error("The client profile could not be saved.");
  } });
  await save();
  assert.equal(state.posts.length, 0);
  assert.match(state.error, /client profile could not be saved/);
});

test("invalid month ranges fail before either save stage", async () => {
  const { state, save } = saveHarness({ form: { id: "c1", maintenanceBilling: { ...prepaid, coveredThrough: "2025-12-31" } } });
  await save();
  assert.match(state.error, /last month must be the same as or after the first/);
  assert.equal(state.posts.length, 0);
  assert.equal(state.saves.length, 0);
});

test("month controls persist valid whole-month bounds including leap years", () => {
  assert.equal(maintenanceCoverageMonthDate("2026-04"), "2026-04-01");
  assert.equal(maintenanceCoverageMonthDate("2026-04", true), "2026-04-30");
  assert.equal(maintenanceCoverageMonthDate("2028-02", true), "2028-02-29");
  assert.equal(maintenanceCoverageMonthDate("2100-02", true), "2100-02-28");
  assert.equal(maintenanceCoverageMonthDate(""), "");
  assert.equal(maintenanceCoverageMonthDate("2026-13"), "");
  assert.equal(maintenanceCoverageMonthDate("2026-04-15"), "");
});

test("old QuickBooks invoice choices show canonical totals and payment status", () => {
  assert.equal(prepaymentInvoiceSummary({ number: "1001", date: "2025-11-15", qbId: "qb1", total: 2400, balance: 0 }), "Paid · $2400.00 · 2025-11-15");
  assert.match(prepaymentInvoiceLabel({ id: "old", number: "1001", date: "2025-11-15", qbId: "qb1", total: 2400, balance: 0, lineItems: [] }), /Invoice 1001 · 2025-11-15 · \$2400\.00 · Paid$/);
  assert.match(prepaymentInvoiceLabel({ number: "1002", total: 2400, balance: 1200 }), /Partly paid$/);
  assert.match(prepaymentInvoiceLabel({ number: "1003", total: 2400, balance: 2400 }), /Unpaid$/);
  assert.match(prepaymentInvoiceLabel({ number: "1004", qbId: "qb4", balance: null }), /Total not available · Payment status unknown$/);
  assert.match(prepaymentInvoiceLabel({ number: "1005", qbId: "qb5", balance: 0 }), /Total not available · Payment status unknown$/);
});
