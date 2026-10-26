// Private recovery of a device proposal. Accounting remains the verified QB copy.
import { APP_STATE_SERVICE_KEY, APP_STATE_SUPABASE_URL, readAppStateVersioned, withAppStateRequestDeadline } from './_app-state.js';
const text = value => String(value ?? '').trim();
const fail = (code, message, status = 409) => Object.assign(new Error(message), {code, status});
export async function invoiceAuthorityRpc(name, body, {fetchImpl = globalThis.fetch} = {}) {
  if (!APP_STATE_SERVICE_KEY) throw fail('INVOICE_AUTHORITY_UNAVAILABLE', 'Shared invoice recovery is unavailable.', 503);
  return withAppStateRequestDeadline(name, async signal => {
    const response = await fetchImpl(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', signal, headers: {apikey: APP_STATE_SERVICE_KEY, Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 409 && payload?.code === 'PT409') {
        throw Object.assign(fail('INVOICE_AUTHORITY_CONFLICT', 'This saved invoice changed or has a protected accounting link. Review its current details before trying again.', 409), { retryable: false, databaseCode: 'PT409' });
      }
      throw fail('INVOICE_AUTHORITY_UNAVAILABLE', 'The saved invoice action could not be confirmed. Retry to check its state.', 503);
    }
    if (payload == null) throw fail('INVOICE_AUTHORITY_UNAVAILABLE', 'The saved invoice action returned an unreadable receipt. Retry to check its state.', 503);
    return payload;
  });
}
export async function readInvoiceWriteProposal(body, {readState = readAppStateVersioned, rpc = invoiceAuthorityRpc} = {}) {
  const id = text(body?.invoiceId), candidateId = text(body?.candidateId);
  if (!id || id.length > 220 || !/^\d{1,18}$/.test(candidateId)) throw fail('INVOICE_PROPOSAL_INVALID', 'Choose the saved invoice change to review.', 400);
  const state = await readState('sps_invoices');
  const matches = Array.isArray(state?.value) ? state.value.filter(row => text(row?.id) === id) : [];
  if (matches.length !== 1 || text(matches[0].qbWriteReview?.candidateId) !== candidateId) throw fail('INVOICE_PROPOSAL_CHANGED', 'This saved change has already been resolved or replaced. Refresh the invoice.');
  const rows = await rpc('sps_invoice_write_candidates_read', {p_invoice_id:id, p_candidate_id:candidateId});
  const proposal = Array.isArray(rows) ? rows.find(row => text(row.id) === candidateId && text(row.invoice_id) === id && !row.resolved_at) : null;
  if (!proposal) throw fail('INVOICE_PROPOSAL_UNAVAILABLE', 'The saved proposal could not be found. The confirmed invoice is unchanged.', 503);
  return {ok:true, invoice:matches[0], proposal: {id:candidateId, reason:proposal.reason, savedAt:proposal.created_at, invoice:proposal.candidate_invoice}, version:state.version};
}
export async function authorizeConfirmedInvoiceDeletion(invoice, actorId, {rpc = invoiceAuthorityRpc} = {}) {
  const payload = await rpc('sps_invoice_authorize_delete', {p_invoice_id:text(invoice.id), p_expected_invoice:invoice, p_actor_id:text(actorId)});
  const receipt = Array.isArray(payload) ? payload[0] : payload;
  if (receipt?.authorized !== true) throw fail('INVOICE_DELETE_CHANGED', 'QuickBooks deletion was confirmed, but this SPS record changed. Refresh and retry to finish removing it.');
  return receipt;
}
