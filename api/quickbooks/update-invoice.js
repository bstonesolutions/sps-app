// api/quickbooks/update-invoice.js
// Updates an existing QuickBooks invoice's content (line items, dates, discount).
// Requires the invoice's current SyncToken, which we fetch first.
import { makeItemResolver, lineTaxCodeRef } from "./qb-helpers.js";
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import {
  fingerprintQuickBooksInvoiceContent,
  normalizeQuickBooksInvoiceContent,
  quickBooksBaseFingerprint,
} from "./invoice-revision.js";
import {
  isGeneratedQuickBooksSubtotalLine,
  mapQuickBooksInvoice,
} from "./invoice-mapper.js";
import { buildUsTxnTaxDetail } from "./qb-tax.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const _u = await requireUser(req, res);
  if (!_u) return;

  const { invoice } = req.body;
  if (!invoice || !invoice.qbId) {
    return res.status(400).json({ error: "Missing required fields (need invoice.qbId)" });
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
  const webLink = (id) => `https://app.qbo.intuit.com/app/invoice?txnId=${id}`;
  const todayISO = () => new Date().toISOString().slice(0, 10);
  // QuickBooks "Object Not Found" / unmatched-invoice errors — recreate fresh instead of failing.
  const isNotFound = (txt) => /object not found|"code"\s*:\s*"?610"?|could not be found|does not exist|not found/i.test(txt || "");
  // Pull a human-readable reason out of a QuickBooks fault response.
  const readableQbError = (txt) => {
    try {
      const e = JSON.parse(txt)?.Fault?.Error?.[0];
      if (e) return [e.Message, e.Detail].filter(Boolean).join(" — ");
    } catch (_) {}
    return txt ? String(txt).slice(0, 300) : "unknown error";
  };

  try {
    // Step 1: read current invoice for SyncToken + CustomerRef
    const getRes = await fetch(`${base}/invoice/${invoice.qbId}?minorversion=65`, { headers });
    if (getRes.status === 404) {
      // The invoice no longer exists in QB — recreate it instead
      return res.status(200).json({ recreate: true });
    }
    if (!getRes.ok) {
      const err = await getRes.text();
      // Invoice is gone or unmatched — recreate it fresh rather than failing.
      if (isNotFound(err)) {
        return res.status(200).json({ recreate: true });
      }
      return res.status(500).json({ error: "Could not read invoice from QuickBooks.", details: err });
    }
    const got = await getRes.json();
    const existing = got?.Invoice;
    if (!existing) return res.status(404).json({ error: "Invoice not found in QuickBooks." });

    // Optimistic concurrency guard: SyncToken alone is too broad (payments and
    // delivery can change it) while blindly accepting the newest SyncToken makes
    // the full Line replacement below erase edits made directly in QuickBooks.
    // The app must send the content fingerprint from its last QB sync. If the
    // current customer-facing invoice differs, stop before resolving items or
    // issuing any write and let the user review the fresh QB version.
    const baseFingerprint = quickBooksBaseFingerprint(invoice);
    const currentSnapshot = normalizeQuickBooksInvoiceContent(existing);
    const currentFingerprint = fingerprintQuickBooksInvoiceContent(existing);
    if (!baseFingerprint || baseFingerprint !== currentFingerprint) {
      return res.status(409).json({
        error: baseFingerprint
          ? "This invoice changed in QuickBooks after SPS last synced it. Review the QuickBooks version before saving."
          : "Sync this invoice from QuickBooks before saving so SPS can protect changes made there.",
        code: baseFingerprint ? "quickbooks_invoice_changed" : "quickbooks_invoice_sync_required",
        reviewRequired: true,
        currentFingerprint,
        currentInvoice: currentSnapshot,
      });
    }

    // SPS can faithfully edit sales lines and one invoice-level discount. Stop
    // before writing if QuickBooks contains grouped, subtotal, description, or
    // multiple discount lines that this editor cannot represent. Replacing Line
    // without this guard would silently delete those QuickBooks-only details.
    const existingLines = Array.isArray(existing.Line) ? existing.Line : [];
    const unsupportedLineTypes = existingLines
      .filter((line, index) => (
        !["SalesItemLineDetail", "DiscountLineDetail"].includes(line.DetailType)
        && !isGeneratedQuickBooksSubtotalLine(line, index, existingLines)
      ))
      .map((line) => line.DetailType || "Unknown");
    const discountLineCount = existingLines.filter(
      (line) => line.DetailType === "DiscountLineDetail",
    ).length;
    if (unsupportedLineTypes.length || discountLineCount > 1) {
      return res.status(422).json({
        error: "This QuickBooks invoice contains grouped, subtotal, description, or multiple discount lines that SPS cannot safely edit yet. The invoice was not changed.",
        code: "QB_COMPLEX_LINES_UNSUPPORTED",
        reviewRequired: false,
        unsupportedLineTypes: [
          ...new Set([
            ...unsupportedLineTypes,
            ...(discountLineCount > 1 ? ["MultipleDiscountLineDetail"] : []),
          ]),
        ],
      });
    }

    // Step 2: build updated line items. Keep only real ids imported from
    // QuickBooks; new SPS lines omit Id so QuickBooks creates them.
    const srcLines = invoice.lineItems || [];
    let qbCustomer = null;
    const customerId = existing.CustomerRef?.value;
    if (customerId) {
      try {
        const customerRes = await fetch(`${base}/customer/${encodeURIComponent(customerId)}?minorversion=65`, { headers });
        if (customerRes.ok) {
          const customerData = await customerRes.json();
          qbCustomer = customerData?.Customer || null;
        }
      } catch (_) {
        // Existing invoice tax metadata remains the preferred source.
      }
    }
    const taxPlan = buildUsTxnTaxDetail({
      sourceLines: srcLines,
      taxRate: invoice.taxRate,
      invoiceDiscountType: invoice.invoiceDiscountType,
      invoiceDiscount: invoice.invoiceDiscount,
      existingInvoice: existing,
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
      const unitPrice = parseFloat(li.unitPrice) || 0;
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
        ...(li.qbLineId ? { Id: String(li.qbLineId) } : {}),
        LineNum:     i + 1,
        Amount:      qty * unitPrice,
        DetailType:  "SalesItemLineDetail",
        Description: li.description || "Service",
        SalesItemLineDetail: detail,
      });
    }

    if (invoice.invoiceDiscount && parseFloat(invoice.invoiceDiscount) > 0) {
      const isPct = invoice.invoiceDiscountType === "pct";
      const existingDiscount = existingLines.find(
        (line) => line.DetailType === "DiscountLineDetail",
      );
      lineItems.push({
        ...(existingDiscount?.Id ? { Id: String(existingDiscount.Id) } : {}),
        DetailType: "DiscountLineDetail",
        Amount: isPct ? undefined : parseFloat(invoice.invoiceDiscount),
        DiscountLineDetail: isPct ? { PercentBased: true, DiscountPercent: parseFloat(invoice.invoiceDiscount) } : { PercentBased: false },
      });
    }

    const updated = {
      Id:           String(invoice.qbId),
      SyncToken:    String(existing.SyncToken),
      // Sparse preserves QuickBooks fields SPS does not own (addresses, terms,
      // custom fields and delivery settings). Supplying Line still deliberately
      // replaces the customer-facing line set, protected by the fingerprint above.
      sparse:       true,
      CustomerRef:  existing.CustomerRef,
      DocNumber:    invoice.number || existing.DocNumber,
      TxnDate:      invoice.date || existing.TxnDate || todayISO(),
      DueDate:      invoice.dueDate || existing.DueDate,
      Line:         lineItems,
      BillEmail:    invoice.clientEmail ? { Address: invoice.clientEmail } : existing.BillEmail,
      // Online payment methods: ONLY override QuickBooks' account-level settings when the app
      // explicitly passes a boolean. Otherwise leave these undefined (dropped from the JSON request)
      // so QuickBooks shows every method enabled on the account — Card, ACH, PayPal, Venmo, Affirm.
      AllowOnlineCreditCardPayment: typeof invoice.allowCard === "boolean" ? invoice.allowCard : undefined,
      AllowOnlineACHPayment: typeof invoice.allowACH === "boolean" ? invoice.allowACH : undefined,
    };
    if (taxPlan.txnTaxDetail) {
      updated.TxnTaxDetail = taxPlan.txnTaxDetail;
    } else if (existing.TxnTaxDetail?.TxnTaxCodeRef && taxPlan.status === "not_applicable") {
      // Explicitly clear a formerly taxed invoice when tax is off OR no remaining
      // line is taxable. Omitting the field on a sparse update can retain old tax.
      updated.TxnTaxDetail = {
        TxnTaxCodeRef: existing.TxnTaxDetail.TxnTaxCodeRef,
        TotalTax: 0,
      };
    }

    const updRes = await fetch(`${base}/invoice?minorversion=65`, {
      method: "POST",
      headers,
      body: JSON.stringify(updated),
    });

    if (!updRes.ok) {
      const err = await updRes.text();
      console.error("QB update invoice error:", err);
      // We successfully read this invoice immediately before the update. A
      // not-found phrase here can refer to an inactive/missing ItemRef, tax code,
      // or customer—not the invoice itself. Never reinterpret an update fault as
      // permission to create a second invoice.
      const responseStatus = updRes.status >= 400 && updRes.status < 500 ? 422 : 502;
      return res.status(responseStatus).json({
        error: "QuickBooks rejected the update: " + readableQbError(err),
        details: err,
        code: "QB_INVOICE_UPDATE_REJECTED",
      });
    }

    const result = await updRes.json();
    const qbId = result?.Invoice?.Id || invoice.qbId;
    let canonicalInvoice = result?.Invoice || null;
    // Re-read the stored invoice so the client receives the fingerprint of what
    // QuickBooks actually accepted (including generated line ids/tax details),
    // not a projection of our request.
    try {
      const canonicalRes = await fetch(`${base}/invoice/${qbId}?minorversion=65`, { headers });
      if (canonicalRes.ok) {
        const canonicalData = await canonicalRes.json();
        canonicalInvoice = canonicalData?.Invoice || canonicalInvoice;
      }
    } catch (_) {
      // The update itself succeeded. Keep the successful response and require a
      // fresh pull before a later update if QB omitted the canonical content.
    }
    const paymentLink = canonicalInvoice?.InvoiceLink || result?.Invoice?.InvoiceLink || webLink(qbId);
    const qbContentFingerprint = canonicalInvoice?.Line
      ? fingerprintQuickBooksInvoiceContent(canonicalInvoice)
      : null;

    return res.status(200).json({
      qbId,
      paymentLink,
      qbContentFingerprint,
      invoice: canonicalInvoice?.Line ? mapQuickBooksInvoice(canonicalInvoice) : null,
      success: true,
    });

  } catch (err) {
    console.error("QB update invoice error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
