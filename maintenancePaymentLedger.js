import {
  isRecurringMaintenanceStop,
  maintenanceBillingPolicyForClient,
  normalizeMaintenanceBillingStore,
  recurringMaintenanceCadence,
} from "./maintenanceBilling.js";

export const MAINTENANCE_PAYMENT_LEDGER_VERSION = 2;
export const MAINTENANCE_PAYMENT_STATUSES = Object.freeze([
  "paid",
  "prepaid",
  "due",
  "partial",
  "missing",
  "review",
  "waived",
  "refunded",
  "not_expected",
]);

const PERSISTED_STATUSES = new Set(MAINTENANCE_PAYMENT_STATUSES);
const SOURCE_KINDS = new Set(["invoice", "payment", "prepaid", "waiver", "refund"]);
const text = (value) => String(value == null ? "" : value).trim();
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function moneyToCents(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : 0;
  const normalized = text(value).replace(/[$,\s]/g, "");
  if (!normalized) return 0;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

export function normalizeMonthKey(value) {
  const normalized = text(value);
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})(?:-\d{2})?(?:T.*)?$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    if (year < 1900 || year > 2200 || month < 1 || month > 12) return "";
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }

  const mdyMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!mdyMatch) return "";
  const month = Number(mdyMatch[1]);
  const day = Number(mdyMatch[2]);
  const year = Number(mdyMatch[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return "";
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    day < 1
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function maintenancePaymentDisplayStatus(status, monthKey, asOfMonth) {
  const normalizedStatus = text(status).toLowerCase() || "not_expected";
  const normalizedMonth = normalizeMonthKey(monthKey);
  const now = new Date();
  const normalizedAsOf = normalizeMonthKey(asOfMonth)
    || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (normalizedStatus === "missing" && normalizedMonth && normalizedMonth > normalizedAsOf) return "upcoming";
  return normalizedStatus;
}

function monthsBetween(coveredFrom, coveredThrough) {
  const first = normalizeMonthKey(coveredFrom);
  const last = normalizeMonthKey(coveredThrough);
  if (!first || !last || first > last) return [];
  const [firstYear, firstMonth] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  const result = [];
  let cursorYear = firstYear;
  let cursorMonth = firstMonth;
  while (cursorYear < lastYear || (cursorYear === lastYear && cursorMonth <= lastMonth)) {
    result.push(`${cursorYear}-${String(cursorMonth).padStart(2, "0")}`);
    cursorMonth += 1;
    if (cursorMonth > 12) {
      cursorMonth = 1;
      cursorYear += 1;
    }
  }
  return result;
}

function sourceIdentity(source) {
  const normalized = normalizeAllocationSource(source);
  if (!normalized) return "";
  return [
    normalized.kind,
    normalized.invoiceId,
    normalized.qbInvoiceId,
    normalized.invoiceNumber,
    normalized.paymentId,
    normalized.qbPaymentId,
    normalized.policyId,
    normalized.waiverId,
    normalized.refundId,
  ].map(text).join("|");
}

export function normalizeAllocationSource(rawSource) {
  if (!isRecord(rawSource)) return null;
  const kind = text(rawSource.kind || rawSource.type).toLowerCase();
  if (!SOURCE_KINDS.has(kind)) return null;
  const source = { kind };
  const copyText = (target, ...keys) => {
    const value = keys.map((key) => text(rawSource[key])).find(Boolean) || "";
    if (!value || value.length > 240) return;
    source[target] = value;
  };
  copyText("invoiceId", "invoiceId", "sourceInvoiceId");
  copyText("qbInvoiceId", "qbInvoiceId", "sourceQbInvoiceId");
  copyText("invoiceNumber", "invoiceNumber", "sourceInvoiceNumber", "number");
  copyText("paymentId", "paymentId", "sourcePaymentId");
  copyText("qbPaymentId", "qbPaymentId", "sourceQbPaymentId");
  copyText("policyId", "policyId");
  copyText("waiverId", "waiverId");
  copyText("refundId", "refundId");
  if (hasOwn(rawSource, "amountCents")) {
    const amountCents = Number(rawSource.amountCents);
    if (!Number.isSafeInteger(amountCents)) return null;
    source.amountCents = amountCents;
  }
  const valid = (
    (kind === "invoice" && !!(source.invoiceId || source.qbInvoiceId || source.invoiceNumber))
    || (kind === "payment" && !!(source.paymentId || source.qbPaymentId))
    || (kind === "prepaid" && !!(source.policyId || source.invoiceId || source.qbInvoiceId || source.invoiceNumber))
    || (kind === "waiver" && !!source.waiverId)
    || (kind === "refund" && !!(source.refundId || source.invoiceId || source.qbInvoiceId || source.paymentId || source.qbPaymentId))
  );
  return valid ? source : null;
}

function normalizeAllocation(rawAllocation) {
  if (!isRecord(rawAllocation)) return null;
  const status = text(rawAllocation.status).toLowerCase();
  if (!PERSISTED_STATUSES.has(status)) return null;
  const rawSources = Array.isArray(rawAllocation.sources)
    ? rawAllocation.sources
    : (rawAllocation.source ? [rawAllocation.source] : []);
  const sources = [];
  const seen = new Set();
  for (const rawSource of rawSources) {
    const source = normalizeAllocationSource(rawSource);
    if (!source) return null;
    const identity = sourceIdentity(source);
    if (!seen.has(identity)) {
      seen.add(identity);
      sources.push(source);
    }
  }
  if (!sources.length) return null;
  const allocation = { status, sources };
  if (hasOwn(rawAllocation, "expectedCents")) {
    const expectedCents = Number(rawAllocation.expectedCents);
    if (!Number.isSafeInteger(expectedCents) || expectedCents < 0) return null;
    allocation.expectedCents = expectedCents;
  }
  if (hasOwn(rawAllocation, "allocatedCents")) {
    const allocatedCents = Number(rawAllocation.allocatedCents);
    if (!Number.isSafeInteger(allocatedCents)) return null;
    allocation.allocatedCents = allocatedCents;
  }
  const note = text(rawAllocation.note);
  const updatedAt = text(rawAllocation.updatedAt);
  const updatedBy = text(rawAllocation.updatedBy || rawAllocation.actor);
  if (note) allocation.note = note.slice(0, 1200);
  if (updatedAt) allocation.updatedAt = updatedAt.slice(0, 80);
  if (updatedBy) allocation.updatedBy = updatedBy.slice(0, 220);
  return allocation;
}

function legacyBillingStoreToLedger(rawStore) {
  const store = normalizeMaintenanceBillingStore(rawStore);
  if (!store) return null;
  const allocations = {};
  for (const [clientId, policy] of Object.entries(store.policies)) {
    const policyId = `prepaid:${clientId}:${policy.coveredFrom}:${policy.coveredThrough}`;
    for (const month of monthsBetween(policy.coveredFrom, policy.coveredThrough)) {
      allocations[clientId] ||= {};
      allocations[clientId][month] = {
        status: "prepaid",
        sources: [{
          kind: "prepaid",
          policyId,
          ...(policy.sourceInvoiceId ? { invoiceId: policy.sourceInvoiceId } : {}),
          ...(policy.sourceInvoiceNumber ? { invoiceNumber: policy.sourceInvoiceNumber } : {}),
        }],
      };
    }
  }
  return {
    version: MAINTENANCE_PAYMENT_LEDGER_VERSION,
    policies: structuredClone(store.policies),
    allocations,
  };
}

export function emptyMaintenancePaymentLedger() {
  return { version: MAINTENANCE_PAYMENT_LEDGER_VERSION, policies: {}, allocations: {} };
}

// Version 1 is the existing owner-protected prepaid policy store. Accepting it
// here lets a deployment introduce the month ledger without rewriting or
// trusting the non-authoritative copy on each client profile.
export function normalizeMaintenancePaymentLedger(rawLedger) {
  if (!isRecord(rawLedger)) return null;
  if (Number(rawLedger.version) === 1 && isRecord(rawLedger.policies)) {
    return legacyBillingStoreToLedger(rawLedger);
  }
  if (Number(rawLedger.version) !== MAINTENANCE_PAYMENT_LEDGER_VERSION) return null;
  if (!isRecord(rawLedger.allocations)) return null;
  const policyStore = normalizeMaintenanceBillingStore({
    version: 1,
    policies: rawLedger.policies == null ? {} : rawLedger.policies,
  });
  if (!policyStore) return null;
  const allocations = {};
  for (const [rawClientId, rawMonths] of Object.entries(rawLedger.allocations)) {
    const clientId = text(rawClientId);
    if (!clientId || clientId !== rawClientId || clientId.length > 220 || !isRecord(rawMonths)) return null;
    const months = {};
    for (const [rawMonth, rawAllocation] of Object.entries(rawMonths)) {
      const month = normalizeMonthKey(rawMonth);
      const allocation = normalizeAllocation(rawAllocation);
      if (!month || month !== rawMonth || !allocation) return null;
      months[month] = allocation;
    }
    if (Object.keys(months).length) allocations[clientId] = months;
  }
  return {
    version: MAINTENANCE_PAYMENT_LEDGER_VERSION,
    policies: policyStore.policies,
    allocations,
  };
}

function earliestMonth(...values) {
  return values.flat().map(normalizeMonthKey).filter(Boolean).sort()[0] || "";
}

export function maintenancePaymentAllocationForMonth(rawLedger, rawClientId, rawMonth) {
  const ledger = normalizeMaintenancePaymentLedger(rawLedger);
  const clientId = text(rawClientId);
  const month = normalizeMonthKey(rawMonth);
  const allocation = ledger?.allocations?.[clientId]?.[month];
  return allocation ? structuredClone(allocation) : null;
}

function allocationShare(totalCents, count, index) {
  if (!count) return 0;
  const base = Math.trunc(totalCents / count);
  return base + (index < Math.abs(totalCents % count) ? Math.sign(totalCents) : 0);
}

export function assignMaintenancePaymentSourceAcrossMonths(rawLedger, {
  clientId: rawClientId,
  months: rawMonths,
  source: rawSource,
  status = "paid",
  totalCents,
  amountsCents,
  expectedCents,
  note,
  updatedAt,
  updatedBy,
  replaceSourceAssignments = true,
} = {}) {
  const ledger = rawLedger == null
    ? emptyMaintenancePaymentLedger()
    : normalizeMaintenancePaymentLedger(rawLedger);
  const clientId = text(rawClientId);
  const source = normalizeAllocationSource(rawSource);
  const normalizedStatus = text(status).toLowerCase();
  const months = [...new Set((Array.isArray(rawMonths) ? rawMonths : [])
    .map(normalizeMonthKey)
    .filter(Boolean))].sort();
  if (!ledger || !clientId || clientId.length > 220 || !source || !PERSISTED_STATUSES.has(normalizedStatus) || !months.length) {
    return null;
  }
  if (amountsCents != null && !isRecord(amountsCents)) return null;
  if (totalCents != null && !Number.isSafeInteger(Number(totalCents))) return null;
  if (expectedCents != null && !Number.isSafeInteger(Number(expectedCents))) return null;
  if (amountsCents && Object.entries(amountsCents).some(([month, amount]) => (
    !normalizeMonthKey(month) || !Number.isSafeInteger(Number(amount))
  ))) return null;

  const next = structuredClone(ledger);
  next.allocations[clientId] ||= {};
  const identity = sourceIdentity(source);
  if (replaceSourceAssignments) {
    for (const [month, cell] of Object.entries(next.allocations[clientId])) {
      const remaining = cell.sources.filter((candidate) => sourceIdentity(candidate) !== identity);
      if (!remaining.length) delete next.allocations[clientId][month];
      else next.allocations[clientId][month] = { ...cell, sources: remaining };
    }
  }

  const splitTotal = totalCents != null
    ? Number(totalCents)
    : (Number.isSafeInteger(source.amountCents) ? source.amountCents : 0);
  months.forEach((month, index) => {
    const explicit = amountsCents && hasOwn(amountsCents, month) ? Number(amountsCents[month]) : null;
    const amountCents = explicit == null ? allocationShare(splitTotal, months.length, index) : explicit;
    const existing = next.allocations[clientId][month];
    const sources = (existing?.sources || []).filter((candidate) => sourceIdentity(candidate) !== identity);
    sources.push({ ...source, amountCents });
    next.allocations[clientId][month] = {
      status: normalizedStatus,
      sources,
      allocatedCents: sources.reduce((sum, candidate) => sum + (Number(candidate.amountCents) || 0), 0),
      ...(expectedCents != null ? { expectedCents: Number(expectedCents) } : (existing?.expectedCents != null ? { expectedCents: existing.expectedCents } : {})),
      ...(text(note) ? { note: text(note).slice(0, 1200) } : (existing?.note ? { note: existing.note } : {})),
      ...(text(updatedAt) ? { updatedAt: text(updatedAt).slice(0, 80) } : (existing?.updatedAt ? { updatedAt: existing.updatedAt } : {})),
      ...(text(updatedBy) ? { updatedBy: text(updatedBy).slice(0, 220) } : (existing?.updatedBy ? { updatedBy: existing.updatedBy } : {})),
    };
  });
  return normalizeMaintenancePaymentLedger(next);
}

export function assignMaintenanceInvoiceMonths(rawLedger, {
  clientId,
  monthKeys,
  invoice,
  payment,
  expectedCents,
  status = "paid",
  note,
  actor,
  updatedAt,
} = {}) {
  const paymentId = text(payment?.id);
  const qbPaymentId = text(payment?.qbId);
  const source = paymentId || qbPaymentId
    ? {
      kind: "payment",
      paymentId,
      qbPaymentId,
      invoiceId: text(invoice?.id),
      qbInvoiceId: text(invoice?.qbId || invoice?.Id),
      invoiceNumber: text(invoice?.number || invoice?.DocNumber),
    }
    : {
      kind: "invoice",
      invoiceId: text(invoice?.id),
      qbInvoiceId: text(invoice?.qbId || invoice?.Id),
      invoiceNumber: text(invoice?.number || invoice?.DocNumber),
    };
  const totalCents = payment
    ? moneyToCents(payment?.appliedAmount ?? payment?.total ?? payment?.amount)
    : invoiceTotalCents(invoice);
  return assignMaintenancePaymentSourceAcrossMonths(rawLedger, {
    clientId,
    months: monthKeys,
    source,
    status,
    totalCents,
    expectedCents,
    note,
    updatedAt,
    updatedBy: actor,
  });
}

export function setMaintenancePaymentMonthOverride(rawLedger, {
  clientId,
  monthKey,
  status,
  source,
  expectedCents,
  allocatedCents,
  note,
  actor,
  updatedAt,
} = {}) {
  return assignMaintenancePaymentSourceAcrossMonths(rawLedger, {
    clientId,
    months: [monthKey],
    source,
    status,
    totalCents: allocatedCents,
    expectedCents,
    note,
    updatedAt,
    updatedBy: actor,
  });
}

export function clearMaintenancePaymentMonths(rawLedger, {
  clientId: rawClientId,
  monthKeys: rawMonthKeys,
  source: rawSource,
} = {}) {
  const ledger = normalizeMaintenancePaymentLedger(rawLedger);
  const clientId = text(rawClientId);
  const monthKeys = [...new Set((Array.isArray(rawMonthKeys) ? rawMonthKeys : [])
    .map(normalizeMonthKey)
    .filter(Boolean))];
  const source = rawSource == null ? null : normalizeAllocationSource(rawSource);
  if (!ledger || !clientId || !monthKeys.length || (rawSource != null && !source)) return null;
  const next = structuredClone(ledger);
  if (!next.allocations[clientId]) return next;
  for (const month of monthKeys) {
    const cell = next.allocations[clientId][month];
    if (!cell) continue;
    if (!source) {
      delete next.allocations[clientId][month];
      continue;
    }
    const identity = sourceIdentity(source);
    const sources = cell.sources.filter((candidate) => sourceIdentity(candidate) !== identity);
    if (!sources.length) delete next.allocations[clientId][month];
    else {
      next.allocations[clientId][month] = {
        ...cell,
        sources,
        allocatedCents: sources.reduce((sum, candidate) => sum + (candidate.amountCents || 0), 0),
      };
    }
  }
  if (!Object.keys(next.allocations[clientId]).length) delete next.allocations[clientId];
  return normalizeMaintenancePaymentLedger(next);
}

function clientIdOf(client) {
  return text(client?.id || client?.clientId);
}

function clientNameOf(client) {
  return text(client?.name || client?.clientName || client?.displayName) || "Unnamed client";
}

function expectedMonthlyCents(client) {
  const direct = moneyToCents(client?.monthlyRate ?? client?.maintenanceRate ?? client?.price);
  if (direct > 0) return direct;
  const rates = client?.serviceRates || client?.rates || client?.planRates;
  if (isRecord(rates)) {
    const total = Object.values(rates).reduce((sum, value) => sum + Math.max(0, moneyToCents(value)), 0);
    if (total > 0) return total;
  }
  if (Array.isArray(client?.plans)) {
    const total = client.plans.reduce((sum, plan) => sum + Math.max(0, moneyToCents(plan?.rate ?? plan?.monthlyRate)), 0);
    if (total > 0) return total;
  }
  return 0;
}

function recurringClient(client) {
  return ["weekly", "biweekly", "monthly"].includes(recurringMaintenanceCadence({}, client));
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const QUICKBOOKS_ADDRESS_SUFFIX = /^(?:\d+[a-z]?(?:[-/]\d+[a-z]?)?\s+).+\b(?:st(?:reet)?|rd|road|ave(?:nue)?|blvd|boulevard|dr|drive|ln|lane|ct|court|cir|circle|way|trl|trail|pike|hwy|highway|pl|place|ter|terrace|pkwy|parkway|run|loop|row|path)\.?$/i;

function quickBooksClientNameBeforeAddress(value) {
  // QuickBooks display names can append a property address. Strip only the
  // explicit spaced separator and a street-shaped suffix, never arbitrary text.
  const match = text(value).match(/^(.+?)\s+-\s+(.+)$/);
  if (!match || !QUICKBOOKS_ADDRESS_SUFFIX.test(match[2].trim())) return "";
  return normalizedName(match[1]);
}

function invoiceClientId(invoice, clients, uniqueClientByName) {
  const direct = text(invoice?.clientId || invoice?.customerId);
  if (direct && clients.some((client) => clientIdOf(client) === direct)) return direct;
  const qbCustomerId = text(invoice?.qbCustomerId || invoice?.CustomerRef?.value);
  if (qbCustomerId) {
    const matches = clients.filter((client) => text(client?.qbId || client?.qbCustomerId) === qbCustomerId);
    if (matches.length === 1) return clientIdOf(matches[0]);
    if (matches.length > 1) return "";
  }
  const invoiceClientName = invoice?.clientName || invoice?.customerName || invoice?.CustomerRef?.name;
  const exact = uniqueClientByName.get(normalizedName(invoiceClientName));
  if (exact) return exact;
  const beforeAddress = quickBooksClientNameBeforeAddress(invoiceClientName);
  return beforeAddress ? (uniqueClientByName.get(beforeAddress) || "") : "";
}

function invoiceTotalCents(invoice) {
  return Math.max(0, moneyToCents(invoice?.total ?? invoice?.amount ?? invoice?.subtotal ?? invoice?.TotalAmt));
}

function invoiceBalanceCents(invoice) {
  if (hasOwn(invoice, "balance")) return Math.max(0, moneyToCents(invoice.balance));
  if (hasOwn(invoice, "Balance")) return Math.max(0, moneyToCents(invoice.Balance));
  const status = text(invoice?.status).toLowerCase();
  return status === "paid" ? 0 : invoiceTotalCents(invoice);
}

function invoiceSource(invoice, amountCents) {
  return normalizeAllocationSource({
    kind: "invoice",
    invoiceId: invoice?.id,
    qbInvoiceId: invoice?.qbId || invoice?.Id,
    invoiceNumber: invoice?.number || invoice?.DocNumber,
    amountCents,
  });
}

function invoiceLineRecords(invoice) {
  if (Array.isArray(invoice?.lineItems) && invoice.lineItems.length) return invoice.lineItems;
  if (Array.isArray(invoice?.items) && invoice.items.length) return invoice.items;
  if (Array.isArray(invoice?.lines) && invoice.lines.length) return invoice.lines;
  if (Array.isArray(invoice?.Line) && invoice.Line.length) return invoice.Line;
  return [];
}

function qbReference(rawReference) {
  if (rawReference == null) return { id: "", name: "" };
  if (!isRecord(rawReference)) return { id: text(rawReference), name: "" };
  return {
    id: text(rawReference.value || rawReference.id || rawReference.Id),
    name: text(rawReference.name || rawReference.Name),
  };
}

function normalizeHistoricalInvoiceLine(rawLine) {
  const salesDetail = isRecord(rawLine?.SalesItemLineDetail) ? rawLine.SalesItemLineDetail : null;
  const reference = qbReference(
    rawLine?.qbItemRef
      || rawLine?.quickBooksItemRef
      || rawLine?.quickbooksItemRef
      || rawLine?.itemRef
      || rawLine?.ItemRef
      || salesDetail?.ItemRef,
  );
  const detailType = text(rawLine?.DetailType || rawLine?.detailType);
  const hasDirectAmount = hasOwn(rawLine, "amount") || hasOwn(rawLine, "Amount");
  const directAmount = hasOwn(rawLine, "amount") ? rawLine.amount : rawLine?.Amount;
  const directAmountNumber = typeof directAmount === "number"
    ? directAmount
    : Number(text(directAmount).replace(/[$,\s]/g, ""));
  const qty = Number(rawLine?.qty ?? rawLine?.quantity ?? salesDetail?.Qty ?? 1);
  const unitPrice = Number(rawLine?.unitPrice ?? rawLine?.rate ?? rawLine?.price ?? salesDetail?.UnitPrice);
  const amountCents = hasDirectAmount && Number.isFinite(directAmountNumber)
    ? Math.round(directAmountNumber * 100)
    : (Number.isFinite(qty) && Number.isFinite(unitPrice) ? Math.round(qty * unitPrice * 100) : null);
  const taxReference = qbReference(salesDetail?.TaxCodeRef || rawLine?.TaxCodeRef);
  return {
    rawLine,
    detailType,
    isSalesLine: !detailType || detailType === "SalesItemLineDetail",
    description: text(
      rawLine?.desc
        || rawLine?.description
        || rawLine?.Description
        || rawLine?.name
        || rawLine?.itemName
        || reference.name,
    ),
    itemId: reference.id,
    itemName: reference.name,
    kind: text(rawLine?.kind || rawLine?.type || rawLine?.category || rawLine?.chargeType),
    amountCents,
    qty,
    unitPrice,
    serviceMonth: normalizeMonthKey(
      rawLine?.maintenanceMonth
        || rawLine?.serviceMonth
        || rawLine?.serviceDate
        || rawLine?.servicePeriodStart
        || rawLine?.serviceStartDate
        || salesDetail?.ServiceDate,
    ),
    taxable: rawLine?.taxable === true
      || /^(?:tax|taxable|t)$/i.test(taxReference.id)
      || /^(?:tax|taxable|t)$/i.test(taxReference.name),
  };
}

function normalizedHistoricalInvoiceLines(invoice) {
  return invoiceLineRecords(invoice).map(normalizeHistoricalInvoiceLine);
}

function invoiceDescription(invoice) {
  return [
    invoice?.description,
    invoice?.memo,
    invoice?.notes,
    invoice?.privateNote,
    ...normalizedHistoricalInvoiceLines(invoice).flatMap((line) => [line.description, line.itemName, line.kind]),
  ].map(text).filter(Boolean).join(" ").toLowerCase();
}

const MAINTENANCE_WORDING = /\bmaintenance\b|weekly\s+service|bi[\s-]*weekly\s+service|monthly\s+service/;
const PREPAY_WORDING = /\bpre[\s-]*paid\b|\bprepayment\b|\bannual\b|\bfull[\s-]*season\b|\bseason[\s-]*pass\b|\bmultiple\s+months?\b/;
const NON_MAINTENANCE_WORDING = /\brepair\b|\binstall(?:ation)?\b|\breplace(?:ment)?\b|\bequipment\b|\bmaterial(?:s)?\b|\bproduct(?:s)?\b|\bpart(?:s)?\b|\bconstruction\b|\brenovation\b|\bservice\s*call\b|\bemergency\b|\bdiagnostic\b|\bpond\s+clean(?:ing|out)\b|\bclean[-\s]*out\b/;
const GENERIC_SERVICE_WORDING = /(^|\s)service(?:s)?($|\s)/;
const EXACT_GENERIC_SERVICE_WORDING = /^service(?:s)?$/;

function invoiceTransactionMonth(invoice) {
  return normalizeMonthKey(
    invoice?.date
      || invoice?.issuedDate
      || invoice?.issueDate
      || invoice?.txnDate
      || invoice?.TxnDate
      || invoice?.createdAt
      || invoice?.created_at,
  );
}

function explicitServiceMonths(invoice) {
  const direct = [
    invoice?.maintenanceMonth,
    invoice?.serviceMonth,
    invoice?.billingMonth,
    invoice?.periodMonth,
    invoice?.serviceDate,
    invoice?.servicePeriodStart,
    invoice?.serviceStartDate,
    ...normalizedHistoricalInvoiceLines(invoice).map((line) => line.serviceMonth),
  ];
  return [...new Set(direct.map(normalizeMonthKey).filter(Boolean))].sort();
}

function invoiceLinkedVisitIds(invoice) {
  const direct = [
    invoice?.sourceStopId,
    invoice?.sourceVisitId,
    invoice?.stopId,
    invoice?.visitId,
    ...(Array.isArray(invoice?.sourceStopIds) ? invoice.sourceStopIds : []),
    ...(Array.isArray(invoice?.sourceVisitIds) ? invoice.sourceVisitIds : []),
    ...(Array.isArray(invoice?.stopIds) ? invoice.stopIds : []),
    ...(Array.isArray(invoice?.visitIds) ? invoice.visitIds : []),
    ...(Array.isArray(invoice?.lineItems)
      ? invoice.lineItems.flatMap((line) => [
        line?.sourceStopId,
        line?.sourceVisitId,
        line?.stopId,
        line?.visitId,
      ])
      : []),
  ];
  return [...new Set(direct.map(text).filter(Boolean))].sort();
}

export function flattenMaintenanceSchedule(schedule = []) {
  const flattened = [];
  for (const entry of Array.isArray(schedule) ? schedule : []) {
    if (!isRecord(entry)) continue;
    if (!Array.isArray(entry.stops)) {
      flattened.push(entry);
      continue;
    }
    const dayDate = text(entry.date || entry.scheduledDate || entry.day);
    for (const stop of entry.stops) {
      if (!isRecord(stop)) continue;
      const stopDate = text(stop.date || stop.scheduledDate || stop.visitDate);
      flattened.push(stopDate || !dayDate ? stop : { ...stop, date: dayDate });
    }
  }
  return flattened;
}

function scheduleStopIds(stop, clientId = "") {
  return [...new Set([
    stop?.sid,
    stop?.stopId,
    stop?.visitId,
    stop?.reportId,
    stop?.completionId,
    text(stop?.id) !== clientId ? stop?.id : "",
  ].map(text).filter(Boolean))];
}

function buildMaintenanceScheduleEvidence(schedule, clients) {
  const clientById = new Map(clients.map((client) => [clientIdOf(client), client]));
  const byClientAndMonth = new Map();
  const byId = new Map();
  const earliestByClient = new Map();
  if (!Array.isArray(schedule)) return { byClientAndMonth, byId, earliestByClient };
  for (const stop of flattenMaintenanceSchedule(schedule)) {
    const directClientId = text(stop?.clientId);
    const legacyClientId = text(stop?.id);
    const clientId = clientById.has(directClientId)
      ? directClientId
      : (clientById.has(legacyClientId) ? legacyClientId : "");
    const client = clientById.get(clientId);
    const month = scheduleDate(stop);
    if (!clientId || !client || !month || !isRecurringMaintenanceStop(stop, client)) continue;
    const evidence = {
      stop,
      clientId,
      month,
      completed: completedStop(stop),
      serviceDate: text(stop?.date || stop?.scheduledDate || stop?.visitDate),
    };
    for (const id of scheduleStopIds(stop, clientId)) byId.set(id, evidence);
    const key = `${clientId}|${month}`;
    const current = byClientAndMonth.get(key) || { visitCount: 0, completedCount: 0, serviceDates: [], visits: [] };
    current.visitCount += 1;
    if (evidence.completed) current.completedCount += 1;
    current.serviceDates.push(evidence.serviceDate);
    current.visits.push(evidence);
    byClientAndMonth.set(key, current);
    const previous = earliestByClient.get(clientId);
    if (!previous || month < previous) earliestByClient.set(clientId, month);
  }
  return { byClientAndMonth, byId, earliestByClient };
}

function explicitInvoiceAllocations(invoice) {
  const exact = invoice?.maintenanceAllocations || invoice?.monthAllocations;
  if (Array.isArray(exact)) {
    const allocations = exact.map((entry) => ({
      month: normalizeMonthKey(entry?.month || entry?.monthKey),
      amountCents: hasOwn(entry || {}, "amountCents") ? Number(entry.amountCents) : moneyToCents(entry?.amount),
    }));
    if (allocations.length && allocations.every((entry) => entry.month && Number.isSafeInteger(entry.amountCents) && entry.amountCents >= 0)) {
      return allocations;
    }
  }
  const rawMonths = invoice?.maintenanceMonths
    || invoice?.billingMonths
    || invoice?.coverageMonths
    || invoice?.serviceMonths;
  const values = Array.isArray(rawMonths) ? rawMonths : (typeof rawMonths === "string" ? rawMonths.split(/[,;\s]+/) : []);
  const months = [...new Set(values.map(normalizeMonthKey).filter(Boolean))].sort();
  if (!months.length) return [];
  const total = invoiceTotalCents(invoice);
  return months.map((month, index) => ({ month, amountCents: allocationShare(total, months.length, index) }));
}

function explicitDatedLineAllocations(invoice) {
  const rawLines = Array.isArray(invoice?.lines) && invoice.lines.length
    ? invoice.lines
    : (Array.isArray(invoice?.lineItems) ? invoice.lineItems : []);
  if (!rawLines.length) return [];

  const byMonth = new Map();
  let allocatedCents = 0;
  const invoiceCents = invoiceTotalCents(invoice);
  if (!(invoiceCents > 0)) return [];
  for (const line of rawLines) {
    const month = normalizeMonthKey(
      line?.maintenanceMonth
        || line?.serviceMonth
        || line?.serviceDate
        || line?.servicePeriodStart
        || line?.serviceStartDate,
    );
    const hasDirectAmount = hasOwn(line || {}, "amount");
    const rawDirectAmount = typeof line?.amount === "number"
      ? line.amount
      : Number(text(line?.amount).replace(/[$,\s]/g, ""));
    if (hasDirectAmount && !Number.isFinite(rawDirectAmount)) return [];
    const directAmount = hasDirectAmount ? Math.round(rawDirectAmount * 100) : null;
    const qty = Number(line?.qty ?? line?.quantity ?? 1);
    const unitPrice = Number(line?.unitPrice ?? line?.rate ?? line?.price);
    const calculatedAmount = Number.isFinite(qty) && Number.isFinite(unitPrice)
      ? Math.round(qty * unitPrice * 100)
      : null;
    const amountCents = directAmount == null ? calculatedAmount : directAmount;
    if (!month || !Number.isSafeInteger(amountCents) || amountCents <= 0) return [];
    byMonth.set(month, (byMonth.get(month) || 0) + amountCents);
    allocatedCents += amountCents;
  }

  if (byMonth.size < 2 || allocatedCents !== invoiceCents) return [];
  return [...byMonth.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, amountCents]) => ({ month, amountCents }));
}

function invoiceLooksLikeMaintenance(invoice, { clientId = "", scheduleEvidence = null } = {}) {
  const description = invoiceDescription(invoice);
  if (NON_MAINTENANCE_WORDING.test(description)) return false;
  if (explicitInvoiceAllocations(invoice).length) return true;
  if (invoice?.recurringMaintenance === true || text(invoice?.billingMode).toLowerCase().includes("maintenance")) return true;
  if (MAINTENANCE_WORDING.test(description)) return true;

  const linked = invoiceLinkedVisitIds(invoice)
    .map((id) => scheduleEvidence?.byId?.get(id))
    .filter(Boolean);
  if (linked.length && linked.every((entry) => entry.clientId === clientId)) return true;

  const serviceMonths = explicitServiceMonths(invoice);
  const month = serviceMonths.length === 1 ? serviceMonths[0] : invoiceTransactionMonth(invoice);
  return !!(
    clientId
      && month
      && GENERIC_SERVICE_WORDING.test(description)
      && scheduleEvidence?.byClientAndMonth?.has(`${clientId}|${month}`)
  );
}

function linkedPaymentAllocations(payment) {
  const values = payment?.invoiceAllocations || payment?.linkedInvoices || payment?.allocations;
  if (!Array.isArray(values)) return [];
  return values.map((entry) => ({
    qbInvoiceId: text(entry?.qbInvoiceId || entry?.invoiceId || entry?.TxnId),
    amountCents: hasOwn(entry || {}, "amountCents") ? Number(entry.amountCents) : moneyToCents(entry?.amount ?? entry?.Amount),
  })).filter((entry) => entry.qbInvoiceId && Number.isSafeInteger(entry.amountCents));
}

function paymentIndexes(payments) {
  const bySpsId = new Map();
  const byQbId = new Map();
  const appliedByInvoice = new Map();
  for (const payment of payments) {
    const spsId = text(payment?.id);
    const qbId = text(payment?.qbId);
    if (spsId) bySpsId.set(spsId, payment);
    if (qbId) byQbId.set(qbId, payment);
    for (const allocation of linkedPaymentAllocations(payment)) {
      const current = appliedByInvoice.get(allocation.qbInvoiceId) || { amountCents: 0, paymentIds: [] };
      current.amountCents += allocation.amountCents;
      current.paymentIds.push(text(payment?.qbId || payment?.id));
      appliedByInvoice.set(allocation.qbInvoiceId, current);
    }
  }
  return { bySpsId, byQbId, appliedByInvoice };
}

function invoiceIndexes(invoices) {
  const bySpsId = new Map();
  const byQbId = new Map();
  const byNumber = new Map();
  for (const invoice of invoices) {
    const spsId = text(invoice?.id);
    const qbId = text(invoice?.qbId || invoice?.Id);
    if (spsId) bySpsId.set(spsId, invoice);
    if (qbId) byQbId.set(qbId, invoice);
    const number = text(invoice?.number || invoice?.DocNumber);
    if (number) {
      if (byNumber.has(number)) byNumber.set(number, null);
      else byNumber.set(number, invoice);
    }
  }
  return { bySpsId, byQbId, byNumber };
}

function suspiciousMultiMonthInvoice(invoice, expectedCents, hasDirectMonthEvidence) {
  if (hasDirectMonthEvidence) return false;
  const description = invoiceDescription(invoice);
  if (PREPAY_WORDING.test(description)) return true;
  if (!(expectedCents > 0)) return false;
  const ratio = invoiceTotalCents(invoice) / expectedCents;
  return ratio >= 1.75;
}

function finiteOwnNumber(record, key) {
  if (!hasOwn(record, key)) return null;
  const value = typeof record[key] === "number"
    ? record[key]
    : Number(text(record[key]).replace(/[$,\s%]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function invoiceHasKnownZeroTaxAndDiscount(invoice) {
  const taxAmount = finiteOwnNumber(invoice, "taxAmount");
  const taxRate = finiteOwnNumber(invoice, "taxRate");
  if (taxAmount !== 0 || taxRate !== 0) return false;
  if (!hasOwn(invoice, "discountType") || !hasOwn(invoice, "discount")) return false;
  const discountType = text(invoice?.discountType).toLowerCase();
  if (discountType && !["none", "off", "false", "0"].includes(discountType)) return false;
  const discount = text(invoice?.discount);
  if (discount && moneyToCents(discount) !== 0) return false;
  return invoice?.qbHasUnsupportedLines === false
    && (!Array.isArray(invoice?.qbUnsupportedLineTypes) || invoice.qbUnsupportedLineTypes.length === 0);
}

function lineHasKnownNonTaxableCode(line) {
  if (hasOwn(line?.rawLine, "taxable")) return line.rawLine.taxable === false;
  const salesDetail = isRecord(line?.rawLine?.SalesItemLineDetail)
    ? line.rawLine.SalesItemLineDetail
    : null;
  const reference = qbReference(salesDetail?.TaxCodeRef || line?.rawLine?.TaxCodeRef);
  return /^(?:non|nontaxable|0)$/i.test(reference.id)
    || /^(?:non|nontaxable|0)$/i.test(reference.name);
}

function invoiceIsFullyPaidByQuickBooks(invoice, appliedFromPaymentsCents = 0) {
  const totalCents = invoiceTotalCents(invoice);
  if (!(totalCents > 0)) return false;
  const hasBalance = hasOwn(invoice, "balance") || hasOwn(invoice, "Balance");
  const rawBalance = hasOwn(invoice, "balance") ? invoice.balance : invoice?.Balance;
  const parsedBalance = typeof rawBalance === "number"
    ? rawBalance
    : Number(text(rawBalance).replace(/[$,\s]/g, ""));
  const knownZeroBalance = hasBalance && Number.isFinite(parsedBalance) && Math.round(parsedBalance * 100) === 0;
  return knownZeroBalance || appliedFromPaymentsCents >= totalCents;
}

function weakHistoricalSeriesEvidence({ invoice, clientId, client, appliedFromPaymentsCents = 0 }) {
  const qbInvoiceId = text(invoice?.qbId || invoice?.Id);
  const serviceMonths = explicitServiceMonths(invoice);
  const month = serviceMonths.length === 1
    ? serviceMonths[0]
    : invoiceTransactionMonth(invoice);
  const totalCents = invoiceTotalCents(invoice);
  const knownMonthlyCents = expectedMonthlyCents(client);
  const lines = normalizedHistoricalInvoiceLines(invoice);
  const combinedDescription = invoiceDescription(invoice);
  const genericOrBlank = [
    invoice?.description,
    invoice?.memo,
    invoice?.notes,
    invoice?.privateNote,
    ...lines.flatMap((line) => [line.description, line.itemName, line.kind]),
  ].map((value) => text(value).toLowerCase()).filter(Boolean)
    .every((value) => EXACT_GENERIC_SERVICE_WORDING.test(value));

  if (!genericOrBlank || PREPAY_WORDING.test(combinedDescription) || NON_MAINTENANCE_WORDING.test(combinedDescription)) {
    return null;
  }
  if (!qbInvoiceId) return { reviewReason: "generic invoice has no stable QuickBooks invoice identity" };
  if (!invoiceIsFullyPaidByQuickBooks(invoice, appliedFromPaymentsCents)) {
    return { reviewReason: "generic invoice is not confirmed fully paid by QuickBooks" };
  }
  if (!month) return { reviewReason: "generic invoice has no usable transaction or service month" };
  if (!(knownMonthlyCents > 0) || totalCents !== knownMonthlyCents) {
    return { reviewReason: "generic invoice amount does not match the saved maintenance rate" };
  }
  if (serviceMonths.length > 1) {
    return { reviewReason: "generic invoice contains more than one possible service month" };
  }
  if (lines.length !== 1 || !lines[0].isSalesLine) {
    return { reviewReason: "generic invoice does not contain exactly one safe service line" };
  }
  const line = lines[0];
  const serviceKind = text(line.kind).toLowerCase() === "service"
    || EXACT_GENERIC_SERVICE_WORDING.test(text(line.itemName).toLowerCase());
  if (!serviceKind || !line.itemId) {
    return { reviewReason: "generic invoice has no stable QuickBooks service item identity" };
  }
  if (
    !Number.isSafeInteger(line.amountCents)
      || line.amountCents <= 0
      || !Number.isFinite(line.qty)
      || line.qty <= 0
      || !Number.isFinite(line.unitPrice)
      || line.unitPrice <= 0
      || line.amountCents !== totalCents
  ) {
    return { reviewReason: "generic invoice line amount does not exactly match the invoice total" };
  }
  if (
    line.taxable
      || !lineHasKnownNonTaxableCode(line)
      || !invoiceHasKnownZeroTaxAndDiscount(invoice)
      || invoice?.lateFeeAppliedAt
      || line?.rawLine?.isLateFee === true
      || /late\s*fee/i.test(`${line.description} ${line.itemName} ${line.kind}`)
  ) {
    return { reviewReason: "generic invoice includes tax, discount, late-fee, or unsupported line evidence" };
  }
  return {
    qbInvoiceId,
    clientId,
    month,
    totalCents,
    itemId: line.itemId,
    seriesKey: `${clientId}|${line.itemId}|${totalCents}`,
  };
}

function monthOrdinal(month) {
  const normalized = normalizeMonthKey(month);
  if (!normalized) return null;
  const [year, monthNumber] = normalized.split("-").map(Number);
  return (year * 12) + monthNumber - 1;
}

function qualifyingWeakSeriesMonths(candidates) {
  const byMonth = new Map();
  const qbIds = new Set();
  for (const candidate of candidates) {
    if (qbIds.has(candidate.qbInvoiceId)) return new Set();
    qbIds.add(candidate.qbInvoiceId);
    const entries = byMonth.get(candidate.month) || [];
    entries.push(candidate);
    byMonth.set(candidate.month, entries);
  }
  if ([...byMonth.values()].some((entries) => entries.length !== 1)) return new Set();
  const months = [...byMonth.keys()].sort();
  const qualifying = new Set();
  for (let startIndex = 0; startIndex < months.length; startIndex += 1) {
    const startOrdinal = monthOrdinal(months[startIndex]);
    const windowMonths = months.filter((month) => {
      const ordinal = monthOrdinal(month);
      return ordinal >= startOrdinal && ordinal <= startOrdinal + 4;
    });
    if (windowMonths.length >= 3) windowMonths.forEach((month) => qualifying.add(month));
  }
  return qualifying;
}

function classifyHistoricalMaintenanceInvoice({ invoice, clientId, client, scheduleEvidence }) {
  const totalCents = invoiceTotalCents(invoice);
  const description = invoiceDescription(invoice);
  if (NON_MAINTENANCE_WORDING.test(description)) {
    return { kind: "skip", reason: "repair, cleaning, product, equipment, or material wording", months: [] };
  }
  const explicit = explicitInvoiceAllocations(invoice);
  if (explicit.length) {
    return {
      kind: "candidate",
      reason: "explicit-months",
      allocations: explicit,
      months: explicit.map((entry) => entry.month),
    };
  }
  const maintenanceFlag = invoice?.recurringMaintenance === true
    || text(invoice?.billingMode).toLowerCase().includes("maintenance");
  const maintenanceWording = maintenanceFlag || MAINTENANCE_WORDING.test(description);
  const datedLines = explicitDatedLineAllocations(invoice);
  if (maintenanceWording && datedLines.length) {
    return {
      kind: "candidate",
      reason: "explicit-line-service-months",
      allocations: datedLines,
      months: datedLines.map((entry) => entry.month),
    };
  }

  const linkedIds = invoiceLinkedVisitIds(invoice);
  if (linkedIds.length) {
    const linked = linkedIds.map((id) => scheduleEvidence.byId.get(id)).filter(Boolean);
    if (!linked.length) {
      return { kind: "ambiguous", reason: "linked recurring visit was not found", months: [] };
    }
    if (linked.some((entry) => entry.clientId !== clientId)) {
      return { kind: "ambiguous", reason: "linked visits belong to a different client", months: [] };
    }
    const months = [...new Set(linked.map((entry) => entry.month))].sort();
    return {
      kind: "candidate",
      reason: "linked-recurring-visits",
      months,
      allocations: months.map((month, index) => ({
        month,
        amountCents: allocationShare(totalCents, months.length, index),
      })),
    };
  }

  const serviceMonths = explicitServiceMonths(invoice);
  if (serviceMonths.length > 1) {
    return { kind: "ambiguous", reason: "more than one service month is present", months: serviceMonths };
  }
  const transactionMonth = invoiceTransactionMonth(invoice);
  const month = serviceMonths[0] || transactionMonth;
  const genericService = GENERIC_SERVICE_WORDING.test(description);

  if (maintenanceWording) {
    if (!month) return { kind: "ambiguous", reason: "maintenance invoice has no usable service month", months: [] };
    if (suspiciousMultiMonthInvoice(invoice, expectedMonthlyCents(client), serviceMonths.length === 1)) {
      return {
        kind: "ambiguous",
        reason: "invoice may be a multi-month prepayment but has no explicit covered months",
        months: [month],
      };
    }
    return {
      kind: "candidate",
      reason: serviceMonths.length ? "explicit-service-month" : "maintenance-transaction-month",
      months: [month],
      allocations: [{ month, amountCents: totalCents }],
    };
  }

  const hasRecurringVisit = !!(
    month && scheduleEvidence.byClientAndMonth.has(`${clientId}|${month}`)
  );
  const genericRecurringPrepayment = !!(
    genericService
      && recurringClient(client)
      && suspiciousMultiMonthInvoice(invoice, expectedMonthlyCents(client), serviceMonths.length === 1)
  );
  if (genericRecurringPrepayment) {
    return {
      kind: "ambiguous",
      reason: "invoice may be a multi-month prepayment but has no explicit covered months",
      months: month ? [month] : [],
    };
  }
  if (genericService && month && hasRecurringVisit) {
    return {
      kind: "candidate",
      reason: "generic-service-with-recurring-visit",
      months: [month],
      allocations: [{ month, amountCents: totalCents }],
    };
  }
  if (genericService && recurringClient(client) && month) {
    return {
      kind: "ambiguous",
      reason: "generic service invoice needs a repeated paid QuickBooks series before it can be treated as maintenance",
      months: [month],
    };
  }
  return { kind: "skip", reason: "no maintenance evidence", months: month ? [month] : [] };
}

function invoiceReceiptIdentity(invoice) {
  return {
    invoiceId: text(invoice?.id),
    qbInvoiceId: text(invoice?.qbId || invoice?.Id),
    invoiceNumber: text(invoice?.number || invoice?.DocNumber),
    invoiceMonth: invoiceTransactionMonth(invoice),
    amountCents: invoiceTotalCents(invoice),
  };
}

function invoiceEvidenceMonths(invoice) {
  const allocatedMonths = explicitInvoiceAllocations(invoice).map((entry) => entry.month).filter(Boolean);
  if (allocatedMonths.length) return [...new Set(allocatedMonths)].sort();
  const serviceMonths = explicitServiceMonths(invoice);
  if (serviceMonths.length) return serviceMonths;
  const transactionMonth = invoiceTransactionMonth(invoice);
  return transactionMonth ? [transactionMonth] : [];
}

function invoiceEvidenceForMonth({ invoice, month, clientId, client, scheduleEvidence, paymentIndex }) {
  if (!invoiceEvidenceMonths(invoice).includes(month)) return null;
  const qbInvoiceId = text(invoice?.qbId || invoice?.Id);
  const appliedCents = paymentIndex.appliedByInvoice.get(qbInvoiceId)?.amountCents || 0;
  const classification = classifyHistoricalMaintenanceInvoice({
    invoice,
    clientId,
    client,
    scheduleEvidence,
  });
  return {
    ...invoiceReceiptIdentity(invoice),
    status: statusFromInvoice(invoice, appliedCents),
    coverageKind: classification.kind === "candidate"
      ? "maintenance"
      : (classification.kind === "ambiguous" ? "review" : "other_work"),
    reason: classification.reason || "invoice exists for this month",
  };
}

function paymentSourceMatchesInvoiceEvidence(source, evidence) {
  const sourceSpsId = text(source?.invoiceId);
  const sourceQbId = text(source?.qbInvoiceId);
  const evidenceSpsId = text(evidence?.invoiceId);
  const evidenceQbId = text(evidence?.qbInvoiceId);
  if (sourceSpsId && evidenceSpsId && sourceSpsId === evidenceSpsId) return true;
  if (sourceQbId && evidenceQbId && sourceQbId === evidenceQbId) return true;
  if (sourceSpsId || sourceQbId || evidenceSpsId || evidenceQbId) return false;
  const sourceNumber = text(source?.invoiceNumber);
  const evidenceNumber = text(evidence?.invoiceNumber);
  return !!sourceNumber && sourceNumber === evidenceNumber;
}

function invoiceWithinYearRange(invoice, fromYear, toYear, scheduleEvidence = null) {
  const months = [
    invoiceTransactionMonth(invoice),
    ...explicitInvoiceAllocations(invoice).map((entry) => entry.month),
    ...explicitServiceMonths(invoice),
    ...invoiceLinkedVisitIds(invoice).map((id) => scheduleEvidence?.byId?.get(id)?.month),
  ].filter(Boolean);
  return months.some((month) => {
    const year = Number(month.slice(0, 4));
    return year >= fromYear && year <= toYear;
  });
}

function sourceAlreadyAssigned(rawLedger, clientId, source) {
  const identity = sourceIdentity(source);
  const found = [];
  for (const [month, allocation] of Object.entries(rawLedger?.allocations?.[clientId] || {})) {
    if (allocation.sources.some((candidate) => sourceIdentity(candidate) === identity)) found.push(month);
  }
  return found.sort();
}

/**
 * Conservatively reconciles historical QuickBooks evidence into the protected
 * month ledger. The function never changes an invoice or a protected prepaid
 * policy. Ambiguous evidence is returned to the caller for owner review.
 */
export function reconcileMaintenancePaymentHistory({
  clients = [],
  invoices = [],
  payments = [],
  schedule = [],
  ledger: rawLedger = null,
  fromYear = new Date().getFullYear(),
  toYear = fromYear,
  actor = "",
  updatedAt = "",
} = {}) {
  const normalizedFromYear = Number(fromYear);
  const normalizedToYear = Number(toYear);
  const ledger = rawLedger == null ? emptyMaintenancePaymentLedger() : normalizeMaintenancePaymentLedger(rawLedger);
  const valid = ledger
    && Array.isArray(clients)
    && Array.isArray(invoices)
    && Array.isArray(payments)
    && Array.isArray(schedule)
    && Number.isInteger(normalizedFromYear)
    && Number.isInteger(normalizedToYear)
    && normalizedFromYear >= 1900
    && normalizedToYear <= 2200
    && normalizedFromYear <= normalizedToYear;
  const receipt = {
    version: 1,
    fromYear: normalizedFromYear,
    toYear: normalizedToYear,
    ...(text(actor) ? { actor: text(actor).slice(0, 220) } : {}),
    ...(text(updatedAt) ? { updatedAt: text(updatedAt).slice(0, 80) } : {}),
    counts: {
      assignedMonths: 0,
      alreadyAssigned: 0,
      ambiguousInvoices: 0,
      unmatchedClientInvoices: 0,
      skippedNonMaintenance: 0,
    },
    clients: [],
    ambiguousInvoices: [],
    unmatchedClientInvoices: [],
    skippedNonMaintenance: [],
  };
  if (!valid) return { ledger: ledger || emptyMaintenancePaymentLedger(), receipt: { ...receipt, invalidInput: true } };

  const clientList = clients.filter((client) => clientIdOf(client));
  const clientById = new Map(clientList.map((client) => [clientIdOf(client), client]));
  const nameGroups = new Map();
  for (const client of clientList) {
    const key = normalizedName(clientNameOf(client));
    if (!key) continue;
    const ids = nameGroups.get(key) || [];
    ids.push(clientIdOf(client));
    nameGroups.set(key, ids);
  }
  const uniqueClientByName = new Map(
    [...nameGroups.entries()].filter(([, ids]) => ids.length === 1).map(([name, ids]) => [name, ids[0]]),
  );
  const scheduleEvidence = buildMaintenanceScheduleEvidence(schedule, clientList);
  const paymentIndex = paymentIndexes(payments);
  const candidates = [];
  const weakSeriesCandidates = [];

  for (const invoice of invoices.filter((entry) => (
    invoiceWithinYearRange(entry, normalizedFromYear, normalizedToYear, scheduleEvidence)
  ))) {
    const clientId = invoiceClientId(invoice, clientList, uniqueClientByName);
    if (!clientId) {
      receipt.unmatchedClientInvoices.push({ ...invoiceReceiptIdentity(invoice), clientName: text(invoice?.clientName || invoice?.customerName) });
      continue;
    }
    const applied = paymentIndex.appliedByInvoice.get(text(invoice?.qbId || invoice?.Id))?.amountCents || 0;
    const classification = classifyHistoricalMaintenanceInvoice({
      invoice,
      clientId,
      client: clientById.get(clientId),
      scheduleEvidence,
    });
    const weakEvidence = classification.kind === "candidate"
      ? null
      : weakHistoricalSeriesEvidence({
        invoice,
        clientId,
        client: clientById.get(clientId),
        appliedFromPaymentsCents: applied,
      });
    const detail = {
      ...invoiceReceiptIdentity(invoice),
      clientId,
      clientName: clientNameOf(clientById.get(clientId)),
      reason: classification.reason,
      months: classification.months || [],
    };
    if (weakEvidence?.seriesKey) {
      weakSeriesCandidates.push({ invoice, clientId, ...weakEvidence });
      continue;
    }
    if (classification.kind === "ambiguous") {
      receipt.ambiguousInvoices.push({
        ...detail,
        ...(weakEvidence?.reviewReason && /repeated paid QuickBooks series/i.test(classification.reason)
          ? { reason: weakEvidence.reviewReason }
          : {}),
      });
      continue;
    }
    if (classification.kind === "skip") {
      if (weakEvidence?.reviewReason) {
        receipt.ambiguousInvoices.push({ ...detail, reason: weakEvidence.reviewReason });
      } else {
        receipt.skippedNonMaintenance.push(detail);
      }
      continue;
    }
    const status = statusFromInvoice(invoice, applied);
    if (!["paid", "due"].includes(status)) {
      receipt.ambiguousInvoices.push({ ...detail, reason: `invoice is ${status || "not settled"}` });
      continue;
    }
    const allocations = classification.allocations.filter((entry) => {
      const year = Number(entry.month.slice(0, 4));
      return year >= normalizedFromYear && year <= normalizedToYear;
    });
    if (allocations.length) candidates.push({ invoice, clientId, status, classification, allocations });
  }

  const weakSeriesGroups = new Map();
  for (const candidate of weakSeriesCandidates) {
    const group = weakSeriesGroups.get(candidate.seriesKey) || [];
    group.push(candidate);
    weakSeriesGroups.set(candidate.seriesKey, group);
  }
  for (const group of weakSeriesGroups.values()) {
    const qualifyingMonths = qualifyingWeakSeriesMonths(group);
    for (const candidate of group) {
      const detail = {
        ...invoiceReceiptIdentity(candidate.invoice),
        clientId: candidate.clientId,
        clientName: clientNameOf(clientById.get(candidate.clientId)),
        reason: "generic or blank paid invoice needs at least three matching months in a rolling five-month QuickBooks series",
        months: [candidate.month],
        qbItemRef: candidate.itemId,
      };
      if (!qualifyingMonths.has(candidate.month)) {
        receipt.ambiguousInvoices.push(detail);
        continue;
      }
      candidates.push({
        invoice: candidate.invoice,
        clientId: candidate.clientId,
        status: "paid",
        classification: {
          reason: "stable-paid-quickbooks-service-series",
          months: [candidate.month],
          qbItemRef: candidate.itemId,
        },
        allocations: [{ month: candidate.month, amountCents: candidate.totalCents }],
      });
    }
  }

  let nextLedger = structuredClone(ledger);
  const clientReceipt = new Map();
  const receiptForClient = (clientId) => {
    if (!clientReceipt.has(clientId)) {
      clientReceipt.set(clientId, {
        clientId,
        clientName: clientNameOf(clientById.get(clientId)),
        coverageStartMonth: scheduleEvidence.earliestByClient.get(clientId) || "",
        assignedMonths: [],
        alreadyAssignedMonths: [],
      });
    }
    return clientReceipt.get(clientId);
  };

  const pendingCandidates = [];
  for (const candidate of candidates) {
    const detail = {
      ...invoiceReceiptIdentity(candidate.invoice),
      clientId: candidate.clientId,
      clientName: clientNameOf(clientById.get(candidate.clientId)),
      reason: candidate.classification.reason,
      months: candidate.allocations.map((entry) => entry.month),
    };
    const source = invoiceSource(candidate.invoice, invoiceTotalCents(candidate.invoice));
    if (!source) {
      receipt.ambiguousInvoices.push({ ...detail, reason: "invoice has no stable source identity" });
      continue;
    }
    const previouslyAssignedMonths = new Set(sourceAlreadyAssigned(nextLedger, candidate.clientId, source));
    if (previouslyAssignedMonths.size) {
      const clientEntry = receiptForClient(candidate.clientId);
      clientEntry.coverageStartMonth = earliestMonth(
        clientEntry.coverageStartMonth,
        ...previouslyAssignedMonths,
        ...candidate.allocations.map((entry) => entry.month),
      );
      clientEntry.alreadyAssignedMonths.push(...previouslyAssignedMonths);
      receipt.counts.alreadyAssigned += previouslyAssignedMonths.size;
      continue;
    }
    pendingCandidates.push({ ...candidate, source });
  }

  const conflicts = new Map();
  for (const candidate of pendingCandidates) {
    for (const allocation of candidate.allocations) {
      const key = `${candidate.clientId}|${allocation.month}`;
      const entries = conflicts.get(key) || [];
      entries.push(candidate);
      conflicts.set(key, entries);
    }
  }
  const conflictCandidates = new Set(
    [...conflicts.values()].filter((entries) => entries.length > 1).flat(),
  );

  for (const candidate of pendingCandidates) {
    const detail = {
      ...invoiceReceiptIdentity(candidate.invoice),
      clientId: candidate.clientId,
      clientName: clientNameOf(clientById.get(candidate.clientId)),
      reason: "more than one invoice points to the same maintenance month",
      months: candidate.allocations.map((entry) => entry.month),
    };
    if (conflictCandidates.has(candidate)) {
      receipt.ambiguousInvoices.push(detail);
      continue;
    }
    const blockedMonths = [];
    for (const allocation of candidate.allocations) {
      const policy = maintenanceBillingPolicyForClient({ version: 1, policies: nextLedger.policies }, candidate.clientId);
      const protectedMonth = policy && monthsBetween(policy.coveredFrom, policy.coveredThrough).includes(allocation.month);
      if (nextLedger.allocations?.[candidate.clientId]?.[allocation.month] || protectedMonth) {
        blockedMonths.push(allocation.month);
      }
    }
    if (blockedMonths.length) {
      receipt.ambiguousInvoices.push({
        ...detail,
        reason: "maintenance month is already covered by a different saved allocation or protected prepaid policy",
        months: blockedMonths,
      });
      continue;
    }
    const available = [];
    const amountsCents = {};
    for (const allocation of candidate.allocations) {
      const month = allocation.month;
      const clientEntry = receiptForClient(candidate.clientId);
      clientEntry.coverageStartMonth = earliestMonth(clientEntry.coverageStartMonth, month);
      available.push(month);
      amountsCents[month] = allocation.amountCents;
    }
    if (!available.length) continue;
    const reconciled = assignMaintenancePaymentSourceAcrossMonths(nextLedger, {
      clientId: candidate.clientId,
      months: available,
      source: candidate.source,
      status: candidate.status,
      amountsCents,
      expectedCents: expectedMonthlyCents(clientById.get(candidate.clientId)),
      note: `Historical QuickBooks reconciliation: ${candidate.classification.reason}.`,
      updatedAt,
      updatedBy: actor,
      replaceSourceAssignments: false,
    });
    if (!reconciled) {
      receipt.ambiguousInvoices.push({ ...detail, reason: "the allocation could not be normalized safely" });
      continue;
    }
    nextLedger = reconciled;
    const clientEntry = receiptForClient(candidate.clientId);
    clientEntry.assignedMonths.push(...available);
    receipt.counts.assignedMonths += available.length;
  }

  const byStableInvoiceIdentity = (left, right) => [
    left.invoiceMonth.localeCompare(right.invoiceMonth),
    left.invoiceNumber.localeCompare(right.invoiceNumber),
    left.qbInvoiceId.localeCompare(right.qbInvoiceId),
    left.invoiceId.localeCompare(right.invoiceId),
  ].find((value) => value !== 0) || 0;
  receipt.ambiguousInvoices.sort(byStableInvoiceIdentity);
  receipt.unmatchedClientInvoices.sort(byStableInvoiceIdentity);
  receipt.skippedNonMaintenance.sort(byStableInvoiceIdentity);
  receipt.clients = [...clientReceipt.values()].map((entry) => ({
    ...entry,
    assignedMonths: [...new Set(entry.assignedMonths)].sort(),
    alreadyAssignedMonths: [...new Set(entry.alreadyAssignedMonths)].sort(),
  })).sort((left, right) => left.clientName.localeCompare(right.clientName) || left.clientId.localeCompare(right.clientId));
  receipt.counts.ambiguousInvoices = receipt.ambiguousInvoices.length;
  receipt.counts.unmatchedClientInvoices = receipt.unmatchedClientInvoices.length;
  receipt.counts.skippedNonMaintenance = receipt.skippedNonMaintenance.length;
  return { ledger: nextLedger, receipt };
}

function resolveSource(source, { invoices, payments, policy, month }) {
  if (source.kind === "invoice" || source.kind === "refund") {
    const invoice = invoices.bySpsId.get(text(source.invoiceId))
      || invoices.byQbId.get(text(source.qbInvoiceId))
      || invoices.byNumber.get(text(source.invoiceNumber));
    if (invoice) return { valid: true, invoice };
  }
  if (source.kind === "payment" || source.kind === "refund") {
    const payment = payments.bySpsId.get(text(source.paymentId))
      || payments.byQbId.get(text(source.qbPaymentId));
    if (payment) return { valid: true, payment };
  }
  if (source.kind === "prepaid" && policy && monthsBetween(policy.coveredFrom, policy.coveredThrough).includes(month)) {
    return { valid: true, policy };
  }
  if (source.kind === "waiver" && source.waiverId) return { valid: true, waiver: true };
  return { valid: false };
}

function scheduleDate(stop) {
  return normalizeMonthKey(stop?.date || stop?.scheduledDate || stop?.visitDate || stop?.startAt || stop?.start);
}

function completedStop(stop) {
  const status = text(stop?.status || stop?.completionStatus).toLowerCase();
  return stop?.completed === true || !!stop?.completedAt || ["complete", "completed", "done", "finished"].includes(status);
}

function clientPlanExpectationForMonth(client, month, { inferredStart = "", exactEvidence = false } = {}) {
  if (exactEvidence) return "expected";

  const explicitStart = normalizeMonthKey(client?.maintenanceStartDate || client?.serviceStartDate || client?.startDate);
  const explicitEnd = normalizeMonthKey(client?.maintenanceEndDate || client?.serviceEndDate || client?.endDate);
  if (explicitStart && explicitEnd) {
    return month >= explicitStart && month <= explicitEnd ? "expected" : "not_expected";
  }
  if (explicitStart && month < explicitStart) return "not_expected";
  if (explicitEnd && month > explicitEnd) return "not_expected";

  const evidenceStart = normalizeMonthKey(inferredStart);
  if (!evidenceStart || month < evidenceStart) return "not_expected";

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (month < currentMonth) return "plan_history_needed";

  const inactive = text(client?.status).toLowerCase() === "inactive" || client?.active === false;
  return !inactive && recurringClient(client) ? "expected" : "not_expected";
}

function statusFromInvoice(invoice, appliedFromPaymentsCents = 0) {
  const rawStatus = text(invoice?.status).toLowerCase();
  if (/refund|void|reversed/.test(rawStatus) || invoiceTotalCents(invoice) < 0) return "refunded";
  const total = invoiceTotalCents(invoice);
  const balance = invoiceBalanceCents(invoice);
  const applied = Math.max(appliedFromPaymentsCents, Math.max(0, total - balance));
  if (total > 0 && (balance <= 0 || applied >= total || !!invoice?.paidDate)) return "paid";
  if (applied > 0 || (balance > 0 && balance < total)) return "partial";
  return "due";
}

function automaticCandidateForMonth({ invoice, month, expectedCents, paymentIndex }) {
  const explicit = explicitInvoiceAllocations(invoice);
  const total = invoiceTotalCents(invoice);
  const qbId = text(invoice?.qbId || invoice?.Id);
  const applied = paymentIndex.appliedByInvoice.get(qbId)?.amountCents || 0;
  if (explicit.length) {
    const allocation = explicit.find((entry) => entry.month === month);
    if (!allocation) return null;
    return {
      status: statusFromInvoice(invoice, applied),
      amountCents: allocation.amountCents,
      source: invoiceSource(invoice, allocation.amountCents),
      invoice,
    };
  }
  const invoiceMonth = invoiceTransactionMonth(invoice);
  if (invoiceMonth !== month) return null;
  if (expectedCents > 0 && total > expectedCents + 1) {
    return {
      status: "review",
      amountCents: total,
      source: invoiceSource(invoice, total),
      invoice,
      reason: "Invoice may cover more than one maintenance month. Assign its months before treating them as paid.",
    };
  }
  return {
    status: statusFromInvoice(invoice, applied),
    amountCents: total,
    source: invoiceSource(invoice, total),
    invoice,
  };
}

function summarizeCell({ expected, expectedCents, policy, manual, month, clientInvoices, indexes }) {
  if (!expected && !manual) {
    return { status: "not_expected", appliedCents: 0, sources: [], reasons: [] };
  }

  if (manual) {
    const resolved = manual.sources.map((source) => ({ source, ...resolveSource(source, { ...indexes, policy, month }) }));
    if (resolved.every((entry) => entry.valid)) {
      const invoices = resolved.map((entry) => entry.invoice).filter(Boolean);
      let status = manual.status;
      if (invoices.length && !["waived", "prepaid", "review", "refunded"].includes(status)) {
        const statuses = invoices.map((invoice) => statusFromInvoice(
          invoice,
          indexes.payments.appliedByInvoice.get(text(invoice?.qbId || invoice?.Id))?.amountCents || 0,
        ));
        status = statuses.includes("partial") ? "partial" : (statuses.includes("due") ? "due" : "paid");
      }
      return {
        status,
        appliedCents: manual.allocatedCents ?? manual.sources.reduce((sum, source) => sum + (source.amountCents || 0), 0),
        sources: manual.sources,
        reasons: manual.note ? [manual.note] : [],
        manual: true,
      };
    }
    return {
      status: "review",
      appliedCents: 0,
      sources: manual.sources,
      reasons: ["The saved month allocation no longer points to a valid invoice, payment, prepayment, or waiver."],
      manual: false,
    };
  }

  const candidates = clientInvoices.map((invoice) => automaticCandidateForMonth({
    invoice,
    month,
    expectedCents,
    paymentIndex: indexes.payments,
  })).filter(Boolean);
  const policyCoversMonth = policy && monthsBetween(policy.coveredFrom, policy.coveredThrough).includes(month);
  if (policyCoversMonth) {
    const policySourceIds = new Set([policy.sourceInvoiceId, policy.sourceInvoiceNumber].map(text).filter(Boolean));
    const unrelated = candidates.filter((candidate) => {
      const invoiceIds = [candidate.invoice?.id, candidate.invoice?.qbId, candidate.invoice?.Id, candidate.invoice?.number, candidate.invoice?.DocNumber].map(text);
      return !invoiceIds.some((id) => id && policySourceIds.has(id));
    });
    if (unrelated.length) {
      return {
        status: "review",
        appliedCents: unrelated.reduce((sum, candidate) => sum + candidate.amountCents, 0),
        sources: unrelated.map((candidate) => candidate.source).filter(Boolean),
        reasons: ["A separate maintenance invoice overlaps this protected prepaid month."],
      };
    }
    return {
      status: "prepaid",
      appliedCents: expectedCents,
      sources: [{
        kind: "prepaid",
        policyId: `prepaid:${policy.coveredFrom}:${policy.coveredThrough}`,
        ...(policy.sourceInvoiceId ? { invoiceId: policy.sourceInvoiceId } : {}),
        ...(policy.sourceInvoiceNumber ? { invoiceNumber: policy.sourceInvoiceNumber } : {}),
      }],
      reasons: [],
    };
  }

  if (!candidates.length) return { status: expected ? "missing" : "not_expected", appliedCents: 0, sources: [], reasons: [] };
  if (candidates.length > 1 || candidates.some((candidate) => candidate.status === "review")) {
    return {
      status: "review",
      appliedCents: candidates.reduce((sum, candidate) => sum + candidate.amountCents, 0),
      sources: candidates.map((candidate) => candidate.source).filter(Boolean),
      reasons: candidates.map((candidate) => candidate.reason).filter(Boolean).concat(
        candidates.length > 1 ? ["More than one invoice covers this maintenance month."] : [],
      ),
    };
  }
  const candidate = candidates[0];
  return {
    status: candidate.status,
    appliedCents: candidate.amountCents,
    sources: candidate.source ? [candidate.source] : [],
    reasons: candidate.reason ? [candidate.reason] : [],
  };
}

export function buildMaintenancePaymentLedgerRows({
  clients = [],
  invoices = [],
  payments = [],
  billingStore = null,
  ledger: rawLedger = null,
  schedule,
  year = new Date().getFullYear(),
} = {}) {
  const normalizedYear = Number(year);
  if (!Number.isInteger(normalizedYear) || normalizedYear < 1900 || normalizedYear > 2200) return [];
  const ledger = rawLedger == null ? emptyMaintenancePaymentLedger() : normalizeMaintenancePaymentLedger(rawLedger);
  if (!ledger || !Array.isArray(clients) || !Array.isArray(invoices) || !Array.isArray(payments)) return [];
  const protectedBillingStore = normalizeMaintenanceBillingStore(billingStore)
    || normalizeMaintenanceBillingStore({ version: 1, policies: ledger.policies });
  const clientList = clients.filter((client) => clientIdOf(client));
  const nameGroups = new Map();
  for (const client of clientList) {
    const key = normalizedName(clientNameOf(client));
    if (!key) continue;
    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(clientIdOf(client));
  }
  const uniqueClientByName = new Map(
    [...nameGroups.entries()].filter(([, ids]) => ids.length === 1).map(([name, ids]) => [name, ids[0]]),
  );
  const invoicesByClient = new Map();
  for (const invoice of invoices) {
    const clientId = invoiceClientId(invoice, clientList, uniqueClientByName);
    if (!clientId) continue;
    if (!invoicesByClient.has(clientId)) invoicesByClient.set(clientId, []);
    invoicesByClient.get(clientId).push(invoice);
  }
  const scheduleEvidence = buildMaintenanceScheduleEvidence(schedule, clientList);
  const scheduleByClientAndMonth = scheduleEvidence.byClientAndMonth;
  const invoiceIndex = invoiceIndexes(invoices);
  const paymentIndex = paymentIndexes(payments);
  const months = Array.from({ length: 12 }, (_, index) => `${normalizedYear}-${String(index + 1).padStart(2, "0")}`);
  const invoiceOnlyEvidenceByClient = new Map();
  for (const client of clientList) {
    const clientId = clientIdOf(client);
    const hasInvoiceEvidence = (invoicesByClient.get(clientId) || []).some((invoice) => {
      const classification = classifyHistoricalMaintenanceInvoice({
        invoice,
        clientId,
        client,
        scheduleEvidence,
      });
      if (!["candidate", "ambiguous"].includes(classification.kind)) return false;
      return classification.months.some((month) => month.startsWith(`${normalizedYear}-`));
    });
    invoiceOnlyEvidenceByClient.set(clientId, hasInvoiceEvidence);
  }

  const included = clientList.filter((client) => {
    const clientId = clientIdOf(client);
    return recurringClient(client)
      || !!protectedBillingStore?.policies?.[clientId]
      || !!ledger.allocations[clientId]
      || [...scheduleByClientAndMonth.keys()].some((key) => key.startsWith(`${clientId}|`))
      || invoiceOnlyEvidenceByClient.get(clientId);
  });

  return included.map((client) => {
    const clientId = clientIdOf(client);
    const baseExpectedCents = expectedMonthlyCents(client);
    const policy = protectedBillingStore ? maintenanceBillingPolicyForClient(protectedBillingStore, clientId) : null;
    const allClientInvoices = invoicesByClient.get(clientId) || [];
    const clientInvoices = allClientInvoices.filter((invoice) => (
      invoiceLooksLikeMaintenance(invoice, { clientId, scheduleEvidence })
    ));
    const invoiceEvidenceStart = earliestMonth(clientInvoices.flatMap((invoice) => (
      explicitInvoiceAllocations(invoice).map((entry) => entry.month).concat(
        explicitServiceMonths(invoice),
        invoiceTransactionMonth(invoice),
      )
    )));
    const allocationStart = earliestMonth(Object.keys(ledger.allocations?.[clientId] || {}));
    const inferredStart = earliestMonth(
      policy?.coveredFrom,
      scheduleEvidence.earliestByClient.get(clientId),
      invoiceEvidenceStart,
      allocationStart,
    );
    const monthRows = months.map((month) => {
      const manual = ledger.allocations?.[clientId]?.[month] || null;
      const scheduled = scheduleByClientAndMonth.get(`${clientId}|${month}`);
      const expectedCents = manual?.expectedCents ?? baseExpectedCents;
      const policyCoversMonth = !!(
        policy && monthsBetween(policy.coveredFrom, policy.coveredThrough).includes(month)
      );
      const maintenanceInvoiceEvidence = clientInvoices.some((invoice) => !!automaticCandidateForMonth({
        invoice,
        month,
        expectedCents,
        paymentIndex,
      }));
      const expectation = clientPlanExpectationForMonth(client, month, {
        inferredStart,
        exactEvidence: !!manual || !!scheduled || policyCoversMonth || maintenanceInvoiceEvidence,
      });
      const expected = expectation === "expected";
      const payment = summarizeCell({
        expected,
        expectedCents,
        policy,
        manual,
        month,
        clientInvoices,
        indexes: { invoices: invoiceIndex, payments: paymentIndex },
      });
      const rawMonthInvoiceEvidence = allClientInvoices.map((invoice) => invoiceEvidenceForMonth({
        invoice,
        month,
        clientId,
        client,
        scheduleEvidence,
        paymentIndex,
      })).filter(Boolean);
      const monthInvoiceEvidence = rawMonthInvoiceEvidence.map((evidence) => {
        const linked = (payment.sources || []).some((source) => paymentSourceMatchesInvoiceEvidence(source, evidence));
        return linked ? { ...evidence, linkedToCoverage: true } : evidence;
      });
      if (expectation === "plan_history_needed" && payment.status === "not_expected") {
        payment.status = "plan_history_needed";
        payment.reasons = ["A dated maintenance plan or recurring visit is needed before this month can be treated as unpaid."];
      }
      payment.evidenceState = payment.status === "plan_history_needed"
        ? "plan_history_needed"
        : (payment.status === "not_expected"
        ? "not_expected"
        : (payment.status === "review"
          ? "unallocated_paid_history"
          : (["paid", "prepaid", "waived"].includes(payment.status)
            ? "covered"
            : (["due", "partial"].includes(payment.status) ? "matching_invoice_open" : "no_matching_payment"))));
      const scheduleState = Array.isArray(schedule) ? {
        expected,
        visitCount: scheduled?.visitCount || 0,
        completedCount: scheduled?.completedCount || 0,
        openCount: Math.max(0, (scheduled?.visitCount || 0) - (scheduled?.completedCount || 0)),
        serviceDates: scheduled?.serviceDates || [],
      } : null;
      return {
        month,
        expectedCents,
        payment,
        invoiceEvidence: monthInvoiceEvidence,
        schedule: scheduleState,
      };
    });
    return {
      clientId,
      clientName: clientNameOf(client),
      expectedMonthlyCents: baseExpectedCents,
      coverageStartMonth: inferredStart,
      months: monthRows,
      byMonth: Object.fromEntries(monthRows.map((entry) => [entry.month, entry])),
    };
  }).sort((left, right) => left.clientName.localeCompare(right.clientName));
}

export const deriveMaintenancePaymentLedgerRows = buildMaintenancePaymentLedgerRows;
