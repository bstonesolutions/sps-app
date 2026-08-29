import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteInvoiceAndCompactSafeDrafts,
  draftInvoiceCanBeRenumbered,
  parseInvoiceSequence,
} from "../invoiceNumbering.js";

test("invoice sequence parsing preserves the configured prefix and digit width", () => {
  assert.deepEqual(parseInvoiceSequence("INV-0098"), {
    raw: "INV-0098", prefix: "INV-", suffix: "", digits: 4, sequence: 98, key: "INV-{number}",
  });
  assert.equal(parseInvoiceSequence("Draft"), null);
});

test("deleting a local draft closes the gap using only later safe drafts", () => {
  const result = deleteInvoiceAndCompactSafeDrafts([
    { id: "sent", number: "INV-1001", status: "Sent" },
    { id: "delete", number: "INV-1002", status: "Draft" },
    { id: "move-a", number: "INV-1003", status: "Draft" },
    { id: "protected", number: "INV-1004", status: "Draft", qbId: "44" },
    { id: "move-b", number: "INV-1006", status: "Draft" },
  ], "delete", { now: "2026-08-29T12:00:00.000Z" });

  assert.deepEqual(result.renumbered, [
    { id: "move-a", from: "INV-1003", to: "INV-1002" },
    { id: "move-b", from: "INV-1006", to: "INV-1003" },
  ]);
  assert.equal(result.invoices.find((invoice) => invoice.id === "protected").number, "INV-1004");
  assert.equal(result.invoices.find((invoice) => invoice.id === "move-a").previousDraftNumber, "INV-1003");
});

test("deleting a linked or issued invoice never renumbers later drafts", () => {
  for (const deleted of [
    { id: "delete", number: "INV-1002", status: "Sent" },
    { id: "delete", number: "INV-1002", status: "Draft", qbId: "22" },
    { id: "delete", number: "INV-1002", status: "Draft", qbCreateOutcomeUnknown: true },
  ]) {
    const result = deleteInvoiceAndCompactSafeDrafts([
      deleted,
      { id: "later", number: "INV-1003", status: "Draft" },
    ], "delete");
    assert.equal(result.invoices[0].number, "INV-1003");
    assert.equal(result.renumbered.length, 0);
  }
});

test("only pristine drafts qualify for number compaction", () => {
  assert.equal(draftInvoiceCanBeRenumbered({ id: "a", number: "INV-1", status: "Draft" }), true);
  assert.equal(draftInvoiceCanBeRenumbered({ id: "a", number: "INV-1", status: "Draft", paymentLink: "https://pay" }), false);
  assert.equal(draftInvoiceCanBeRenumbered({ id: "a", number: "INV-1", status: "Draft", qbNeedsReview: true }), false);
});

test("review, delivery, payment, export, and linked-work evidence protects a draft number", () => {
  for (const evidence of [
    { qbSpsOnly: true },
    { qbFormerId: "old-qb-id" },
    { qbEmailStatus: "EmailSent" },
    { exportedAt: "2026-08-29T12:00:00.000Z" },
    { paymentStatus: "pending" },
    { sourceEstimateId: "estimate-1" },
    { sourceStopIds: ["stop-1"] },
    { autoDraftKey: "visit-1" },
  ]) {
    assert.equal(draftInvoiceCanBeRenumbered({ id: "a", number: "INV-1", status: "Draft", ...evidence }), false);
  }
});

test("externally protected draft candidates are skipped when closing a number gap", () => {
  const result = deleteInvoiceAndCompactSafeDrafts([
    { id: "delete", number: "INV-1002", status: "Draft" },
    { id: "linked", number: "INV-1003", status: "Draft" },
    { id: "move", number: "INV-1004", status: "Draft" },
  ], "delete", { protectedInvoiceIds: new Set(["linked"]) });

  assert.deepEqual(result.renumbered, [{ id: "move", from: "INV-1004", to: "INV-1002" }]);
  assert.equal(result.invoices.find((invoice) => invoice.id === "linked").number, "INV-1003");
});
