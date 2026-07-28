import {
  ESTIMATE_LINE_TAX_MODEL,
  defaultEstimateLineTaxable,
  estimateLineAmount,
  estimateLineHasKnownCost,
  estimateLineIsTaxable,
  estimateLineQuantity,
  estimateLineUnitPrice,
  estimateNumberIsValid,
  estimateNumberValue,
  estimateTotals,
} from "./estimateMath.js";

const text = (value) => String(value == null ? "" : value).trim();

const safeIdPart = (value) => text(value).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");

const estimateLineHasContent = (line) => (
  [line?.price, line?.unitPrice, line?.amount]
    .some((value) => value != null && text(value) !== "")
);

// Estimates created before per-line tax existed treated the entire quote as taxable. That legacy
// display rule protects already-sent customer totals, but it must never leak into a newly-created
// invoice and make service labor taxable. Conversion is the explicit billing action, so normalize
// missing line flags here while preserving any tax choice that was actually stored.
export function normalizeEstimateTaxForInvoice(estimate) {
  if (!estimate || typeof estimate !== "object") return estimate;
  if (estimate.taxModel === ESTIMATE_LINE_TAX_MODEL || estimate.taxEnabled !== true) return estimate;
  return {
    ...estimate,
    taxModel: ESTIMATE_LINE_TAX_MODEL,
    items: (Array.isArray(estimate.items) ? estimate.items : []).map((line) => ({
      ...line,
      // A few partially-migrated records picked up `taxable:true` while they still had no
      // line-item model. Never let that stale quote-wide flag make service labor taxable.
      // Preserve an explicit opt-out, while deriving every other legacy line from its kind.
      taxable: line?.taxable === false
        ? false
        : defaultEstimateLineTaxable(line?.kind, { ...line, taxable: undefined }),
    })),
  };
}

export function estimateTaxMigrationImpact(estimate, fallbackRate = 0) {
  const normalizedEstimate = normalizeEstimateTaxForInvoice(estimate);
  const priorTotal = estimateTotals(estimate, fallbackRate).total;
  const normalizedTotal = estimateTotals(normalizedEstimate, fallbackRate).total;
  const priorCents = Math.round((priorTotal + Number.EPSILON) * 100);
  const normalizedCents = Math.round((normalizedTotal + Number.EPSILON) * 100);
  return {
    normalizedEstimate,
    priorTotal,
    normalizedTotal,
    changesCustomerTotal: priorCents !== normalizedCents,
    requiresConfirmation: normalizedEstimate !== estimate && priorCents !== normalizedCents,
  };
}

export function estimateDraftInvoiceId(estimate) {
  const source = safeIdPart(estimate?.id || estimate?.number);
  if (!source) throw new Error("Save the estimate before converting it to an invoice.");
  return `iv_est_${source}`;
}

export function findInvoiceForEstimate(invoices, estimate) {
  const list = Array.isArray(invoices) ? invoices : [];
  const linkedInvoiceId = text(estimate?.linkedInvoiceId);
  if (linkedInvoiceId) {
    const linked = list.find((invoice) => text(invoice?.id) === linkedInvoiceId);
    if (linked) return linked;
  }

  const estimateId = text(estimate?.id);
  let deterministicId = "";
  try { deterministicId = estimateDraftInvoiceId(estimate); } catch (_) {}
  return list.find((invoice) => (
    (!!estimateId && text(invoice?.sourceEstimateId) === estimateId)
    || (!!deterministicId && text(invoice?.id) === deterministicId)
  )) || null;
}

const normalizedClientName = (value) => text(value).replace(/\s+/g, " ").toLocaleLowerCase();

export function completeEstimateWithInvoice(
  estimate,
  invoice,
  { completedAt = new Date().toISOString() } = {},
) {
  const estimateId = text(estimate?.id);
  if (!estimate || typeof estimate !== "object" || !estimateId) {
    throw new Error("Save the estimate before completing it.");
  }

  const invoiceId = text(invoice?.id);
  if (!invoice || typeof invoice !== "object" || !invoiceId) {
    throw new Error("Save the invoice before completing the estimate.");
  }

  const estimateClientId = text(estimate.clientId);
  const invoiceClientId = text(invoice.clientId);
  let sameClient = false;
  if (estimateClientId && invoiceClientId) {
    sameClient = estimateClientId === invoiceClientId;
  } else {
    const estimateClientName = normalizedClientName(estimate.clientName);
    const invoiceClientName = normalizedClientName(invoice.clientName);
    sameClient = !!estimateClientName && estimateClientName === invoiceClientName;
  }
  if (!sameClient) {
    throw new Error("The estimate and invoice must belong to the same client.");
  }

  if (text(invoice.status).toLowerCase() === "void") {
    throw new Error("A void invoice cannot complete an estimate.");
  }

  return {
    ...estimate,
    status: "complete",
    linkedInvoiceId: invoice.id,
    linkedInvoiceNumber: invoice.number || "",
    completedAt,
  };
}

function invoiceLineFromEstimate(line, estimate, index) {
  const qty = estimateLineQuantity(line);
  const directPrice = line?.price ?? line?.unitPrice;
  const unitPrice = estimateNumberIsValid(directPrice)
    ? estimateLineUnitPrice(line)
    : (qty > 0 ? estimateLineAmount(line) / qty : estimateLineAmount(line));
  const knownCost = estimateLineHasKnownCost(line);
  const unitCost = knownCost
    ? estimateNumberValue(line?.unitCost ?? line?.cost)
    : "";

  return {
    id: `il_${safeIdPart(estimate?.id || estimate?.number)}_${safeIdPart(line?.id || index + 1)}`,
    desc: text(line?.desc ?? line?.description) || "Estimate item",
    qty: String(qty),
    unitPrice: String(unitPrice),
    unitCost: knownCost ? String(unitCost) : "",
    costKnown: knownCost,
    ...(estimateNumberIsValid(line?.knownUnitCost) ? { knownUnitCost: String(line.knownUnitCost) } : {}),
    taxable: estimateLineIsTaxable(line, estimate),
    kind: line?.kind || "custom",
    ...(line?.refId != null ? { refId: line.refId } : {}),
    ...(line?.unit ? { unit: line.unit } : {}),
    ...(line?.bundleNote ? { bundleNote: line.bundleNote } : {}),
    ...(Array.isArray(line?.bundleItems) ? { bundleItems: line.bundleItems.map((item) => ({ ...item })) } : {}),
    sourceEstimateLineId: line?.id || null,
  };
}

export function estimateToDraftInvoice(estimate, {
  client,
  number,
  issueDate,
  dueDate,
  dueDays,
  defaultTaxRate = 0,
  paymentTerms = "",
  createdAt = Date.now(),
} = {}) {
  if (!estimate || typeof estimate !== "object") throw new Error("Choose an estimate to convert.");
  if (!client || client.id == null) throw new Error("Choose a client before converting this estimate.");
  const billingEstimate = normalizeEstimateTaxForInvoice(estimate);
  const lines = (Array.isArray(billingEstimate.items) ? billingEstimate.items : []).filter(estimateLineHasContent);
  if (!lines.length) throw new Error("Add at least one line item before converting this estimate.");
  if (!text(number)) throw new Error("An invoice number could not be assigned.");

  const taxEnabled = billingEstimate.taxEnabled === true;
  const taxRate = taxEnabled
    ? estimateNumberValue(billingEstimate.taxRate ?? defaultTaxRate)
    : 0;
  const notes = [...new Set([text(billingEstimate.notes), text(paymentTerms)].filter(Boolean))].join("\n\n");
  const lineItems = lines.map((line, index) => invoiceLineFromEstimate(line, billingEstimate, index));
  const invoiceSubtotal = lineItems.reduce((sum, line) => (
    sum + estimateNumberValue(line.qty) * estimateNumberValue(line.unitPrice)
  ), 0);
  const invoiceTaxableSubtotal = lineItems.reduce((sum, line) => (
    sum + (line.taxable ? estimateNumberValue(line.qty) * estimateNumberValue(line.unitPrice) : 0)
  ), 0);
  const invoiceTax = taxEnabled ? invoiceTaxableSubtotal * taxRate / 100 : 0;
  const invoiceCents = Math.round((invoiceSubtotal + invoiceTax + Number.EPSILON) * 100);
  const estimateCents = Math.round((estimateTotals(billingEstimate, defaultTaxRate).total + Number.EPSILON) * 100);
  if (invoiceCents !== estimateCents) {
    throw new Error("The estimate and draft invoice totals do not match. Review the line pricing before converting.");
  }

  return {
    id: estimateDraftInvoiceId(estimate),
    number: text(number),
    clientId: client.id,
    clientName: client.name || estimate.clientName || "",
    clientAddress: client.address || "",
    clientEmail: client.email || "",
    date: issueDate || "",
    dueDate: dueDate || "",
    ...(dueDays != null ? { termsDays: String(dueDays) } : {}),
    status: "Draft",
    lineItems,
    taxRate: String(taxRate),
    notes,
    createdAt,
    source: "estimate",
    sourceEstimateId: estimate.id,
    sourceEstimateNumber: estimate.number || "",
    sourceEstimateTitle: estimate.title || "",
    sourceEstimateStatus: estimate.status || "draft",
    sourceEstimateTaxModel: billingEstimate.taxModel || "",
    ...(
      billingEstimate !== estimate || estimate.taxMigrationConfirmedAt
        ? {
          sourceEstimateTaxMigration: "services-nontaxable-v1",
          ...(estimate.taxMigrationConfirmedAt
            ? { sourceEstimateTaxMigrationConfirmedAt: estimate.taxMigrationConfirmedAt }
            : {}),
          ...(estimate.taxMigrationSource
            ? { sourceEstimateTaxMigrationSource: estimate.taxMigrationSource }
            : {}),
          ...(estimate.taxMigrationPriorTotal != null
            ? { sourceEstimatePriorTotal: estimate.taxMigrationPriorTotal }
            : {}),
          ...(estimate.taxMigrationCorrectedTotal != null
            ? { sourceEstimateCorrectedTotal: estimate.taxMigrationCorrectedTotal }
            : {}),
        }
        : {}
    ),
    convertedFromEstimate: true,
    convertedAt: new Date(createdAt).toISOString(),
    qbSyncStatus: "local",
  };
}
