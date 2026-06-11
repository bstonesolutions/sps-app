// api/quickbooks/create-invoice.js
// Creates an invoice in QuickBooks and returns the payment link
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { access_token, realm_id, invoice } = req.body;

  if (!access_token || !realm_id || !invoice) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = {
    "Authorization": `Bearer ${access_token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };

  try {
    // Step 1: Find or create the customer in QB
    let qbCustomerId = invoice.qbCustomerId;

    if (!qbCustomerId && invoice.clientName) {
      // Search for existing customer by name
      const query = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${invoice.clientName.replace(/'/g, "\\'")}'`);
      const searchRes = await fetch(`${base}/query?query=${query}&minorversion=65`, { headers });
      const searchData = await searchRes.json();
      const existing = searchData?.QueryResponse?.Customer?.[0];

      if (existing) {
        qbCustomerId = existing.Id;
      } else {
        // Create new customer
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
      return res.status(400).json({ error: "Could not find or create QB customer" });
    }

    // Step 2: Build QB invoice payload
    const lineItems = (invoice.lineItems || invoice.items || []).map((li, i) => ({
      Id:         String(i + 1),
      LineNum:    i + 1,
      Amount:     parseFloat(li.amount || (parseFloat(li.qty || 1) * parseFloat(li.unitPrice || li.rate || 0))) || 0,
      DetailType: "SalesItemLineDetail",
      Description: li.description || li.name || "Service",
      SalesItemLineDetail: {
        ItemRef:   { value: "1", name: "Services" }, // Default service item
        Qty:       parseFloat(li.qty) || 1,
        UnitPrice: parseFloat(li.unitPrice || li.rate) || 0,
      },
    }));

    const qbInvoice = {
      CustomerRef:  { value: qbCustomerId },
      DocNumber:    invoice.number,
      TxnDate:      invoice.date || new Date().toISOString().split("T")[0],
      DueDate:      invoice.dueDate,
      Line:         lineItems,
      BillEmail:    invoice.clientEmail ? { Address: invoice.clientEmail } : undefined,
      EmailStatus:  "NeedToSend",
    };

    // Apply an invoice-level discount if present (QB DiscountLineDetail)
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

    // Step 3: Create invoice in QB
    const createRes = await fetch(`${base}/invoice?minorversion=65`, {
      method: "POST",
      headers,
      body: JSON.stringify(qbInvoice),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error("QB create invoice error:", err);
      return res.status(500).json({ error: "Failed to create QB invoice", details: err });
    }

    const created = await createRes.json();
    const qbId = created?.Invoice?.Id;
    const invoiceLink = created?.Invoice?.InvoiceLink;

    // Step 4: Get payment link if not returned directly
    let paymentLink = invoiceLink;
    if (!paymentLink && qbId) {
      // Try to send invoice to get payment link
      const sendRes = await fetch(`${base}/invoice/${qbId}/send?sendTo=${encodeURIComponent(invoice.clientEmail || "")}`, {
        method: "POST",
        headers,
      });
      if (sendRes.ok) {
        const sent = await sendRes.json();
        paymentLink = sent?.Invoice?.InvoiceLink;
      }
    }

    res.status(200).json({
      qbId,
      paymentLink: paymentLink || `https://app.qbo.intuit.com/app/invoice?txnId=${qbId}`,
      success: true,
    });

  } catch (err) {
    console.error("QB create invoice error:", err);
    res.status(500).json({ error: err.message });
  }
}
