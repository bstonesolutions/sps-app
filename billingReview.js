import { estimateTaxMigrationImpact, estimateToDraftInvoice } from "./estimateInvoiceConversion.js";
import { unlinkUnpaidInvoiceCoverage } from "./invoiceBulkDeletion.js";
import { emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger } from "./maintenancePaymentLedger.js";
import { invoiceCompletedVisitSources } from "./invoiceVisitImport.js";
import { isMaintenanceServiceLine } from "./maintenanceServiceLine.js";
import { invoiceServiceLineMonths } from "./invoiceServiceDescription.js";

export const BILLING_REVIEW_KEY = "sps_billing_reviews";
const text = value => String(value == null ? "" : value).trim();
const list = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const evidence = value => value != null && value !== false && value !== "" && value !== 0
  && (Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : true);
const stamp = now => new Date(now ?? Date.now()).toISOString();

export function isBillingReview(record) {
  return record?.recordType === "billing-review" && text(record.id) !== "";
}

// Legacy/manual accounting writes reserve their numbers and source identities in
// the same protected CAS collection. These are internal durable claims, not reviews.
export function isBillingReviewNumberClaim(record) {
  return record?.recordType === "invoice-number-claim" && text(record.id) !== ""
    && text(record.approval?.number) !== "";
}

export function billingRecordsShareSource(left, right) {
  const a = invoiceCompletedVisitSources(left), b = invoiceCompletedVisitSources(right);
  return a.sourceStopIds.some(id => b.sourceStopIds.includes(id))
    || a.sourceCompletionReceiptIds.some(id => b.sourceCompletionReceiptIds.includes(id))
    || (!!text(left?.sourceEstimateId) && text(left.sourceEstimateId) === text(right?.sourceEstimateId));
}

export function makeBillingReview(invoice, { now = Date.now(), originalInvoice } = {}) {
  if (!invoice || !text(invoice.id) || !text(invoice.clientId)) throw new Error("A billing review needs an ID and client.");
  const record = {
    ...copy(invoice), number: "", status: "Review", recordType: "billing-review",
    reviewState: "pending", reviewRevision: 1, reviewCreatedAt: stamp(now), reviewUpdatedAt: stamp(now),
  };
  for (const key of Object.keys(record)) {
    if (/^qb(?:[A-Z_]|$)/.test(key) && key !== "qbCustomerId") delete record[key];
  }
  for (const key of ["balance", "amountPaid", "paidAmount", "paymentLink", "approval", "sentAt", "sentDate", "paidAt", "paidDate", "delivery"]) delete record[key];
  if (originalInvoice) record.billingReviewAudit = { originalInvoice: copy(originalInvoice), migratedAt: stamp(now) };
  return record;
}

export function collectBillingReviewNumberClaims({ invoices = [], reviews = [] } = {}) {
  return [...new Set([
    ...list(invoices).map(invoice => text(invoice?.number)),
    ...list(reviews).flatMap(review => [text(review?.approval?.number), text(review?.approval?.invoice?.number), ...list(review?.numberClaims).map(text)]),
  ].filter(Boolean))];
}

export function billingReviewMigrationIssue(invoice) {
  if (!invoice || !text(invoice.id) || !text(invoice.clientId) || text(invoice.status).toLowerCase() !== "draft") return "not-a-job-draft";
  if (isBillingReview(invoice)) return "already-a-review";
  const provenance = ["sourceStopId", "sourceStopIds", "sourceCompletionReceiptId", "sourceCompletionReceiptIds", "sourceEstimateId", "autoDraftKey", "autoPeriod"];
  if (!provenance.some(key => evidence(invoice[key]))) return "no-job-provenance";
  if (Object.entries(invoice).some(([key, value]) => /^qb(?:[A-Z_]|$)/.test(key)
    && key !== "qbCustomerId" && !(key === "qbSyncStatus" && ["local", "not-synced"].includes(text(value))) && evidence(value))) return "quickbooks-evidence";
  if (["sentDate", "sentAt", "emailedAt", "emailSentAt", "deliveredAt", "deliveryDate", "delivery", "viewedAt", "clientViewedAt", "openedAt", "downloadedAt", "exportedAt", "printedAt", "sharedAt", "issuedAt", "paymentLink", "paidDate", "paidAt", "payment", "payments", "paymentId", "paymentStatus", "partial", "amountPaid", "paidAmount", "creditApplied", "creditsApplied", "paymentAmount"].some(key => evidence(invoice[key]))) return "issued-or-payment-evidence";
  if (invoice.balance != null && Number(invoice.balance) !== 0) return "balance-evidence";
  if (/quickbooks|import/i.test(text(invoice.source || invoice.origin))) return "external-source";
  return null;
}

function migrateLink(record, moved) {
  const review = moved.get(text(record?.linkedInvoiceId));
  if (!review) return record;
  const result = { ...record, linkedBillingReviewId: review.id };
  delete result.linkedInvoiceId;
  delete result.linkedInvoiceNumber;
  if (result.billingDisposition === "linked-invoice") result.billingDisposition = "billing-review";
  if (result.estimateFulfillment) result.estimateFulfillment = { ...result.estimateFulfillment, billingDisposition: "billing-review" };
  return result;
}

const invoiceCoverageSourceMatches = (invoice, source) => {
  const id = text(invoice.id), number = text(invoice.number), qbId = text(invoice.qbId);
  return (!!id && text(source?.invoiceId) === id)
    || (!!text(source?.sourceInvoiceId) && [id, qbId].filter(Boolean).includes(text(source.sourceInvoiceId)))
    || (!!qbId && text(source?.qbInvoiceId || source?.sourceQbInvoiceId) === qbId)
    || (!!number && text(source?.invoiceNumber || source?.sourceInvoiceNumber) === number);
};

export function planBillingReviewMigration({ invoices = [], reviews = [], estimates = [], schedule = [], protectedNumbers = [], ledger = emptyMaintenancePaymentLedger(), clientPolicies = {}, now = Date.now() } = {}) {
  if (![invoices, reviews, estimates, schedule].every(Array.isArray)) throw new Error("Billing migration requires valid shared lists.");
  const normalizedLedger = normalizeMaintenancePaymentLedger(ledger);
  if (!normalizedLedger || !clientPolicies || typeof clientPolicies !== "object" || Array.isArray(clientPolicies)) throw new Error("Billing migration requires verified payment coverage.");
  let nextLedger = normalizedLedger;
  const moved = new Map();
  const remoteNumbers = new Set(Array.from(protectedNumbers || []).map(value => text(value).toLowerCase()).filter(Boolean));
  // Match the allocator's conservative sequence rule across historic formatting.
  // A lost QB link must not let INV-1001 migrate when QB already has number 1001.
  const invoiceSequence = value => Number.parseInt(text(value).replace(/\D/g, ""), 10);
  const remoteSequences = new Set([...remoteNumbers].map(invoiceSequence).filter(Number.isSafeInteger));
  const skipped = [];
  const idCounts = new Map();
  invoices.forEach(row => idCounts.set(text(row?.id), (idCounts.get(text(row?.id)) || 0) + 1));
  for (const invoice of invoices) {
    let reason = billingReviewMigrationIssue(invoice);
    if (!reason && (remoteNumbers.has(text(invoice.number).toLowerCase()) || remoteSequences.has(invoiceSequence(invoice.number)))) reason = "quickbooks-number-present";
    if (!reason && idCounts.get(text(invoice.id)) !== 1) reason = "duplicate-invoice-id";
    if (!reason && reviews.some(row => text(row?.id) === text(invoice.id))) reason = "existing-review-id";
    if (!reason && [...invoices.filter(row => row !== invoice), ...reviews].some(row => billingRecordsShareSource(invoice, row))) reason = "source-already-linked";
    // Payment coverage may be the only evidence on a locally drafted invoice. Protect
    // all policies and non-unpaid allocations, including legacy client policy mirrors.
    const matchesCoverage = source => invoiceCoverageSourceMatches(invoice, source);
    const unlinkedLedger = !reason ? unlinkUnpaidInvoiceCoverage(invoice, nextLedger) : null;
    if (!reason && (Object.values(clientPolicies).some(matchesCoverage)
      || Object.values(unlinkedLedger.policies).some(matchesCoverage)
      || Object.values(unlinkedLedger.allocations).some(months => Object.values(months).some(allocation => allocation.sources.some(matchesCoverage))))) reason = "payment-coverage";
    // A conflicting client backlink is evidence of corrupt source ownership; never repair by guessing.
    const linked = [...estimates, ...schedule.flatMap(day => list(day?.stops))].filter(row => text(row?.linkedInvoiceId) === text(invoice?.id));
    if (!reason && linked.some(row => text(row.clientId ?? row.id) && text(row.clientId ?? row.id) !== text(invoice.clientId))) reason = "backlink-client-mismatch";
    if (reason) { skipped.push({ id: invoice?.id, reason }); continue; }
    moved.set(text(invoice.id), makeBillingReview(invoice, { now, originalInvoice: invoice }));
    nextLedger = unlinkedLedger;
  }
  return {
    changed: moved.size > 0,
    invoices: invoices.filter(row => !moved.has(text(row?.id))),
    reviews: [...moved.values(), ...reviews],
    estimates: estimates.map(row => migrateLink(row, moved)),
    schedule: schedule.map(day => ({ ...day, stops: list(day.stops).map(stop => migrateLink(stop, moved)) })),
    migratedIds: [...moved.keys()], skipped,
    ledger: nextLedger, ledgerChanged: JSON.stringify(nextLedger) !== JSON.stringify(normalizedLedger),
  };
}

export function prepareEstimateBillingReview({ estimate, client, invoicing = {}, now = Date.now(), taxMigrationConfirmed = false } = {}) {
  if (!estimate || text(estimate.status).toLowerCase() === "declined") throw new Error("A declined estimate cannot be prepared for billing.");
  const migration = estimateTaxMigrationImpact(estimate, invoicing.taxRate);
  if (migration.requiresConfirmation && !taxMigrationConfirmed) throw Object.assign(new Error("Review and confirm the corrected service-tax total before preparing this estimate for billing."), { code: "estimate-tax-confirmation-required" });
  const source = migration.requiresConfirmation ? { ...migration.normalizedEstimate, taxMigrationConfirmedAt: stamp(now), taxMigrationSource: "billing-review", taxMigrationPriorTotal: migration.priorTotal, taxMigrationCorrectedTotal: migration.normalizedTotal } : migration.normalizedEstimate;
  const date = new Date(now);
  const days = Number.isFinite(Number(invoicing.dueDays)) ? Math.max(0, Number(invoicing.dueDays)) : 15;
  const format = value => `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;
  const due = new Date(date); due.setUTCDate(due.getUTCDate() + days);
  // The converter validates matching quote/tax totals; this non-accounting sentinel is discarded.
  const candidate = estimateToDraftInvoice(source, { client, number: "billing-review", issueDate: format(date), dueDate: format(due), dueDays: days, defaultTaxRate: invoicing.taxRate, paymentTerms: invoicing.terms, createdAt: date.getTime() });
  return makeBillingReview(candidate, { now });
}

const MERGE_SOURCE_KEYS = [["sourceStopId", "sourceStopIds"], ["sourceCompletionReceiptId", "sourceCompletionReceiptIds"], ["sourceVisitClientId", "sourceVisitClientIds"]];
const mergeIssue = (status, code, message) => Object.assign(new Error(message), { status, code });
const isMaintenanceReview = review => text(review?.source) === "monthly-maintenance";
const wholeInvoiceDiscount = review => ["amt", "pct"].includes(text(review?.discountType)) && Number(review?.discount || 0) > 0;
const rate = value => Number.isFinite(Number(value || 0)) ? Number(value || 0) : NaN;

/** The owner combines pending reviews for one client into one invoice. Every moved line keeps
 * its own visits and whether it is a maintenance charge; the reviews merged away become
 * discarded tombstones pointing at the survivor, so their numbers and identities stay held.
 * An estimate review survives (its identity is validated against the estimate), then a monthly
 * maintenance review (completion finds it by its period), then the review the owner has open.
 */
export function planBillingReviewMerge({ target, others = [], now = Date.now() } = {}) {
  const records = [target, ...list(others)];
  if (!list(others).length) throw mergeIssue(400, "billing_review_merge_empty", "Choose at least one review to merge.");
  if (records.length > 21) throw mergeIssue(400, "billing_review_merge_too_many", "Merge up to 20 reviews at a time.");
  if (!records.every(isBillingReview)) throw mergeIssue(409, "billing_review_merge_invalid", "Only billing reviews can be merged.");
  if (new Set(records.map(review => text(review.id))).size !== records.length) throw mergeIssue(400, "billing_review_merge_duplicate", "Choose each review only once.");
  if (records.some(review => review.reviewState !== "pending" || (review.approval && review.approval.state !== "rejected") || review.approval?.writeStartedAt || review.approval?.qbResult)) {
    throw mergeIssue(409, "billing_review_locked", "A review that is syncing with QuickBooks can't be merged. Finish or retry its sync first.");
  }
  if (records.some(review => text(review.clientId) !== text(target.clientId))) throw mergeIssue(409, "billing_review_merge_client", "Only reviews for the same client can be merged.");
  const estimates = records.filter(review => text(review.sourceEstimateId));
  if (estimates.length > 1) throw mergeIssue(409, "billing_review_merge_estimates", "Two of these reviews come from different estimates. Confirm them as separate invoices.");
  const survivor = estimates[0] || (isMaintenanceReview(target) ? target : records.find(isMaintenanceReview)) || target;
  const merged = records.filter(review => review !== survivor);
  const rates = [...new Set(records.filter(review => list(review.lineItems).some(line => line?.taxable)).map(review => rate(review.taxRate)))];
  if (rates.length > 1 || rates.some(Number.isNaN)) throw mergeIssue(422, "billing_review_merge_tax", "These reviews use different tax rates. Set the same tax rate on each before merging.");
  if (records.some(wholeInvoiceDiscount)) throw mergeIssue(422, "billing_review_merge_discount", "A whole-invoice discount can't be carried into a merge. Remove it, merge, then add the discount to the merged invoice.");

  const usedIds = new Set(list(survivor.lineItems).map(line => text(line?.id)).filter(Boolean));
  const movedLines = merged.flatMap(review => list(review.lineItems).map((line, index) => {
    const next = copy(line);
    const base = text(next.id) || `line_${index + 1}`;
    let id = base;
    for (let suffix = 1; !id || usedIds.has(id); suffix += 1) id = `${base}_merged_${suffix}`;
    usedIds.add(id);
    next.id = id;
    // A line's charge type comes from its own review. Carry it explicitly so the survivor's
    // source (for example monthly maintenance) neither adds nor drops maintenance coverage.
    const maintenance = isMaintenanceServiceLine(review, next);
    if (maintenance && !isMaintenanceServiceLine(survivor, next)) next.maintenanceService = true;
    if (!maintenance && isMaintenanceServiceLine(survivor, next)) next.billSeparately = true;
    if (maintenance && !text(next.serviceMonth)) {
      const months = invoiceServiceLineMonths(review, next);
      if (months.length === 1 && !invoiceServiceLineMonths({ ...review, serviceMonth: "", autoPeriod: "" }, next).length) next.serviceMonth = months[0];
    }
    return next;
  }));
  const lineItems = [...list(survivor.lineItems).map(copy), ...movedLines];
  if (lineItems.length > 300) throw mergeIssue(422, "billing_review_merge_too_large", "The merged invoice would have more than 300 lines. Merge fewer reviews.");

  const sources = {};
  for (const [single, plural] of MERGE_SOURCE_KEYS) {
    const values = [...new Set(records.flatMap(review => [text(review[single]), ...list(review[plural]).map(text)]).filter(Boolean))];
    if (values.length) sources[plural] = values;
  }
  const notes = [...new Set([survivor, ...merged].map(review => text(review.notes)).filter(Boolean))].join("\n\n").slice(0, 20000);
  const taxRate = rates.length && !list(survivor.lineItems).some(line => line?.taxable)
    ? records.find(review => list(review.lineItems).some(line => line?.taxable)).taxRate : survivor.taxRate;
  const at = stamp(now);
  const nextSurvivor = {
    ...copy(survivor), ...sources, lineItems, taxRate,
    title: text(survivor.title) || merged.map(review => text(review.title)).find(Boolean) || survivor.title,
    ...(notes || survivor.notes != null ? { notes } : {}),
    reviewMergedFrom: [...new Set([...list(survivor.reviewMergedFrom), ...merged.map(review => text(review.id))])],
    reviewRevision: survivor.reviewRevision + 1, reviewUpdatedAt: at,
  };
  const tombstones = merged.map(review => {
    const moved = { lineItems: copy(list(review.lineItems)) };
    for (const keys of MERGE_SOURCE_KEYS) for (const key of keys) if (review[key] != null) moved[key] = copy(review[key]);
    const tombstone = {
      ...copy(review), lineItems: [], reviewState: "discarded", discardReason: "merged", reviewMergedInto: survivor.id,
      reviewMergedAt: at, reviewDiscardedAt: at, reviewRevision: review.reviewRevision + 1, reviewUpdatedAt: at,
      billingReviewAudit: { ...(review.billingReviewAudit || {}), mergedInto: { id: survivor.id, at, moved } },
    };
    for (const keys of MERGE_SOURCE_KEYS) for (const key of keys) delete tombstone[key];
    return tombstone;
  });
  return { survivor: nextSurvivor, merged: tombstones, mergedIds: merged.map(review => text(review.id)) };
}
