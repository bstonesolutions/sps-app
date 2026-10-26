// Delete only the reviewed, unpaid invoice. QuickBooks stays authoritative for
// its current balance, content revision, and deletion receipt.
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { authorizeConfirmedInvoiceDeletion } from "../_invoice-write-candidates.js";
import { requireCapability } from "../_staff-auth.js";
import { readAppStatesVersioned } from "../_app-state.js";
import { maintenanceInvoiceTotalCents } from "../../maintenancePaymentLedger.js";
import { checkInvoiceDeletionSnapshot, completeConfirmedInvoiceDeletion, confirmedInvoiceDeletionReplay, invoiceDeletionKeys } from "../_invoice-deletion.js";
import { fingerprintQuickBooksInvoiceContent, quickBooksBaseFingerprint } from "./invoice-revision.js";

export const config = { maxDuration: 60 };
const text = (value) => String(value == null ? "" : value).trim();
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const keys = invoiceDeletionKeys;
const cents = (value) => value != null && text(value) && Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
const fault = (raw) => {
  try {
    const issue = JSON.parse(raw)?.Fault?.Error?.[0];
    if (issue) return { code: text(issue.code), message: [issue.Message, issue.Detail].filter(Boolean).join(": ").slice(0, 500) };
  } catch (_) { /* The response may be a plain transport error. */ }
  return { code: "", message: text(raw).slice(0, 300) };
};
const review = (res, code, error) => res.status(409).json({ success: false, code, error, reviewRequired: true });

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const actor = await requireCapability(req, res, "invoiceDelete", "invoice deletion");
  if (!actor) return;

  const qbId = text(req.body?.qb_id);
  const reviewedInvoice = req.body?.reviewed_invoice;
  if (!qbId || qbId.length > 220 || !isRecord(reviewedInvoice) || !text(reviewedInvoice.id)) {
    return res.status(400).json({ error: "Review the invoice before deleting it from QuickBooks." });
  }

  let snapshot, canonical, expectedCustomer;
  const completeInSps = req.body?.completeInSps === true;
  const unlinkJobs = req.body?.unlinkJobs === true;
  try {
    snapshot = await readAppStatesVersioned(keys);
    const checked = checkInvoiceDeletionSnapshot(snapshot, reviewedInvoice, qbId, unlinkJobs);
    if (checked.absent) {
      if (!completeInSps) return review(res, "invoice_identity_changed", "This invoice is no longer in the saved list. Refresh the invoices.");
      return res.status(200).json(await confirmedInvoiceDeletionReplay(snapshot, reviewedInvoice, qbId, actor.id));
    }
    ({ canonical, expectedCustomer } = checked);
  } catch (error) {
    return res.status(error.status || 503).json({ success: false, code: error.code || "invoice_records_unavailable", error: error.code ? error.message : "Shared invoice links and payment coverage could not be checked. Nothing was deleted.", reviewRequired: error.status === 409 });
  }

  const finish = async (alreadyGone = false) => {
    if (completeInSps) return { ...(await completeConfirmedInvoiceDeletion(canonical, qbId, actor.id, unlinkJobs)), alreadyGone };
    // Compatibility for older callers which perform the subsequent guarded SPS
    // cleanup themselves. New callers receive one complete server receipt.
    await authorizeConfirmedInvoiceDeletion(canonical, actor.id);
    return { success: true, alreadyGone };
  };

  let access_token, realm_id;
  try { ({ access_token, realm_id } = await getValidAccessToken()); }
  catch (_) { return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true }); }
  const base = `${QB_API_BASE}/v3/company/${encodeURIComponent(realm_id)}`;
  const headers = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" };
  const fetchQuickBooks = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  let deleteStarted = false;
  try {
    const response = await fetchQuickBooks(`${base}/invoice/${encodeURIComponent(qbId)}?minorversion=65`, { headers });
    if (!response.ok) {
      const issue = fault(await response.text());
      if (issue.code === "610") return res.status(200).json(await finish(true));
      if (response.status === 404) {
        // A proxy, expired route, or generic HTTP 404 is not accounting evidence.
        // Confirm the requested invoice is absent through a successful QB query.
        const escapedId = qbId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const query = `select Id from Invoice where Id = '${escapedId}'`;
        const lookup = await fetchQuickBooks(`${base}/query?query=${encodeURIComponent(query)}&minorversion=65`, { headers });
        const payload = await lookup.json().catch(() => null);
        const found = payload?.QueryResponse;
        if (lookup.ok && found && typeof found === "object" && !Array.isArray(found)
          && (!Object.hasOwn(found, "Invoice") || Array.isArray(found.Invoice) && found.Invoice.length === 0)
          && (!Object.hasOwn(found, "totalCount") || Number(found.totalCount) === 0)) {
          return res.status(200).json(await finish(true));
        }
      }
      return res.status(502).json({ error: `Could not verify the invoice in QuickBooks${issue.message ? `: ${issue.message}` : "."}`, code: "quickbooks_read_failed" });
    }
    const existing = (await response.json())?.Invoice;
    if (!existing || text(existing.Id) !== qbId || existing.SyncToken == null) {
      return res.status(502).json({ error: "QuickBooks did not return the requested invoice and its revision. Nothing was deleted.", code: "quickbooks_read_unverified" });
    }
    const total = cents(existing.TotalAmt);
    const balance = cents(existing.Balance);
    if (total == null || balance == null || total < 0 || balance < 0 || balance !== total
      || Number(existing.Deposit) > 0 || (Array.isArray(existing.LinkedTxn) && existing.LinkedTxn.some((txn) => /payment|credit|refund/i.test(text(txn.TxnType))))) {
      return review(res, "quickbooks_payment_protected", "This invoice has a payment, credit, deposit, or unverified balance in QuickBooks. Keep it as the accounting record.");
    }
    if (!expectedCustomer) return review(res, "quickbooks_customer_unverified", "The saved client could not be matched to this QuickBooks customer. Refresh the invoice details before deleting.");
    if (text(existing.CustomerRef?.value) !== expectedCustomer || total !== maintenanceInvoiceTotalCents(canonical)
      || (text(canonical.number) && text(existing.DocNumber) !== text(canonical.number))) {
      return review(res, "quickbooks_invoice_changed", "The customer, amount, or number changed in QuickBooks. Sync and review this invoice before deleting it.");
    }
    const fingerprint = quickBooksBaseFingerprint(canonical);
    if (!fingerprint) return review(res, "quickbooks_revision_missing", "Refresh this invoice from QuickBooks and review it before deleting. Its saved version cannot be verified yet.");
    if (fingerprint !== fingerprintQuickBooksInvoiceContent(existing)) {
      return review(res, "quickbooks_invoice_changed", "This invoice changed in QuickBooks. Sync and review the current version before deleting it.");
    }

    // Recheck this target and its payment coverage after the remote read.
    // Unrelated client, job, or invoice edits do not invalidate this request.
    const latest = await readAppStatesVersioned(keys);
    const checked = checkInvoiceDeletionSnapshot(latest, canonical, qbId, unlinkJobs);
    if (checked.absent || checked.expectedCustomer !== expectedCustomer) {
      return review(res, "invoice_records_changed", "This invoice or its linked customer changed during the check. Refresh its details before deleting.");
    }
    canonical = checked.canonical;
    deleteStarted = true;
    const deleted = await fetchQuickBooks(`${base}/invoice?operation=delete&minorversion=65`, {
      method: "POST", headers, body: JSON.stringify({ Id: qbId, SyncToken: String(existing.SyncToken) }),
    });
    if (!deleted.ok) {
      const issue = fault(await deleted.text());
      return res.status(502).json({ success: false, code: "quickbooks_delete_rejected", error: `QuickBooks rejected the deletion${issue.message ? `: ${issue.message}` : "."}` });
    }
    const receipt = (await deleted.json())?.Invoice;
    if (text(receipt?.Id) !== qbId || text(receipt?.status).toLowerCase() !== "deleted") {
      return res.status(502).json({ success: false, outcomeUnknown: true, code: "quickbooks_delete_unconfirmed", error: "QuickBooks did not return a confirmed deletion. Keep the SPS invoice and retry to check its current state." });
    }
    return res.status(200).json(await finish());
  } catch (error) {
    if (typeof error.code === "string" || error.status) return res.status(error.status || 503).json({ success:false, code:error.code, error:error.message, outcomeUnknown:deleteStarted });
    return res.status(502).json({ success: false, outcomeUnknown: deleteStarted, code: deleteStarted ? "quickbooks_delete_unconfirmed" : "quickbooks_read_failed", error: deleteStarted
      ? "The connection ended before QuickBooks confirmed deletion. Keep the SPS invoice and retry to check its current state."
      : "The invoice could not be checked in QuickBooks. Nothing was deleted." });
  }
}
