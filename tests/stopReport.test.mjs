import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { buildReportEditRequest, requestStopReportEdit, stableReportJSON } from "../stopReport.js";

const entry = { sid: "stop-1", completionReceiptId: "receipt-1", notes: "Original", photos: [{ src: "data:image/jpeg;base64,fixture" }], services: [{ name: "Pond care", price: 80 }], invoice: "$80" };

test("report edits send only the changed fields and a stable fingerprint, without re-uploading old photos", async () => {
  const body = await buildReportEditRequest({ clientId: 7, entry, updated: { ...entry, notes: "Corrected", linkedInvoiceId: "forbidden", sid: "stop-1" }, cryptoImpl: webcrypto });
  assert.deepEqual(body.changes, { notes: "Corrected" });
  assert.equal(body.expectedHash, createHash("sha256").update(stableReportJSON(entry)).digest("hex"));
  const reordered = { invoice: entry.invoice, services: [{ price: 80, name: "Pond care" }], photos: entry.photos, notes: entry.notes, completionReceiptId: entry.completionReceiptId, sid: entry.sid };
  assert.equal(stableReportJSON(entry), stableReportJSON(reordered));
});

test("missing-report repair sends no inventory, identity overrides, or generated recovery timestamps", async () => {
  const body = await buildReportEditRequest({ clientId: 7, entry: null, updated: { ...entry, date: "10/07/2026", assigneeId: "e1", checklist: [], treatmentsUsed: [{ oz: 3 }], recoveredAt: "client-clock", recoveredFromSchedule: true } });
  assert.equal(body.expectedHash, null);
  assert.equal(body.changes.date, "10/07/2026");
  assert.equal(Object.hasOwn(body.changes, "treatmentsUsed"), false);
  assert.equal(Object.hasOwn(body.changes, "recoveredAt"), false);
  assert.equal(Object.hasOwn(body.changes, "completionReceiptId"), false);
});

test("a success response must prove the exact edited receipt and fields", async () => {
  const body = { sid: entry.sid, receiptId: entry.completionReceiptId, changes: { notes: "Corrected" } };
  const run = data => requestStopReportEdit({ url: "https://example.test/api/stop-report", body, fetchImpl: async () => ({ ok: true, json: async () => data }) });
  await assert.rejects(run({ ok: true, receiptId: "other", entry }), /exact report changes/);
  await assert.rejects(run({ ok: true, receiptId: entry.completionReceiptId, entry }), /exact report changes/);
  const saved = { ...entry, notes: "Corrected" };
  assert.deepEqual((await run({ ok: true, receiptId: entry.completionReceiptId, entry: saved })).entry, saved);
});

test("conflicts and transport timeouts surface without claiming saved or automatic retry", async () => {
  await assert.rejects(requestStopReportEdit({ url: "https://example.test", body: {}, fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "Another device edited this report", code: "report-changed" }) }) }), error => error.code === "report-changed" && error.status === 409);
  await assert.rejects(requestStopReportEdit({ url: "https://example.test", body: {}, timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) }), /edits are still here/);
});
