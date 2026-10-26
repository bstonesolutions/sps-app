// Resolve one reviewed SPS invoice against a fresh, read-only QuickBooks read.
// The browser supplies identity and intent only. It never supplies accounting
// contents, a roster snapshot, or an expected version for this privileged write.
import { APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, readAppStateVersioned, withAppStateRequestDeadline } from "./_app-state.js";
import { invoiceAuthorityRpc } from "./_invoice-write-candidates.js";
import { mapQuickBooksInvoice } from "./quickbooks/invoice-mapper.js";
import { escapeQuickBooksQueryLiteral, fetchAllQuickBooksQueryPages } from "./quickbooks/sync-helpers.js";
import { rankQuickBooksInvoiceCandidates, resolveInvoiceReconciliationReview } from "../invoiceReconciliationActions.js";
import { createHash } from "node:crypto";
import { stableInvoiceReviewJSON, stableInvoiceReviewResultJSON } from "../invoiceReviewIdentity.js";
import { maintenanceInvoiceTotalCents } from "../maintenancePaymentLedger.js";

const text = value => String(value == null ? "" : value).trim();
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const actions = new Set(["retry-linked", "match-remote", "keep-sps-only"]);
const failure = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const same = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const reviewedHash = invoice => sha256(stableInvoiceReviewJSON(invoice));
const confirmedHash = invoice => sha256(stableInvoiceReviewResultJSON(invoice));

export function validateInvoiceReviewResolutionRequest(body) {
  if (!record(body) || body.mode !== "resolve-invoice-review" || !actions.has(body.action)
    || !["string", "number"].includes(typeof body.invoiceId)
    || !text(body.invoiceId) || text(body.invoiceId).length > 220
    || typeof body.reviewedInvoiceHash !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewedInvoiceHash)
    || (body.quickBooksInvoiceId != null && (!["string", "number"].includes(typeof body.quickBooksInvoiceId)
      || !text(body.quickBooksInvoiceId) || text(body.quickBooksInvoiceId).length > 220))) {
    throw failure("INVOICE_REVIEW_INVALID", "Choose an invoice and a supported reconciliation action.", 400);
  }
  if (body.action === "keep-sps-only" && body.acknowledged !== true) {
    throw failure("QB_REVIEW_ACK_REQUIRED", "Confirm that this invoice should remain SPS-only.", 400);
  }
  return { invoiceId: text(body.invoiceId), action: body.action,
    reviewedInvoiceHash: body.reviewedInvoiceHash,
    quickBooksInvoiceId: text(body.quickBooksInvoiceId), acknowledged: body.acknowledged === true };
}

async function invoiceMatchingContext(local, readInvoiceState) {
  // Edited invoices display their current line charges, discounts, and tax in
  // SPS. The previous QuickBooks total can still be cached on the record; it
  // must not select a different replacement than the amount the owner reviewed.
  // Pass only the calculation fields to the shared helper so no old QB total
  // or identity is mistaken for authoritative evidence of those edited charges.
  const amountSource = local.locallyEdited === true || local.qbAuthoritative === false ? {
    lineItems: local.lineItems, discountType: local.discountType,
    discount: local.discount, taxRate: local.taxRate,
  } : local;
  const totalCents = maintenanceInvoiceTotalCents(amountSource, { unknownAsNull: true });
  if (totalCents == null) throw failure("QB_REVIEW_TOTAL_UNKNOWN", "The saved invoice total is unavailable. Review its amount before matching a replacement in QuickBooks.");
  const matching = { ...local, total: totalCents / 100 };
  if (text(matching.clientName) && text(matching.qbCustomerId)) return matching;
  if (text(local.clientId)) {
    const clients = await readInvoiceState("sps_clients");
    if (!clients?.exists || !Array.isArray(clients.value)) throw failure("QB_REVIEW_CLIENT_UNAVAILABLE", "The saved client could not be verified. Nothing was changed.", 503);
    const matches = clients.value.filter(client => record(client) && text(client.id) === text(local.clientId));
    if (matches.length !== 1) throw failure("QB_REVIEW_CLIENT_AMBIGUOUS", "This invoice does not identify one saved client. Review its client before matching QuickBooks.");
    const client = matches[0];
    const customerId = text(client.qbId || client.qbCustomerId);
    if (!text(matching.qbCustomerId) && customerId
      && clients.value.filter(candidate => text(candidate?.qbId || candidate?.qbCustomerId) === customerId).length === 1) matching.qbCustomerId = customerId;
    if (!text(matching.clientName)) matching.clientName = text(client.name);
  }
  if (!text(matching.clientName) && !text(matching.qbCustomerId)) {
    throw failure("QB_REVIEW_CLIENT_MISSING", "This invoice has no verified client identity. Choose its client before matching QuickBooks.");
  }
  return matching;
}

function mappedInvoice(raw, expectedId = "") {
  if (!record(raw) || !text(raw.Id) || (expectedId && text(raw.Id) !== expectedId)
    || !Array.isArray(raw.Line) || !text(raw.CustomerRef?.value)
    || [raw.TotalAmt, raw.Balance].some(value => value == null || text(value) === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw failure("QB_REVIEW_RESPONSE_INVALID", "QuickBooks did not return a complete invoice. Nothing was changed.", 502);
  }
  return mapQuickBooksInvoice(raw);
}

async function quickBooksResponse(url, headers, fetchImpl) {
  return withAppStateRequestDeadline("invoice-review-quickbooks-read", async signal => {
    const response = await fetchImpl(url, { headers, signal, cache: "no-store" });
    let data;
    try { data = await response.json(); } catch (_) {
      if (response.status === 404) return { missing: true };
      throw failure("QB_REVIEW_RESPONSE_INVALID", "QuickBooks returned an unreadable response. Nothing was changed.", 502);
    }
    const codes = Array.isArray(data?.Fault?.Error) ? data.Fault.Error.map(error => text(error.code)) : [];
    if (response.status === 404 || codes.includes("610")) return { missing: true };
    if (response.status === 401) throw failure("QB_AUTH_EXPIRED", "The QuickBooks connection expired. Reconnect before reviewing this invoice.", 401);
    if (!response.ok || data?.Fault || !record(data)) {
      throw failure("QB_REVIEW_READ_FAILED", "QuickBooks could not verify this invoice. Nothing was changed.", 502);
    }
    return { data };
  }, { timeoutMs: 15_000 });
}

async function currentQuickBooksChoice(local, request, { base, headers, fetchImpl, readInvoiceState }) {
  const linkedId = text(local.qbId);
  const priorId = linkedId || (request.action === "keep-sps-only" ? text(local.qbFormerId) : "");
  let linked = null;
  if (priorId) {
    const read = await quickBooksResponse(`${base}/invoice/${encodeURIComponent(priorId)}?minorversion=65`, headers, fetchImpl);
    if (!read.missing) linked = mappedInvoice(read.data.Invoice, priorId);
  }
  if (request.action === "retry-linked") {
    if (!linkedId || !linked) throw failure("QB_REVIEW_LINK_MISSING", "The linked QuickBooks invoice was not found. Check for a replacement invoice first.");
    if (request.quickBooksInvoiceId && request.quickBooksInvoiceId !== linkedId) {
      throw failure("QB_REVIEW_ID_CHANGED", "The invoice link changed. Reopen its review before continuing.");
    }
    return { quickBooksInvoice: linked, eligibleCandidateCount: 1 };
  }
  if (linked) {
    if (request.action === "keep-sps-only") throw failure("QB_REVIEW_STILL_LINKED", "This invoice still exists in QuickBooks. Use its current QuickBooks version.");
    if (!request.quickBooksInvoiceId || request.quickBooksInvoiceId === linkedId) {
      return { quickBooksInvoice: linked, eligibleCandidateCount: 1 };
    }
    throw failure("QB_REVIEW_LINK_EXISTS", "The original QuickBooks invoice still exists. Review that invoice before changing its link.");
  }

  // A requested replacement id alone is not evidence of uniqueness. Query the
  // saved document number and require exactly one number/customer/total match.
  const number = text(local.number);
  if (!number) {
    if (request.action === "keep-sps-only" && priorId) return {};
    throw failure("QB_REVIEW_NUMBER_MISSING", "This invoice has no number with which to verify a QuickBooks match.");
  }
  const matchingInvoice = await invoiceMatchingContext(local, readInvoiceState);
  const result = await fetchAllQuickBooksQueryPages({
    base, headers, entity: "Invoice", where: `DocNumber = '${escapeQuickBooksQueryLiteral(number)}'`, maxPages: 2,
    fetchImpl: async url => {
      const read = await quickBooksResponse(url, headers, fetchImpl);
      if (read.missing || !record(read.data?.QueryResponse)
        || (read.data.QueryResponse.Invoice != null && !Array.isArray(read.data.QueryResponse.Invoice))) {
        throw failure("QB_REVIEW_RESPONSE_INVALID", "QuickBooks did not return a complete invoice search. Nothing was changed.", 502);
      }
      return { ok: true, json: async () => read.data };
    },
  });
  if (!result.complete) throw failure("QB_REVIEW_SEARCH_INCOMPLETE", "QuickBooks invoice matching was incomplete. Nothing was changed.", 502);
  const candidates = result.records.map(invoice => mappedInvoice(invoice));
  const ranked = rankQuickBooksInvoiceCandidates(matchingInvoice, candidates);
  if (request.action === "keep-sps-only") {
    if (ranked.safeCandidate || ranked.ambiguous) {
      throw failure("QB_REVIEW_MATCH_EXISTS", "QuickBooks has a matching invoice. Review its match before keeping this SPS-only.");
    }
    return {};
  }
  if (!ranked.safeCandidate || ranked.ambiguous
    || (request.quickBooksInvoiceId && text(ranked.safeCandidate.qbId) !== request.quickBooksInvoiceId)) {
    throw failure("QB_REVIEW_MATCH_UNSAFE", "A unique QuickBooks match by number, customer, and total could not be verified.");
  }
  return { quickBooksInvoice: ranked.safeCandidate, eligibleCandidateCount: 1, matchingInvoice };
}

export async function patchReviewedInvoice({ invoiceId, beforeInvoice, invoice, actorId, action }, { fetchImpl = globalThis.fetch } = {}) {
  if (!APP_STATE_SERVICE_KEY) throw failure("INVOICE_REVIEW_UNAVAILABLE", "Invoice reconciliation is temporarily unavailable.", 503);
  return withAppStateRequestDeadline("invoice-review-patch", async signal => {
    const response = await fetchImpl(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/sps_invoice_review_patch`, {
      method: "POST", headers: { apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`, "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ p_invoice_id: invoiceId, p_expected_invoice: beforeInvoice, p_invoice: invoice, p_actor_id: actorId, p_action: action }),
    });
    let data;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) {
      if (response.status === 409 && data?.code === "PT409") {
        throw Object.assign(failure("INVOICE_REVIEW_SAVE_CONFLICT", "This invoice changed or contains protected accounting information. Reopen its review before choosing a version.", 409), { retryable: false, databaseCode: "PT409" });
      }
      throw failure("INVOICE_REVIEW_SAVE_UNCONFIRMED", "The invoice save was not confirmed. Retry to check the same review.", 503);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!record(row) || typeof row.applied !== "boolean") {
      throw failure("INVOICE_REVIEW_SAVE_UNCONFIRMED", "The server did not confirm the invoice save. Retry to check the same review.", 503);
    }
    return row;
  }, { timeoutMs: 15_000 });
}

export async function resolveInvoiceReviewOnServer(body, { actorId, base, headers,
  fetchImpl = globalThis.fetch, readInvoiceState = readAppStateVersioned, patchInvoice = patchReviewedInvoice,
  readCandidates = invoiceId => invoiceAuthorityRpc("sps_invoice_write_candidates_read", {p_invoice_id:invoiceId}),
  now = () => new Date().toISOString() } = {}) {
  const request = validateInvoiceReviewResolutionRequest(body);
  if (!text(actorId)) throw failure("INVOICE_REVIEW_UNAUTHORIZED", "Sign in before resolving this invoice.", 401);
  {
    const state = await readInvoiceState("sps_invoices");
    if (!state?.exists || !Array.isArray(state.value)) throw failure("INVOICE_REVIEW_STATE_INVALID", "Shared invoices could not be read. Nothing was changed.", 503);
    const matches = state.value.filter(invoice => record(invoice) && text(invoice.id) === request.invoiceId);
    if (matches.length !== 1) throw failure("INVOICE_REVIEW_IDENTITY_INVALID", "This invoice was removed or its identity is duplicated. Refresh the invoice list.");
    const beforeInvoice = matches[0];
    const priorResolution = beforeInvoice.qbReviewResolution;
    const exactReviewedSource = reviewedHash(beforeInvoice) === request.reviewedInvoiceHash;
    const confirmedReplay = !exactReviewedSource
      && priorResolution?.reviewedInvoiceHash === request.reviewedInvoiceHash
      && priorResolution?.requestAction === request.action
      && text(priorResolution?.requestedQuickBooksInvoiceId) === request.quickBooksInvoiceId
      && priorResolution?.confirmedResultHash === confirmedHash(beforeInvoice);
    if (!exactReviewedSource && !confirmedReplay) {
      throw failure("INVOICE_REVIEW_TARGET_CHANGED", "This invoice changed after you opened its review. Reopen the invoice to review the current details before choosing a version.");
    }
    const choice = await currentQuickBooksChoice(beforeInvoice, request, { base, headers, fetchImpl, readInvoiceState });
    if (choice.quickBooksInvoice && state.value.some(invoice => invoice !== beforeInvoice
      && text(invoice?.qbId) === text(choice.quickBooksInvoice.qbId))) {
      throw failure("QB_REVIEW_DUPLICATE_LINK", "Another SPS invoice already links to this QuickBooks invoice. Review the duplicate before continuing.");
    }
    // Repeating a confirmed choice against the same current facts is a no-op.
    // The SQL RPC verifies the exact existing target before returning its receipt.
    const repeatChoice = priorResolution?.action === request.action
      || (choice.quickBooksInvoice && ["retry-linked", "match-remote"].includes(priorResolution?.action)
        && text(priorResolution.qbId) === text(choice.quickBooksInvoice.qbId));
    const resolvedAt = repeatChoice && text(priorResolution?.resolvedAt)
      ? text(priorResolution.resolvedAt) : now();
    let invoice;
    try { invoice = resolveInvoiceReconciliationReview(choice.matchingInvoice || beforeInvoice, { ...request, ...choice, resolvedAt }); }
    catch (error) { throw failure(error.code || "QB_REVIEW_CHOICE_INVALID", error.message); }
    if (request.action === "keep-sps-only" && priorResolution?.action === "keep-sps-only"
      && !text(beforeInvoice.qbId) && text(priorResolution.formerQbId)) {
      invoice.qbReviewResolution.formerQbId = text(priorResolution.formerQbId);
    }
    // A deliberate choice retires exactly the held proposal captured by this
    // reviewed record. Plan the next marker before hashing the response; SQL
    // validates and applies this same transition under the target CAS lock.
    if (!confirmedReplay && ["retry-linked", "match-remote"].includes(request.action) && text(beforeInvoice.qbWriteReview?.candidateId)) {
      const heldId = text(beforeInvoice.qbWriteReview.candidateId);
      const candidates = await readCandidates(request.invoiceId);
      if (!Array.isArray(candidates) || !candidates.some(row => text(row.id) === heldId && text(row.invoice_id) === request.invoiceId && !row.resolved_at)) {
        throw failure("INVOICE_REVIEW_PROPOSAL_CHANGED", "The held change could not be verified. Refresh this invoice before choosing a version.");
      }
      const remaining = candidates.filter(row => text(row.id) !== heldId && text(row.invoice_id) === request.invoiceId && !row.resolved_at)
        .sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0];
      delete invoice.qbWriteReview;
      if (remaining) invoice.qbWriteReview = {candidateId:text(remaining.id), reason:remaining.reason, savedAt:remaining.created_at};
    }
    // Evidence such as total-match can become true only because the first
    // resolution succeeded. Do not turn that bookkeeping difference into a
    // second write when the authoritative invoice itself is unchanged.
    const unchangedConfirmedInvoice = repeatChoice && same({ ...invoice, qbReviewResolution: priorResolution }, beforeInvoice);
    if (confirmedReplay && !unchangedConfirmedInvoice) {
      throw failure("INVOICE_REVIEW_REMOTE_CHANGED", "QuickBooks changed after the original review was saved. Reopen the invoice to review its latest version.");
    }
    if (unchangedConfirmedInvoice) {
      invoice.qbReviewResolution = { ...priorResolution };
    } else invoice.qbReviewResolution.resolvedAt = now();
    if (!confirmedReplay) {
      invoice.qbReviewResolution = { ...invoice.qbReviewResolution,
        reviewedInvoiceHash: request.reviewedInvoiceHash, requestAction: request.action,
        requestedQuickBooksInvoiceId: request.quickBooksInvoiceId };
      invoice.qbReviewResolution.confirmedResultHash = confirmedHash(invoice);
    }
    const receipt = await patchInvoice({ invoiceId: request.invoiceId, beforeInvoice, invoice, actorId: text(actorId), action: request.action }, { fetchImpl });
    if (!receipt.applied && receipt.outcome === "target_changed") {
      throw failure("INVOICE_REVIEW_TARGET_CHANGED", "This invoice changed while you were reviewing it. Reopen the invoice to review those changes before choosing a version.");
    }
    if (!receipt.applied && receipt.outcome !== "unchanged") {
      throw failure("INVOICE_REVIEW_SAVE_CONFLICT", "This invoice changed or was removed before the save. Refresh and review it again.");
    }
    const beforeVersion = Number(receipt.before_version);
    const afterVersion = Number(receipt.current_version);
    if (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1 || !Number.isSafeInteger(afterVersion)
      || afterVersion !== beforeVersion + (receipt.applied ? 1 : 0)
      || !same(receipt.invoice, invoice) || !same(receipt.before_invoice, beforeInvoice)) {
      throw failure("INVOICE_REVIEW_SAVE_UNCONFIRMED", "The server did not confirm the reviewed invoice. Retry to check its saved state.", 503);
    }
    return { ok: true, invoice: receipt.invoice, beforeInvoice: receipt.before_invoice,
      beforeVersion, afterVersion, replayed: !receipt.applied };
  }
}
