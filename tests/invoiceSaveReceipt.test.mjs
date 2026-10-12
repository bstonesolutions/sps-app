import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { mergeStoredState } from "../stateMerge.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const identityStart = app.indexOf("function matchesPendingEditorCreation(");
const identityEnd = app.indexOf("function storeReceiptIssue(", identityStart);
const matchesPendingEditorCreation = new Function(`${app.slice(identityStart, identityEnd)}; return matchesPendingEditorCreation;`)();
const start = app.indexOf("  const handleSaveInvoice =");
const end = app.indexOf("  const handleConvertEstimateToInvoice =", start);
assert.ok(start > 0 && end > start);
const source = app.slice(start, end);
const original = { id: "invoice-1", number: "2001", status: "Draft", clientId: "client-1", notes: "", lineItems: [{ id: "line-1", desc: "Service", qty: 1, unitPrice: 100 }] };
const edited = { ...original, lineItems: [{ ...original.lineItems[0], unitPrice: 150 }] };

function harness({ rows = [original], storedRows = rows, receipt = async (value) => ({ ok: true, value }) } = {}) {
  const state = { writes: [], adopted: [], effects: [] };
  const invoicesRef = { current: rows };
  const dependencies = {
    invoices: rows, invoicesRef, matchesPendingEditorCreation, clients: [], branding: {}, perms: { isAdmin: true },
    invoiceTotals: () => ({ total: 150 }), setInvoices: value => state.adopted.push(value),
    notifyOwnerEmail: () => state.effects.push("email"), postClientMessage: () => state.effects.push("message"), sendPushEvent: () => state.effects.push("push"),
    storeReceiptIssue: result => result?.ok ? "" : "SPS save is pending.",
    store: {
      get: async () => ({ value: JSON.stringify(storedRows) }),
      set: async (key, value, options) => { state.writes.push({ key, value, options }); return receipt(value, options); },
    },
  };
  const save = new Function(...Object.keys(dependencies), `${source}; return handleSaveInvoice;`)(...Object.values(dependencies));
  return { save, state, invoicesRef };
}

test("invoice editor waits for exact persistence without customer or accounting side effects", async () => {
  let resolve;
  const { save, state, invoicesRef } = harness({ receipt: async () => new Promise(done => { resolve = done; }) });
  const pending = save(edited, { confirmedSave: true, baselineJson: JSON.stringify(original) });
  await Promise.resolve();
  assert.deepEqual(state.adopted, []);
  assert.equal(invoicesRef.current[0], original);
  assert.equal(state.writes[0].key, "sps_invoices");
  assert.deepEqual(JSON.parse(state.writes[0].options.baseValue), [original]);
  resolve({ ok: true, value: JSON.stringify([edited]) });
  assert.deepEqual(await pending, edited);
  assert.deepEqual(state.adopted, [[edited]]);
  assert.deepEqual(invoicesRef.current, [edited]);
  assert.deepEqual(state.effects, []);
});

test("invoice pending, malformed, missing, or mismatched QuickBooks receipts never confirm success", async () => {
  const synced = { ...edited, qbId: "QB-1" };
  for (const response of [
    { ok: false, queued: true }, { ok: true, value: "bad" }, { ok: true, value: "[]" },
    { ok: true, value: JSON.stringify([{ ...synced, qbId: "QB-other" }]) },
  ]) {
    const { save, state } = harness({ receipt: async () => response });
    await assert.rejects(save(synced, { confirmedSave: true, baselineJson: JSON.stringify(original) }), /pending|verified/);
    assert.deepEqual(state.adopted, []);
    assert.deepEqual(state.effects, []);
  }
});

test("invoice save preserves a newer independent remote note using its open-editor baseline", async () => {
  const current = { ...original, notes: "From another device" };
  const { save } = harness({ rows: [current], receipt: async (value, options) => {
    const merged = mergeStoredState("sps_invoices", JSON.parse(options.baseValue), JSON.parse(value), [current]);
    assert.deepEqual(merged.conflicts, []);
    return { ok: true, value: merged.value };
  } });
  const saved = await save(edited, { confirmedSave: true, baselineJson: JSON.stringify(original) });
  assert.equal(saved.notes, current.notes);
  assert.equal(saved.lineItems[0].unitPrice, 150);
});

test("invoice editor cannot resurrect a deleted invoice or overwrite an unrelated new invoice collision", async () => {
  const absent = harness({ rows: [] });
  await assert.rejects(absent.save(edited, { confirmedSave: true, baselineJson: JSON.stringify(original) }), /removed/);
  assert.deepEqual(absent.state.writes, []);
  const collision = harness();
  await assert.rejects(collision.save(edited, { confirmedSave: true, baselineJson: "" }), /already exists/);
  assert.deepEqual(collision.state.writes, []);
});

test("a just-saved visit reservation is used before React has rerendered the invoice list", async () => {
  const reserved = { ...original, sourceStopIds: ["stop-1"] };
  const synced = { ...reserved, qbId: "QB-1" };
  const { save, state } = harness({ rows: [], storedRows: [reserved] });
  assert.deepEqual(await save(synced, { confirmedSave: true, baselineJson: JSON.stringify(reserved) }), synced);
  assert.deepEqual(JSON.parse(state.writes[0].options.baseValue), [reserved]);
});

test("new invoice SPS retry adopts its background commit and preserves newer QuickBooks metadata", async () => {
  const attempted = { ...edited, createdAt: 1001, qbId: "QB-1", qbSyncedAt: "2026-10-07T14:00:00Z" };
  const current = { ...attempted, qbSyncedAt: "2026-10-07T14:00:30Z", notes: "Office note" };
  const { save } = harness({ rows: [current], receipt: async (value, options) => {
    const merged = mergeStoredState("sps_invoices", JSON.parse(options.baseValue), JSON.parse(value), [current]);
    assert.deepEqual(merged.conflicts, []);
    return { ok: true, value: merged.value };
  } });
  const confirmed = await save(attempted, { confirmedSave: true, baselineJson: "", attemptedInvoice: attempted });
  assert.equal(confirmed.qbSyncedAt, current.qbSyncedAt);
  assert.equal(confirmed.notes, current.notes);
  assert.equal(confirmed.qbId, "QB-1");
});
