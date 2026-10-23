// A QuickBooks write is already successful when this module runs. Persist its
// confirmed accounting independently of the device's generic save queue.
import { readAppStateVersioned } from "./_app-state.js";
import { compareAndSetCanonicalInvoices } from "./_invoice-canonical-state.js";
import { invoiceAuthorityRpc } from "./_invoice-write-candidates.js";
import { mapQuickBooksInvoice } from "./quickbooks/invoice-mapper.js";
import { hasPendingLocalInvoiceEdits, reconcileQuickBooksInvoice } from "../quickbooksInvoiceReconciliation.js";
import { mergeInvoiceSpsMetadataResult } from "../invoiceMetadata.js";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";
import { mergeQuickBooksInvoiceRefresh } from "./_quickbooks-invoice-refresh.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";

const KEY = "sps_invoices";
const text = value => String(value ?? "").trim();
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const actions = new Set(["quickbooks-create", "quickbooks-update", "quickbooks-payment"]);
function ledger(state) {
  if (!state?.exists || !Number.isSafeInteger(state.version) || state.version < 1 || !Array.isArray(state.value)
    || state.value.some(row => !record(row) || !text(row.id))
    || new Set(state.value.map(row => text(row.id))).size !== state.value.length) {
    throw fail("QB_WRITE_STATE_INVALID", "The shared invoice ledger could not be verified.");
  }
  return state;
}
function mappedConfirmedInvoice(raw) {
  if (!record(raw) || !text(raw.Id) || !text(raw.CustomerRef?.value) || !Array.isArray(raw.Line)
    || [raw.TotalAmt, raw.Balance].some(value => value == null || text(value) === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw fail("QB_WRITE_SNAPSHOT_INCOMPLETE", "QuickBooks saved the change but its full invoice snapshot is unavailable.");
  }
  return mapQuickBooksInvoice(raw);
}
function newer(local, remote) {
  const previous = Date.parse(local?.qbLastUpdatedTime), incoming = Date.parse(remote.qbLastUpdatedTime);
  if (Number.isFinite(previous) && Number.isFinite(incoming) && previous > incoming) return true;
  return /^\d+$/.test(text(local?.qbSyncToken)) && /^\d+$/.test(text(remote.qbSyncToken))
    && BigInt(local.qbSyncToken) > BigInt(remote.qbSyncToken);
}
function financialIntent(payload, customerId) {
  return { customer: text(payload.qbCustomerId || customerId), number: text(payload.number), date: text(payload.date), dueDate: text(payload.dueDate),
    taxRate: Number(payload.taxRate || 0), discountType: text(payload.invoiceDiscountType), discount: Number(payload.invoiceDiscount || 0),
    lines: (payload.lineItems || []).map(line => ({ description: text(line.description ?? line.desc).replace(/\s+/g, " "),
      qty: Number(line.qty || 1), unitPrice: Number(line.unitPrice ?? line.rate ?? 0), taxable: line.taxable === true,
      item: text(line.qbItemRef?.value), kind: text(line.kind || "custom") })) };
}

export async function persistQuickBooksInvoiceWriteReceipt({
  quickBooksInvoice, expectedQuickBooksId, invoiceId, sourceInvoice = {}, trustedSource = null,
  actorId, action, realmId, candidateId,
}, { readState = readAppStateVersioned, save = compareAndSetCanonicalInvoices,
  rpc = invoiceAuthorityRpc, now = () => new Date().toISOString(), maxAttempts = 3 } = {}) {
  if (!text(actorId) || !actions.has(action)) throw fail("QB_WRITE_SCOPE_INVALID", "The confirmed invoice write has no authorized scope.");
  const remote = mappedConfirmedInvoice(quickBooksInvoice);
  if (text(expectedQuickBooksId) && text(remote.qbId) !== text(expectedQuickBooksId)) {
    throw fail("QB_WRITE_IDENTITY_CONFLICT", "QuickBooks returned a different invoice than the confirmed write.");
  }
  const id = text(invoiceId || trustedSource?.id || sourceInvoice.spsInvoiceId || sourceInvoice.id);
  const fetchedAt = now();
  const clients = await readState("sps_clients");
  if (!clients?.exists || !Array.isArray(clients.value)) throw fail("QB_WRITE_CLIENTS_UNAVAILABLE", "The saved client identities could not be verified.");
  const mapped = mergeQuickBooksInvoiceRefresh([], clients.value, {
    invoices: [remote], customers: [], reconciliation: { fetchedAt },
  }).invoices[0];
  const limit = Math.min(5, Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : 3));
  for (let attempt = 1; attempt <= limit; attempt++) {
    const before = ledger(await readState(KEY));
    const exact = id ? before.value.find(row => text(row.id) === id) : null;
    const linked = before.value.filter(row => text(row.qbId) === text(remote.qbId));
    if (linked.length > 1 || (exact && linked.length && exact !== linked[0]) || (!exact && id && linked.length && text(linked[0].id) !== id)) {
      throw fail("QB_WRITE_IDENTITY_CONFLICT", "QuickBooks saved the change but its SPS identity needs review.");
    }
    const existing = exact || linked[0] || null;
    if (existing?.qbId && text(existing.qbId) !== text(remote.qbId)
      && !(action === "quickbooks-create" && text(sourceInvoice.qbId) === text(existing.qbId))) {
      throw fail("QB_WRITE_IDENTITY_CONFLICT", "The SPS invoice is linked to a different QuickBooks record.");
    }
    const targetId = text(existing?.id || id || mapped.id);
    if (existing && newer(existing, mapped)) {
      return { ok: true, actorId: text(actorId), key: KEY, complete: true, invoices: before.value,
        beforeVersion: before.version, afterVersion: before.version, fetchedAt, realmId: realmId || null,
        changed: false, superseded: true, invoiceId: targetId };
    }
    const seed = existing || (record(trustedSource) ? copy(trustedSource) : { id: targetId, createdAt: Date.parse(fetchedAt), source: "quickbooks" });
    const metadata = action === "quickbooks-payment" ? { invoice: seed, proposedInvoice: seed, conflicts: [] }
      : mergeInvoiceSpsMetadataResult(seed, sourceInvoice, { isNew: !existing });
    const source = metadata.invoice;
    const next = reconcileQuickBooksInvoice({ ...source, id: targetId, qbId: remote.qbId,
      locallyEdited: false, qbPendingLocalEdits: false, qbLocalChangesPending: false, qbSyncStatus: "synced" }, mapped);
    // trustedSource is supplied only by the in-process billing-review route.
    if (!existing && trustedSource?.billingReviewId) {
      next.billingReviewId = trustedSource.billingReviewId;
      next.billingConfirmedAt = trustedSource.billingConfirmedAt || fetchedAt;
    }
    const values = existing ? before.value.map(row => row === existing ? next : row) : [...before.value, next];
    const currentClient = clients.value.find(client => text(client.id) === text(existing?.clientId)) || null;
    const competingFinancialEdit = existing && hasPendingLocalInvoiceEdits(existing) && (action === "quickbooks-payment"
      || !same(financialIntent(buildQuickBooksInvoicePayload(existing, currentClient, {}, { today: new Date(fetchedAt) }), mapped.qbCustomerId),
        financialIntent(sourceInvoice, mapped.qbCustomerId)));
    const proposedMetadata = metadata.conflicts.length ? reconcileQuickBooksInvoice({ ...metadata.proposedInvoice,
      id: targetId, qbId: remote.qbId, locallyEdited: false, qbPendingLocalEdits: false, qbLocalChangesPending: false, qbSyncStatus: "synced" }, mapped) : null;
    const saved = await save(before.version, values, { actorId, action,
      authority: { [targetId]: next }, candidates: competingFinancialEdit ? { [targetId]: existing } : {},
      metadataCandidates: proposedMetadata ? { [targetId]: { expected: existing, proposed: proposedMetadata } } : {} });
    if (!saved?.applied) {
      if (["conflict", "missing"].includes(saved?.outcome)) continue;
      throw fail("QB_WRITE_SAVE_UNCONFIRMED", "The confirmed invoice could not be saved in SPS yet.");
    }
    if (saved.currentVersion !== before.version + 1 && !(saved.outcome === "unchanged" && saved.currentVersion === before.version)) {
      throw fail("QB_WRITE_SAVE_UNCONFIRMED", "The shared invoice version could not be verified.");
    }
    let confirmed = ledger(await readState(KEY));
    if (confirmed.version < saved.currentVersion || (confirmed.version === saved.currentVersion && !same(confirmed.value, saved.value))) {
      throw fail("QB_WRITE_SAVE_UNCONFIRMED", "The confirmed invoice snapshot could not be verified.");
    }
    let candidateResolutionPending = false;
    if (text(candidateId)) {
      const target = confirmed.value.find(row => text(row.id) === targetId);
      if (text(target?.qbWriteReview?.candidateId) === text(candidateId)) {
        try {
          const response = await rpc("sps_invoice_write_candidate_resolve", { p_invoice_id: targetId,
            p_candidate_id: text(candidateId), p_expected_invoice: target, p_actor_id: text(actorId), p_resolution: "applied-to-quickbooks" });
          const resolved = Array.isArray(response) ? response[0] : response;
          if (!resolved?.applied) candidateResolutionPending = true;
          else {
            const latest = ledger(await readState(KEY));
            if (latest.version < Number(resolved.current_version)) throw fail("QB_WRITE_SAVE_UNCONFIRMED", "The proposal resolution could not be verified.");
            confirmed = latest;
          }
        } catch (_) { candidateResolutionPending = true; }
      } else if (target?.qbWriteReview) candidateResolutionPending = true;
    }
    return { ok: true, actorId: text(actorId), key: KEY, complete: true, invoices: confirmed.value,
      beforeVersion: before.version, afterVersion: confirmed.version, fetchedAt, realmId: realmId || null,
      changed: confirmed.version > before.version, invoiceId: targetId, attempts: attempt,
      ...(candidateResolutionPending ? { candidateResolutionPending: true } : {}),
      ...(confirmed.version > saved.currentVersion ? { superseded: true } : {}) };
  }
  throw fail("QB_WRITE_CONTENTION", "QuickBooks saved the change while SPS invoices were changing. Refresh SPS to finish syncing.");
}

export async function confirmedQuickBooksWriteResponse(options, dependencies) {
  try {
    const invoiceRefresh = await persistQuickBooksInvoiceWriteReceipt(options, dependencies);
    return { invoiceRefresh, ...(invoiceRefresh.candidateResolutionPending
      ? { appSyncPending: true, warning: "QuickBooks saved the invoice. A newer saved SPS change still needs review; refresh the invoice before editing again." } : {}) };
  } catch (error) {
    return { appSyncPending: true, appSyncCode: error.code || "QB_WRITE_SAVE_UNCONFIRMED",
      warning: "QuickBooks saved this change. Refresh SPS to finish updating the app; do not create or record it again." };
  }
}
