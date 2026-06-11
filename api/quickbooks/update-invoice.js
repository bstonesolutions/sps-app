// api/quickbooks/update-invoice.js
// Updates invoice status in QuickBooks (void, paid, etc.)
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { access_token, realm_id, qbId, action } = req.body;

  if (!access_token || !realm_id || !qbId || !action) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = {
    "Authorization": `Bearer ${access_token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };

  try {
    // First fetch the invoice to get SyncToken (required for updates)
    const fetchRes = await fetch(`${base}/invoice/${qbId}?minorversion=65`, { headers });
    if (!fetchRes.ok) {
      return res.status(404).json({ error: "Invoice not found in QuickBooks" });
    }
    const fetchData = await fetchRes.json();
    const inv = fetchData?.Invoice;
    if (!inv) return res.status(404).json({ error: "Invoice not found" });

    if (action === "void") {
      // Void the invoice
      const voidRes = await fetch(`${base}/invoice?operation=void&minorversion=65`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Id: qbId, SyncToken: inv.SyncToken }),
      });
      if (!voidRes.ok) throw new Error("Failed to void invoice");
      return res.status(200).json({ success: true, action: "voided" });
    }

    if (action === "delete") {
      const delRes = await fetch(`${base}/invoice?operation=delete&minorversion=65`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Id: qbId, SyncToken: inv.SyncToken }),
      });
      if (!delRes.ok) throw new Error("Failed to delete invoice");
      return res.status(200).json({ success: true, action: "deleted" });
    }

    res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    console.error("QB update invoice error:", err);
    res.status(500).json({ error: err.message });
  }
}
