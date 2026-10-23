// api/quickbooks/record-payment.js
// Records a manual payment (cash / check / card / other) against an invoice in
// QuickBooks: links it to the invoice, sets the deposit-to account, the payment
// method, and a reference (e.g. check #). The app never moves money — this only
// writes the payment record so QuickBooks reflects how + where it was paid.
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { requireCapability } from "../_staff-auth.js";
import { confirmedQuickBooksWriteResponse } from "../_quickbooks-invoice-write-receipt.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { qbId, amount, method, reference, txnDate, depositAccountId } = req.body || {};
  if (!qbId) return res.status(400).json({ error: "Missing qbId" });
  const amt = Number(amount) || 0;
  if (amt <= 0) return res.status(400).json({ error: "Amount must be greater than zero" });

  const _u = await requireCapability(req, res, "invoiceMarkPaid", "recording invoice payments");
  if (!_u) return;

  let access_token, realm_id;
  let paymentWriteStarted = false;
  let paymentConfirmed = false;
  let paymentId = null;
  try {
    ({ access_token, realm_id } = await getValidAccessToken());
  } catch (e) {
    return res.status(401).json({ error: "Not connected to QuickBooks", reconnect: true });
  }

  const base = `${QB_API_BASE}/v3/company/${realm_id}`;
  const headers = { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json", "Accept": "application/json" };
  const readErr = (txt) => {
    try { const e = JSON.parse(txt)?.Fault?.Error?.[0]; if (e) return [e.Message, e.Detail].filter(Boolean).join(" — "); } catch (_) {}
    return txt ? String(txt).slice(0, 300) : "unknown error";
  };

  try {
    // Read the invoice to get its CustomerRef (a payment must reference the customer).
    const invRes = await fetch(`${base}/invoice/${qbId}?minorversion=65`, { headers });
    if (!invRes.ok) {
      const t = await invRes.text();
      return res.status(invRes.status === 404 ? 404 : 500).json({ error: "Couldn't read the invoice in QuickBooks: " + readErr(t) });
    }
    const inv = (await invRes.json())?.Invoice;
    if (!inv || !inv.CustomerRef) return res.status(500).json({ error: "Invoice has no customer in QuickBooks." });

    // Guard against over-applying: a stale UI total must not exceed the live balance due, or QB
    // records an overpayment/credit. Reject with the real balance so the app can correct itself.
    const balanceDue = Number(inv.Balance);
    if (Number.isFinite(balanceDue) && amt > balanceDue + 0.005) {
      return res.status(400).json({ error: `Amount ($${amt.toFixed(2)}) exceeds the balance due ($${balanceDue.toFixed(2)}).`, balanceDue });
    }

    // Resolve the QB PaymentMethod id by name (optional — payment records without it).
    let paymentMethodRef = null;
    const pmName = ({ "Manual Card": "Credit Card", "Card": "Credit Card" }[method]) || method;
    if (pmName && pmName !== "Other") {
      try {
        const pmQ = encodeURIComponent(`SELECT Id, Name FROM PaymentMethod WHERE Name = '${String(pmName).replace(/'/g, "\\'")}'`);
        const pmRes = await fetch(`${base}/query?query=${pmQ}&minorversion=65`, { headers });
        const pm = (await pmRes.json().catch(() => ({})))?.QueryResponse?.PaymentMethod?.[0];
        if (pm) paymentMethodRef = { value: pm.Id };
      } catch (_) { /* optional */ }
    }

    const payment = {
      CustomerRef: inv.CustomerRef,
      TotalAmt: amt,
      ...(txnDate ? { TxnDate: txnDate } : {}),
      Line: [{ Amount: amt, LinkedTxn: [{ TxnId: String(qbId), TxnType: "Invoice" }] }],
      ...(depositAccountId ? { DepositToAccountRef: { value: String(depositAccountId) } } : {}),
      ...(paymentMethodRef ? { PaymentMethodRef: paymentMethodRef } : {}),
      ...(reference ? { PaymentRefNum: String(reference).slice(0, 21) } : {}),
    };

    paymentWriteStarted = true;
    const payRes = await fetch(`${base}/payment?minorversion=65`, { method: "POST", headers, body: JSON.stringify(payment) });
    if (!payRes.ok) {
      const t = await payRes.text();
      const knownRejected = payRes.status >= 400 && payRes.status < 500 && payRes.status !== 408;
      return res.status(knownRejected ? 422 : 502).json({ error: knownRejected ? "QuickBooks rejected the payment: " + readErr(t)
        : "The payment result could not be confirmed. Check QuickBooks before retrying so it is not recorded twice.",
        ...(!knownRejected ? { paymentOutcomeUnknown: true } : {}) });
    }
    paymentConfirmed = true;
    const result = await payRes.json().catch(() => ({}));
    paymentId = result?.Payment?.Id || null;
    let canonicalInvoice = null;
    try {
      const current = await fetch(`${base}/invoice/${encodeURIComponent(qbId)}?minorversion=65`, { headers });
      if (current.ok) canonicalInvoice = (await current.json())?.Invoice || null;
    } catch (_) { /* The payment already succeeded. The next refresh recovers its balance. */ }
    const appReceipt = await confirmedQuickBooksWriteResponse({ quickBooksInvoice: canonicalInvoice, expectedQuickBooksId: qbId,
      invoiceId: req.body?.spsInvoiceId, actorId: _u.id, action: "quickbooks-payment", realmId: realm_id });
    return res.status(200).json({ success: true, paymentId, ...appReceipt });
  } catch (err) {
    if (paymentConfirmed) return res.status(200).json({ success: true, paymentId, appSyncPending: true,
      warning: "QuickBooks recorded the payment. Refresh SPS to update the balance; do not record the payment again." });
    if (paymentWriteStarted) return res.status(502).json({ error: "The payment result could not be confirmed. Check QuickBooks before retrying so it is not recorded twice.", paymentOutcomeUnknown: true });
    return res.status(500).json({ error: err.message || "Failed to record payment" });
  }
}
