import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const start = app.indexOf("  const save = async", app.indexOf("function HistoryEditModal("));
const source = app.slice(start, app.indexOf("  const labelStyle =", start));
const entry = { sid: "s1", completionReceiptId: "r1", notes: "Before", invoice: "$0", services: [{ name: "Covered service", price: 0, catalogId: "catalog-1" }], products: [{ id: "p1", name: "Filter" }] };
function harness(saveStopReport) {
  const events = [];
  const originalServices = entry.services.map(s => ({ ...s, price: s.price ?? "" }));
  const originalProducts = entry.products.map(p => p.name);
  const deps = { busy: false, saveInFlight: { current: false }, isRecovery: false, clientId: "client-1", entry,
    notes: "After", officeNotes: "", type: "Service", tech: "David", readings: {}, readingStatus: {}, photos: [],
    originalServices, svcList: structuredClone(originalServices), originalProducts, prodList: [...originalProducts],
    revenue: "0", b: {}, canEditFinancials: true, num: value => parseFloat(value) || 0,
    saveStopReport, onSave: () => events.push("generic-write"), onClose: () => events.push("close"),
    setBusy: value => events.push(["busy", value]), setSaveError: value => events.push(["error", value]),
  };
  for (const name of ["labor", "treatment", "partsCost", "product", "gas", "insurance", "equipment", "overhead"]) deps[name] = "0";
  return { events, save: new Function(...Object.keys(deps), `${source}; return save;`)(...Object.values(deps)) };
}
test("notes-only report edits preserve untouched zero prices, catalog identity, products and financial snapshots", async () => {
  let submitted;
  const h = harness(async request => { submitted = request; });
  await h.save();
  assert.deepEqual(submitted.updated.services, entry.services);
  assert.deepEqual(submitted.updated.products, entry.products);
  assert.equal(Object.hasOwn(submitted.updated, "breakdown"), false);
  assert.equal(submitted.updated.invoice, "$0");
  assert.equal(submitted.updated.notes, "After");
  assert.equal(h.events.includes("generic-write"), false);
  assert.equal(h.events.includes("close"), true);
});
test("the report editor waits for confirmation and stays open after save or refresh failure", async () => {
  let reject;
  const h = harness(() => new Promise((_resolve, failed) => { reject = failed; }));
  const saving = h.save();
  assert.equal(h.events.includes("close"), false);
  await h.save();
  reject(new Error("Saved on the server but refresh failed"));
  await saving;
  assert.equal(h.events.includes("close"), false);
  assert.equal(h.events.includes("generic-write"), false);
  assert.deepEqual(h.events.at(-1), ["busy", false]);
  assert.ok(h.events.some(event => event[0] === "error" && /refresh failed/.test(event[1])));
});

test("confirmed server save with a failed display refresh is not presented as finished", async () => {
  const start = app.indexOf("  const saveStopReport = async", app.indexOf("export default function App("));
  const source = app.slice(start, app.indexOf("  const refreshCompletionOutboxView =", start));
  const deps = { buildReportEditRequest: async value => value, requestStopReportEdit: async () => ({ ok: true, entry }),
    PROD_URL: "https://example.invalid", authHeaders: async headers => headers, refreshStopBaseline: async () => null };
  const save = new Function(...Object.keys(deps), `${source}; return saveStopReport;`)(...Object.values(deps));
  await assert.rejects(save({ clientId: "client-1", entry, updated: entry }), /saved on the server.*could not refresh/);
});
