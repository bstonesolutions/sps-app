import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the actual batch controller with isolated transport/storage fakes.
const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const start = app.indexOf("  const createAll = async () => {", app.indexOf("function BatchInvoiceModal"));
const end = app.indexOf("  const fillWithLink", start);
assert.ok(start > 0 && end > start);
const source = app.slice(start, end) + "\ncreateAll";

async function runBatch({ pending = false, failAdoption = false, networkFailure = false, connected = true } = {}) {
  let progress = [], phase;
  const calls = [], saves = [];
  const invoiceRefresh = { ok: true, actorId: "owner", invoices: [] };
  const createAll = vm.runInNewContext(source, {
    Date, String, Error, coverageLoading: false, batchNeedsCoverage: false, coverageLedger: {},
    setPhase: value => { phase = value; }, nextInvoiceNumber: () => 2001,
    invoices: [], cfg: { dueDays: 15 }, prefix: "", serviceMonth: "2026-10", taxRate: 0,
    chosen: [{ id: "client-1", name: "Sample client" }],
    hasAmount: () => true, linesFor: () => [{ id: "line-1", desc: "Service", qty: 1, unitPrice: 100 }],
    coverageFor: () => null, todayMDY: () => "10/22/2026", addDaysMDY: () => "11/06/2026",
    qbIsConnected: () => connected, QB_API: "/api/quickbooks", authHeaders: async headers => headers,
    qbPayload: invoice => invoice, setProgress: values => { progress = values; },
    applyQuickBooksInvoiceSaveResult: (invoice, data) => ({ ...invoice, qbId: data.qbId }),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (networkFailure) throw new Error("Network interrupted");
      return { ok: true, json: async () => ({ success: true, qbId: "QB-1", ...(pending ? { appSyncPending: true } : { invoiceRefresh }) }) };
    },
    onSave: async (invoice, options) => {
      saves.push({ invoice, options });
      if (failAdoption) throw new Error("Disk unavailable");
      return invoice;
    },
  });
  await createAll();
  return { calls, saves, progress, phase, invoiceRefresh };
}

test("batch rows become send-eligible only after awaiting exact server receipt adoption", async () => {
  const result = await runBatch();
  assert.equal(result.calls.length, 1); assert.equal(result.saves.length, 1);
  assert.equal(result.saves[0].options.confirmedSave, true);
  assert.equal(result.saves[0].options.invoiceRefresh, result.invoiceRefresh);
  assert.equal(result.progress[0].ok, true);
  assert.equal(result.progress[0].invoice.qbId, "QB-1");
  assert.equal(result.phase, "messaging");
});

test("a QB-saved batch row with pending SPS persistence cannot be counted as saved or sent", async () => {
  for (const options of [{ pending: true }, { failAdoption: true }]) {
    const result = await runBatch(options);
    assert.equal(result.calls.length, 1);
    assert.equal(result.saves.length, options.pending ? 0 : 1);
    assert.equal(result.progress[0].ok, false);
    assert.equal(result.progress[0].held, true);
    assert.match(result.progress[0].error, /Saved in QuickBooks.*Refresh SPS/);
  }
});

test("an unknown batch result retains a review marker and never retries the create", async () => {
  const result = await runBatch({ networkFailure: true });
  assert.equal(result.calls.length, 1); assert.equal(result.saves.length, 1);
  assert.equal(result.saves[0].invoice.qbCreateOutcomeUnknown, true);
  assert.equal(result.progress[0].ok, false); assert.equal(result.progress[0].held, true);
});

test("a disconnected batch still requires a confirmed SPS save", async () => {
  const success = await runBatch({ connected: false });
  assert.equal(success.calls.length, 0); assert.equal(success.saves[0].options.confirmedSave, true);
  assert.equal(success.progress[0].ok, true);
  const failure = await runBatch({ connected: false, failAdoption: true });
  assert.equal(failure.progress[0].ok, false);
});
