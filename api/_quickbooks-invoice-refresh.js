// Persist a QuickBooks read on the server before returning it to any device.
// Only this invoice row is written; a device's client/profile queue is irrelevant.
import { readAppStateVersioned } from "./_app-state.js";
import { compareAndSetCanonicalInvoices } from "./_invoice-canonical-state.js";
import { invoiceAuthorityRpc } from "./_invoice-write-candidates.js";
import { hasPendingLocalInvoiceEdits, reconcileQuickBooksInvoice } from "../quickbooksInvoiceReconciliation.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";

const KEY = "sps_invoices";
const text = value => String(value ?? "").trim();
const normalized = value => text(value).replace(/\s+/g, " ").toLowerCase();
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);
const copy = value => JSON.parse(JSON.stringify(value));
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const stamp = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };

function validInvoices(value, label) {
  const ids = new Set();
  if (!Array.isArray(value) || value.some(invoice => {
    if (!record(invoice) || !text(invoice.id) || ids.has(text(invoice.id))) return true;
    ids.add(text(invoice.id)); return false;
  })) throw failure("QB_REFRESH_STATE_INVALID", `${label} invoices could not be verified. Nothing was replaced.`);
  return value;
}

function confirmedState(state) {
  if (!state?.exists || !Number.isSafeInteger(state.version) || state.version < 1) {
    throw failure("QB_REFRESH_STATE_INVALID", "Shared invoices could not be read. Nothing was replaced.");
  }
  validInvoices(state.value, "Shared");
  return state;
}

function uniqueIndex(rows, keyOf) {
  const index = new Map(), ambiguous = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (index.has(key)) ambiguous.add(key);
    else index.set(key, row);
  }
  for (const key of ambiguous) index.delete(key);
  return { index, ambiguous };
}

function resolveClient(clients, customers) {
  const usable = clients.filter(client => record(client) && text(client.id));
  const ids = uniqueIndex(usable, client => text(client.id));
  const rows = usable.filter(client => !ids.ambiguous.has(text(client.id)));
  const qb = uniqueIndex(rows, client => text(client.qbId));
  const names = uniqueIndex(rows, client => normalized(client.name));
  const emails = uniqueIndex(rows, client => normalized(client.email));
  const customerMap = uniqueIndex(customers, customer => text(customer.qbId));
  return invoice => {
    const qbId = text(invoice.qbCustomerId);
    if (qb.ambiguous.has(qbId) || customerMap.ambiguous.has(qbId)) return null;
    if (qb.index.has(qbId)) return qb.index.get(qbId).id;
    const customer = customerMap.index.get(qbId);
    const byName = names.index.get(normalized(customer?.name || invoice.clientName));
    const byEmail = customer ? emails.index.get(normalized(customer.email)) : null;
    // Two different unique matches are conflicting evidence, not permission to
    // move an invoice to whichever identity happened to be tested first.
    if (byName && byEmail && text(byName.id) !== text(byEmail.id)) return null;
    const candidate = byName || byEmail;
    // A name/email fallback cannot contradict a client's already-known QB id.
    if (candidate && text(candidate.qbId) && text(candidate.qbId) !== qbId) return null;
    return candidate?.id ?? null;
  };
}

function newerConfirmedRevision(local, remote) {
  const localTime = stamp(local.qbLastUpdatedTime), remoteTime = stamp(remote.qbLastUpdatedTime);
  if (localTime != null && remoteTime != null && localTime > remoteTime) return true;
  const localToken = text(local.qbSyncToken), remoteToken = text(remote.qbSyncToken);
  return /^\d+$/.test(localToken) && /^\d+$/.test(remoteToken) && BigInt(localToken) > BigInt(remoteToken);
}

function validatePayload(payload) {
  const seen = new Set();
  if (!record(payload) || !Array.isArray(payload.invoices) || !Array.isArray(payload.customers)
    || payload.invoices.some(invoice => {
      const id = text(invoice?.qbId);
      if (!record(invoice) || !id || seen.has(id) || !text(invoice.qbCustomerId)
        || !Array.isArray(invoice.lineItems)
        || [invoice.total, invoice.balance].some(value => value == null || text(value) === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) return true;
      seen.add(id); return false;
    }) || payload.customers.some(customer => !record(customer) || !text(customer.qbId))) {
    throw failure("QB_REFRESH_PAYLOAD_INVALID", "QuickBooks did not return a complete invoice response. Nothing was replaced.", 502);
  }
}

/** Pure invoice reconciliation, shared by every bounded server CAS attempt. */
export function mergeQuickBooksInvoiceRefresh(current, clients, payload, { fetchedAt, startedAt, authorityOwners = [] } = {}) {
  validInvoices(current, "Shared");
  validatePayload(payload);
  if (!Array.isArray(clients)) throw failure("QB_REFRESH_CLIENTS_INVALID", "Saved client identities could not be read. Nothing was replaced.");
  const findClient = resolveClient(clients, payload.customers);
  const receivedAt = fetchedAt || payload.reconciliation?.fetchedAt;
  if (stamp(receivedAt) == null) throw failure("QB_REFRESH_TIME_INVALID", "The QuickBooks snapshot has no verified read time.", 502);
  const queryStarted = stamp(startedAt || payload.startedAt || receivedAt);
  if (queryStarted == null || queryStarted > stamp(receivedAt)) throw failure("QB_REFRESH_TIME_INVALID", "The QuickBooks read interval could not be verified.", 502);
  const complete = payload.reconciliation?.pagination?.invoices?.complete === true;
  const remoteById = new Map(payload.invoices.map(invoice => {
    const remote = { ...copy(invoice), id: `qb_${text(invoice.qbId)}`, clientId: findClient(invoice),
      source: "quickbooks", qbAuthoritative: true, qbSyncStatus: "synced", locallyEdited: false,
      qbBaseContentFingerprint: invoice.qbContentFingerprint || "", createdAt: stamp(receivedAt) };
    return [text(invoice.qbId), remote];
  }));
  const preferred = new Map();
  const ownerIds = new Map();
  for (const owner of authorityOwners) {
    if (!text(owner?.invoice_id) || !text(owner?.qb_id)) continue;
    if (ownerIds.has(text(owner.qb_id)) && ownerIds.get(text(owner.qb_id)) !== text(owner.invoice_id)) {
      throw failure("QB_REFRESH_IDENTITY_CONFLICT", "Multiple saved invoice identities need review before refreshing.", 409);
    }
    ownerIds.set(text(owner.qb_id), text(owner.invoice_id));
  }
  for (const invoice of current) {
    const qbId = text(invoice.qbId);
    if (!qbId) continue;
    const existing = preferred.get(qbId);
    if (!existing || text(invoice.id) === ownerIds.get(qbId)
      || (text(existing.id) !== ownerIds.get(qbId) && existing.source === "quickbooks" && invoice.source !== "quickbooks")) preferred.set(qbId, invoice);
  }
  for (const [qbId, invoice] of preferred) {
    if (ownerIds.has(qbId) && text(invoice.id) !== ownerIds.get(qbId)) {
      throw failure("QB_REFRESH_IDENTITY_CONFLICT", "The saved QuickBooks owner is missing from the SPS invoice list. Review the duplicate invoice records before refreshing.", 409);
    }
  }
  const authority = Object.create(null), candidates = Object.create(null), diagnostics = Object.create(null);
  const diagnose = (invoice, patch) => {
    diagnostics[text(invoice.id)] = { expected: copy(invoice), patch };
    return { ...invoice, ...patch };
  };
  const used = new Set(), counts = { imported: 0, updated: 0, preservedNewer: 0, review: 0, missing: 0, duplicates: 0 };
  const merged = current.map(invoice => {
    const qbId = text(invoice.qbId);
    if (!qbId || invoice.qbSpsOnly === true || invoice.qbSyncStatus === "sps-only") return invoice;
    const remote = remoteById.get(qbId);
    if (remote) used.add(qbId);
    if (preferred.get(qbId) !== invoice) {
      counts.duplicates++;
      return diagnose(invoice, { qbNeedsReview: true, qbSyncStatus: "duplicate-local-qb-id", qbDuplicateOfId: preferred.get(qbId).id });
    }
    if (!remote) {
      // A record created/updated after this read began cannot be declared absent
      // merely because a concurrent paged query did not include it yet.
      const newer = [invoice.qbLastUpdatedTime, invoice.qbSyncAttemptedAt].some(value => stamp(value) != null && stamp(value) >= queryStarted)
        || (Number.isFinite(Number(invoice.createdAt)) && Number(invoice.createdAt) >= queryStarted);
      if (!complete || newer) return invoice;
      counts.missing++;
      return diagnose(invoice, { qbNeedsReview: true, qbSyncStatus: "missing-remote", qbMissingSince: invoice.qbMissingSince || receivedAt });
    }
    if (newerConfirmedRevision(invoice, remote)) { counts.preservedNewer++; return invoice; }
    // The ledger holds confirmed QB accounting. Keep genuine pending SPS work
    // separately so the transaction can journal it and add a visible review
    // marker without blessing an unconfirmed edit as QuickBooks truth.
    const next = reconcileQuickBooksInvoice({ ...invoice, locallyEdited: false,
      qbPendingLocalEdits: false, qbLocalChangesPending: false, qbSyncStatus: "synced" }, remote);
    authority[text(invoice.id)] = copy(next);
    if (hasPendingLocalInvoiceEdits(invoice)) {
      candidates[text(invoice.id)] = copy(invoice);
      counts.review++;
    }
    if (!same(next, invoice)) counts.updated++;
    return next;
  });
  const existingIds = new Set(current.map(invoice => text(invoice.id)));
  for (const [qbId, remote] of remoteById) {
    if (used.has(qbId)) continue;
    if (existingIds.has(remote.id)) {
      throw failure("QB_REFRESH_IDENTITY_CONFLICT", "A QuickBooks import shares an existing SPS invoice identity. Review that invoice before refreshing.", 409);
    }
    merged.push(remote); existingIds.add(remote.id); counts.imported++;
    authority[remote.id] = copy(remote);
  }
  return { invoices: merged, authority, candidates, diagnostics, counts, quickBooksComplete: complete };
}

/** A confirmed full snapshot, independent of any browser or native pending queue. */
export async function persistQuickBooksInvoiceRefresh(payload, {
  actorId, readState = readAppStateVersioned, compareAndSet,
  readAuthorityOwners = () => invoiceAuthorityRpc("sps_invoice_authority_owners", {}),
  now = () => new Date().toISOString(), maxAttempts = 3, startedAt,
} = {}) {
  if (!text(actorId)) throw failure("QB_REFRESH_UNAUTHORIZED", "Sign in before refreshing shared invoices.", 401);
  const writeInvoices = compareAndSet || ((key, version, value, scope) => compareAndSetCanonicalInvoices(version, value, scope));
  validatePayload(payload);
  const fetchedAt = payload.reconciliation?.fetchedAt || now();
  const clients = await readState("sps_clients");
  if (!clients?.exists || !Array.isArray(clients.value)) throw failure("QB_REFRESH_CLIENTS_INVALID", "Saved client identities could not be read. Nothing was replaced.");
  const limit = Math.min(5, Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : 3));
  for (let attempt = 1; attempt <= limit; attempt++) {
    const before = confirmedState(await readState(KEY));
    const linkedIds = before.value.map(invoice => text(invoice.qbId)).filter(Boolean);
    // Existing duplicate rows must retain the server's established owner. Do
    // not let source ordering move accounting authority to a different SPS id.
    const authorityOwners = new Set(linkedIds).size < linkedIds.length ? await readAuthorityOwners() : [];
    if (!Array.isArray(authorityOwners)) throw failure("QB_REFRESH_IDENTITY_CONFLICT", "Saved invoice identities could not be verified.");
    const plan = mergeQuickBooksInvoiceRefresh(before.value, clients.value, payload, { fetchedAt, startedAt, authorityOwners });
    const changed = !same(plan.invoices, before.value);
    if (!changed && !Object.keys(plan.authority).length && !Object.keys(plan.diagnostics).length) return { ok: true, actorId: text(actorId), key: KEY, complete: true, invoices: before.value,
      beforeVersion: before.version, afterVersion: before.version, changed: false,
      fetchedAt, realmId: payload.realmId || null, quickBooksComplete: plan.quickBooksComplete, counts: plan.counts, attempts: attempt };
    const saved = await writeInvoices(KEY, before.version, plan.invoices, { actorId, action: "quickbooks-refresh",
      authority: plan.authority, candidates: plan.candidates, diagnostics: plan.diagnostics });
    if (!saved?.applied) {
      if (["conflict", "missing"].includes(saved?.outcome)) continue;
      throw failure("QB_REFRESH_SAVE_UNCONFIRMED", "The shared QuickBooks refresh was not confirmed. Retry the refresh to check its saved state.");
    }
    if (saved.currentVersion !== before.version + 1 && !(saved.outcome === "unchanged" && saved.currentVersion === before.version)) {
      throw failure("QB_REFRESH_SAVE_UNCONFIRMED", "The shared invoice version could not be confirmed. Retry the refresh.");
    }
    validInvoices(saved.value, "Confirmed");
    const confirmed = confirmedState(await readState(KEY));
    if (confirmed.version < saved.currentVersion || (confirmed.version === saved.currentVersion && !same(confirmed.value, saved.value))) {
      throw failure("QB_REFRESH_SAVE_UNCONFIRMED", "The saved invoice snapshot could not be verified. Retry the refresh.");
    }
    return { ok: true, actorId: text(actorId), key: KEY, complete: true, invoices: confirmed.value,
      beforeVersion: before.version, afterVersion: confirmed.version, changed: saved.currentVersion > before.version,
      fetchedAt, realmId: payload.realmId || null, quickBooksComplete: plan.quickBooksComplete, counts: plan.counts, attempts: attempt,
      ...(confirmed.version > saved.currentVersion ? { superseded: true } : {}) };
  }
  throw failure("QB_REFRESH_CONTENTION", "Shared invoices changed during the refresh. Your work is preserved; retry to read the latest saved invoices.", 409);
}
