// api/quickbooks/update-invoice.js
// Updates an existing QuickBooks invoice's content (line items, dates, discount).
// Requires the invoice's current SyncToken, which we fetch first.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { access_token, realm_id, invoice } = req.body;

  if (!access_token || !realm_id || !invoice || !invoice.qbId) {
    return res.status(400).json({ error: "Missing required fields (need invoice.qbId)" });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = {
    "Authorization": `Bearer ${access_token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };
  const webLink = (id) => `https://app.qbo.intuit.com/app/invoice?txnId=${id}`;

  try {
    // Step 1: read current invoice for SyncToken + CustomerRef
    const getRes = await fetch(`${base}/invoice/${invoice.qbId}?minorversion=65`, { headers });
    if (getRes.status === 404) {
      // The invoice no longer exists in QB — recreate it instead
      return res.status(200).json({ recreate: true });
    }
    if (!getRes.ok) {
      const err = await getRes.text();
      return res.status(500).json({ error: "Could not read invoice from QuickBooks.", details: err });
    }
    const got = await getRes.json();
    const existing = got?.Invoice;
    if (!existing) return res.status(404).json({ error: "Invoice not found in QuickBooks." });

    // Step 2: build updated line items
    const lineItems = (invoice.lineItems || []).map((li, i) => {
      const qty = parseFloat(li.qty) || 1;
      const unitPrice = parseFloat(li.unitPrice) || 0;
      return {
        Id:          String(i + 1),
        LineNum:     i + 1,
        Amount:      qty * unitPrice,
        DetailType:  "SalesItemLineDetail",
        Description: li.description || "Service",
        SalesItemLineDetail: { ItemRef: { value: "1", name: "Services" }, Qty: qty, UnitPrice: unitPrice },
      };
    });

    if (invoice.invoiceDiscount && parseFloat(invoice.invoiceDiscount) > 0) {
      const isPct = invoice.invoiceDiscountType === "pct";
      lineItems.push({
        DetailType: "DiscountLineDetail",
        Amount: isPct ? undefined : parseFloat(invoice.invoiceDiscount),
        DiscountLineDetail: isPct ? { PercentBased: true, DiscountPercent: parseFloat(invoice.invoiceDiscount) } : { PercentBased: false },
      });
    }

    const updated = {
      Id:           String(invoice.qbId),
      SyncToken:    String(existing.SyncToken),
      sparse:       false,
      CustomerRef:  existing.CustomerRef,
      DocNumber:    invoice.number || existing.DocNumber,
      TxnDate:      invoice.date || existing.TxnDate,
      DueDate:      invoice.dueDate || existing.DueDate,
      Line:         lineItems,
      BillEmail:    invoice.clientEmail ? { Address: invoice.clientEmail } : existing.BillEmail,
      AllowOnlineCreditCardPayment: true,
      AllowOnlineACHPayment: true,
    };

    const updRes = await fetch(`${base}/invoice?minorversion=65`, {
      method: "POST",
      headers,
      body: JSON.stringify(updated),
    });

    if (!updRes.ok) {
      const err = await updRes.text();
      console.error("QB update invoice error:", err);
      return res.status(500).json({ error: "QuickBooks rejected the update.", details: err });
    }

    const result = await updRes.json();
    const qbId = result?.Invoice?.Id || invoice.qbId;
    const paymentLink = result?.Invoice?.InvoiceLink || webLink(qbId);

    return res.status(200).json({ qbId, paymentLink, success: true });

  } catch (err) {
    console.error("QB update invoice error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
