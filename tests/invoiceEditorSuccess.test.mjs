import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const editorStart = app.indexOf("function InvoiceEditor");
const finishStart = app.indexOf("  const finishSave = ", editorStart) + "  const finishSave = ".length;
const finishEnd = app.indexOf("\n\n  // QuickBooks errors", finishStart);
assert.ok(editorStart >= 0 && finishStart > editorStart && finishEnd > finishStart);
const finishSource = app.slice(finishStart, finishEnd).trim().replace(/;$/, "");
const sendBranch = app.slice(finishEnd).match(/if \(([^\n]+)\) return <InvoiceSendStep invoice=\{sendStep\}/);
assert.ok(sendBranch, "the real editor must expose its post-save notification step");
const showsSendStep = new Function("sendStep", "sendClient", "coverageIssue", "billingReview = false", `return Boolean(${sendBranch[1]});`);

const draft = { id: "sample-invoice", clientId: "sample-client", number: "SAMPLE-1", status: "Sent", lineItems: [{ id: "service", desc: "Monthly service", serviceMonth: "2026-08", qty: 1, unitPrice: 350 }] };
const synced = { ...draft, qbId: "sample-qb", qbSyncStatus: "synced", qbAuthoritative: true, total: 350, balance: 350,
  lineItems: [{ ...draft.lineItems[0], desc: "Monthly service - August 2026", qbLineId: "1" }] };

function finishHarness(overrides = {}) {
  const state = { inv: draft, persisted: false, qbState: "sending", qbMsg: "Previous attempt failed", coverageError: "Previous coverage check failed", sendStep: null, saved: [], closed: 0, requests: 0 };
  const deps = {
    client: { id: draft.clientId, name: "Sample client" },
    onSave: invoice => { state.saved.push(invoice); },
    setInv: invoice => { state.inv = invoice; },
    setIsPersisted: value => { state.persisted = value; },
    setQbState: value => { state.qbState = value; },
    setQbMsg: value => { state.qbMsg = value; },
    setCoverageError: value => { state.coverageError = value; },
    setSendStep: invoice => { state.sendStep = invoice; },
    onClose: () => { state.closed++; },
    fetch: () => { state.requests++; throw new Error("Completion must not send any request"); },
    ...overrides,
  };
  return { state, deps, finish: new Function(...Object.keys(deps), `return (${finishSource});`)(...Object.values(deps)) };
}

test("a successful QB save adopts normalized lines and exits sending despite a stale coverage warning", () => {
  const { state, deps, finish } = finishHarness();
  finish(synced);
  assert.deepEqual(state.saved, [synced]);
  assert.equal(state.inv, synced, "the editor must retain the returned QB id and normalized accounting content");
  assert.equal(state.persisted, true);
  assert.equal(state.qbState, "done");
  assert.equal(state.qbMsg, "");
  assert.equal(state.coverageError, "");
  assert.equal(state.sendStep, synced);
  assert.equal(showsSendStep(state.sendStep, deps.client, { code: "maintenance-coverage-review" }), true,
    "an old advisory must not hide completion after QB has already accepted this invoice");
  assert.equal(state.requests, 0, "showing optional delivery controls must not notify a client");
  assert.equal(state.closed, 0);
});

test("a local save with no invoice lines exits the busy editor without a notification step", () => {
  const { state, finish } = finishHarness();
  finish({ ...draft, lineItems: [] });
  assert.equal(state.qbState, "done");
  assert.equal(state.sendStep, null);
  assert.equal(state.closed, 1);
  assert.equal(state.requests, 0);
  assert.equal(showsSendStep(null, { id: draft.clientId }, null), false);
});

test("a synchronous parent save failure does not replace the draft or expose delivery controls", () => {
  const { state, finish } = finishHarness({ onSave: () => { throw new Error("Save rejected"); } });
  assert.throws(() => finish(synced), /Save rejected/);
  assert.equal(state.inv, draft);
  assert.equal(state.sendStep, null);
  assert.equal(state.persisted, false);
  assert.equal(state.closed, 0);
  assert.equal(state.requests, 0);
});

test("a current maintenance preflight rejection still prevents QB creation and the success step", async () => {
  const saveStart = app.indexOf("  const save = async () => {", editorStart) + "  const save = ".length;
  const saveEnd = app.indexOf("\n\n  const field =", saveStart);
  assert.ok(saveStart > editorStart && saveEnd > saveStart);
  const saveSource = app.slice(saveStart, saveEnd).trim().replace(/;$/, "");
  const state = { qbState: "idle", qbMsg: "", finishes: 0, requests: 0 };
  const deps = {
    progressState: "idle", qbState: "idle", selectedClientSnapshot: () => draft,
    editRevisionRef: { current: 0 }, needsCoverageCheck: true,
    setQbState: value => { state.qbState = value; }, setQbMsg: value => { state.qbMsg = value; },
    loadInvoiceCoverage: async () => ({ version: 2, policies: {}, allocations: {} }),
    withMatchedMaintenanceServiceMonths: ({ invoice }) => invoice,
    invoiceMaintenanceCoverageIssue: () => ({ code: "maintenance-coverage-review", message: "Review the current month first." }),
    client: { id: draft.clientId }, clients: [], invoices: [draft], schedule: [],
    finishSave: () => { state.finishes++; },
    fetch: () => { state.requests++; throw new Error("A blocked invoice must not reach QB"); },
  };
  await new Function(...Object.keys(deps), `return (${saveSource});`)(...Object.values(deps))();
  assert.equal(state.qbState, "error");
  assert.match(state.qbMsg, /Review the current month first/);
  assert.equal(state.finishes, 0);
  assert.equal(state.requests, 0);
});
