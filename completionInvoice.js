import {
  isRecurringMaintenanceStop,
  prepaidMaintenanceCoverage,
  recurringMaintenanceCadence,
} from "./maintenanceBilling.js";

export const COMPLETION_INVOICE_VERSION = 1;

const text = (value) => String(value == null ? "" : value).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const sameId = (left, right) => text(left) !== "" && text(left) === text(right);
const safeIdPart = (value) => text(value)
  .replace(/[^a-zA-Z0-9_-]+/g, "_")
  .replace(/^_+|_+$/g, "");
const number = (value) => {
  const parsed = Number.parseFloat(String(value == null ? "" : value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const rounded = (value) => Math.round((number(value) + Number.EPSILON) * 1e10) / 1e10;
const decimal = (value) => String(rounded(value));
const copy = (value) => {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function dateParts(value) {
  const raw = text(value);
  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, month, day, year] = match.map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }
  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }
  return null;
}

function periodForDate(value) {
  const parts = dateParts(value);
  return parts ? `${parts.year}-${String(parts.month).padStart(2, "0")}` : "";
}

function formatMDY(value) {
  const parts = dateParts(value);
  return parts
    ? `${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")}/${parts.year}`
    : "";
}

function addDaysMDY(value, amount) {
  const parts = dateParts(value);
  if (!parts) return "";
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + Math.max(0, Number.parseInt(amount, 10) || 0));
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

function monthLabel(period) {
  const [year, month] = text(period).split("-").map(Number);
  if (!year || !month) return text(period);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function timestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function scheduledRows(schedule) {
  const rows = [];
  list(schedule).forEach((day, dayIndex) => {
    list(day?.stops).forEach((stop, stopIndex) => {
      rows.push({ day, dayIndex, date: text(day?.date), stop, stopIndex });
    });
  });
  return rows;
}

function stopClientId(stop) {
  return stop?.clientId ?? stop?.id;
}

function findScheduledStop(schedule, sid) {
  const matches = scheduledRows(schedule).filter((row) => sameId(row.stop?.sid, sid));
  if (matches.length > 1) throw new Error("This stop appears more than once on the schedule.");
  return matches[0] || null;
}

function isEstimateStop(stop, entry) {
  return !!(
    text(stop?.source).toLowerCase() === "estimate"
    || text(stop?.sourceEstimateId)
    || text(entry?.sourceEstimateId)
  );
}

function isMonthlyAggregatedMaintenanceStop(stop, client) {
  if (!isRecurringMaintenanceStop(stop, client)) return false;
  const billingMode = text(stop.billingMode || stop.billingDisposition).toLowerCase();
  if (["monthly-maintenance", "monthly_maintenance"].includes(billingMode)) return true;
  return new Set(["weekly", "biweekly"]).has(recurringMaintenanceCadence(stop, client));
}

function markerReceiptId(completed, sid) {
  const marker = completed && completed[sid];
  return marker && typeof marker === "object" ? text(marker.receiptId) : "";
}

function isCompleted(completed, sid) {
  return !!(completed && completed[sid]);
}

function historyEntryForStop(client, sid, completed) {
  const receiptId = markerReceiptId(completed, sid);
  const matches = list(client?.history).filter((entry) => (
    sameId(entry?.sid, sid)
    || (!!receiptId && text(entry?.completionReceiptId) === receiptId)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function nextInvoiceNumber(invoices, invoicing) {
  const start = Number.parseInt(invoicing?.nextNumber, 10) || 1001;
  const values = list(invoices)
    .map((invoice) => Number.parseInt(text(invoice?.number).replace(/\D/g, ""), 10))
    .filter(Number.isFinite);
  const next = Math.max(values.length ? Math.max(...values) + 1 : start, start);
  const prefix = invoicing?.numberPrefix != null ? String(invoicing.numberPrefix) : "INV-";
  return `${prefix}${next}`;
}

function savedVisitCharge(entry) {
  for (const value of [entry?.quoted_price, entry?.invoice]) {
    const raw = text(value).replace(/[$,]/g, "");
    if (!raw) continue;
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return rounded(parsed);
  }
  return null;
}

function lineAmount(line) {
  return rounded(number(line?.qty) * number(line?.unitPrice));
}

function serviceLines(entry, stop, sourceStopId, sourceReceiptId) {
  const services = list(entry?.services);
  const priced = services.filter((service) => (
    typeof service === "object" && service != null && number(service.price ?? service.unitPrice) > 0
  ));
  if (priced.length) {
    const lines = priced.map((service, index) => ({
      id: `il_stop_${safeIdPart(sourceStopId)}_service_${safeIdPart(service.id || service.refId || index + 1)}`,
      desc: text(service.name || service.desc || service.description) || text(stop?.type) || "Service visit",
      qty: "1",
      unitPrice: decimal(service.price ?? service.unitPrice),
      unitCost: hasOwn(service, "cost") || hasOwn(service, "unitCost")
        ? decimal(service.cost ?? service.unitCost)
        : "",
      costKnown: hasOwn(service, "cost") || hasOwn(service, "unitCost"),
      taxable: false,
      kind: "service",
      ...(service.refId != null || service.id != null ? { refId: service.refId ?? service.id } : {}),
      sourceStopId,
      ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
    }));
    const savedCharge = savedVisitCharge(entry);
    if (savedCharge != null) {
      const serviceTotal = rounded(lines.reduce((sum, line) => sum + lineAmount(line), 0));
      const adjustment = rounded(savedCharge - serviceTotal);
      if (Math.abs(adjustment) >= 0.005) {
        lines.push({
          id: `il_stop_${safeIdPart(sourceStopId)}_service_adjustment`,
          desc: "Service price adjustment",
          qty: "1",
          unitPrice: decimal(adjustment),
          unitCost: "0",
          costKnown: true,
          taxable: false,
          kind: "service",
          sourceStopId,
          ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
        });
      }
    }
    return lines;
  }

  const fallback = savedVisitCharge(entry);
  if (!(fallback > 0)) return [];
  return [{
    id: `il_stop_${safeIdPart(sourceStopId)}_service`,
    desc: text(stop?.type || entry?.type) || "Service visit",
    qty: "1",
    unitPrice: decimal(fallback),
    unitCost: "",
    costKnown: false,
    taxable: false,
    kind: "service",
    sourceStopId,
    ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
  }];
}

function purchasedLines(entry, sourceStopId, sourceReceiptId) {
  const output = [];
  list(entry?.partsUsed).forEach((part, index) => {
    const qty = rounded(part?.qty);
    if (!part || part.bill === false || !(qty > 0)) return;
    const unitPrice = number(part.retailPer) || (number(part.retail) / qty);
    const costKnown = hasOwn(part, "costPer") || hasOwn(part, "cost");
    const unitCost = hasOwn(part, "costPer") ? number(part.costPer) : (number(part.cost) / qty);
    output.push({
      id: `il_stop_${safeIdPart(sourceStopId)}_part_${safeIdPart(part.id || index + 1)}`,
      desc: text(part.name) || "Part",
      qty: decimal(qty),
      unitPrice: decimal(unitPrice),
      unitCost: costKnown ? decimal(unitCost) : "",
      costKnown,
      taxable: part.taxable !== false,
      kind: "part",
      ...(part.id != null ? { refId: part.id } : {}),
      ...(text(part.unit) ? { unit: text(part.unit) } : {}),
      sourceStopId,
      ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
    });
  });
  list(entry?.productsPurchased).forEach((product, index) => {
    const qty = rounded(product?.qty);
    if (!product || product.bill === false || !(qty > 0)) return;
    const unitPrice = number(product.price) || (number(product.retail) / qty);
    const costKnown = hasOwn(product, "cost") || hasOwn(product, "costTotal");
    const unitCost = hasOwn(product, "cost") ? number(product.cost) : (number(product.costTotal) / qty);
    output.push({
      id: `il_stop_${safeIdPart(sourceStopId)}_product_${safeIdPart(product.id || index + 1)}`,
      desc: text(product.name) || "Product",
      qty: decimal(qty),
      unitPrice: decimal(unitPrice),
      unitCost: costKnown ? decimal(unitCost) : "",
      costKnown,
      taxable: product.taxable !== false,
      kind: "product",
      ...(product.id != null ? { refId: product.id } : {}),
      ...(text(product.unit) ? { unit: text(product.unit) } : {}),
      sourceStopId,
      ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
    });
  });
  return output;
}

function aggregatePurchasedLines(visits, period) {
  const groups = new Map();
  visits.forEach(({ stop, entry, receiptId }) => {
    purchasedLines(entry, text(stop.sid), receiptId).forEach((line) => {
      const key = [line.kind, text(line.refId), line.desc, line.unit || "", line.unitPrice, line.unitCost, line.taxable].join("|");
      const prior = groups.get(key);
      if (!prior) {
        groups.set(key, {
          ...line,
          id: `il_maint_${safeIdPart(period)}_${safeIdPart(line.kind)}_${safeIdPart(line.refId || line.desc)}_${groups.size + 1}`,
          sourceStopIds: [line.sourceStopId],
          sourceCompletionReceiptIds: line.sourceCompletionReceiptId ? [line.sourceCompletionReceiptId] : [],
        });
        return;
      }
      prior.qty = decimal(number(prior.qty) + number(line.qty));
      if (!prior.sourceStopIds.includes(line.sourceStopId)) prior.sourceStopIds.push(line.sourceStopId);
      if (line.sourceCompletionReceiptId && !prior.sourceCompletionReceiptIds.includes(line.sourceCompletionReceiptId)) {
        prior.sourceCompletionReceiptIds.push(line.sourceCompletionReceiptId);
      }
    });
  });
  return [...groups.values()].map((line) => {
    const next = { ...line };
    delete next.sourceStopId;
    delete next.sourceCompletionReceiptId;
    return next;
  });
}

function canonicalLine(line) {
  return {
    id: text(line?.id),
    desc: text(line?.desc),
    qty: text(line?.qty),
    unitPrice: text(line?.unitPrice),
    unitCost: text(line?.unitCost),
    costKnown: !!line?.costKnown,
    taxable: !!line?.taxable,
    kind: text(line?.kind),
    refId: line?.refId == null ? "" : text(line.refId),
    unit: text(line?.unit),
    sourceStopId: text(line?.sourceStopId),
    sourceCompletionReceiptId: text(line?.sourceCompletionReceiptId),
    sourceStopIds: list(line?.sourceStopIds).map(text),
    sourceCompletionReceiptIds: list(line?.sourceCompletionReceiptIds).map(text),
  };
}

function hash(value) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function completionInvoiceFingerprint(invoice) {
  const content = {
    number: text(invoice?.number),
    clientId: text(invoice?.clientId),
    clientName: text(invoice?.clientName),
    clientAddress: text(invoice?.clientAddress),
    clientEmail: text(invoice?.clientEmail),
    date: text(invoice?.date),
    dueDate: text(invoice?.dueDate),
    termsDays: text(invoice?.termsDays),
    lineItems: list(invoice?.lineItems).map(canonicalLine),
    taxRate: text(invoice?.taxRate),
    notes: text(invoice?.notes),
    source: text(invoice?.source),
    sourceStopId: text(invoice?.sourceStopId),
    sourceCompletionReceiptId: text(invoice?.sourceCompletionReceiptId),
    sourceStopIds: list(invoice?.sourceStopIds).map(text),
    sourceCompletionReceiptIds: list(invoice?.sourceCompletionReceiptIds).map(text),
    autoPeriod: text(invoice?.autoPeriod),
  };
  return `fnv1a:${hash(JSON.stringify(content))}`;
}

function finalizeAutoDraft(invoice) {
  const draft = {
    ...invoice,
    completionInvoiceVersion: COMPLETION_INVOICE_VERSION,
    autoGenerated: true,
    autoGeneratedBy: "stop-completion",
    qbSyncStatus: "local",
  };
  return { ...draft, autoDraftFingerprint: completionInvoiceFingerprint(draft) };
}

function buildDraftBase({ invoices, invoicing, client, lineItems, issueDate, createdAt, source }) {
  const dueDays = Number.parseInt(invoicing?.dueDays, 10);
  const termsDays = Number.isFinite(dueDays) ? dueDays : 15;
  const taxRate = invoicing?.taxRate == null ? "6" : String(number(invoicing.taxRate));
  const notes = invoicing?.terms == null
    ? "Thank you for your business. Payment is due within 15 days."
    : text(invoicing.terms);
  return {
    id: source.id,
    number: nextInvoiceNumber(invoices, invoicing),
    clientId: client.id,
    clientName: client.name || "",
    clientAddress: client.address || "",
    clientEmail: client.email || "",
    date: issueDate,
    dueDate: addDaysMDY(issueDate, termsDays),
    termsDays: String(termsDays),
    status: "Draft",
    lineItems,
    taxRate,
    notes,
    createdAt,
    // The stop-completion planner already has the authoritative client. Persist that
    // ownership with the visit provenance so a delayed or incomplete history refresh
    // cannot make a valid draft look as though it belongs to an unknown client.
    sourceVisitClientId: client.id,
    sourceVisitClientIds: [client.id],
    ...source.fields,
  };
}

function completionInvoiceForStop(invoices, stop) {
  const sid = text(stop?.sid);
  const deterministicId = sid ? `iv_stop_${safeIdPart(sid)}` : "";
  return list(invoices).filter((invoice) => (
    (!!deterministicId && text(invoice?.id) === deterministicId)
    || (!!sid && text(invoice?.sourceStopId) === sid)
    || (!!sid && list(invoice?.sourceStopIds).some((sourceSid) => text(sourceSid) === sid))
  ));
}

function completionInvoiceForPeriod(invoices, clientId, period) {
  const deterministicId = `iv_maint_${safeIdPart(clientId)}_${safeIdPart(period)}`;
  return list(invoices).filter((invoice) => (
    text(invoice?.id) === deterministicId
    || (
      sameId(invoice?.clientId, clientId)
      && text(invoice?.autoPeriod) === period
      && text(invoice?.autoGeneratedBy) === "stop-completion"
    )
  ));
}

function existingOutcome(matches, kind, extra = {}) {
  if (matches.length > 1) {
    return {
      status: "review_required",
      kind,
      reason: "duplicate-auto-drafts",
      invoiceIds: matches.map((invoice) => invoice.id),
      ...extra,
    };
  }
  if (matches.length === 1) {
    return {
      status: "existing",
      kind,
      invoiceId: matches[0].id,
      invoiceNumber: matches[0].number || "",
      ...extra,
    };
  }
  return null;
}

function planPrepaidMaintenance({
  invoices,
  invoicing,
  client,
  stop,
  entry,
  sourceReceiptId,
  issueDate,
  createdAt,
  coverage,
}) {
  const sourceStopId = text(stop.sid);
  const existingMatches = completionInvoiceForStop(invoices, stop);
  if (existingMatches.length > 1) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "review_required",
        kind: "prepaid-maintenance",
        reason: "multiple-invoices-reference-covered-stop",
        action: "preserve-invoices",
        invoiceIds: existingMatches.map((invoice) => invoice.id),
        sourceStopId,
      },
    };
  }
  if (existingMatches.length === 1) {
    const existing = existingMatches[0];
    if (text(existing.source) === "prepaid-maintenance-extras") {
      return {
        invoices,
        changed: false,
        outcome: existingOutcome(existingMatches, "prepaid-maintenance-extras", { sourceStopId }),
      };
    }
    return {
      invoices,
      changed: false,
      outcome: {
        status: "review_required",
        kind: "prepaid-maintenance",
        reason: "invoice-already-references-covered-stop",
        action: "preserve-invoice",
        invoiceId: existing.id,
        invoiceNumber: existing.number || "",
        sourceStopId,
      },
    };
  }

  const lineItems = purchasedLines(entry, sourceStopId, sourceReceiptId);
  if (!lineItems.length) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "covered",
        kind: "prepaid-maintenance",
        action: "no-draft",
        sourceStopId,
        coverage: copy(coverage.snapshot),
      },
    };
  }

  const draft = finalizeAutoDraft(buildDraftBase({
    invoices,
    invoicing,
    client,
    lineItems,
    issueDate,
    createdAt,
    source: {
      id: `iv_stop_${safeIdPart(sourceStopId)}`,
      fields: {
        source: "prepaid-maintenance-extras",
        sourceStopId,
        ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
        maintenanceBilling: copy(coverage.snapshot),
      },
    },
  }));
  return {
    invoices: [draft, ...list(invoices)],
    changed: true,
    outcome: {
      status: "created",
      kind: "prepaid-maintenance-extras",
      invoiceId: draft.id,
      invoiceNumber: draft.number,
      sourceStopId,
      extraLineCount: lineItems.length,
    },
  };
}

function untouchedAutoDraft(invoice) {
  if (text(invoice?.autoGeneratedBy) !== "stop-completion") return false;
  if (text(invoice?.status).toLowerCase() !== "draft") return false;
  if (invoice?.qbId || invoice?.qbPushed || invoice?.sentDate || invoice?.paidDate) return false;
  if (invoice?.locallyEdited || invoice?.qbPendingLocalEdits || invoice?.qbLocalChangesPending) return false;
  const saved = text(invoice?.autoDraftFingerprint);
  return !!saved && saved === completionInvoiceFingerprint(invoice);
}

function planReopen({ invoices, stop }) {
  if (isEstimateStop(stop)) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "linked",
        kind: "estimate",
        invoiceId: stop?.linkedInvoiceId || "",
        action: "preserve-linked-invoice",
      },
    };
  }

  const sid = text(stop?.sid);
  const matches = list(invoices).filter((invoice) => (
    text(invoice?.sourceStopId) === sid
    || list(invoice?.sourceStopIds).some((sourceSid) => text(sourceSid) === sid)
  ));
  if (!matches.length) {
    return { invoices, changed: false, outcome: { status: "none", kind: "none", action: "nothing-to-reopen" } };
  }
  if (matches.length !== 1) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "review_required",
        kind: "ambiguous",
        reason: "multiple-invoices-reference-stop",
        action: "preserve-invoices",
        invoiceIds: matches.map((invoice) => invoice.id),
        safeToRemove: false,
      },
    };
  }

  const invoice = matches[0];
  const kind = text(invoice.source) === "monthly-maintenance"
    ? "monthly"
    : text(invoice.source) === "prepaid-maintenance-extras"
      ? "prepaid-maintenance-extras"
      : "one-off";
  if (!untouchedAutoDraft(invoice)) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "review_required",
        kind,
        reason: "invoice-is-not-an-untouched-draft",
        action: "preserve-invoice",
        invoiceId: invoice.id,
        invoiceNumber: invoice.number || "",
        safeToRemove: false,
      },
    };
  }

  return {
    invoices: list(invoices).filter((candidate) => candidate !== invoice),
    changed: true,
    outcome: {
      status: "removed",
      kind,
      action: "remove-untouched-draft",
      invoiceId: invoice.id,
      invoiceNumber: invoice.number || "",
      safeToRemove: true,
    },
  };
}

/**
 * Purely plans the invoice side of a completed-stop transaction.
 *
 * Callers pass the post-completion `completed` map and post-completion client history. The returned
 * invoice array can then be included in the same versioned CAS batch as the completed stop. This
 * helper performs no I/O and never sends or syncs an invoice to QuickBooks.
 */
export function planCompletionInvoice({
  mode = "complete",
  invoices = [],
  invoicing = {},
  schedule = [],
  completed = {},
  stop,
  entry,
  client,
  receiptId = "",
  completedAt,
  now = completedAt || Date.now(),
  maintenanceBillingDecision = null,
} = {}) {
  if (!stop || !text(stop.sid)) throw new TypeError("A scheduled stop with an ID is required.");
  if (!client || client.id == null || text(client.id) === "") throw new TypeError("The stop client is required.");
  if (!sameId(stopClientId(stop), client.id)) throw new Error("The stop and invoice client must match.");
  if (mode === "reverse") return planReopen({ invoices, stop });
  if (mode !== "complete") throw new TypeError("Invoice planning mode must be complete or reverse.");

  if (isEstimateStop(stop, entry)) {
    const linkedInvoiceId = text(stop.linkedInvoiceId || entry?.linkedInvoiceId);
    return {
      invoices,
      changed: false,
      outcome: linkedInvoiceId
        ? { status: "linked", kind: "estimate", invoiceId: linkedInvoiceId, action: "preserve-linked-invoice" }
        : { status: "review_required", kind: "estimate", reason: "estimate-invoice-required", action: "create-or-link-estimate-invoice" },
    };
  }

  const scheduled = findScheduledStop(schedule, stop.sid);
  const authoritativeStop = scheduled?.stop || stop;
  if (authoritativeStop.cancelled) {
    return {
      invoices,
      changed: false,
      outcome: { status: "review_required", kind: "none", reason: "stop-cancelled" },
    };
  }
  const scheduledDate = scheduled?.date || entry?.date;
  const issueDate = formatMDY(completedAt || now) || formatMDY(scheduledDate);
  const createdAt = timestamp(now);
  const sourceReceiptId = text(receiptId || entry?.completionReceiptId || markerReceiptId(completed, stop.sid));
  const coverage = maintenanceBillingDecision && typeof maintenanceBillingDecision.covered === "boolean"
    ? maintenanceBillingDecision
    : prepaidMaintenanceCoverage({ client, stop: authoritativeStop, entry, scheduledDate });

  if (coverage.blocked) {
    return {
      invoices,
      changed: false,
      outcome: {
        status: "review_required",
        kind: "prepaid-maintenance",
        reason: coverage.reason,
        action: "fix-client-billing-policy",
      },
    };
  }

  if (coverage.covered) {
    if (!isCompleted(completed, stop.sid)) {
      return {
        invoices,
        changed: false,
        outcome: { status: "pending", kind: "prepaid-maintenance", reason: "stop-not-confirmed" },
      };
    }
    return planPrepaidMaintenance({
      invoices,
      invoicing,
      client,
      stop: authoritativeStop,
      entry,
      sourceReceiptId,
      issueDate,
      createdAt,
      coverage,
    });
  }

  if (isMonthlyAggregatedMaintenanceStop(authoritativeStop, client)) {
    const period = periodForDate(scheduledDate);
    if (!period) {
      return { invoices, changed: false, outcome: { status: "review_required", kind: "monthly", reason: "scheduled-date-invalid" } };
    }
    const existingMatches = completionInvoiceForPeriod(invoices, client.id, period);
    if (existingMatches.length > 1) {
      return {
        invoices,
        changed: false,
        outcome: existingOutcome(existingMatches, "monthly", { period }),
      };
    }
    const existingInvoice = existingMatches[0] || null;

    const visits = scheduledRows(schedule)
      .filter((row) => (
        periodForDate(row.date) === period
        && sameId(stopClientId(row.stop), client.id)
        && !row.stop?.cancelled
        && isMonthlyAggregatedMaintenanceStop(row.stop, client)
      ))
      .sort((left, right) => (
        formatMDY(left.date).localeCompare(formatMDY(right.date))
        || text(left.stop.sid).localeCompare(text(right.stop.sid))
      ));
    const incomplete = visits.filter((visit) => !isCompleted(completed, visit.stop.sid));
    if (incomplete.length) {
      return {
        invoices,
        changed: false,
        outcome: {
          status: "pending",
          kind: "monthly",
          period,
          visitCount: visits.length,
          completedVisitCount: visits.length - incomplete.length,
          remainingStopIds: incomplete.map((visit) => visit.stop.sid),
        },
      };
    }

    const visitEntries = [];
    for (const visit of visits) {
      const current = sameId(visit.stop.sid, stop.sid);
      const visitEntry = current ? entry : historyEntryForStop(client, visit.stop.sid, completed);
      const visitReceiptId = current
        ? sourceReceiptId
        : text(visitEntry?.completionReceiptId || markerReceiptId(completed, visit.stop.sid));
      if (!visitEntry) {
        return {
          invoices,
          changed: false,
          outcome: {
            status: "review_required",
            kind: "monthly",
            period,
            reason: "completed-visit-history-missing",
            stopId: visit.stop.sid,
          },
        };
      }
      visitEntries.push({ stop: visit.stop, entry: visitEntry, receiptId: visitReceiptId });
    }

    const monthlyRate = number(client.monthlyRate);
    if (!(monthlyRate > 0)) {
      return { invoices, changed: false, outcome: { status: "review_required", kind: "monthly", period, reason: "monthly-rate-missing" } };
    }
    const sourceStopIds = visits.map((visit) => text(visit.stop.sid));
    const sourceCompletionReceiptIds = visitEntries.map((visit) => visit.receiptId).filter(Boolean);
    const lineItems = [{
      id: `il_maint_${safeIdPart(client.id)}_${safeIdPart(period)}_service`,
      desc: `Monthly service — ${monthLabel(period)}`,
      qty: "1",
      unitPrice: decimal(monthlyRate),
      unitCost: "",
      costKnown: false,
      taxable: false,
      kind: "service",
      sourceStopIds,
      sourceCompletionReceiptIds,
    }, ...aggregatePurchasedLines(visitEntries, period)];
    const id = `iv_maint_${safeIdPart(client.id)}_${safeIdPart(period)}`;
    const sourceFields = {
      source: "monthly-maintenance",
      autoPeriod: period,
      sourceStopIds,
      sourceCompletionReceiptIds,
      sourceFinalStopId: sourceStopIds[sourceStopIds.length - 1] || text(stop.sid),
    };
    if (existingInvoice) {
      if (!untouchedAutoDraft(existingInvoice)) {
        return {
          invoices,
          changed: false,
          outcome: existingOutcome(existingMatches, "monthly", { period }),
        };
      }
      const rebuilt = finalizeAutoDraft({
        ...existingInvoice,
        lineItems,
        ...sourceFields,
      });
      if (completionInvoiceFingerprint(rebuilt) === completionInvoiceFingerprint(existingInvoice)) {
        return {
          invoices,
          changed: false,
          outcome: existingOutcome(existingMatches, "monthly", { period }),
        };
      }
      return {
        invoices: list(invoices).map((invoice) => (invoice === existingInvoice ? rebuilt : invoice)),
        changed: true,
        outcome: {
          status: "updated",
          kind: "monthly",
          period,
          invoiceId: rebuilt.id,
          invoiceNumber: rebuilt.number,
          visitCount: visits.length,
        },
      };
    }

    const draft = finalizeAutoDraft(buildDraftBase({
      invoices,
      invoicing,
      client,
      lineItems,
      issueDate,
      createdAt,
      source: { id, fields: sourceFields },
    }));
    return {
      invoices: [draft, ...list(invoices)],
      changed: true,
      outcome: {
        status: "created",
        kind: "monthly",
        period,
        invoiceId: draft.id,
        invoiceNumber: draft.number,
        visitCount: visits.length,
      },
    };
  }

  const existing = existingOutcome(completionInvoiceForStop(invoices, stop), "one-off", { sourceStopId: text(stop.sid) });
  if (existing) return { invoices, changed: false, outcome: existing };
  if (!isCompleted(completed, stop.sid)) {
    return { invoices, changed: false, outcome: { status: "pending", kind: "one-off", reason: "stop-not-confirmed" } };
  }
  const lineItems = [
    ...serviceLines(entry, authoritativeStop, text(stop.sid), sourceReceiptId),
    ...purchasedLines(entry, text(stop.sid), sourceReceiptId),
  ];
  if (!lineItems.length) {
    return { invoices, changed: false, outcome: { status: "review_required", kind: "one-off", reason: "no-billable-lines" } };
  }
  const id = `iv_stop_${safeIdPart(stop.sid)}`;
  const draft = finalizeAutoDraft(buildDraftBase({
    invoices,
    invoicing,
    client,
    lineItems,
    issueDate,
    createdAt,
    source: {
      id,
      fields: {
        source: "completed-stop",
        sourceStopId: text(stop.sid),
        ...(sourceReceiptId ? { sourceCompletionReceiptId: sourceReceiptId } : {}),
      },
    },
  }));
  return {
    invoices: [draft, ...list(invoices)],
    changed: true,
    outcome: {
      status: "created",
      kind: "one-off",
      invoiceId: draft.id,
      invoiceNumber: draft.number,
      sourceStopId: text(stop.sid),
    },
  };
}
