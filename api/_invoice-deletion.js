// Server-owned cleanup for one reviewed invoice. Device queues never supply a
// replacement ledger, and the database transaction confirms every saved section.
import { readAppStatesVersioned } from './_app-state.js';
import { compareAndSetSharedStatePatchBatch } from './_shared-state-patch.js';
import { authorizeConfirmedInvoiceDeletion, invoiceAuthorityRpc } from './_invoice-write-candidates.js';
import { invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches, unlinkUnpaidInvoiceCoverage } from '../invoiceBulkDeletion.js';
import { findInvoiceDeletionReferences, unlinkInvoiceDeletionReferences } from '../invoiceDeletionGuard.js';
import { emptyMaintenancePaymentLedger, maintenanceInvoiceTotalCents } from '../maintenancePaymentLedger.js';
import { stableInvoiceReviewJSON } from '../invoiceReviewIdentity.js';

export const invoiceDeletionKeys = ['sps_invoices', 'sps_estimates', 'sps_schedule', 'sps_maintenance_billing', 'sps_clients'];
const savedKeys = invoiceDeletionKeys.slice(0, 4);
const text = value => String(value ?? '').trim();
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const equal = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);

export function checkInvoiceDeletionSnapshot(snapshot, reviewedInvoice, qbId, unlinkJobs) {
  if (!Array.isArray(snapshot.sps_invoices?.value) || !Array.isArray(snapshot.sps_schedule?.value)
    || snapshot.sps_estimates?.exists && !Array.isArray(snapshot.sps_estimates.value)) {
    throw fail('INVOICE_DELETE_SNAPSHOT_INVALID', 'Shared invoice and job records could not be checked. Nothing was removed.', 503);
  }
  const invoices = snapshot.sps_invoices.value;
  const matches = invoices.filter(invoice => text(invoice?.id) === text(reviewedInvoice.id));
  const qbMatches = invoices.filter(invoice => text(invoice?.qbId || invoice?.Id) === qbId);
  if (!matches.length && !qbMatches.length) return { absent: true };
  if (matches.length !== 1 || qbMatches.length !== 1 || matches[0] !== qbMatches[0]) {
    throw fail('invoice_identity_changed', 'This QuickBooks invoice no longer matches one saved SPS invoice. Refresh its details before deleting.');
  }
  const canonical = matches[0];
  if (!invoiceDeletionReviewMatches(reviewedInvoice, canonical)) {
    throw fail('review-required', 'The invoice changed after you opened it. Refresh its details before deleting.');
  }
  const estimates = snapshot.sps_estimates?.value || [];
  const schedule = snapshot.sps_schedule.value;
  const ledger = snapshot.sps_maintenance_billing?.exists ? snapshot.sps_maintenance_billing.value : emptyMaintenancePaymentLedger();
  const eligibility = invoiceBulkDeleteEligibility(canonical, {
    invoices, reviewedInvoice, includeQuickBooks: true, allowQuickBooksReviewCheck: true, unlinkJobs,
    estimates, schedule, ledger, totalOf: invoice => maintenanceInvoiceTotalCents(invoice) / 100,
  });
  if (!eligibility.eligible) throw fail(eligibility.code, eligibility.reason);
  let expectedCustomer = text(canonical.qbCustomerId);
  const clientId = text(canonical.clientId || canonical.customerId);
  const clients = Array.isArray(snapshot.sps_clients?.value) ? snapshot.sps_clients.value : [];
  const clientMatches = clientId ? clients.filter(client => text(client?.id) === clientId) : [];
  if (!expectedCustomer && clientMatches.length === 1) expectedCustomer = text(clientMatches[0].qbId || clientMatches[0].qbCustomerId);
  return { canonical, invoices, estimates, schedule, ledger, expectedCustomer };
}

export async function confirmedInvoiceDeletionReplay(snapshot, reviewedInvoice, qbId, actorId, { rpc = invoiceAuthorityRpc } = {}) {
  const payload = await rpc('sps_invoice_delete_receipt', { p_invoice_id: text(reviewedInvoice.id), p_qb_id: qbId });
  const receipt = Array.isArray(payload) ? payload[0] : payload;
  if (receipt?.deleted !== true || text(receipt.invoice_id) !== text(reviewedInvoice.id) || text(receipt.qb_id) !== qbId
    || !receipt.consumed_at || !invoiceDeletionReviewMatches(reviewedInvoice, receipt.expected_invoice)) {
    throw fail('INVOICE_DELETE_RECEIPT_MISSING', 'This invoice is no longer in the saved list, but its deletion receipt could not be confirmed. Refresh the invoice list.', 409);
  }
  const references = findInvoiceDeletionReferences(receipt.expected_invoice, snapshot.sps_estimates?.value || [], snapshot.sps_schedule.value);
  if (references.estimates.some(item => text(item.linkedInvoiceId) === text(reviewedInvoice.id))
    || references.stops.some(item => text(item.linkedInvoiceId) === text(reviewedInvoice.id))) {
    throw fail('INVOICE_DELETE_LINKS_CHANGED', 'A job was linked again after this invoice was removed. Review the current job link before continuing.');
  }
  const versions = Object.fromEntries(savedKeys.map(key => [key, snapshot[key]?.version || 0]));
  const values = Object.fromEntries(savedKeys.map(key => [key, snapshot[key]?.value ?? (key === 'sps_maintenance_billing' ? emptyMaintenancePaymentLedger() : [])]));
  return { success: true, complete: true, existing: true, alreadyGone: true, deletedInvoiceId: text(reviewedInvoice.id), qbId, beforeInvoice: receipt.expected_invoice, actorId,
    beforeVersions: versions, versions, values };
}

export async function completeConfirmedInvoiceDeletion(reviewedInvoice, qbId, actorId, unlinkJobs, {
  read = readAppStatesVersioned, authorize = authorizeConfirmedInvoiceDeletion, batch = compareAndSetSharedStatePatchBatch,
  replay = confirmedInvoiceDeletionReplay, maxAttempts = 4,
} = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await read(invoiceDeletionKeys);
    const checked = checkInvoiceDeletionSnapshot(snapshot, reviewedInvoice, qbId, unlinkJobs);
    if (checked.absent) return replay(snapshot, reviewedInvoice, qbId, actorId);
    const { canonical, invoices, estimates, schedule, ledger } = checked;
    const unlinked = unlinkJobs ? unlinkInvoiceDeletionReferences(canonical, estimates, schedule) : { estimates, schedule };
    const values = { sps_invoices: invoices.filter(invoice => text(invoice?.id) !== text(canonical.id)), sps_estimates: unlinked.estimates,
      sps_schedule: unlinked.schedule, sps_maintenance_billing: unlinkJobs ? unlinkUnpaidInvoiceCoverage(canonical, ledger) : ledger };
    await authorize(canonical, actorId);
    const beforeVersions = Object.fromEntries(savedKeys.map(key => [key, snapshot[key]?.version || 0]));
    const saved = await batch(savedKeys.map(key => ({ key, expectedVersion: beforeVersions[key], value: values[key] })), {
      actorId, expectedCurrent: { sps_schedule: schedule },
    });
    if (!saved.applied) {
      if (['conflict', 'current-changed'].includes(saved.outcome) && attempt + 1 < maxAttempts) continue;
      throw fail('INVOICE_DELETE_SAVE_CONFLICT', 'Related records changed while removing the invoice. Retry to finish the same deletion.');
    }
    if (savedKeys.some(key => !equal(saved.values?.[key], values[key]) || !Number.isSafeInteger(saved.currentVersions?.[key])
      || saved.currentVersions[key] < beforeVersions[key])) {
      throw fail('INVOICE_DELETE_SAVE_UNCONFIRMED', 'The server did not confirm the complete invoice removal. Retry to check the same deletion.', 503);
    }
    return { success: true, complete: true, deletedInvoiceId: text(canonical.id), qbId, beforeInvoice: canonical, actorId, beforeVersions,
      versions: saved.currentVersions, values: saved.values };
  }
  throw fail('INVOICE_DELETE_SAVE_CONFLICT', 'Related records changed repeatedly. Retry to finish the same deletion.');
}
