// api/quickbooks/qb-tax.js
// Pure helpers for building US QuickBooks transaction tax.
//
// Important: TAX/NON are line-level pseudo tax codes. They are not a safe
// substitute for the real TaxCode reference required by TxnTaxDetail. A real
// transaction tax code must come from QuickBooks (prefer the existing invoice,
// then the customer's DefaultTaxCodeRef). If QuickBooks does not provide one,
// callers must stop and surface setup/review instead of guessing a jurisdiction.

const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const numberOrZero = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const cleanTaxCodeRef = (ref) => {
  const value = String(ref?.value ?? "").trim();
  // TAX/NON are pseudo codes used only on SalesItemLineDetail.TaxCodeRef.
  if (!value || value === "TAX" || value === "NON") return null;
  const name = String(ref?.name ?? "").trim();
  return name ? { value, name } : { value };
};

export function resolveTransactionTaxCodeRef({
  existingInvoice,
  customer,
  storedTaxCodeRef,
} = {}) {
  return cleanTaxCodeRef(existingInvoice?.TxnTaxDetail?.TxnTaxCodeRef)
    || cleanTaxCodeRef(customer?.DefaultTaxCodeRef)
    || cleanTaxCodeRef(storedTaxCodeRef)
    || null;
}

export function calculateSpsInvoiceTax({
  sourceLines = [],
  taxRate = 0,
  invoiceDiscountType = "",
  invoiceDiscount = 0,
} = {}) {
  const normalizedRate = numberOrZero(taxRate);
  const lines = Array.isArray(sourceLines) ? sourceLines : [];
  const lineAmounts = lines.map((line) => {
    const explicitAmount = Number.parseFloat(line?.amount);
    if (Number.isFinite(explicitAmount)) return Math.max(0, cents(explicitAmount));
    const qty = numberOrZero(line?.qty);
    const unitPrice = numberOrZero(line?.unitPrice ?? line?.rate);
    return Math.max(0, cents(qty * unitPrice));
  });
  const subtotal = cents(lineAmounts.reduce((sum, amount) => sum + amount, 0));
  const taxableBeforeInvoiceDiscount = cents(lines.reduce(
    (sum, line, index) => sum + (line?.taxable ? lineAmounts[index] : 0),
    0,
  ));

  let discount = 0;
  const discountValue = Math.max(0, numberOrZero(invoiceDiscount));
  if (invoiceDiscountType === "pct") discount = subtotal * (discountValue / 100);
  else if (invoiceDiscountType === "amt") discount = discountValue;
  discount = cents(Math.min(discount, subtotal));

  // SPS applies an invoice-wide discount proportionally to taxable and
  // non-taxable lines. Keep the server calculation aligned with invoiceTotals.
  const discountFactor = subtotal > 0 ? 1 - (discount / subtotal) : 1;
  const taxableBase = cents(taxableBeforeInvoiceDiscount * discountFactor);
  const totalTax = cents(taxableBase * (normalizedRate / 100));

  return {
    taxRate: normalizedRate,
    subtotal,
    discount,
    taxableBase,
    totalTax,
  };
}

export function buildUsTxnTaxDetail({
  sourceLines = [],
  taxRate = 0,
  invoiceDiscountType = "",
  invoiceDiscount = 0,
  existingInvoice,
  customer,
  storedTaxCodeRef,
} = {}) {
  const rawRate = String(taxRate ?? "").trim();
  const parsedRate = rawRate === "" ? 0 : Number(rawRate);
  if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100) {
    return {
      status: "blocked",
      code: "QB_TAX_RATE_INVALID",
      message: "The invoice tax rate must be a number from 0 through 100 before syncing to QuickBooks.",
      txnTaxDetail: undefined,
      taxRate: parsedRate,
      subtotal: 0,
      discount: 0,
      taxableBase: 0,
      totalTax: 0,
    };
  }

  const calculated = calculateSpsInvoiceTax({
    sourceLines,
    taxRate,
    invoiceDiscountType,
    invoiceDiscount,
  });

  if (calculated.taxRate <= 0 || calculated.taxableBase <= 0) {
    return {
      status: "not_applicable",
      txnTaxDetail: undefined,
      ...calculated,
    };
  }

  const txnTaxCodeRef = resolveTransactionTaxCodeRef({
    existingInvoice,
    customer,
    storedTaxCodeRef,
  });

  if (!txnTaxCodeRef) {
    return {
      status: "blocked",
      code: "QB_TAX_CODE_REQUIRED",
      message: "QuickBooks did not provide a transaction tax code for this customer. Review the customer's sales-tax setup in QuickBooks before syncing.",
      txnTaxDetail: undefined,
      ...calculated,
    };
  }

  return {
    status: "ready",
    txnTaxDetail: {
      TxnTaxCodeRef: txnTaxCodeRef,
      // Intuit honors TotalTax as an override for US Automated Sales Tax when
      // accompanied by the real transaction TaxCodeRef.
      TotalTax: calculated.totalTax,
    },
    ...calculated,
  };
}
