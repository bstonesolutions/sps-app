import { estimateTaxMigrationImpact, estimateToDraftInvoice } from "./estimateInvoiceConversion.js";
import { unlinkUnpaidInvoiceCoverage } from "./invoiceBulkDeletion.js";
import { emptyMaintenancePaymentLedger, normalizeMaintenancePaymentLedger } from "./maintenancePaymentLedger.js";
import { invoiceCompletedVisitSources } from "./invoiceVisitImport.js";

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
