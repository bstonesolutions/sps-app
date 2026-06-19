// api/quickbooks/sync.js
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
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
    return res.status(401).json({ error: 'Not connected to QuickBooks', reconnect: true });
  }

  const base = `${QB_API_BASE}/v3/company/${realm_id}`;
  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Accept':        'application/json',
  };

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
      return res.status(401).json({ error: 'Token expired', action: 'reconnect' });
    }
    if (!invoiceRes.ok || !customerRes.ok) {
      throw new Error('QB API error ' + invoiceRes.status);
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

    // Reverse-map a QuickBooks item name back to the app's line "kind".
    const itemNameToKind = (name) => {
      if (name === 'Product Sales') return 'product';
      if (name === 'Materials')     return 'part';
      if (name === 'Services')      return 'service';
      return 'custom';
    };
    const isTaxableCode = (ref) => !!(ref?.value && ref.value !== 'NON' && ref.value !== '0');

    const isLateFeeLine = (l, d) => /late\s*fee/i.test(l.Description || '') || /late\s*fee/i.test(d?.ItemRef?.name || '');
    const todayISO = new Date().toISOString().slice(0, 10);

    const mappedInvoices = invoices.map(inv => {
      const salesLines = (inv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');
      let hasLateFee = false;
      // Editable line items so the invoice can be opened, changed, and re-synced.
      const lineItems = salesLines.map((l, i) => {
        const d = l.SalesItemLineDetail || {};
        const taxable = isTaxableCode(d.TaxCodeRef);
        const lateFee = isLateFeeLine(l, d);
        if (lateFee) hasLateFee = true;
        return {
          id:        `qbl_${inv.Id}_${i}`,
          desc:      l.Description || d.ItemRef?.name || 'Service',
          qty:       String(d.Qty != null ? d.Qty : 1),
          unitPrice: String(d.UnitPrice != null ? d.UnitPrice : (l.Amount || 0)),
          taxable,
          kind:      lateFee ? 'lateFee' : itemNameToKind(d.ItemRef?.name),
          isLateFee: lateFee,
        };
      });
      // Derive a tax rate from QB's tax detail so app-side totals match.
      const totalTax    = parseFloat(inv.TxnTaxDetail?.TotalTax) || 0;
      const taxableBase = salesLines.reduce((s, l) => s + (isTaxableCode(l.SalesItemLineDetail?.TaxCodeRef) ? (parseFloat(l.Amount) || 0) : 0), 0);
      const taxRate     = (taxableBase > 0 && totalTax > 0) ? Number(((totalTax / taxableBase) * 100).toFixed(4)) : 0;
      return {
        qbId:         inv.Id,
        number:       inv.DocNumber || inv.Id,
        clientName:   inv.CustomerRef?.name  || '',
        qbCustomerId: inv.CustomerRef?.value || '',
        date:         inv.TxnDate,
        dueDate:      inv.DueDate,
        total:        inv.TotalAmt,
        taxAmount:    totalTax,                                   // QB's authoritative sales tax (TxnTaxDetail.TotalTax)
        subTotal:     (parseFloat(inv.TotalAmt) || 0) - totalTax, // QB Invoice has no SubTotal field — derive
        balance:      inv.Balance,
        taxRate,
        source:       'quickbooks',
        // Build 15, Item 3 — richer reporting straight from QuickBooks. NOTE: "viewed" is
        // intentionally absent — QB does NOT expose invoice opens via its API (UI-only), so
        // the app marks viewed "Not tracked via QuickBooks" rather than implying not-viewed.
        qbEmailStatus:  inv.EmailStatus || 'NotSet',          // NotSet | NeedToSend | EmailSent
        sentDate:       inv.DeliveryInfo?.DeliveryTime ? String(inv.DeliveryInfo.DeliveryTime).slice(0, 10) : null,
        qbDeliveryType: inv.DeliveryInfo?.DeliveryType || null,
        paidDate:       paidDateByInvoice[inv.Id] || null,
        partial:        (parseFloat(inv.Balance) > 0 && parseFloat(inv.Balance) < parseFloat(inv.TotalAmt)),
        // Flag so the app's auto-apply logic won't add a second late fee.
        ...(hasLateFee ? { lateFeeAppliedAt: todayISO } : {}),
        // LOW#3: only treat an unpaid invoice as Overdue when DueDate is present AND a
        // valid date. A missing/invalid DueDate yields an Invalid Date whose comparison is
        // always false, which would silently mislabel it 'Sent' — so fall back instead.
        status:       inv.Balance <= 0 ? 'Paid'
                      : (inv.DueDate && !isNaN(new Date(inv.DueDate).getTime()) && new Date(inv.DueDate) < new Date()) ? 'Overdue'
                      : 'Sent',
        lineItems,
        // Keep the legacy read-only shape too, for any display that used it.
        lines: salesLines.map(l => ({
          description: l.Description || l.SalesItemLineDetail?.ItemRef?.name || 'Service',
          qty:         l.SalesItemLineDetail?.Qty       || 1,
          rate:        l.SalesItemLineDetail?.UnitPrice || 0,
          amount:      l.Amount || 0,
        })),
      };
    });

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
