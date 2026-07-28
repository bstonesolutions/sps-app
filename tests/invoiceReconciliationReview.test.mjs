import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  invoiceNeedsReconciliationReview,
  invoiceReconciliationIssue,
} from "../invoiceReconciliationReview.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("only unresolved accounting records enter the invoice review queue", () => {
  assert.equal(invoiceNeedsReconciliationReview({
    id: "draft",
    status: "Draft",
    total: 200,
  }, { effectiveStatus: "Draft", balance: 200 }), false);

  assert.equal(invoiceNeedsReconciliationReview({
    id: "sent-local",
    status: "Sent",
    total: 200,
  }, { effectiveStatus: "Sent", balance: 200 }), true);

  assert.equal(invoiceNeedsReconciliationReview({
    id: "missing",
    status: "Sent",
    qbId: "4949",
    qbSyncStatus: "missing-remote",
  }, { effectiveStatus: "Sent", balance: 0 }), true);

  assert.equal(invoiceNeedsReconciliationReview({
    id: "paid",
    status: "Paid",
    total: 200,
  }, { effectiveStatus: "Paid", balance: 0 }), false);

  assert.equal(invoiceNeedsReconciliationReview({
    id: "intentional-sps-only",
    status: "Sent",
    total: 200,
    qbSpsOnly: true,
    qbSyncStatus: "sps-only",
  }, { effectiveStatus: "Sent", balance: 200 }), false);
});

test("missing remote details preserve identifiers and explain that SPS kept the record", () => {
  const issue = invoiceReconciliationIssue({
    qbId: "4949",
    qbSyncStatus: "missing-remote",
    qbSyncError: "QuickBooks object not found.",
    qbSyncErrorCode: "QB_SYNC_FAILED",
    qbSyncAttemptedAt: "2026-07-28T19:00:00.000Z",
  });

  assert.equal(issue.code, "missing-remote");
  assert.equal(issue.qbId, "4949");
  assert.match(issue.reason, /SPS kept the record instead of deleting it/);
  assert.match(issue.nextStep, /deliberately recreate it/);
  assert.equal(issue.lastError, "QuickBooks object not found.");
  assert.equal(issue.errorCode, "QB_SYNC_FAILED");
  assert.equal(issue.attemptedAt, "2026-07-28T19:00:00.000Z");
});

test("duplicate and conflict records get reason-specific safe next steps", () => {
  const duplicate = invoiceReconciliationIssue({
    qbId: "4949",
    qbSyncStatus: "duplicate-local-qb-id",
    qbDuplicateOfId: "invoice-preferred",
  });
  assert.equal(duplicate.relatedInvoiceId, "invoice-preferred");
  assert.match(duplicate.title, /Two SPS records/);
  assert.match(duplicate.nextStep, /Compare both SPS records/);

  const conflict = invoiceReconciliationIssue({
    qbId: "4949",
    qbNeedsReview: true,
    qbSyncStatus: "conflict",
    qbSyncConflict: { reason: "newer-local-edits-after-unknown-create" },
  });
  assert.match(conflict.title, /recovered an earlier version/);
  assert.match(conflict.nextStep, /explicitly choose/);
});

test("a persisted create failure is not mislabeled as a two-version conflict", () => {
  const issue = invoiceReconciliationIssue({
    qbNeedsReview: true,
    qbSyncStatus: "pending-push",
    qbSyncError: "Duplicate Document Number Error",
    qbSyncErrorCode: "QB_DUPLICATE_DOCUMENT_NUMBER",
  });

  assert.equal(issue.title, "QuickBooks sync did not complete");
  assert.equal(issue.actionLabel, "Retry invoice link");
  assert.doesNotMatch(issue.title, /both changed/);
});

test("invoice review UI is actionable and its QuickBooks inspection is read-only", () => {
  assert.match(appSource, /function InvoiceReconciliationReviewQueue/);
  assert.match(appSource, /Review now/);
  assert.match(appSource, /Tap to see the exact invoice, reason, IDs, and safe next step/);
  assert.match(appSource, /SPS ID:/);
  assert.match(appSource, /QB ID:/);
  assert.match(appSource, /Check QuickBooks/);
  assert.match(appSource, /reviewInvoiceId/);
  assert.match(appSource, /reviewInvoiceNumber/);
  assert.match(appSource, /Use confirmed QuickBooks record/);
  assert.match(appSource, /Link exact QuickBooks match/);
  assert.match(appSource, /issue\.code !== "conflict"/);
  assert.match(appSource, /Confirm SPS-only/);
  assert.match(appSource, /method:\s*"POST"[\s\S]*?mode:\s*"invoice-review"/);
  assert.doesNotMatch(appSource, /sync\?\$\{params\.toString\(\)\}/);
  assert.match(appSource, /QuickBooks outstanding · all dates/);
});

test("invoice save failures persist reviewable QuickBooks diagnostics", () => {
  assert.match(appSource, /applyQuickBooksInvoiceSyncFailure/);
  assert.match(appSource, /code:\s*"QB_CREATE_OUTCOME_UNKNOWN"/);
  assert.match(appSource, /code:\s*"QB_AUTH_EXPIRED"/);
  assert.match(appSource, /code:\s*"QB_NETWORK_ERROR"/);
  assert.match(appSource, /Last sync error/);
});
