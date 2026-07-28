// api/quickbooks/sync.js
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { mapQuickBooksInvoice } from "./invoice-mapper.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  // Caller-auth gate: this endpoint returns ALL invoices + customers (sensitive).
  // OPTIONS preflight is handled above and stays open. There is no GET "?check"/health
  // branch here, so gate immediately before any privileged QuickBooks work.
  const _u = await requireUser(req, res);
  if (!_u) return;

  // Tokens are read server-side from the store (never passed by the client).
  let access_token, realm_id;
  try {
    ({ access_token, realm_id } = await getValidAccessToken());
  } catch (e) {
    // Surface WHY (e.g. "refresh_failed" = token expired + refresh rejected by Intuit, vs "not_connected"
    // = no usable token). Without this the UI just says "Load failed" and the real cause is invisible.
    console.error("QB sync getValidAccessToken failed:", (e && e.message) || e);
    return res.status(401).json({ error: 'Not connected to QuickBooks', reason: (e && e.message) || String(e), reconnect: true });
  }

  const base = `${QB_API_BASE}/v3/company/${realm_id}`;
  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Accept':        'application/json',
  };

  // On-demand single-invoice pay link (folded in here rather than its own /api file, to avoid
  // adding another Vercel Serverless Function). Client portal calls /api/quickbooks/sync?invoiceLink=<id>
  // when a client taps "Pay now" on a QB-created invoice that has no stored paymentLink.
  // include=invoiceLink → Invoice.InvoiceLink (QB's hosted pay page; needs online payments enabled).
  if (req.query && req.query.invoiceLink) {
    const rawId = String(req.query.invoiceLink).replace(/^qb_/, "");
    try {
      const lr = await fetch(`${base}/invoice/${encodeURIComponent(rawId)}?include=invoiceLink&minorversion=65`, { headers });
      if (lr.status === 401) return res.status(401).json({ error: 'Token expired', action: 'reconnect' });
      if (!lr.ok) return res.status(502).json({ error: 'QuickBooks error ' + lr.status });
      const ld = await lr.json().catch(() => ({}));
      const link = ld && ld.Invoice && ld.Invoice.InvoiceLink;
      if (!link) return res.status(404).json({ error: 'No pay link yet — enable online payments for this invoice in QuickBooks.' });
      return res.status(200).json({ link });
    } catch (e) {
      return res.status(500).json({ error: (e && e.message) || 'Failed to fetch the pay link.' });
    }
  }

  try {
    const invoiceQuery = encodeURIComponent(
      "SELECT * FROM Invoice ORDER BY MetaData.LastUpdatedTime DESC MAXRESULTS 1000"
    );
    const customerQuery = encodeURIComponent(
      "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000"
    );
    // Build 15, Item 3 — pull Payments too so we can report the real DATE PAID per invoice.
    // QB's LinkedTxn on the invoice only references the payment; the date lives on Payment.
    const paymentQuery = encodeURIComponent(
      "SELECT * FROM Payment ORDER BY MetaData.LastUpdatedTime DESC MAXRESULTS 1000"
    );

    const [invoiceRes, customerRes, paymentRes] = await Promise.all([
      fetch(`${base}/query?query=${invoiceQuery}&minorversion=65`, { headers }),
      fetch(`${base}/query?query=${customerQuery}&minorversion=65`, { headers }),
      fetch(`${base}/query?query=${paymentQuery}&minorversion=65`, { headers }),
    ]);

    if (invoiceRes.status === 401) {
      const body401 = await invoiceRes.text().catch(() => "");
      console.error("QB sync 401 from QuickBooks API:", body401);
      return res.status(401).json({ error: 'Token expired', action: 'reconnect', detail: body401.slice(0, 400) });
    }
    if (!invoiceRes.ok || !customerRes.ok) {
      const bad = invoiceRes.ok ? customerRes : invoiceRes;
      const errBody = await bad.text().catch(() => "");
      console.error("QB sync API error:", "invoice", invoiceRes.status, "customer", customerRes.status, errBody);
      throw new Error('QB API error (invoice ' + invoiceRes.status + ', customer ' + customerRes.status + ')' + (errBody ? ': ' + errBody.slice(0, 300) : ''));
    }

    const invoiceData  = await invoiceRes.json();
    const customerData = await customerRes.json();

    const invoices  = invoiceData?.QueryResponse?.Invoice   || [];
    const customers = customerData?.QueryResponse?.Customer || [];
    // Map invoice id -> most recent payment date applied to it (Item 3). Payments are
    // supplementary: if the query failed (e.g. scope), date-paid is simply omitted.
    const paymentData = (paymentRes && paymentRes.ok) ? await paymentRes.json().catch(() => ({})) : {};
    const paidDateByInvoice = {};
    for (const pm of (paymentData?.QueryResponse?.Payment || [])) {
      const when = pm.TxnDate || String(pm.MetaData?.CreateTime || "").slice(0, 10);
      for (const line of (pm.Line || [])) {
        for (const lt of (line.LinkedTxn || [])) {
          if (lt.TxnType === "Invoice" && lt.TxnId && when && (!paidDateByInvoice[lt.TxnId] || when > paidDateByInvoice[lt.TxnId])) {
            paidDateByInvoice[lt.TxnId] = when;
          }
        }
      }
    }

    const todayISO = new Date().toISOString().slice(0, 10);

    const mappedInvoices = invoices.map(inv => mapQuickBooksInvoice(inv, {
      ...(paidDateByInvoice[inv.Id] ? { paidDate: paidDateByInvoice[inv.Id] } : {}),
      todayISO,
    }));

    const mappedCustomers = customers.map(c => ({
      qbId:    c.Id,
      name:    c.DisplayName || c.FullyQualifiedName,
      email:   c.PrimaryEmailAddr?.Address          || '',
      phone:   c.PrimaryPhone?.FreeFormNumber        || '',
      address: c.BillAddr
        ? [c.BillAddr.Line1, c.BillAddr.City, c.BillAddr.CountrySubDivisionCode]
            .filter(Boolean).join(', ')
        : '',
      balance: c.Balance || 0,
    }));

    res.status(200).json({
      invoices:  mappedInvoices,
      customers: mappedCustomers,
      realmId:   realm_id,
    });

  } catch (err) {
    console.error('QB sync error:', err);
    res.status(500).json({ error: 'Failed to fetch from QuickBooks: ' + err.message });
  }
}
