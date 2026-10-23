import { invoiceReviewHash, stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";
import { invoiceNeedsReconciliationReview } from "./invoiceReconciliationReview.js";

const attemptsByStore = new WeakMap();
const text = value => String(value ?? "").trim();
const same = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);
const copy = value => JSON.parse(stableInvoiceReviewJSON(value));
const targetOf = (rows, id) => {
  const matches = Array.isArray(rows) ? rows.filter(row => row && text(row.id) === id) : [];
  return matches.length === 1 ? matches[0] : null;
};

function failure(message, receipt, details = {}) {
  const error = new Error(message);
  if (receipt?.ok === true) {
    error.serverConfirmed = true;
    error.invoice = receipt.invoice;
    error.receipt = receipt;
  }
  return Object.assign(error, details);
}

/** Resolve one reviewed invoice without flushing or replacing unrelated local work. */
export async function resolveConfirmedInvoiceReview({
  invoiceId, options = {}, store, readInvoices, fetchReview, adoptInvoices,
  isResolved = invoice => !invoiceNeedsReconciliationReview(invoice),
}) {
  const id = text(invoiceId);
  const identity = store.captureIdentity();
  const initial = targetOf(readInvoices(), id);
  if (!id || !initial) throw failure("This invoice could not be identified safely. Reopen its review and try again.");
  const expectedInvoice = copy(initial);
  const assertCurrent = (receipt, allowedInvoice) => {
    if (!store.isCurrentIdentity(identity)) throw failure("The signed-in account changed. Reopen this invoice in the current account.", receipt, { staleIdentity: true });
    const current = targetOf(readInvoices(), id);
    if (!current || (!same(current, expectedInvoice) && (!allowedInvoice || !same(current, allowedInvoice)))) {
      throw failure(receipt?.ok
        ? "The QuickBooks choice was saved, but this invoice changed on this device. Your newer work is preserved. Reopen the invoice to review it."
        : "This invoice changed while its review was being prepared. Reopen it before choosing a version.", receipt, { targetChanged: true });
    }
  };
  assertCurrent();
  const action = text(options.action);
  const quickBooksInvoiceId = text(options.quickBooksInvoice?.qbId ?? options.remote?.qbId ?? options.quickBooksInvoiceId);
  const acknowledged = options.acknowledged === true;
  const inspectionKey = text(options.inspectionKey);
  const signature = stableInvoiceReviewJSON({ identity, expectedInvoice, action, quickBooksInvoiceId, acknowledged, inspectionKey });
  let attempts = attemptsByStore.get(store);
  if (!attempts) { attempts = new Map(); attemptsByStore.set(store, attempts); }
  for (const [key, saved] of attempts) {
    if (!store.isCurrentIdentity(saved.identity)) attempts.delete(key);
  }
  let attempt = attempts.get(id);
  if (attempt?.signature !== signature) {
    attempts.delete(id);
    // The displayed target may contain pending local edits. Hash the confirmed
    // server target as the CAS precondition, while preserving the displayed
    // target separately so only its explicitly reviewed intent can be retired.
    const fresh = await store.refresh("sps_invoices");
    assertCurrent();
    let confirmed;
    try { confirmed = targetOf(JSON.parse(fresh?.value), id); } catch (_) {}
    if (fresh?.ok === false || fresh?.error || !confirmed) {
      throw failure("The saved invoice could not be checked. Your local work is preserved; try again when shared data is available.");
    }
    const reviewedInvoiceHash = await invoiceReviewHash(confirmed);
    assertCurrent();
    if (attempts.size >= 20) {
      throw failure("Several invoice choices still need confirmation on this device. Finish one of those reviews before starting another.");
    }
    attempt = { signature, reviewedInvoiceHash, identity };
    attempts.set(id, attempt);
  }
  // Retain this exact hash after an unknown outcome. Re-reading and rehashing
  // here on retry could authorize replacing a later employee's server edit.
  if (attempt.blockedError) throw attempt.blockedError;
  let receipt;
  try {
    receipt = await fetchReview({
      mode: "resolve-invoice-review", invoiceId: id, action, quickBooksInvoiceId,
      acknowledged, reviewedInvoiceHash: attempt.reviewedInvoiceHash,
    });
  } catch (error) {
    if ([400, 401, 403, 409].includes(Number(error?.status))) {
      const message = error?.message || "The saved invoice choice could not be applied.";
      attempt.blockedError = failure(/check quickbooks again/i.test(message) ? message
        : `${message} Check QuickBooks again before choosing a version.`, null, {
        status: Number(error.status), code: error.code, reviewRequiresInspection: true,
      });
      throw attempt.blockedError;
    }
    throw error;
  }
  assertCurrent(receipt, receipt?.invoice);
  if (receipt?.ok !== true || text(receipt?.invoice?.id) !== id) {
    throw failure(receipt?.error || "SPS did not confirm the invoice choice. The invoice is still available to review.");
  }
  let accepted;
  try { accepted = await store.acceptInvoiceReviewResolution(receipt, identity, { expectedInvoice }); }
  catch (error) {
    throw failure(`The invoice choice was saved, but this device could not display it safely. ${error?.message || "Reopen the invoice to check it."}`, receipt, { cause: error });
  }
  assertCurrent(receipt, accepted?.invoice || receipt.invoice);
  if (!accepted?.ok) {
    throw failure(accepted?.error?.message || "The invoice choice was saved, but this device could not finish saving its confirmation. Reopen the invoice to check it.", receipt, {
      staleIdentity: accepted?.staleIdentity === true, targetChanged: accepted?.targetChanged === true,
    });
  }
  const canonical = targetOf(accepted.parsedValue, id);
  if (!canonical || !same(canonical, accepted.invoice)) {
    throw failure("The invoice choice was saved, but its display confirmation was incomplete. Refresh the invoice list to check it.", receipt);
  }
  await adoptInvoices(accepted.parsedValue, { confirmedInvoice: { before: expectedInvoice, after: canonical } });
  assertCurrent(receipt, canonical);
  if (!isResolved(canonical)) {
    throw failure(accepted.superseded
      ? "A newer invoice change still needs review. Your saved QuickBooks choice did not overwrite that newer work."
      : "This invoice still needs review. Reopen it to inspect the remaining issue.", receipt, { superseded: accepted.superseded === true });
  }
  if (attempts.get(id) === attempt) attempts.delete(id);
  return canonical;
}
