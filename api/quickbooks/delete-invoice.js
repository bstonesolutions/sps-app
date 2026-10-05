// Delete only the reviewed, unpaid invoice. QuickBooks stays authoritative for
// its current balance, content revision, and deletion receipt.
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { requireCapability } from "../_staff-auth.js";
import { readAppStatesVersioned } from "../_app-state.js";
import { invoiceBulkDeleteEligibility } from "../../invoiceBulkDeletion.js";
import { emptyMaintenancePaymentLedger, maintenanceInvoiceTotalCents } from "../../maintenancePaymentLedger.js";
import { fingerprintQuickBooksInvoiceContent, quickBooksBaseFingerprint } from "./invoice-revision.js";

const text = (value) => String(value == null ? "" : value).trim();
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const keys = ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing", "sps_clients"];
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
  if (!await requireCapability(req, res, "invoiceDelete", "invoice deletion")) return;

  const qbId = text(req.body?.qb_id);
  const reviewedInvoice = req.body?.reviewed_invoice;
  if (!qbId || qbId.length > 220 || !isRecord(reviewedInvoice) || !text(reviewedInvoice.id)) {
    return res.status(400).json({ error: "Review the invoice before deleting it from QuickBooks." });
  }

  let snapshot, canonical, expectedCustomer;
  try {
    snapshot = await readAppStatesVersioned(keys);
    if (!Array.isArray(snapshot.sps_invoices?.value)) throw new Error("Shared invoices are unavailable");
    const invoices = snapshot.sps_invoices.value;
    const matches = invoices.filter((invoice) => text(invoice?.id) === text(reviewedInvoice.id));
    const qbMatches = invoices.filter((invoice) => text(invoice?.qbId || invoice?.Id) === qbId);
    if (matches.length !== 1 || qbMatches.length !== 1 || matches[0] !== qbMatches[0]) {
      return review(res, "invoice_identity_changed", "This QuickBooks invoice no longer matches one saved SPS invoice. Refresh and review it again.");
    }
    canonical = matches[0];
    for (const key of ["sps_estimates", "sps_schedule"]) if (snapshot[key]?.exists && !Array.isArray(snapshot[key].value)) throw new Error("Shared job links are unavailable");
    const eligibility = invoiceBulkDeleteEligibility(canonical, {
      invoices, reviewedInvoice, includeQuickBooks: true, unlinkJobs: req.body?.unlinkJobs === true,
      estimates: snapshot.sps_estimates?.value || [], schedule: snapshot.sps_schedule?.value || [],
      ledger: snapshot.sps_maintenance_billing?.exists ? snapshot.sps_maintenance_billing.value : emptyMaintenancePaymentLedger(),
    });
    if (!eligibility.eligible) return review(res, eligibility.code, eligibility.reason);
    expectedCustomer = text(canonical.qbCustomerId);
    const clientId = text(canonical.clientId || canonical.customerId);
    const clients = Array.isArray(snapshot.sps_clients?.value) ? snapshot.sps_clients.value : [];
    const clientMatches = clientId ? clients.filter((client) => text(client?.id) === clientId) : [];
    if (!expectedCustomer && clientMatches.length === 1) expectedCustomer = text(clientMatches[0].qbId || clientMatches[0].qbCustomerId);
    if (!expectedCustomer) return review(res, "quickbooks_customer_unverified", "Sync this invoice from QuickBooks before deleting it so its customer can be verified.");
  } catch (_) {
    return res.status(503).json({ error: "Shared invoice links and payment coverage could not be checked. Nothing was deleted." });
  }

  let access_token, realm_id;
  try { ({ access_token, realm_id } = await getValidAccessToken()); }
  catch (_) { return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true }); }
  const base = `${QB_API_BASE}/v3/company/${encodeURIComponent(realm_id)}`;
  const headers = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" };
  let deleteStarted = false;
  try {
    const response = await fetch(`${base}/invoice/${encodeURIComponent(qbId)}?minorversion=65`, { headers });
    if (response.status === 404) return res.status(200).json({ success: true, alreadyGone: true });
    if (!response.ok) {
      const issue = fault(await response.text());
      if (issue.code === "610") return res.status(200).json({ success: true, alreadyGone: true });
      return res.status(502).json({ error: `Could not read the invoice from QuickBooks${issue.message ? `: ${issue.message}` : "."}`, code: "quickbooks_read_failed" });
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
    if (text(existing.CustomerRef?.value) !== expectedCustomer || total !== maintenanceInvoiceTotalCents(canonical)
      || (text(canonical.number) && text(existing.DocNumber) !== text(canonical.number))) {
      return review(res, "quickbooks_invoice_changed", "The customer, amount, or number changed in QuickBooks. Sync and review this invoice before deleting it.");
    }
    const fingerprint = quickBooksBaseFingerprint(canonical);
    if (!fingerprint) return review(res, "quickbooks_revision_missing", "Refresh this invoice from QuickBooks and review it before deleting. Its saved version cannot be verified yet.");
    if (fingerprint !== fingerprintQuickBooksInvoiceContent(existing)) {
      return review(res, "quickbooks_invoice_changed", "This invoice changed in QuickBooks. Sync and review the current version before deleting it.");
    }

    // Recheck shared versions after the remote read, before the irreversible
    // request. The app separately fences its local removal after QB confirms.
    const latest = await readAppStatesVersioned(keys);
    if (keys.some((key) => snapshot[key]?.version !== latest[key]?.version || snapshot[key]?.exists !== latest[key]?.exists)) {
      return review(res, "invoice_records_changed", "Invoice links or payment coverage changed during this check. Refresh and review the invoice again.");
    }
    deleteStarted = true;
    const deleted = await fetch(`${base}/invoice?operation=delete&minorversion=65`, {
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
    return res.status(200).json({ success: true });
  } catch (_) {
    return res.status(502).json({ success: false, outcomeUnknown: deleteStarted, code: deleteStarted ? "quickbooks_delete_unconfirmed" : "quickbooks_read_failed", error: deleteStarted
      ? "The connection ended before QuickBooks confirmed deletion. Keep the SPS invoice and retry to check its current state."
      : "The invoice could not be checked in QuickBooks. Nothing was deleted." });
  }
}
