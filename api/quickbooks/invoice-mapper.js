import { fingerprintQuickBooksInvoiceContent } from "./invoice-revision.js";

const itemNameToKind = (name) => {
  if (name === "Product Sales") return "product";
  if (name === "Materials") return "part";
  if (name === "Services") return "service";
  return "custom";
};

const isTaxableCode = (ref) => !!(ref?.value && ref.value !== "NON" && ref.value !== "0");
const isLateFeeLine = (line, detail) => (
  /late\s*fee/i.test(line?.Description || "")
  || /late\s*fee/i.test(detail?.ItemRef?.name || "")
);

// QuickBooks AST responses automatically append a plain trailing subtotal line.
// It is generated again by QuickBooks and is not a user-authored invoice section.
// A subtotal in the middle of the invoice (or carrying text/settings) remains
// unsupported because omitting it could change a grouped invoice's meaning.
export function isGeneratedQuickBooksSubtotalLine(line, index, lines) {
  if (line?.DetailType !== "SubTotalLineDetail" || index !== lines.length - 1) return false;
  if (String(line.Description || "").trim()) return false;
  const detail = line.SubTotalLineDetail;
  return !detail
    || (
      typeof detail === "object"
      && !Array.isArray(detail)
      && Object.keys(detail).length === 0
    );
}

/**
 * Convert a canonical QuickBooks Invoice into the app's editable invoice shape.
 * A direct create/update response and a later full sync must produce the same
 * lines, totals, tax, and revision metadata.
 */
export function mapQuickBooksInvoice(invoice, options = {}) {
  const todayISO = options.todayISO || new Date().toISOString().slice(0, 10);
  const hasPaidDate = Object.prototype.hasOwnProperty.call(options, "paidDate");
  const inv = invoice || {};
  const allLines = Array.isArray(inv.Line) ? inv.Line : [];
  const salesLines = allLines.filter((line) => line.DetailType === "SalesItemLineDetail");
  const discountLines = allLines.filter((line) => line.DetailType === "DiscountLineDetail");
  const unsupportedLines = allLines.filter(
    (line, index) => (
      !["SalesItemLineDetail", "DiscountLineDetail"].includes(line.DetailType)
      && !isGeneratedQuickBooksSubtotalLine(line, index, allLines)
    ),
  );
  let hasLateFee = false;

  const lineItems = salesLines.map((line, index) => {
    const detail = line.SalesItemLineDetail || {};
    const lateFee = isLateFeeLine(line, detail);
    if (lateFee) hasLateFee = true;
    return {
      id: `qbl_${inv.Id}_${line.Id || index}`,
      qbLineId: line.Id ? String(line.Id) : null,
      qbItemRef: detail.ItemRef
        ? {
            value: String(detail.ItemRef.value || ""),
            ...(detail.ItemRef.name ? { name: detail.ItemRef.name } : {}),
          }
        : null,
      desc: line.Description || detail.ItemRef?.name || "Service",
      qty: String(detail.Qty != null ? detail.Qty : 1),
      unitPrice: String(detail.UnitPrice != null ? detail.UnitPrice : (line.Amount || 0)),
      taxable: isTaxableCode(detail.TaxCodeRef),
      kind: lateFee ? "lateFee" : itemNameToKind(detail.ItemRef?.name),
      isLateFee: lateFee,
      ...(detail.ServiceDate ? { serviceDate: String(detail.ServiceDate) } : {}),
    };
  });

  const totalTax = parseFloat(inv.TxnTaxDetail?.TotalTax) || 0;
  const grossSubtotal = salesLines.reduce(
    (sum, line) => sum + (parseFloat(line.Amount) || 0),
    0,
  );
  const taxableBeforeDiscount = salesLines.reduce(
    (sum, line) => sum + (
      isTaxableCode(line.SalesItemLineDetail?.TaxCodeRef)
        ? (parseFloat(line.Amount) || 0)
        : 0
    ),
    0,
  );
  const discountAmount = discountLines.reduce(
    (sum, line) => sum + Math.max(0, parseFloat(line.Amount) || 0),
    0,
  );
  const taxAfterDiscount = inv.ApplyTaxAfterDiscount !== false;
  const discountFactor = taxAfterDiscount && grossSubtotal > 0
    ? Math.max(0, 1 - (discountAmount / grossSubtotal))
    : 1;
  const taxableBase = taxableBeforeDiscount * discountFactor;
  const taxRate = taxableBase > 0 && totalTax > 0
    // TotalTax is the customer-facing amount QuickBooks accepted. It can be an
    // explicit override even when jurisdiction component percentages differ.
    ? Number(((totalTax / taxableBase) * 100).toFixed(4))
    : 0;
  const total = parseFloat(inv.TotalAmt) || 0;
  const balance = parseFloat(inv.Balance) || 0;
  const singleDiscount = discountLines.length === 1 ? discountLines[0] : null;
  const discountDetail = singleDiscount?.DiscountLineDetail || {};
  const discountType = singleDiscount
    ? (discountDetail.PercentBased ? "pct" : "amt")
    : "";
  const discount = singleDiscount
    ? String(
        discountDetail.PercentBased
          ? (parseFloat(discountDetail.DiscountPercent) || 0)
          : (parseFloat(singleDiscount.Amount) || 0),
      )
    : "";
  const sentDate = inv.DeliveryInfo?.DeliveryTime
    ? String(inv.DeliveryInfo.DeliveryTime).slice(0, 10)
    : null;
  const delivered = inv.EmailStatus === "EmailSent" || !!sentDate;
  const dueDateISO = String(inv.DueDate || "").slice(0, 10);
  const overdue = !!(
    /^\d{4}-\d{2}-\d{2}$/.test(dueDateISO)
    && /^\d{4}-\d{2}-\d{2}$/.test(todayISO)
    && dueDateISO < todayISO
  );

  return {
    qbId: inv.Id,
    qbSyncToken: inv.SyncToken != null ? String(inv.SyncToken) : null,
    qbLastUpdatedTime: inv.MetaData?.LastUpdatedTime || null,
    qbContentFingerprint: inv.Line ? fingerprintQuickBooksInvoiceContent(inv) : null,
    qbTaxCodeRef: inv.TxnTaxDetail?.TxnTaxCodeRef || null,
    number: inv.DocNumber || inv.Id,
    clientName: inv.CustomerRef?.name || "",
    qbCustomerId: inv.CustomerRef?.value || "",
    date: inv.TxnDate,
    dueDate: inv.DueDate,
    ...(inv.PrivateNote ? { privateNote: String(inv.PrivateNote) } : {}),
    ...(inv.CustomerMemo?.value
      ? { memo: String(inv.CustomerMemo.value) }
      : (typeof inv.CustomerMemo === "string" && inv.CustomerMemo
        ? { memo: inv.CustomerMemo }
        : {})),
    total,
    taxAmount: totalTax,
    subTotal: total - totalTax,
    balance,
    taxRate,
    discountType,
    discount,
    qbHasUnsupportedLines: unsupportedLines.length > 0 || discountLines.length > 1,
    qbUnsupportedLineTypes: [
      ...new Set([
        ...unsupportedLines.map((line) => line.DetailType || "Unknown"),
        ...(discountLines.length > 1 ? ["MultipleDiscountLineDetail"] : []),
      ]),
    ],
    source: "quickbooks",
    qbEmailStatus: inv.EmailStatus || "NotSet",
    ...(sentDate ? { sentDate } : {}),
    qbDeliveryType: inv.DeliveryInfo?.DeliveryType || null,
    ...(hasPaidDate ? { paidDate: options.paidDate } : {}),
    partial: balance > 0 && balance < total,
    ...(hasLateFee ? { lateFeeAppliedAt: todayISO } : {}),
    // QuickBooks creates an accounting invoice before anyone sends it. Keep
    // unsent/open records as Draft in SPS; only delivery evidence promotes them.
    status: balance <= 0 ? "Paid" : delivered ? (overdue ? "Overdue" : "Sent") : "Draft",
    lineItems,
    lines: salesLines.map((line) => ({
      description: line.Description || line.SalesItemLineDetail?.ItemRef?.name || "Service",
      qty: line.SalesItemLineDetail?.Qty || 1,
      rate: line.SalesItemLineDetail?.UnitPrice || 0,
      amount: line.Amount || 0,
      ...(line.SalesItemLineDetail?.ServiceDate
        ? { serviceDate: String(line.SalesItemLineDetail.ServiceDate) }
        : {}),
    })),
  };
}
