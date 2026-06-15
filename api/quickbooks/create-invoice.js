// api/quickbooks/create-invoice.js
// Creates an invoice in QuickBooks and returns a shareable payment link.
// Key principle: once the invoice is created in QB, that is a SUCCESS even if
// fetching the payment link later fails. We never report failure after creation.
import { makeItemResolver, lineTaxCodeRef } from "./qb-helpers.js";
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { invoice } = req.body;
  if (!invoice) {
    return res.status(400).json({ error: "Missing invoice" });
  }

  // Tokens are read server-side from the store (never passed by the client).
  let access_token, realm_id;
  try {
    ({ access_token, realm_id } = await getValidAccessToken());
  } catch (e) {
    return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true });
  }

  const base = `${QB_API_BASE}/v3/company/${realm_id}`;
  const headers = {
    "Authorization": `Bearer ${access_token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };

  // Helper: build the QBO web link for an invoice (always works as a fallback)
  const webLink = (qbId) => `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`;
  // Pull a human-readable reason out of a QuickBooks fault response.
  const readableQbError = (txt) => {
    try {
      const e = JSON.parse(txt)?.Fault?.Error?.[0];
      if (e) return [e.Message, e.Detail].filter(Boolean).join(" — ");
    } catch (_) {}
    return txt ? String(txt).slice(0, 300) : "unknown error";
  };

  let qbId = null;

  try {
    // ── Step 1: Find or create the customer ──
    let qbCustomerId = invoice.qbCustomerId;

    if (!qbCustomerId && invoice.clientName) {
      const query = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${invoice.clientName.replace(/'/g, "\\'")}'`);
      const searchRes = await fetch(`${base}/query?query=${query}&minorversion=65`, { headers });
      const searchData = await searchRes.json();
      const existing = searchData?.QueryResponse?.Customer?.[0];

      if (existing) {
        qbCustomerId = existing.Id;
      } else {
        const createCustRes = await fetch(`${base}/customer?minorversion=65`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            DisplayName: invoice.clientName,
            PrimaryEmailAddr: invoice.clientEmail ? { Address: invoice.clientEmail } : undefined,
            PrimaryPhone: invoice.clientPhone ? { FreeFormNumber: invoice.clientPhone } : undefined,
          }),
        });
        const custData = await createCustRes.json();
        qbCustomerId = custData?.Customer?.Id;
      }
    }

    if (!qbCustomerId) {
      return res.status(400).json({ error: "Could not find or create the QuickBooks customer." });
    }

    // ── Step 2: Build the invoice payload ──
    const resolveItemRef = makeItemResolver(base, headers);
    const taxRate = parseFloat(invoice.taxRate) || 0;
    const srcLines = invoice.lineItems || invoice.items || [];
    const lineItems = [];
    for (let i = 0; i < srcLines.length; i++) {
      const li = srcLines[i];
      const qty = parseFloat(li.qty) || 1;
      const unitPrice = parseFloat(li.unitPrice || li.rate) || 0;
      const amount = parseFloat(li.amount) || (qty * unitPrice);
      // Map each line to its real QuickBooks item based on the app's "kind".
      const itemRef = await resolveItemRef(li.kind);
      const detail = { ItemRef: itemRef, Qty: qty, UnitPrice: unitPrice };
      // Mark taxability so QuickBooks applies sales tax to the right lines.
      if (taxRate > 0) detail.TaxCodeRef = lineTaxCodeRef(!!li.taxable);
      lineItems.push({
        LineNum:     i + 1,
        Amount:      amount,
        DetailType:  "SalesItemLineDetail",
        Description: li.description || li.name || "Service",
        SalesItemLineDetail: detail,
      });
    }

    const qbInvoice = {
      CustomerRef:  { value: qbCustomerId },
      DocNumber:    invoice.number,
      TxnDate:      invoice.date || new Date().toISOString().split("T")[0],
      DueDate:      invoice.dueDate || undefined,
      Line:         lineItems,
      BillEmail:    invoice.clientEmail ? { Address: invoice.clientEmail } : undefined,
      // Online payment methods offered on the pay link — controlled in app settings (default on).
      AllowOnlineCreditCardPayment: invoice.allowCard !== false,
      AllowOnlineACHPayment: invoice.allowACH !== false,
    };

    // Invoice-level discount
    if (invoice.invoiceDiscount && parseFloat(invoice.invoiceDiscount) > 0) {
      const isPct = invoice.invoiceDiscountType === "pct";
      qbInvoice.Line.push({
        DetailType: "DiscountLineDetail",
        Amount: isPct ? undefined : parseFloat(invoice.invoiceDiscount),
        DiscountLineDetail: isPct
          ? { PercentBased: true, DiscountPercent: parseFloat(invoice.invoiceDiscount) }
          : { PercentBased: false },
      });
    }

    // ── Step 3: Create the invoice ──
    const createRes = await fetch(`${base}/invoice?minorversion=65`, {
      method: "POST",
      headers,
      body: JSON.stringify(qbInvoice),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error("QB create invoice error:", err);
      // Nothing was created — safe to report failure
      return res.status(500).json({ error: "QuickBooks rejected the invoice: " + readableQbError(err), details: err });
    }

    const created = await createRes.json();
    qbId = created?.Invoice?.Id;
    let paymentLink = created?.Invoice?.InvoiceLink || null;

    // ── Step 4 (best-effort): get the shareable payment link ──
    // From here on, the invoice EXISTS. Any failure below still returns success
    // with the QBO web link so the app stays in sync with QuickBooks.
    if (!paymentLink && qbId) {
      try {
        // Re-fetch the invoice asking for the sharable link
        const getRes = await fetch(`${base}/invoice/${qbId}?minorversion=65`, { headers });
        if (getRes.ok) {
          const got = await getRes.json();
          paymentLink = got?.Invoice?.InvoiceLink || null;
        }
      } catch (linkErr) {
        console.error("QB payment link fetch failed (invoice still created):", linkErr.message);
      }
    }

    return res.status(200).json({
      qbId,
      paymentLink: paymentLink || webLink(qbId),
      hasOnlineLink: !!paymentLink,
      success: true,
    });

  } catch (err) {
    console.error("QB create invoice error:", err.message);
    // If the invoice was already created before the error, report SUCCESS so the
    // app doesn't think it failed and try again (which would duplicate it in QB).
    if (qbId) {
      return res.status(200).json({
        qbId,
        paymentLink: webLink(qbId),
        hasOnlineLink: false,
        success: true,
        warning: "Invoice created, but the payment link could not be confirmed.",
      });
    }
    return res.status(500).json({ error: err.message });
  }
}
