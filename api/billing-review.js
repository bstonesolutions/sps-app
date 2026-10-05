// Owner billing workbench. Reviews never enter accounting until the frozen
// approval has succeeded in QuickBooks and the SPS promotion has been confirmed.
import { randomUUID } from "node:crypto";
import { requireOwner } from "./_staff-auth.js";
import { readAppStatesVersioned, compareAndSetAppState, compareAndSetAppStateBatch } from "./_app-state.js";
import createQuickBooksInvoice from "./quickbooks/create-invoice.js";
import { BILLING_REVIEW_CREATE_CONTEXT } from "./_billing-review-context.js";
import { readQuickBooksInvoiceNumberInventory, firstUnusedInvoiceNumber, sameInvoiceNumber, normalizeBillingReviewInvoiceNumber, billingReviewInvoiceNumberChoices } from "./_billing-review-numbering.js";
import { BILLING_REVIEW_KEY, collectBillingReviewNumberClaims, planBillingReviewMigration } from "../billingReview.js";
import * as billingReviewDomain from "../billingReview.js";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";
import { applyQuickBooksInvoiceSaveResult, quickBooksInvoiceIntentSignature } from "../quickbooksInvoiceReconciliation.js";
import { quickBooksMaintenanceGuard } from "./quickbooks/maintenance-guard.js";
import { invoiceServiceDescriptionIssue } from "../invoiceServiceDescription.js";
import { invoiceCompletedVisitSources, reserveCompletedVisitInvoice } from "../invoiceVisitImport.js";
import { billingReviewAccountingIssue } from "./_billing-review-claims.js";

export const config = { maxDuration: 60 };
const KEYS = [BILLING_REVIEW_KEY, "sps_invoices", "sps_estimates", "sps_schedule", "sps_clients", "sps_completed", "sps_invoicing", "sps_maintenance_billing"];
const ARRAY_KEYS = new Set([BILLING_REVIEW_KEY, "sps_invoices", "sps_estimates", "sps_schedule", "sps_clients"]);
const text = value => String(value ?? "").trim();
const copy = value => structuredClone(value);
const list = value => Array.isArray(value) ? value : [];
const same = (a, b) => text(a) === text(b);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const editedFields = ["title", "date", "dueDate", "termsDays", "taxRate", "notes", "discountType", "discount", "serviceMonth", "lineItems"];
const lineFields = ["id", "desc", "qty", "unitPrice", "unitCost", "knownUnitCost", "costKnown", "taxable", "kind", "refId", "unit", "bundleNote", "bundleItems", "discountType", "discount", "serviceMonth", "serviceDate", "maintenanceService", "isLateFee"];
const sourceFields = ["sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds", "sourceVisitDates", "sourceClientId", "sourceEstimateId", "sourceEstimateItemId", "sourceEstimateLineId"];
const nowISO = now => new Date(now()).toISOString();

function responseCapture() {
  return { statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
}

function reviewedRecord(reviews, id) {
  const matches = reviews.filter(record => same(record?.id, id));
  if (matches.length !== 1) throw fail(409, "billing_review_not_unique", "This billing review is missing or duplicated. Refresh the review list.");
  return matches[0];
}

function revisionMatches(review, expected) {
  if (!Number.isSafeInteger(Number(expected)) || Number(expected) !== Number(review.reviewRevision)) {
    throw fail(409, "billing_review_changed", "This review changed on another device. Reopen it before saving or confirming.");
  }
}

function pendingOnly(review) {
  if (review.reviewState !== "pending") throw fail(409, "billing_review_locked", "This review is already being confirmed. Finish or retry its existing sync before changing it.");
}

export function sanitizeBillingReviewEdit(review, requested) {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) throw fail(400, "billing_review_invalid", "The review changes are invalid.");
  const result = { ...review };
  for (const key of editedFields) if (Object.hasOwn(requested, key)) result[key] = copy(requested[key]);
  if (Object.hasOwn(requested, "lineItems")) {
    if (!Array.isArray(requested.lineItems) || requested.lineItems.length > 300) throw fail(400, "billing_review_lines_invalid", "Review line items could not be saved.");
    const used = new Set();
    result.lineItems = requested.lineItems.map((line, index) => {
      if (!line || typeof line !== "object" || Array.isArray(line)) throw fail(400, "billing_review_line_invalid", "A review line is invalid.");
      const original = list(review.lineItems).find(saved => text(line.id) && same(saved.id, line.id));
      const next = Object.fromEntries(lineFields.filter(key => Object.hasOwn(line, key)).map(key => [key, copy(line[key])]));
      next.id = text(next.id) || `review_line_${index}_${randomUUID()}`;
      if (used.has(next.id)) throw fail(400, "billing_review_line_duplicate", "Review lines need unique IDs.");
      used.add(next.id);
      // Source identities are retained from canonical work, never accepted from a body.
      for (const key of sourceFields) if (original && Object.hasOwn(original, key)) next[key] = copy(original[key]);
      if (original?.maintenanceService === true) next.maintenanceService = true;
      return next;
    });
  }
  for (const key of ["title", "date", "dueDate", "termsDays", "taxRate", "notes", "discountType", "discount"]) {
    if (result[key] != null && !["string", "number"].includes(typeof result[key])) throw fail(400, "billing_review_field_invalid", "A review field is invalid.");
    if (String(result[key] ?? "").length > (key === "notes" ? 20000 : 1000)) throw fail(400, "billing_review_field_too_long", "A review field is too long.");
  }
  return { ...result, id: review.id, number: "", status: "Review", recordType: "billing-review", reviewState: "pending" };
}

function realInvoiceShape(review) {
  const invoice = copy(review);
  for (const key of Object.keys(invoice)) if (key.startsWith("review") || ["recordType", "approval", "billingReviewAudit", "approvalHistory"].includes(key)) delete invoice[key];
  return { ...invoice, status: "Draft", billingReviewId: review.id };
}

function assertBillable(invoice) {
  if (!list(invoice.lineItems).length) throw fail(422, "billing_review_empty", "Add at least one billable line before confirming.");
  if (list(invoice.lineItems).some(line => !text(line.desc) || !Number.isFinite(Number(line.qty)) || Number(line.qty) <= 0
    || !Number.isFinite(Number(line.unitPrice)))) throw fail(422, "billing_review_amount_invalid", "Every line needs a description, positive quantity, and valid price.");
  if (invoice.lineItems.reduce((sum, line) => sum + Number(line.qty) * Number(line.unitPrice), 0) <= 0) throw fail(422, "billing_review_no_charge", "The review has no billable amount. Discard it if no invoice is needed.");
  if (!Number.isFinite(Number(invoice.taxRate || 0)) || Number(invoice.taxRate || 0) < 0 || Number(invoice.taxRate || 0) > 100) throw fail(422, "billing_review_tax_invalid", "The tax rate must be between 0 and 100.");
}

function confirmedSourceCheck(invoice, snapshot) {
  const clients = snapshot.sps_clients.value;
  const clientsFound = clients.filter(client => same(client.id, invoice.clientId));
  if (clientsFound.length !== 1) throw fail(409, "billing_review_client_invalid", "This review must belong to one saved client.");
  const client = clientsFound[0];
  const claimIssue = billingReviewAccountingIssue(invoice, snapshot[BILLING_REVIEW_KEY].value.filter(row => !same(row.id, invoice.id)), snapshot.sps_invoices.value);
  if (claimIssue) throw fail(409, claimIssue.code, claimIssue.message);
  const sources = invoiceCompletedVisitSources(invoice);
  const completed = snapshot.sps_completed.value || {};
  for (const stopId of sources.sourceStopIds) {
    const marker = completed[stopId];
    if (!marker) throw fail(409, "billing_review_work_reopened", "A source visit is no longer completed. Complete or review that work before invoicing.");
    if (sources.sourceCompletionReceiptIds.length && (!text(marker.receiptId) || !sources.sourceCompletionReceiptIds.includes(text(marker.receiptId)))) {
      throw fail(409, "billing_review_receipt_changed", "The work was reopened or completed again. Review its current service record before invoicing.");
    }
  }
  const actualIds = new Set(snapshot.sps_invoices.value.map(row => text(row.id)));
  const otherReviews = snapshot[BILLING_REVIEW_KEY].value.filter(review => review.reviewState !== "discarded" && !actualIds.has(text(review.id)));
  const reservation = reserveCompletedVisitInvoice(invoice, [...snapshot.sps_invoices.value, ...otherReviews], client.history || [], { clientId: client.id });
  if (!reservation.ok) throw fail(409, "billing_review_source_claimed", reservation.conflict?.message || "This completed work is already linked to another billing record.");
  if (invoice.sourceEstimateId) {
    const estimates = snapshot.sps_estimates.value.filter(estimate => same(estimate.id, invoice.sourceEstimateId));
    if (estimates.length !== 1 || !same(estimates[0].clientId, invoice.clientId)) throw fail(409, "billing_review_estimate_changed", "The source estimate no longer matches this client.");
    if (text(estimates[0].linkedInvoiceId) && !same(estimates[0].linkedInvoiceId, invoice.id)) throw fail(409, "billing_review_estimate_already_billed", "The source estimate already has an invoice.");
  }
  return client;
}

function promoteBacklink(record, review, invoice) {
  if (!same(record?.linkedBillingReviewId, review.id)) return record;
  const result = { ...record, linkedInvoiceId: invoice.id, linkedInvoiceNumber: invoice.number, billingDisposition: "linked-invoice" };
  if (result.estimateFulfillment) result.estimateFulfillment = { ...result.estimateFulfillment, billingDisposition: "linked-invoice" };
  delete result.linkedBillingReviewId;
  return result;
}

export function createBillingReviewHandler(overrides = {}) {
  const deps = {
    authorize: requireOwner, read: readAppStatesVersioned, cas: compareAndSetAppState, batch: compareAndSetAppStateBatch,
    inventory: readQuickBooksInvoiceNumberInventory, guard: quickBooksMaintenanceGuard, createInvoice: createQuickBooksInvoice,
    now: () => Date.now(), uuid: randomUUID, ...overrides,
  };

  async function read(keys = KEYS) {
    const snapshot = await deps.read(keys);
    for (const key of keys) {
      if (!snapshot[key]) throw new Error("Shared billing snapshot is incomplete.");
      if (snapshot[key].exists && ARRAY_KEYS.has(key) && !Array.isArray(snapshot[key].value)) throw new Error("Shared billing records could not be read.");
      if (!snapshot[key].exists) snapshot[key] = { ...snapshot[key], value: ARRAY_KEYS.has(key) ? [] : {} };
    }
    return snapshot;
  }

  async function commit(snapshot, changes, fenceKeys = []) {
    const operations = Object.entries(changes).map(([key, value]) => ({ key, expectedVersion: snapshot[key].version || 0, value }));
    for (const key of fenceKeys) if (!Object.hasOwn(changes, key)) operations.push(snapshot[key].exists
      ? { key, expectedVersion: snapshot[key].version, checkOnly: true }
      : { key, expectedVersion: 0, value: snapshot[key].value });
    return operations.length > 1 ? deps.batch(operations) : deps.cas(operations[0].key, operations[0].expectedVersion, operations[0].value);
  }

  async function changeReview(id, updater) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const snapshot = await read([BILLING_REVIEW_KEY]);
      const current = reviewedRecord(snapshot[BILLING_REVIEW_KEY].value, id);
      const next = updater(current, snapshot);
      const reviews = snapshot[BILLING_REVIEW_KEY].value.map(review => same(review.id, id) ? next : review);
      if ((await commit(snapshot, { [BILLING_REVIEW_KEY]: reviews })).applied) return next;
    }
    throw fail(409, "billing_review_contention", "Billing records changed repeatedly. Refresh and try again.");
  }

  async function promote(id, attemptId, result) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const snapshot = await read([BILLING_REVIEW_KEY, "sps_invoices", "sps_estimates", "sps_schedule"]);
      const review = reviewedRecord(snapshot[BILLING_REVIEW_KEY].value, id);
      if (review.reviewState === "synced") {
        const invoice = snapshot.sps_invoices.value.find(row => same(row.id, id) && same(row.qbId, review.approval?.qbResult?.qbId));
        if (!invoice) throw new Error("The confirmed QuickBooks invoice is missing in SPS.");
        return { ok: true, review, invoice, reviewsVersion: snapshot[BILLING_REVIEW_KEY].version, invoicesVersion: snapshot.sps_invoices.version };
      }
      if (review.approval?.attemptId !== attemptId) throw new Error("The billing approval changed while syncing.");
      const collision = snapshot.sps_invoices.value.find(row => same(row.id, id) || same(row.qbId, result.qbId));
      if (collision && (!same(collision.id, id) || !same(collision.qbId, result.qbId))) throw new Error("QuickBooks is linked to another SPS record. The approval is preserved for reconciliation.");
      const invoice = { ...applyQuickBooksInvoiceSaveResult(review.approval.invoice, result), billingReviewId: id, billingConfirmedAt: review.approval.startedAt };
      const nextReview = { ...review, reviewState: "synced", reviewRevision: review.reviewRevision + 1, reviewUpdatedAt: nowISO(deps.now),
        approval: { ...review.approval, state: "created", qbResult: copy(result), leaseUntil: null }, linkedInvoiceId: invoice.id };
      const nextInvoices = collision ? snapshot.sps_invoices.value : [invoice, ...snapshot.sps_invoices.value];
      const changes = {
        [BILLING_REVIEW_KEY]: snapshot[BILLING_REVIEW_KEY].value.map(row => same(row.id, id) ? nextReview : row),
        sps_invoices: nextInvoices,
        sps_estimates: snapshot.sps_estimates.value.map(estimate => promoteBacklink(estimate, review, invoice)),
        sps_schedule: snapshot.sps_schedule.value.map(day => ({ ...day, stops: list(day.stops).map(stop => promoteBacklink(stop, review, invoice)) })),
      };
      const committed = await commit(snapshot, changes);
      if (committed.applied) {
        const verified = await read([BILLING_REVIEW_KEY, "sps_invoices"]);
        const savedReview = reviewedRecord(verified[BILLING_REVIEW_KEY].value, id);
        const savedInvoice = verified.sps_invoices.value.find(row => same(row.id, id) && same(row.qbId, result.qbId));
        if (savedReview.reviewState !== "synced" || !savedInvoice) throw new Error("SPS could not verify the final QuickBooks link.");
        return { ok: true, review: savedReview, invoice: savedInvoice, reviewsVersion: verified[BILLING_REVIEW_KEY].version, invoicesVersion: verified.sps_invoices.version };
      }
    }
    throw new Error("QuickBooks saved the invoice, but SPS is busy. Retry to finish the existing link.");
  }

  async function runApproval(req, review) {
    const approval = review.approval;
    if (approval.qbResult?.qbId) return promote(review.id, approval.attemptId, approval.qbResult);
    const context = {
      canonicalInvoice: approval.invoice, realmId: approval.realmId, recovering: !!approval.writeStartedAt,
      frozenQuickBooksInvoice: approval.quickBooksInvoice || null, writeStarted: false,
      beforeInvoiceWrite: async (wire, metadata) => {
        await changeReview(review.id, current => {
          if (current.reviewState !== "approving" || current.approval?.attemptId !== approval.attemptId) throw new Error("The approval no longer owns this review.");
          if (current.approval.quickBooksInvoice && JSON.stringify(current.approval.quickBooksInvoice) !== JSON.stringify(wire)) throw new Error("A retry cannot change the confirmed QuickBooks payload.");
          return { ...current, approval: { ...current.approval, quickBooksInvoice: copy(wire), qbRequestId: metadata.qbRequestId,
            writeStartedAt: current.approval.writeStartedAt || nowISO(deps.now), state: "writing" } };
        });
      },
    };
    const captured = responseCapture();
    try {
      await deps.createInvoice({ ...req, method: "POST", body: { invoice: copy(approval.payload) }, [BILLING_REVIEW_CREATE_CONTEXT]: context }, captured);
      const result = captured.body || {};
      if (captured.statusCode < 300 && result.success === true && text(result.qbId)) {
        await changeReview(review.id, current => {
          if (current.approval?.attemptId !== approval.attemptId) throw new Error("The billing approval changed.");
          return { ...current, approval: { ...current.approval, state: "created", qbResult: copy(result), leaseUntil: null } };
        });
        return await promote(review.id, approval.attemptId, result);
      }
      const unknown = result.createOutcomeUnknown || (context.writeStarted && !result.createRejected) || !!approval.writeStartedAt;
      const next = await changeReview(review.id, current => ({ ...current,
        reviewState: unknown ? "approving" : "pending", reviewRevision: current.reviewRevision + 1, reviewUpdatedAt: nowISO(deps.now),
        approval: { ...current.approval, state: unknown ? "unknown" : "rejected", leaseUntil: null, error: result.error || "QuickBooks did not confirm the invoice." },
      }));
      return { ok: false, pending: !!unknown, review: next, code: unknown ? "QB_CONFIRMATION_PENDING" : (result.code || "QB_CONFIRMATION_REJECTED"), error: result.error || "QuickBooks did not confirm the invoice.", ...(result.reconnect ? { reconnect: true } : {}) };
    } catch (error) {
      // A durable frozen intent precedes every POST. Even if saving this error
      // also fails, the next retry can recover the exact original request.
      let retained = review;
      try { retained = await changeReview(review.id, current => ({ ...current, approval: { ...current.approval, leaseUntil: null, error: error.message, state: current.approval?.qbResult?.qbId ? "created" : "unknown" } })); } catch (_) {}
      return { ok: false, pending: true, review: retained, code: "QB_CONFIRMATION_PENDING", error: "The approval is preserved. Retry sync to finish the same invoice; no new invoice will be created." };
    }
  }

  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
    if (!await deps.authorize(req, res, "billing reviews")) return;
    try {
      if (req.method === "GET") {
        const snapshot = await read([BILLING_REVIEW_KEY]);
        return res.status(200).json({ ok: true, reviews: snapshot[BILLING_REVIEW_KEY].value.filter(row => row.recordType === "billing-review"), version: snapshot[BILLING_REVIEW_KEY].version });
      }
      const action = text(req.body?.action);
      if (!["save", "discard", "migrate", "confirm", "retry", "from-estimate", "prepare-estimate", "available-numbers"].includes(action)) throw fail(400, "billing_review_action_invalid", "Choose a billing review action.");
      if (action === "available-numbers") {
        const snapshot = await read([BILLING_REVIEW_KEY, "sps_invoices", "sps_invoicing"]);
        const inventory = await deps.inventory();
        const claims = collectBillingReviewNumberClaims({ invoices: snapshot.sps_invoices.value, reviews: snapshot[BILLING_REVIEW_KEY].value });
        return res.status(200).json({ ok: true, ...billingReviewInvoiceNumberChoices([...claims, ...inventory.numbers], snapshot.sps_invoicing.value), checkedAt: inventory.checkedAt });
      }
      if (action === "migrate" || action === "from-estimate" || action === "prepare-estimate") {
        const qbInventory = action === "migrate" ? await deps.inventory() : null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const snapshot = await read([BILLING_REVIEW_KEY, "sps_invoices", "sps_estimates", "sps_schedule", "sps_clients", ...(action === "migrate" ? ["sps_maintenance_billing"] : ["sps_invoicing"])]);
          let plan;
          if (action === "migrate") {
            plan = planBillingReviewMigration({ invoices: snapshot.sps_invoices.value, reviews: snapshot[BILLING_REVIEW_KEY].value, estimates: snapshot.sps_estimates.value, schedule: snapshot.sps_schedule.value, protectedNumbers: qbInventory.numbers,
              ledger: snapshot.sps_maintenance_billing.exists ? snapshot.sps_maintenance_billing.value : undefined,
              clientPolicies: Object.fromEntries(snapshot.sps_clients.value.filter(client => client.maintenanceBilling).map(client => [client.id, client.maintenanceBilling])), now: deps.now() });
          } else {
            const estimates = snapshot.sps_estimates.value.filter(estimate => same(estimate.id, req.body?.estimateId));
            if (estimates.length !== 1) throw fail(409, "billing_review_estimate_missing", "Choose one saved estimate.");
            const estimate = estimates[0];
            const existingInvoices = snapshot.sps_invoices.value.filter(invoice => same(invoice.sourceEstimateId, estimate.id) || (text(estimate.linkedInvoiceId) && same(invoice.id, estimate.linkedInvoiceId)));
            if (existingInvoices.length > 1 || existingInvoices.some(invoice => !same(invoice.clientId, estimate.clientId))) throw fail(409, "billing_review_estimate_ambiguous", "The estimate's invoice links do not identify one matching client. Review the existing links first.");
            if (existingInvoices.length) return res.status(200).json({ ok: true, invoice: existingInvoices[0] });
            const existingReviews = snapshot[BILLING_REVIEW_KEY].value.filter(review => same(review.sourceEstimateId, estimate.id) || (text(estimate.linkedBillingReviewId) && same(review.id, estimate.linkedBillingReviewId)));
            if (existingReviews.length > 1 || existingReviews.some(review => !same(review.clientId, estimate.clientId))) throw fail(409, "billing_review_estimate_ambiguous", "The estimate's billing reviews do not identify one matching client.");
            const existingReview = existingReviews[0];
            if (existingReview && existingReview.recordType !== "billing-review") throw fail(409, "billing_review_estimate_accounting_pending", "This estimate already has a QuickBooks creation request. Recover that invoice's sync before preparing another billing review.");
            if (existingReview && existingReview.reviewState !== "discarded") return res.status(200).json({ ok: true, review: existingReview });
            if (existingReview?.approval?.writeStartedAt) throw fail(409, "billing_review_prior_accounting_attempt", "This discarded review has an accounting attempt. Reconcile it before preparing another invoice.");
            const clients = snapshot.sps_clients.value.filter(client => same(client.id, estimate.clientId));
            if (clients.length !== 1) throw fail(409, "billing_review_client_invalid", "Select a saved client on the estimate.");
            const prepared = billingReviewDomain.prepareEstimateBillingReview({ estimate, client: clients[0], invoicing: snapshot.sps_invoicing.value, now: deps.now(), taxMigrationConfirmed: req.body?.taxMigrationConfirmed === true });
            const review = existingReview ? { ...prepared, id: existingReview.id, reviewRevision: existingReview.reviewRevision + 1,
              ...(existingReview.billingReviewAudit ? { billingReviewAudit: existingReview.billingReviewAudit } : {}), ...(existingReview.approval ? { approval: existingReview.approval } : {}),
              reviewReopenedAt: nowISO(deps.now), reviewPreviouslyDiscardedAt: existingReview.reviewDiscardedAt } : prepared;
            if (snapshot[BILLING_REVIEW_KEY].value.some(row => same(row.id, review.id) && row !== existingReview)) throw fail(409, "billing_review_id_collision", "Another billing review uses this estimate's identity.");
            plan = { changed: true, reviews: [review, ...snapshot[BILLING_REVIEW_KEY].value.filter(row => row !== existingReview)], invoices: snapshot.sps_invoices.value,
              estimates: snapshot.sps_estimates.value.map(row => same(row.id, estimate.id) ? { ...row, linkedBillingReviewId: review.id, billingDisposition: "billing-review" } : row), schedule: snapshot.sps_schedule.value, review };
          }
          if (!plan.changed) return res.status(200).json({ ok: true, reviews: plan.reviews, migratedIds: plan.migratedIds || [], skipped: plan.skipped || [], version: snapshot[BILLING_REVIEW_KEY].version });
          const result = await commit(snapshot, { [BILLING_REVIEW_KEY]: plan.reviews, sps_invoices: plan.invoices, sps_estimates: plan.estimates, sps_schedule: plan.schedule,
            ...(plan.ledgerChanged ? { sps_maintenance_billing: plan.ledger } : {}),
          }, action === "migrate" ? ["sps_clients", "sps_maintenance_billing"] : ["sps_clients", "sps_invoicing"]);
          if (result.applied) return res.status(200).json({ ok: true, reviews: plan.reviews, ...(plan.review ? { review: plan.review } : {}), migratedIds: plan.migratedIds || [], skipped: plan.skipped || [], versions: result.currentVersions });
        }
        throw fail(409, "billing_review_contention", "Billing records changed. Refresh and try again.");
      }

      const id = text(req.body?.reviewId);
      if (!id || id.length > 320) throw fail(400, "billing_review_id_invalid", "Choose a billing review.");
      if (action === "save" || action === "discard") {
        const review = await changeReview(id, current => {
          pendingOnly(current); revisionMatches(current, req.body?.expectedRevision);
          const edited = action === "save" ? sanitizeBillingReviewEdit(current, req.body.review) : current;
          return { ...edited, reviewState: action === "discard" ? "discarded" : "pending", reviewRevision: current.reviewRevision + 1,
            reviewUpdatedAt: nowISO(deps.now), ...(action === "discard" ? { reviewDiscardedAt: nowISO(deps.now) } : {}) };
        });
        return res.status(200).json({ ok: true, review });
      }

      const chosenNumber = normalizeBillingReviewInvoiceNumber(req.body?.invoiceNumber);
      let inventory = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const snapshot = await read();
        const review = reviewedRecord(snapshot[BILLING_REVIEW_KEY].value, id);
        if (["approving", "synced"].includes(review.reviewState) && chosenNumber && chosenNumber !== review.approval?.number) throw fail(409, "billing_review_number_locked", "This approval already has an invoice number. Retry its existing sync before changing anything.");
        if (review.reviewState === "synced") return res.status(200).json(await promote(id, review.approval?.attemptId, review.approval?.qbResult));
        if (review.reviewState === "discarded") throw fail(409, "billing_review_discarded", "This review was discarded and cannot create an invoice.");
        let next;
        if (review.reviewState === "approving") {
          if (!review.approval?.payload || !review.approval?.attemptId) throw fail(409, "billing_review_approval_invalid", "The saved approval could not be verified.");
          if (review.approval.qbResult?.qbId) return res.status(200).json(await promote(id, review.approval.attemptId, review.approval.qbResult));
          if (Date.parse(review.approval.leaseUntil || "") > deps.now()) return res.status(202).json({ ok: false, pending: true, review, code: "QB_CONFIRMATION_IN_PROGRESS", error: "This invoice is still syncing. Retry shortly to check its result." });
          next = { ...review, approval: { ...review.approval, leaseUntil: new Date(deps.now() + 90_000).toISOString() } };
        } else {
          revisionMatches(review, req.body?.expectedRevision);
          const invoice = realInvoiceShape(review);
          assertBillable(invoice);
          const client = confirmedSourceCheck(invoice, snapshot);
          const initialPayload = buildQuickBooksInvoicePayload(invoice, client, snapshot.sps_invoicing.value);
          const coverage = await deps.guard(initialPayload, { trustedCanonicalInvoice: invoice });
          if (coverage) throw fail(coverage.status || 409, coverage.code, coverage.message);
          const monthIssue = invoiceServiceDescriptionIssue(initialPayload);
          if (monthIssue) throw fail(422, monthIssue.code, monthIssue.message);
          if (!inventory) inventory = await deps.inventory();
          const claims = collectBillingReviewNumberClaims({ invoices: snapshot.sps_invoices.value, reviews: snapshot[BILLING_REVIEW_KEY].value });
          const previousNumber = review.approval?.number;
          const otherClaims = collectBillingReviewNumberClaims({ invoices: snapshot.sps_invoices.value, reviews: snapshot[BILLING_REVIEW_KEY].value.filter(row => !same(row.id, id)) });
          if (chosenNumber && [...otherClaims, ...inventory.numbers].some(number => sameInvoiceNumber(number, chosenNumber))) throw fail(409, "billing_review_number_unavailable", "That invoice number is already used or reserved. Choose another available number.");
          const previousOccupied = [...otherClaims, ...inventory.numbers].some(number => sameInvoiceNumber(number, previousNumber));
          invoice.number = chosenNumber || (previousNumber && !previousOccupied ? previousNumber : firstUnusedInvoiceNumber([...claims, ...inventory.numbers], snapshot.sps_invoicing.value));
          normalizeBillingReviewInvoiceNumber(invoice.number);
          const attemptId = deps.uuid();
          const requestKey = `${id}:approval:${attemptId}`;
          const payload = { ...buildQuickBooksInvoicePayload(invoice, client, snapshot.sps_invoicing.value), qbCreateRequestKey: requestKey };
          next = { ...review, reviewState: "approving", reviewRevision: review.reviewRevision + 1, reviewUpdatedAt: nowISO(deps.now),
            numberClaims: [...new Set([...list(review.numberClaims), previousNumber, invoice.number].filter(Boolean))],
            approval: { attemptId, requestKey, number: invoice.number, invoice, payload, realmId: inventory.realmId,
              intentSignature: quickBooksInvoiceIntentSignature(payload), startedAt: nowISO(deps.now), state: "prepared", leaseUntil: new Date(deps.now() + 90_000).toISOString(), numberInventoryCheckedAt: inventory.checkedAt } };
        }
        const reviews = snapshot[BILLING_REVIEW_KEY].value.map(row => same(row.id, id) ? next : row);
        const reserved = await commit(snapshot, { [BILLING_REVIEW_KEY]: reviews }, KEYS.filter(key => key !== BILLING_REVIEW_KEY));
        if (!reserved.applied) continue;
        const result = await runApproval(req, next);
        return res.status(result.ok ? 200 : result.pending ? 202 : 422).json(result);
      }
      throw fail(409, "billing_review_contention", "Billing records changed repeatedly. Refresh and try again.");
    } catch (error) {
      return res.status(error.status || (error.code === "estimate-tax-confirmation-required" ? 422 : 503)).json({ ok: false, code: error.code || "BILLING_REVIEW_UNAVAILABLE", error: error.message || "Billing reviews are temporarily unavailable." });
    }
  };
}

export default createBillingReviewHandler();
