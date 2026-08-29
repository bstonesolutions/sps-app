const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;

const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const toCents = (value) => Math.round(finiteNumber(value) * 100);
const fromCents = (value) => Number((value / 100).toFixed(2));
const sumCents = (values) => values.reduce((sum, value) => sum + toCents(value), 0);

export class QuickBooksQueryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "QuickBooksQueryError";
    this.status = options.status || 0;
    this.detail = options.detail || "";
    this.entity = options.entity || "";
  }
}

export function buildQuickBooksPagedQuery({
  entity,
  where = "",
  orderBy = "",
  startPosition = 1,
  maxResults = DEFAULT_PAGE_SIZE,
}) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(entity || ""))) {
    throw new TypeError("A valid QuickBooks entity is required.");
  }

  const clauses = [`SELECT * FROM ${entity}`];
  if (String(where || "").trim()) clauses.push(`WHERE ${String(where).trim()}`);
  if (String(orderBy || "").trim()) clauses.push(`ORDER BY ${String(orderBy).trim()}`);
  clauses.push(`STARTPOSITION ${Math.max(1, Math.trunc(finiteNumber(startPosition) || 1))}`);
  clauses.push(`MAXRESULTS ${Math.max(1, Math.trunc(finiteNumber(maxResults) || DEFAULT_PAGE_SIZE))}`);
  return clauses.join(" ");
}

/**
 * Fetch every page for a QuickBooks query entity.
 *
 * QuickBooks caps query pages at 1,000 rows. A successful response containing
 * exactly one full page must therefore be followed by another query; otherwise
 * the caller cannot tell 1,000 rows from a truncated result.
 */
export async function fetchAllQuickBooksQueryPages({
  fetchImpl = globalThis.fetch,
  base,
  headers,
  entity,
  where = "",
  orderBy = "",
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  minorVersion = 65,
}) {
  const records = [];
  let pageCount = 0;
  let nextStartPosition = 1;
  let complete = false;

  while (pageCount < maxPages) {
    const query = buildQuickBooksPagedQuery({
      entity,
      where,
      orderBy,
      startPosition: nextStartPosition,
      maxResults: pageSize,
    });
    const response = await fetchImpl(
      `${base}/query?query=${encodeURIComponent(query)}&minorversion=${minorVersion}`,
      { headers },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new QuickBooksQueryError(
        `QuickBooks ${entity} query failed (${response.status})`,
        { status: response.status, detail: detail.slice(0, 500), entity },
      );
    }

    const data = await response.json().catch(() => ({}));
    const queryResponse = data?.QueryResponse || {};
    const page = Array.isArray(queryResponse[entity]) ? queryResponse[entity] : [];
    records.push(...page);
    pageCount += 1;

    if (page.length < pageSize) {
      complete = true;
      break;
    }

    // Prefer the position acknowledged by QuickBooks. Falling back to the
    // requested position still advances safely when QueryResponse omits it.
    const acknowledgedStart = Math.max(
      1,
      Math.trunc(finiteNumber(queryResponse.startPosition) || nextStartPosition),
    );
    nextStartPosition = acknowledgedStart + page.length;
  }

  return {
    records,
    pageCount,
    pageSize,
    complete,
    truncated: !complete,
  };
}

export function mapQuickBooksCreditMemo(creditMemo) {
  const memo = creditMemo || {};
  const totalCents = toCents(memo.TotalAmt);
  const remainingCents = Math.max(0, toCents(memo.RemainingCredit));
  const appliedCents = Math.max(0, totalCents - remainingCents);

  return {
    qbId: memo.Id != null ? String(memo.Id) : "",
    qbSyncToken: memo.SyncToken != null ? String(memo.SyncToken) : null,
    qbLastUpdatedTime: memo.MetaData?.LastUpdatedTime || null,
    number: memo.DocNumber || memo.Id || "",
    qbCustomerId: memo.CustomerRef?.value != null
      ? String(memo.CustomerRef.value)
      : "",
    clientName: memo.CustomerRef?.name || "",
    date: memo.TxnDate || null,
    total: fromCents(totalCents),
    remainingCredit: fromCents(remainingCents),
    appliedAmount: fromCents(appliedCents),
    status: remainingCents <= 0
      ? "Applied"
      : (remainingCents < totalCents ? "Partially applied" : "Open"),
    source: "quickbooks-credit-memo",
  };
}

export function mapQuickBooksPayment(payment) {
  const source = payment || {};
  const totalCents = Math.max(0, toCents(source.TotalAmt));
  const unappliedCents = Math.min(
    totalCents,
    Math.max(0, toCents(source.UnappliedAmt)),
  );
  const appliedCents = Math.max(0, totalCents - unappliedCents);
  const invoiceAllocations = [];
  let allocationReviewRequired = false;
  for (const line of (Array.isArray(source.Line) ? source.Line : [])) {
    const linkedInvoices = (Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [])
      .filter((linked) => String(linked?.TxnType || "").toLowerCase() === "invoice" && linked?.TxnId != null);
    if (!linkedInvoices.length) continue;
    // QuickBooks normally emits one applied invoice per payment line. If one line points at
    // multiple invoices, its single Amount cannot be divided safely, so keep the links visible
    // while forcing the maintenance ledger to ask for a human allocation.
    if (linkedInvoices.length !== 1) allocationReviewRequired = true;
    const lineCents = Math.max(0, toCents(line?.Amount));
    linkedInvoices.forEach((linked) => {
      invoiceAllocations.push({
        qbInvoiceId: String(linked.TxnId),
        amount: linkedInvoices.length === 1 ? fromCents(lineCents) : null,
      });
    });
  }

  return {
    qbId: source.Id != null ? String(source.Id) : "",
    qbSyncToken: source.SyncToken != null ? String(source.SyncToken) : null,
    qbLastUpdatedTime: source.MetaData?.LastUpdatedTime || null,
    number: source.PaymentRefNum || source.Id || "",
    qbCustomerId: source.CustomerRef?.value != null
      ? String(source.CustomerRef.value)
      : "",
    clientName: source.CustomerRef?.name || "",
    date: source.TxnDate || null,
    total: fromCents(totalCents),
    appliedAmount: fromCents(appliedCents),
    unappliedAmount: fromCents(unappliedCents),
    invoiceAllocations,
    allocationReviewRequired,
    paymentMethod: source.PaymentMethodRef?.name || "",
    qbPaymentMethodId: source.PaymentMethodRef?.value != null
      ? String(source.PaymentMethodRef.value)
      : "",
    depositAccount: source.DepositToAccountRef?.name || "",
    qbDepositAccountId: source.DepositToAccountRef?.value != null
      ? String(source.DepositToAccountRef.value)
      : "",
    note: source.PrivateNote || "",
    status: unappliedCents <= 0
      ? "Applied"
      : (unappliedCents < totalCents ? "Partially applied" : "Unapplied"),
    source: "quickbooks-payment",
  };
}

export function summarizeQuickBooksAccounting({
  invoices = [],
  creditMemos = [],
  payments = [],
  invoicesComplete = true,
  creditMemosComplete = true,
  paymentsComplete = true,
  todayISO = new Date().toISOString().slice(0, 10),
}) {
  const openInvoices = invoices.filter((invoice) => toCents(invoice?.balance) > 0);
  const openCreditMemos = creditMemos.filter(
    (creditMemo) => toCents(creditMemo?.remainingCredit) > 0,
  );
  const unappliedPayments = payments.filter(
    (payment) => toCents(payment?.unappliedAmount) > 0,
  );
  const overdueInvoices = openInvoices.filter((invoice) => (
    invoice?.dueDate
    && String(invoice.dueDate).slice(0, 10) < todayISO
  ));
  const currentMonth = String(todayISO || "").slice(0, 7);
  const paymentsThisMonth = currentMonth
    ? payments.filter((payment) => String(payment?.date || "").slice(0, 7) === currentMonth)
    : [];

  const openInvoiceBalanceCents = sumCents(openInvoices.map((invoice) => invoice.balance));
  const availableCreditMemoCents = sumCents(
    openCreditMemos.map((creditMemo) => creditMemo.remainingCredit),
  );
  const unappliedPaymentCents = sumCents(
    unappliedPayments.map((payment) => payment.unappliedAmount),
  );
  const availableCreditCents = availableCreditMemoCents + unappliedPaymentCents;
  const openCreditCount = openCreditMemos.length + unappliedPayments.length;

  return {
    currency: "USD",
    complete: invoicesComplete && creditMemosComplete && paymentsComplete,
    invoiceCount: invoices.length,
    invoiceTotal: fromCents(sumCents(invoices.map((invoice) => invoice.total))),
    openInvoiceCount: openInvoices.length,
    openInvoiceBalance: fromCents(openInvoiceBalanceCents),
    overdueInvoiceCount: overdueInvoices.length,
    overdueInvoiceBalance: fromCents(sumCents(
      overdueInvoices.map((invoice) => invoice.balance),
    )),
    creditMemoCount: creditMemos.length,
    creditMemoTotal: fromCents(sumCents(creditMemos.map((memo) => memo.total))),
    openCreditMemoCount: openCreditMemos.length,
    availableCreditMemoBalance: fromCents(availableCreditMemoCents),
    paymentCount: payments.length,
    paymentTotal: fromCents(sumCents(payments.map((payment) => payment.total))),
    unappliedPaymentCount: unappliedPayments.length,
    unappliedPaymentBalance: fromCents(unappliedPaymentCents),
    openCreditCount,
    openTransactionCount: openInvoices.length + openCreditCount,
    availableCreditBalance: fromCents(availableCreditCents),
    netOpenReceivables: fromCents(openInvoiceBalanceCents - availableCreditCents),
    paymentCountThisMonth: paymentsThisMonth.length,
    paymentsReceivedThisMonth: fromCents(sumCents(
      paymentsThisMonth.map((payment) => payment.total),
    )),
    paymentsAppliedThisMonth: fromCents(sumCents(
      paymentsThisMonth.map((payment) => payment.appliedAmount),
    )),
  };
}

export function buildQuickBooksReconciliationMetadata({
  invoices = [],
  customers = [],
  creditMemos = [],
  payments = [],
  fetches = {},
  fetchedAt = new Date().toISOString(),
  todayISO,
}) {
  const invoiceIds = invoices.map((invoice) => String(invoice.qbId || "")).filter(Boolean);
  const customerIds = customers.map((customer) => String(customer.qbId || "")).filter(Boolean);
  const creditMemoIds = creditMemos.map((memo) => String(memo.qbId || "")).filter(Boolean);
  const paymentIds = payments.map((payment) => String(payment.qbId || "")).filter(Boolean);
  const invoicesComplete = fetches.invoices?.complete === true;
  const creditMemosComplete = fetches.creditMemos?.complete === true;
  const paymentsComplete = fetches.payments?.complete === true;
  const accounting = summarizeQuickBooksAccounting({
    invoices,
    creditMemos,
    payments,
    invoicesComplete,
    creditMemosComplete,
    paymentsComplete,
    ...(todayISO ? { todayISO } : {}),
  });
  const warnings = [];

  for (const [name, fetchInfo] of Object.entries(fetches)) {
    if (fetchInfo?.error) warnings.push(`${name}: ${fetchInfo.error}`);
    else if (fetchInfo?.truncated) warnings.push(`${name}: result was truncated`);
  }

  return {
    source: "quickbooks",
    fetchedAt,
    complete: accounting.complete && warnings.length === 0,
    qbInvoiceIds: invoiceIds,
    qbCustomerIds: customerIds,
    qbCreditMemoIds: creditMemoIds,
    qbPaymentIds: paymentIds,
    counts: {
      invoices: invoiceIds.length,
      customers: customerIds.length,
      creditMemos: creditMemoIds.length,
      payments: paymentIds.length,
    },
    pagination: Object.fromEntries(
      Object.entries(fetches).map(([name, fetchInfo]) => [name, {
        count: fetchInfo?.count || 0,
        pages: fetchInfo?.pageCount || 0,
        complete: fetchInfo?.complete === true,
        truncated: fetchInfo?.truncated === true,
        ...(fetchInfo?.error ? { error: fetchInfo.error } : {}),
      }]),
    ),
    accounting,
    warnings,
  };
}

export function escapeQuickBooksQueryLiteral(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}
