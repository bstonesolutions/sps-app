// api/quickbooks/delete-invoice.js
// Deletes an invoice in QuickBooks. QB requires the invoice Id AND its current
// SyncToken, so we first read the invoice to get the token, then delete.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { access_token, realm_id, qb_id } = req.body;

  if (!access_token || !realm_id || !qb_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = {
    "Authorization": `Bearer ${access_token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
  };

  try {
    // Step 1: read the invoice to get its SyncToken
    const getRes = await fetch(`${base}/invoice/${qb_id}?minorversion=65`, { headers });
    if (getRes.status === 404) {
      // Already gone from QB — treat as success so the app can finish deleting locally
      return res.status(200).json({ success: true, alreadyGone: true });
    }
    if (!getRes.ok) {
      const err = await getRes.text();
      return res.status(500).json({ error: "Could not read invoice from QuickBooks.", details: err });
    }
    const got = await getRes.json();
    const syncToken = got?.Invoice?.SyncToken;
    if (syncToken == null) {
      return res.status(500).json({ error: "Invoice found but missing SyncToken." });
    }

    // Step 2: delete it (operation=delete with Id + SyncToken)
    const delRes = await fetch(`${base}/invoice?operation=delete&minorversion=65`, {
      method: "POST",
      headers,
      body: JSON.stringify({ Id: String(qb_id), SyncToken: String(syncToken) }),
    });

    if (!delRes.ok) {
      const err = await delRes.text();
      console.error("QB delete invoice error:", err);
      return res.status(500).json({ error: "QuickBooks rejected the delete.", details: err });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("QB delete invoice error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
