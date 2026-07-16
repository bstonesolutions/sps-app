import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCompletedReportIndex, canRebuildCompletedReport, resolveCompletedReport } from "../completedReport.js";

const clients = [
  { id: "a", history: [{ sid: "legacy-one", notes: "A" }, { sid: "shared", notes: "A shared" }, { completionReceiptId: "r-one", sid: "modern-one" }] },
  { id: "b", history: [{ sid: "shared", notes: "B shared" }, { completionReceiptId: "r-split", sid: "modern-b" }] },
  { id: "c", history: [{ completionReceiptId: "r-split", sid: "modern-c" }] },
];
const index = buildCompletedReportIndex(clients);

test("legacy reports resolve to the scheduled client and never another client", () => {
  const completed = { "legacy-one": true, shared: true };
  assert.equal(resolveCompletedReport({ stop: { sid: "legacy-one" }, completed, index, scheduledClientId: "a" }).match?.entry.notes, "A");
  assert.equal(resolveCompletedReport({ stop: { sid: "shared" }, completed, index, scheduledClientId: "b" }).match?.entry.notes, "B shared");
  assert.equal(resolveCompletedReport({ stop: { sid: "legacy-one" }, completed, index, scheduledClientId: "b" }).reason, "legacy-report-wrong-client");
});

test("legacy missing and ambiguous reports stay unavailable", () => {
  assert.equal(resolveCompletedReport({ stop: { sid: "missing" }, completed: { missing: true }, index, scheduledClientId: "a" }).reason, "missing-legacy-report");
  assert.equal(resolveCompletedReport({ stop: { sid: "shared" }, completed: { shared: true }, index }).reason, "ambiguous-legacy-report");
});

test("modern receipts require one authoritative saved report", () => {
  const completed = {
    "modern-one": { receiptId: "r-one" },
    "modern-b": { receiptId: "r-split" },
    __stopReversalReceipts: { "r-split": { clientId: "b" } },
  };
  assert.equal(resolveCompletedReport({ stop: { sid: "modern-one" }, completed, index }).match?.client.id, "a");
  assert.equal(resolveCompletedReport({ stop: { sid: "modern-b" }, completed, index }).match?.client.id, "b");
});

test("malformed and unmatched modern markers never fall back to a legacy sid", () => {
  assert.equal(resolveCompletedReport({ stop: { sid: "modern-one" }, completed: { "modern-one": {} }, index }).reason, "invalid-modern-marker");
  assert.equal(resolveCompletedReport({ stop: { sid: "modern-one" }, completed: { "modern-one": { receiptId: "not-there" } }, index }).reason, "missing-receipt-report");
});

test("only genuinely missing reports qualify for a reviewed rebuild", () => {
  assert.equal(canRebuildCompletedReport("missing-legacy-report"), true);
  assert.equal(canRebuildCompletedReport("missing-receipt-report"), true);
  assert.equal(canRebuildCompletedReport("ambiguous-legacy-report"), false);
  assert.equal(canRebuildCompletedReport("duplicate-owner-reports"), false);
  assert.equal(canRebuildCompletedReport("legacy-report-wrong-client"), false);
});

test("missing reports expose an explicit reviewed rebuild flow", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /Report needs attention/);
  assert.match(app, /Rebuild report/);
  assert.match(app, /__recoveryDraft/);
  assert.match(app, /Planned details are prefilled/);
  assert.match(app, /historyEdit\.create/);
});
