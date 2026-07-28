// api/quickbooks/create-invoice.js
// Creates an invoice in QuickBooks and returns a shareable payment link.
// Key principle: once the invoice is created in QB, that is a SUCCESS even if
// fetching the payment link later fails. We never report failure after creation.
import { makeItemResolver, lineTaxCodeRef } from "./qb-helpers.js";
import {
  fingerprintQuickBooksInvoiceContent,
  quickBooksInvoiceCreateRequestId,
} from "./invoice-revision.js";
import { mapQuickBooksInvoice } from "./invoice-mapper.js";
import { buildUsTxnTaxDetail } from "./qb-tax.js";
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Require an authenticated caller before any privileged QuickBooks work.
  const _u = await requireUser(req, res);
  if (!_u) return;

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
  let qbRequestId = null;
  let createWriteStarted = false;

  try {
    // ── Step 1: Find or create the customer ──
    let qbCustomerId = invoice.qbCustomerId;
    let qbCustomer = null;
    const clientAddress = {
      Line1: String(invoice.clientStreet || invoice.clientAddress || "").trim() || undefined,
      City: String(invoice.clientCity || "").trim() || undefined,
      CountrySubDivisionCode: String(invoice.clientState || "").trim() || undefined,
      PostalCode: String(invoice.clientZip || "").trim() || undefined,
    };
    const hasClientAddress = Object.values(clientAddress).some(Boolean);

    if (qbCustomerId) {
      try {
        const customerRes = await fetch(`${base}/customer/${encodeURIComponent(qbCustomerId)}?minorversion=65`, { headers });
        if (customerRes.ok) {
          const customerData = await customerRes.json();
          qbCustomer = customerData?.Customer || null;
        }
      } catch (_) {
        // A missing customer snapshot is only blocking when this invoice needs tax.
      }
    }

    if (!qbCustomerId && invoice.clientName) {
      const query = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${invoice.clientName.replace(/'/g, "\\'")}'`);
      const searchRes = await fetch(`${base}/query?query=${query}&minorversion=65`, { headers });
      const searchData = await searchRes.json();
      const existing = searchData?.QueryResponse?.Customer?.[0];

      if (existing) {
        qbCustomerId = existing.Id;
        qbCustomer = existing;
      } else {
        const createCustRes = await fetch(`${base}/customer?minorversion=65`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            DisplayName: invoice.clientName,
            PrimaryEmailAddr: invoice.clientEmail ? { Address: invoice.clientEmail } : undefined,
            PrimaryPhone: invoice.clientPhone ? { FreeFormNumber: invoice.clientPhone } : undefined,
            BillAddr: hasClientAddress ? clientAddress : undefined,
            ShipAddr: hasClientAddress ? clientAddress : undefined,
          }),
        });
        if (!createCustRes.ok) {
          // Capture the real QuickBooks fault instead of returning a generic 400.
          const custErr = await createCustRes.text();
          console.error("QB create customer error:", custErr);
          // A duplicate-name fault means the customer already exists — re-query and reuse it.
          if (/duplicate/i.test(custErr)) {
            const reqRes = await fetch(`${base}/query?query=${query}&minorversion=65`, { headers });
            const reqData = await reqRes.json().catch(() => null);
            qbCustomer = reqData?.QueryResponse?.Customer?.[0] || null;
            qbCustomerId = qbCustomer?.Id;
          }
          if (!qbCustomerId) {
            return res.status(400).json({
              error: "QuickBooks could not create the customer: " + readableQbError(custErr),
              details: custErr,
            });
          }
        } else {
          const custData = await createCustRes.json();
          qbCustomer = custData?.Customer || null;
          qbCustomerId = qbCustomer?.Id;
        }
      }
    }

    if (!qbCustomerId) {
      return res.status(400).json({ error: "Could not find or create the QuickBooks customer." });
    }

    // ── Step 2: Build the invoice payload ──
    const srcLines = invoice.lineItems || invoice.items || [];
    let taxPlan = buildUsTxnTaxDetail({
      sourceLines: srcLines,
      taxRate: invoice.taxRate,
      invoiceDiscountType: invoice.invoiceDiscountType,
      invoiceDiscount: invoice.invoiceDiscount,
      customer: qbCustomer,
      storedTaxCodeRef: invoice.qbTaxCodeRef,
    });
    if (taxPlan.status === "blocked") {
      return res.status(422).json({
        error: taxPlan.message,
        code: taxPlan.code,
        reviewRequired: true,
        expectedTax: taxPlan.totalTax,
      });
    }
    const resolveItemRef = makeItemResolver(base, headers);
    const lineItems = [];
    for (let i = 0; i < srcLines.length; i++) {
      const li = srcLines[i];
      const qty = parseFloat(li.qty) || 1;
      const unitPrice = parseFloat(li.unitPrice || li.rate) || 0;
      const amount = parseFloat(li.amount) || (qty * unitPrice);
      // Map each line to its real QuickBooks item based on the app's "kind".
      const suppliedItemRef = li.qbItemRef && String(li.qbItemRef.value || "").trim()
        ? { value: String(li.qbItemRef.value), ...(li.qbItemRef.name ? { name: li.qbItemRef.name } : {}) }
        : null;
      const itemRef = suppliedItemRef || await resolveItemRef(li.kind);
      const detail = { ItemRef: itemRef, Qty: qty, UnitPrice: unitPrice };
      // Always state line taxability. Explicit NON is required when tax is
      // disabled so an item's QuickBooks default cannot silently reapply tax.
      detail.TaxCodeRef = lineTaxCodeRef(taxPlan.taxRate > 0 && !!li.taxable);
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
      ShipAddr:     hasClientAddress ? clientAddress : undefined,
      // Online payment methods: ONLY override QuickBooks' account-level settings when the app
      // explicitly passes a boolean. Otherwise leave these undefined (dropped from the JSON request)
      // so QuickBooks shows every method enabled on the account — Card, ACH, PayPal, Venmo, Affirm.
      // Forcing them here restricts the invoice to card/ACH and silently drops the rest.
      AllowOnlineCreditCardPayment: typeof invoice.allowCard === "boolean" ? invoice.allowCard : undefined,
      AllowOnlineACHPayment: typeof invoice.allowACH === "boolean" ? invoice.allowACH : undefined,
    };

    if (taxPlan.txnTaxDetail) qbInvoice.TxnTaxDetail = taxPlan.txnTaxDetail;

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
    // Intuit strongly recommends a stable requestid for every write. If the
    // connection drops after QuickBooks stores the invoice, a retry with this
    // same id returns the original response instead of creating a duplicate.
    const requestKey = String(
      invoice.qbCreateRequestKey
      || invoice.spsInvoiceId
      || invoice.id
      || `${qbCustomerId}:${invoice.number || "auto"}`,
    );
    qbRequestId = quickBooksInvoiceCreateRequestId(realm_id, requestKey);
    // From this point forward, a thrown network/response error is ambiguous:
    // QuickBooks may have committed the invoice before the connection failed.
    // The stable request id lets a later retry recover that same create safely.
    createWriteStarted = true;
    const createRes = await fetch(
      `${base}/invoice?minorversion=65&requestid=${encodeURIComponent(qbRequestId)}`,
      {
      method: "POST",
      headers,
      body: JSON.stringify(qbInvoice),
      },
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error("QB create invoice error:", err);
      // Nothing was created — safe to report failure
      return res.status(500).json({ error: "QuickBooks rejected the invoice: " + readableQbError(err), details: err });
    }

    const created = await createRes.json();
    qbId = created?.Invoice?.Id;
    let paymentLink = created?.Invoice?.InvoiceLink || null;
    let canonicalInvoice = created?.Invoice || null;

    // ── Step 4 (best-effort): get the shareable payment link ──
    // From here on, the invoice EXISTS. Any failure below still returns success
    // with the QBO web link so the app stays in sync with QuickBooks.
    if (qbId) {
      try {
        // Re-fetch the canonical stored invoice. Besides the share link, this
        // gives SPS a revision fingerprint for safe future full updates.
        const getRes = await fetch(`${base}/invoice/${qbId}?minorversion=65`, { headers });
        if (getRes.ok) {
          const got = await getRes.json();
          canonicalInvoice = got?.Invoice || canonicalInvoice;
          paymentLink = canonicalInvoice?.InvoiceLink || paymentLink;
        }
      } catch (linkErr) {
        console.error("QB payment link fetch failed (invoice still created):", linkErr.message);
      }
    }

    return res.status(200).json({
      qbId,
      paymentLink: paymentLink || webLink(qbId),
      qbContentFingerprint: canonicalInvoice?.Line
        ? fingerprintQuickBooksInvoiceContent(canonicalInvoice)
        : null,
      invoice: canonicalInvoice?.Line ? mapQuickBooksInvoice(canonicalInvoice) : null,
      qbRequestId,
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
    if (createWriteStarted) {
      return res.status(502).json({
        error: "QuickBooks may have created this invoice, but the response could not be confirmed. Retry the same invoice to recover it safely.",
        createOutcomeUnknown: true,
        qbRequestId,
      });
    }
    return res.status(500).json({ error: err.message });
  }
}
