import { createHash } from "node:crypto";
import { readAppStatesVersioned, compareAndSetAppStateBatch } from "./_app-state.js";
import { BILLING_REVIEW_KEY } from "../billingReview.js";
import { invoiceCompletedVisitSources } from "../invoiceVisitImport.js";
import { quickBooksInvoiceIntentSignature } from "../quickbooksInvoiceReconciliation.js";

const text = value => String(value ?? "").trim();
const list = value => Array.isArray(value) ? value : [];
const same = (a, b) => text(a) !== "" && text(a) === text(b);
const sequence = value => text(value).replace(/\D/g, "").replace(/^0+/, "");
const numberSame = (a, b) => text(a) !== "" && (text(a).toLowerCase() === text(b).toLowerCase() || (sequence(a) && sequence(a) === sequence(b)));
const issue = message => ({ status: 409, code: "billing_review_confirmation_required", message });

export function billingReviewAccountingIssue(invoice, reviews, canonicalInvoices = []) {
  const id = text(invoice.spsInvoiceId || invoice.id);
  const saved = canonicalInvoices.find(row => same(row.id, id));
  const candidate = { ...saved, ...invoice };
  const sources = invoiceCompletedVisitSources(candidate);
  for (const review of reviews) {
    const own = same(review.id, id) || same(review.claimInvoiceId, id);
    if (own && review.recordType === "billing-review" && review.reviewState !== "synced") return issue("Confirm this billing review in SPS before creating or changing its invoice.");
    if (own) continue;
    const numbers = [review.approval?.number, review.approval?.invoice?.number, ...list(review.numberClaims)];
    if (numbers.some(number => numberSame(number, candidate.number))) return issue("That invoice number is already reserved by another billing approval. Refresh and choose another number.");
    // Discard is an automatic-completion tombstone, but the owner can bill the
    // work deliberately in a new manual invoice. Accounting numbers stay held.
    if (review.recordType === "billing-review" && review.reviewState === "discarded") continue;
    const other = invoiceCompletedVisitSources(review);
    if (sources.sourceStopIds.some(value => other.sourceStopIds.includes(value))
      || sources.sourceCompletionReceiptIds.some(value => other.sourceCompletionReceiptIds.includes(value))
      || same(candidate.sourceEstimateId, review.sourceEstimateId)) return issue("This work already has a billing review or accounting claim. Finish that record before billing it again.");
  }
  return null;
}

// Direct/manual and older app writes share the review ledger's CAS fence.
// This closes the gap between a number availability check and the QB write.
export async function reserveDirectInvoiceAccountingClaim(invoice, { requestKey = "", mode = "create", verifyRecreation = null, quickBooksInvoice = null, realmId = null, read = readAppStatesVersioned, batch = compareAndSetAppStateBatch } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snapshot = await read([BILLING_REVIEW_KEY, "sps_invoices"]);
    const reviewRow = snapshot[BILLING_REVIEW_KEY];
    const invoiceRow = snapshot.sps_invoices;
    if ((reviewRow.exists && !Array.isArray(reviewRow.value)) || (invoiceRow.exists && !Array.isArray(invoiceRow.value))) throw new Error("Shared accounting claims could not be verified.");
    const reviews = list(reviewRow.value);
    const invoices = list(invoiceRow.value);
    const conflict = billingReviewAccountingIssue(invoice, reviews, invoices);
    if (conflict) throw Object.assign(new Error(conflict.message), conflict);
    const identity = text(invoice.spsInvoiceId || invoice.id);
    const canonical = invoices.find(row => same(row.id, identity));
    const candidate = { ...canonical, ...invoice };
    if (!text(candidate.number)) throw Object.assign(new Error("Choose an invoice number before syncing to QuickBooks."), { status: 422, code: "invoice_number_required" });
    const id = identity || `invoice_claim_${createHash("sha256").update(text(requestKey) || `${candidate.qbCustomerId}:${candidate.number}`).digest("hex").slice(0, 32)}`;
    const existing = reviews.filter(row => same(row.id, id));
    if (existing.length > 1) throw new Error("Accounting claims contain a duplicate identity.");
    const prior = existing[0];
    let intent = null;
    if (mode === "create") {
      const baseRequestKey = text(requestKey);
      const signature = quickBooksInvoiceIntentSignature(invoice);
      const previous = prior?.createIntent;
      const sameIntent = previous && (previous.baseRequestKey || previous.requestKey) === baseRequestKey && previous.signature === signature
        && (!previous.realmId || !realmId || text(previous.realmId) === text(realmId));
      const rejected = previous?.state === "rejected";
      if (previous && !sameIntent && !rejected) {
        const recreation = (previous.baseRequestKey || previous.requestKey) !== baseRequestKey && typeof verifyRecreation === "function"
          && await verifyRecreation({ canonical, prior, invoice });
        if (!recreation) throw Object.assign(new Error("This invoice already has a different creation request. Recover its existing QuickBooks result before changing or recreating it."), { status: 409, code: "quickbooks_create_intent_changed" });
      }
      if (sameIntent && !rejected) intent = previous;
      else {
        const generation = previous ? Number(previous.generation || 0) + 1 : 0;
        intent = { baseRequestKey, requestKey: generation ? `${baseRequestKey}:attempt:${generation}` : baseRequestKey, signature, generation, state: "prepared",
          ...(realmId ? { realmId: text(realmId) } : {}), ...(quickBooksInvoice ? { quickBooksInvoice } : {}) };
      }
    }
    const sources = invoiceCompletedVisitSources(candidate);
    const claim = {
      ...(prior || { id, recordType: "invoice-number-claim", reviewState: "synced", number: "", clientId: candidate.clientId || null, claimInvoiceId: identity, claimCreatedAt: new Date().toISOString() }),
      numberClaims: [...new Set([...list(prior?.numberClaims), text(candidate.number)].filter(Boolean))],
      ...(intent ? { createIntent: intent, ...(prior?.createIntent && prior.createIntent.requestKey !== intent.requestKey
        ? { previousCreateIntents: [...list(prior.previousCreateIntents), prior.createIntent] } : {}) } : {}),
      sourceStopIds: [...new Set([...list(prior?.sourceStopIds), ...sources.sourceStopIds])],
      sourceCompletionReceiptIds: [...new Set([...list(prior?.sourceCompletionReceiptIds), ...sources.sourceCompletionReceiptIds])],
      ...(candidate.sourceEstimateId ? { sourceEstimateId: candidate.sourceEstimateId } : {}),
      ...(prior?.approval ? {} : { approval: { number: text(candidate.number), requestKey: text(requestKey), state: "external-accounting-claim" } }),
    };
    if (prior && JSON.stringify(prior) === JSON.stringify(claim)) return claim;
    const operations = [
      { key: BILLING_REVIEW_KEY, expectedVersion: reviewRow.version || 0, value: prior ? reviews.map(row => row === prior ? claim : row) : [...reviews, claim] },
      invoiceRow.exists ? { key: "sps_invoices", expectedVersion: invoiceRow.version, checkOnly: true } : { key: "sps_invoices", expectedVersion: 0, value: [] },
    ];
    if ((await batch(operations)).applied) return claim;
  }
  throw new Error("Another billing approval is changing invoice numbers. Retry after refreshing.");
}

// An explicit QB rejection permits a corrected create; transport failures keep
// the exact intent frozen. Match the generation so a late result cannot change
// a newer request, and never downgrade a confirmed creation.
export async function settleDirectInvoiceAccountingClaim(claim, outcome, { read = readAppStatesVersioned, batch = compareAndSetAppStateBatch } = {}) {
  if (!claim?.createIntent?.requestKey || !["created", "rejected", "unknown"].includes(outcome?.state)) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snapshot = await read([BILLING_REVIEW_KEY, "sps_invoices"]);
    const row = snapshot[BILLING_REVIEW_KEY];
    if (!row?.exists || !Array.isArray(row.value)) throw new Error("Shared accounting claims could not be verified.");
    const current = row.value.find(value => same(value.id, claim.id));
    if (!current || current.createIntent?.requestKey !== claim.createIntent.requestKey) return false;
    if (current.createIntent.state === "created" || (current.createIntent.state === "rejected" && outcome.state === "unknown")) return true;
    const next = { ...current, createIntent: { ...current.createIntent, ...outcome, settledAt: new Date().toISOString() } };
    const invoiceRow = snapshot.sps_invoices;
    if ((await batch([
      { key: BILLING_REVIEW_KEY, expectedVersion: row.version, value: row.value.map(value => value === current ? next : value) },
      invoiceRow.exists ? { key: "sps_invoices", expectedVersion: invoiceRow.version, checkOnly: true } : { key: "sps_invoices", expectedVersion: 0, value: [] },
    ])).applied) return true;
  }
  throw new Error("The QuickBooks creation result could not be saved. Retry the same invoice to recover it.");
}
