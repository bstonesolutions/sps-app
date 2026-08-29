// api/quickbooks/sync.js
import { getValidAccessToken, QB_API_BASE, setCors } from "./qb-store.js";
import { mapQuickBooksInvoice } from "./invoice-mapper.js";
import {
  buildQuickBooksReconciliationMetadata,
  escapeQuickBooksQueryLiteral,
  fetchAllQuickBooksQueryPages,
  mapQuickBooksCreditMemo,
  mapQuickBooksPayment,
  QuickBooksQueryError,
} from "./sync-helpers.js";
import {
  rankQuickBooksInvoiceCandidates,
} from "../../invoiceReconciliationActions.js";
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

  // Targeted invoice review. The editor previously downloaded the entire
  // QuickBooks ledger merely to inspect one flagged record. This branch is
  // read-only: it never links, updates, recreates, or deletes an invoice.
  //
  // If a stored QB id no longer exists, an optional document number lookup
  // returns candidates with conservative evidence. Number alone is never
  // marked safe; replacement linking requires a unique number + customer +
  // total match and remains an explicit client-side owner action.
  const postedReview = req.method === "POST" && req.body?.mode === "invoice-review"
    ? req.body
    : null;
  const reviewRequest = postedReview || req.query || {};
  if (reviewRequest.reviewInvoiceId || reviewRequest.reviewInvoiceNumber) {
    const reviewInvoiceId = String(reviewRequest.reviewInvoiceId || "").trim();
    const reviewInvoiceNumber = String(reviewRequest.reviewInvoiceNumber || "").trim();
    const localInvoice = {
      qbId: reviewInvoiceId,
      number: reviewInvoiceNumber,
      qbCustomerId: String(reviewRequest.reviewCustomerId || "").trim(),
      clientName: String(reviewRequest.reviewClientName || "").trim(),
      total: reviewRequest.reviewTotal,
    };

    try {
      if (reviewInvoiceId) {
        const linkedResponse = await fetch(
          `${base}/invoice/${encodeURIComponent(reviewInvoiceId)}?minorversion=65`,
          { headers },
        );
        if (linkedResponse.status === 401) {
          return res.status(401).json({ error: "Token expired", action: "reconnect" });
        }
        if (linkedResponse.ok) {
          const linkedData = await linkedResponse.json().catch(() => ({}));
          const invoice = linkedData?.Invoice
            ? mapQuickBooksInvoice(linkedData.Invoice)
            : null;
          if (!invoice) {
            return res.status(502).json({ error: "QuickBooks returned an invalid invoice response." });
          }
          return res.status(200).json({
            mode: "invoice-review",
            linkedStatus: "found",
            invoice,
            candidates: [{
              invoice,
              assessment: rankQuickBooksInvoiceCandidates(localInvoice, [invoice]).candidates[0].assessment,
              safeToLink: true,
            }],
          });
        }
        if (!linkedResponse.ok) {
          const detail = await linkedResponse.text().catch(() => "");
          const missing = linkedResponse.status === 404
            || /object not found|"code"\s*:\s*"?610"?|could not be found|does not exist/i.test(detail);
          if (missing) {
            // Continue below and look for a safe replacement by DocNumber.
          } else {
            return res.status(502).json({
              error: `QuickBooks could not inspect invoice ${reviewInvoiceId}.`,
              detail: detail.slice(0, 400),
            });
          }
        }
      }

      if (!reviewInvoiceNumber) {
        return res.status(200).json({
          mode: "invoice-review",
          linkedStatus: reviewInvoiceId ? "missing" : "not-linked",
          candidates: [],
          safeCandidate: null,
          ambiguous: false,
        });
      }

      const queryResult = await fetchAllQuickBooksQueryPages({
        fetchImpl: fetch,
        base,
        headers,
        entity: "Invoice",
        where: `DocNumber = '${escapeQuickBooksQueryLiteral(reviewInvoiceNumber)}'`,
        maxPages: 2,
      });
      const mappedCandidates = queryResult.records.map((invoice) => mapQuickBooksInvoice(invoice));
      const ranked = rankQuickBooksInvoiceCandidates(localInvoice, mappedCandidates);
      return res.status(200).json({
        mode: "invoice-review",
        linkedStatus: reviewInvoiceId ? "missing" : "not-linked",
        candidates: ranked.candidates,
        safeCandidate: ranked.safeCandidate,
        ambiguous: ranked.ambiguous,
        complete: queryResult.complete,
      });
    } catch (error) {
      if (error instanceof QuickBooksQueryError && error.status === 401) {
        return res.status(401).json({ error: "Token expired", action: "reconnect" });
      }
      console.error("QB invoice review failed:", error);
      return res.status(500).json({
        error: "Failed to inspect the QuickBooks invoice: " + (error?.message || String(error)),
      });
    }
  }

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
    const query = (entity, options = {}) => fetchAllQuickBooksQueryPages({
      fetchImpl: fetch,
      base,
      headers,
      entity,
      ...options,
    });

    // Invoice and Customer are required for the legacy sync contract. Payments
    // and CreditMemos enrich it; a failure there is returned explicitly as an
    // incomplete reconciliation rather than silently pretending the numbers
    // match QuickBooks.
    const [
      invoiceResult,
      customerResult,
      paymentResult,
      creditMemoResult,
    ] = await Promise.allSettled([
      query("Invoice", { orderBy: "MetaData.LastUpdatedTime DESC" }),
      query("Customer", { where: "Active = true" }),
      query("Payment", { orderBy: "MetaData.LastUpdatedTime DESC" }),
      query("CreditMemo", { orderBy: "MetaData.LastUpdatedTime DESC" }),
    ]);

    const requiredFailure = [invoiceResult, customerResult]
      .find((result) => result.status === "rejected");
    if (requiredFailure) {
      const error = requiredFailure.reason;
      if (error instanceof QuickBooksQueryError && error.status === 401) {
        console.error("QB sync 401 from QuickBooks API:", error.detail);
        return res.status(401).json({
          error: "Token expired",
          action: "reconnect",
          detail: error.detail.slice(0, 400),
        });
      }
      throw error;
    }

    const invoices = invoiceResult.value.records;
    const customers = customerResult.value.records;
    const payments = paymentResult.status === "fulfilled"
      ? paymentResult.value.records
      : [];
    const creditMemos = creditMemoResult.status === "fulfilled"
      ? creditMemoResult.value.records
      : [];

    const fetchInfo = (result) => {
      if (result.status === "fulfilled") {
        return {
          count: result.value.records.length,
          pageCount: result.value.pageCount,
          complete: result.value.complete,
          truncated: result.value.truncated,
        };
      }
      const error = result.reason;
      return {
        count: 0,
        pageCount: 0,
        complete: false,
        truncated: false,
        error: (error && error.message) || String(error),
      };
    };

    // Map invoice id -> most recent payment date applied to it (Item 3). Payments are
    // supplementary: if the query failed (e.g. scope), date-paid is simply omitted.
    const paidDateByInvoice = {};
    for (const pm of payments) {
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
    const mappedCreditMemos = creditMemos.map(mapQuickBooksCreditMemo);
    const mappedPayments = payments.map(mapQuickBooksPayment);
    const mappedUnappliedPayments = mappedPayments.filter(
      payment => Number(payment.unappliedAmount || 0) > 0,
    );

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

    const fetchedAt = new Date().toISOString();
    const reconciliation = buildQuickBooksReconciliationMetadata({
      invoices: mappedInvoices,
      customers: mappedCustomers,
      creditMemos: mappedCreditMemos,
      payments: mappedPayments,
      fetchedAt,
      todayISO,
      fetches: {
        invoices: fetchInfo(invoiceResult),
        customers: fetchInfo(customerResult),
        payments: fetchInfo(paymentResult),
        creditMemos: fetchInfo(creditMemoResult),
      },
    });

    res.status(200).json({
      invoices: mappedInvoices,
      customers: mappedCustomers,
      creditMemos: mappedCreditMemos,
      // The maintenance payment ledger needs fully applied payments too. Each mapped payment is
      // compact and carries only the QuickBooks invoice allocations required for reconciliation.
      payments: mappedPayments,
      unappliedPayments: mappedUnappliedPayments,
      // These totals are calculated exclusively from the current QuickBooks
      // snapshots. They deliberately do not include unsynced SPS invoices.
      accounting: reconciliation.accounting,
      reconciliation,
      realmId: realm_id,
    });

  } catch (err) {
    console.error('QB sync error:', err);
    res.status(500).json({ error: 'Failed to fetch from QuickBooks: ' + err.message });
  }
}
