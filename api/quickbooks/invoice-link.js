// api/quickbooks/invoice-link.js
// Fetch a single QuickBooks invoice's hosted pay link ON DEMAND. QB's bulk sync (sync.js) doesn't
// return a pay URL, so invoices CREATED in QuickBooks come into the app without one. When a client
// taps "Pay now" on such an invoice in the portal, we fetch its QuickBooks pay link here and open it
// in the in-app browser. Payment stays 100% in QuickBooks — no other payment service.
//
// Requires online payments enabled on the QB account (so QB exposes Invoice.InvoiceLink). Auth-gated;
// the QB token is read server-side (never passed by the client), same as sync.js.
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const _u = await requireUser(req, res);
  if (!_u) return;

  let id = (req.query && (req.query.id || req.query.invoiceId)) || "";
  if (!id) { try { id = new URL(req.url, "http://x").searchParams.get("id") || ""; } catch (_) {} }
  if (!id) return res.status(400).json({ error: "Missing invoice id" });

  // The app prefixes QB-synced invoice ids as "qb_<rawId>" — strip it for the QB API.
  id = String(id).replace(/^qb_/, "");

  let access_token, realm_id;
  try {
    ({ access_token, realm_id } = await getValidAccessToken());
  } catch (e) {
    return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true });
  }

  try {
    // include=invoiceLink → Invoice.InvoiceLink: QB's hosted online-payment page for this invoice.
    const url = `${QB_API_BASE}/v3/company/${realm_id}/invoice/${encodeURIComponent(id)}?include=invoiceLink&minorversion=65`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
    if (r.status === 401) return res.status(401).json({ error: "Token expired", action: "reconnect" });
    if (!r.ok) return res.status(502).json({ error: "QuickBooks error " + r.status });
    const data = await r.json().catch(() => ({}));
    const link = data && data.Invoice && data.Invoice.InvoiceLink;
    if (!link) return res.status(404).json({ error: "No pay link yet — enable online payments for this invoice in QuickBooks." });
    return res.status(200).json({ link });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Failed to fetch the pay link." });
  }
}
