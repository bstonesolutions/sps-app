import {
  estimateLineAmount,
  estimateLineHasKnownCost,
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

export function estimateDraftInvoiceId(estimate) {
  const source = safeIdPart(estimate?.id || estimate?.number);
  if (!source) throw new Error("Save the estimate before converting it to an invoice.");
  return `iv_est_${source}`;
}

export function findInvoiceForEstimate(invoices, estimate) {
  const estimateId = text(estimate?.id);
  let deterministicId = "";
  try { deterministicId = estimateDraftInvoiceId(estimate); } catch (_) { return null; }
  return (Array.isArray(invoices) ? invoices : []).find((invoice) => (
    (!!estimateId && text(invoice?.sourceEstimateId) === estimateId)
    || text(invoice?.id) === deterministicId
  )) || null;
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
    taxable: estimate?.taxEnabled === true,
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
  const lines = (Array.isArray(estimate.items) ? estimate.items : []).filter(estimateLineHasContent);
  if (!lines.length) throw new Error("Add at least one line item before converting this estimate.");
  if (!text(number)) throw new Error("An invoice number could not be assigned.");

  const taxEnabled = estimate.taxEnabled === true;
  const taxRate = taxEnabled
    ? estimateNumberValue(estimate.taxRate ?? defaultTaxRate)
    : 0;
  const notes = [...new Set([text(estimate.notes), text(paymentTerms)].filter(Boolean))].join("\n\n");
  const lineItems = lines.map((line, index) => invoiceLineFromEstimate(line, estimate, index));
  const invoiceSubtotal = lineItems.reduce((sum, line) => (
    sum + estimateNumberValue(line.qty) * estimateNumberValue(line.unitPrice)
  ), 0);
  const invoiceTax = taxEnabled ? invoiceSubtotal * taxRate / 100 : 0;
  const invoiceCents = Math.round((invoiceSubtotal + invoiceTax + Number.EPSILON) * 100);
  const estimateCents = Math.round((estimateTotals(estimate, defaultTaxRate).total + Number.EPSILON) * 100);
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
    convertedFromEstimate: true,
    convertedAt: new Date(createdAt).toISOString(),
    qbSyncStatus: "local",
  };
}
