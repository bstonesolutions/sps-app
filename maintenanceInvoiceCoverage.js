import {
  isRecurringMaintenanceStop,
  maintenanceBillingPolicyForClient,
  normalizeMaintenanceBillingPolicy,
  prepaidMaintenanceCoverage,
} from "./maintenanceBilling.js";
import {
  moneyToCents,
  normalizeAllocationSource,
  normalizeMaintenancePaymentLedger,
  normalizeMonthKey,
  reconcileMaintenancePaymentHistory,
} from "./maintenancePaymentLedger.js";

export const COVERED_MAINTENANCE_DISPOSITION = "covered-maintenance";
export const REVIEW_MAINTENANCE_DISPOSITION = "maintenance-review";
const text = value => String(value == null ? "" : value).trim();
const list = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const hold = reason => ({ covered: false, blocked: true, reason, invoiceEvidenceRequired: true });
const maintenanceWording = value => /\bmaintenance\b|\b(?:weekly|biweekly|monthly|recurring)\s+(?:(?:pool|pond)\s+)?service\b/i.test(text(value));

export function isMaintenanceServiceExtra(service) {
  if (!service || service.bill === false) return false;
  if (service.billSeparately === true || service.includedInMaintenance === false
    || ["one-off", "oneoff", "single"].includes(text(service.billingMode).toLowerCase())) return true;
  const description = typeof service === "string" ? service : service.desc || service.description || service.name || service.type;
  return /\b(?:repair|repairs|project|install|installation|startup|start-up|cleanout|clean-out|inspection|consultation|emergency|renovation|construction|replacement|replace)\b|service\s*call/i.test(text(description));
}

// These snapshots are written by the completion endpoint, never accepted from a
// completion request. Replays/imports use the recorded decision, not today's policy.
export function savedMaintenanceCoverage(entry, { clientId = "" } = {}) {
  const disposition = text(entry?.billingDisposition).toLowerCase();
  if (disposition === REVIEW_MAINTENANCE_DISPOSITION) {
    const snapshot = entry?.maintenanceBillingSnapshot;
    if (Number(snapshot?.version) !== 1 || snapshot?.mode !== "review" || !text(snapshot.clientId)
      || (text(clientId) && text(snapshot.clientId) !== text(clientId))
      || !snapshot.month || normalizeMonthKey(snapshot.month) !== snapshot.month || !text(snapshot.reason)) return hold("stored-coverage-invalid");
    return { ...hold(snapshot.reason), snapshot: copy(snapshot) };
  }
  if (disposition === "prepaid-maintenance") {
    const snapshot = normalizeMaintenanceBillingPolicy(entry?.maintenanceBillingSnapshot);
    return snapshot ? { covered: true, reason: "prepaid-maintenance", snapshot } : hold("stored-coverage-invalid");
  }
  if (disposition !== COVERED_MAINTENANCE_DISPOSITION) return null;
  const snapshot = entry?.maintenanceBillingSnapshot;
  const sources = list(snapshot?.sources).map(normalizeAllocationSource);
  if (Number(snapshot?.version) !== 1 || snapshot?.mode !== "month-allocation"
    || !text(snapshot.clientId) || (text(clientId) && text(snapshot.clientId) !== text(clientId))
    || normalizeMonthKey(snapshot.month) !== snapshot.month
    || !["paid", "waived"].includes(snapshot.status) || !sources.length || sources.some(source => !source)) {
    return hold("stored-coverage-invalid");
  }
  return { covered: true, reason: "maintenance-month-covered", snapshot: copy(snapshot) };
}

function invoiceTotalCents(invoice) {
  for (const key of ["total", "TotalAmt", "amount"]) {
    if (invoice?.[key] != null && text(invoice[key]) !== "") return moneyToCents(invoice[key]);
  }
  return list(invoice?.lineItems).reduce((sum, line) => sum + Math.round(
    Number(line?.qty ?? 1) * moneyToCents(line?.unitPrice),
  ), 0);
}

function sourceInvoice(source, invoices, client, clients) {
  const refs = [
    ["invoiceId", invoice => text(invoice?.id)],
    ["qbInvoiceId", invoice => text(invoice?.qbId || invoice?.Id)],
    ["invoiceNumber", invoice => text(invoice?.number || invoice?.DocNumber)],
  ].filter(([key]) => text(source?.[key]));
  if (!refs.length) return null;
  const matches = list(invoices).filter(invoice => refs.every(([key, value]) => value(invoice) === text(source[key])));
  if (matches.length !== 1) return null;
  const invoice = matches[0];
  const directId = text(invoice.clientId || invoice.customerId);
  if (directId) return directId === text(client?.id) ? invoice : null;
  const qbId = text(invoice.qbCustomerId || invoice.CustomerRef?.value);
  const owners = list(clients).filter(candidate => qbId && text(candidate?.qbId || candidate?.qbCustomerId) === qbId);
  return owners.length === 1 && text(owners[0].id) === text(client?.id) ? invoice : null;
}

function invoiceSettled(invoice) {
  const status = text(invoice?.status).toLowerCase();
  if (/draft|refund|void|revers|cancel|delet/.test(status) || invoice?.qbNeedsReview || invoice?.qbPendingRemoteInvoice
    || invoice?.qbSyncStatus === "conflict" || invoice?.qbPendingLocalEdits || invoice?.qbLocalChangesPending) return false;
  if (!(invoiceTotalCents(invoice) > 0)) return false;
  const balance = invoice?.balance ?? invoice?.Balance;
  if (balance != null && text(balance) !== "") {
    const value = Number(text(balance).replace(/[$,\s]/g, ""));
    return Number.isFinite(value) && value === 0;
  }
  return status === "paid" || !!text(invoice?.paidDate);
}

function policyDecision(client, stop, entry, scheduledDate, ledger) {
  const policy = maintenanceBillingPolicyForClient(ledger, client?.id);
  const billingClient = { ...client };
  if (policy) billingClient.maintenanceBilling = policy;
  else delete billingClient.maintenanceBilling;
  const serviceDate = /^\d{4}-\d{2}$/.test(text(scheduledDate)) ? `${scheduledDate}-01` : scheduledDate;
  return prepaidMaintenanceCoverage({ client: billingClient, stop, entry, scheduledDate: serviceDate });
}

export function maintenanceCoverageForService({ client, clients = [], stop, entry, scheduledDate, ledger: rawLedger, invoices = [], schedule = [] } = {}) {
  const saved = savedMaintenanceCoverage(entry, { clientId: client?.id });
  if (saved) return saved;
  if (!isRecurringMaintenanceStop(stop, client, entry)) return { covered: false, reason: "not-recurring-maintenance" };
  let ledger = normalizeMaintenancePaymentLedger(rawLedger);
  if (!ledger) return hold("maintenance-coverage-unavailable");
  const policy = policyDecision(client, stop, entry, scheduledDate, ledger);
  if (policy.covered || policy.blocked) return policy;
  const month = normalizeMonthKey(scheduledDate);
  if (!month) return hold("scheduled-date-invalid");
  let allocation = ledger.allocations?.[text(client?.id)]?.[month];
  if (!allocation) {
    // Refreshing QuickBooks should protect a plainly identified maintenance
    // payment immediately, even before the calendar saves its month allocation.
    // Reuse the conservative reconciler without writing its derived ledger.
    const evidence = list(invoices).filter(invoice => {
      const strong = invoice?.recurringMaintenance === true || text(invoice?.billingMode).includes("maintenance")
        || text(invoice?.source) === "monthly-maintenance"
        || list(invoice?.lineItems || invoice?.lines).some(line => maintenanceWording(line?.desc || line?.description));
      return strong && !/draft/i.test(text(invoice?.status)) && (invoiceSettled(invoice) || text(invoice?.qbId || invoice?.Id));
    });
    const year = Number(month.slice(0, 4));
    const derived = reconcileMaintenancePaymentHistory({ clients: clients.length ? clients : [client], invoices: evidence, schedule, ledger, fromYear: year, toYear: year });
    const ambiguous = derived.receipt.ambiguousInvoices.some(issue => text(issue.clientId) === text(client?.id)
      && (list(issue.months).includes(month) || issue.invoiceMonth === month || /multi-month prepayment/.test(issue.reason)));
    if (ambiguous) return hold("maintenance-payment-evidence-unverified");
    ledger = derived.ledger;
    allocation = ledger.allocations?.[text(client?.id)]?.[month];
  }
  if (!allocation) return { covered: false, reason: "month-not-covered" };
  if (allocation.status === "waived" && allocation.sources.every(source => source.kind === "waiver" && source.waiverId)) {
    return {
      covered: true,
      reason: "maintenance-month-covered",
      snapshot: { version: 1, mode: "month-allocation", clientId: text(client.id), month, status: "waived", sources: copy(allocation.sources) },
    };
  }
  // Payment status can change in QuickBooks after this allocation was saved.
  // Canonical balances decide settlement; the allocation supplies only months.
  if (!["paid", "due", "partial"].includes(allocation.status)) return hold("maintenance-month-needs-review");
  const expectedCents = allocation.expectedCents ?? moneyToCents(client?.monthlyRate ?? client?.maintenanceRate);
  const allocatedCents = allocation.allocatedCents ?? allocation.sources.reduce((sum, source) => sum + (source.amountCents || 0), 0);
  if (allocation.sources.some(source => !Number.isSafeInteger(source.amountCents) || source.amountCents < 0)
    || allocatedCents !== allocation.sources.reduce((sum, source) => sum + source.amountCents, 0)) return hold("maintenance-payment-evidence-unverified");
  if (!(expectedCents > 0) || allocatedCents < expectedCents) return hold("maintenance-month-partially-covered");
  const resolved = new Set();
  for (const source of allocation.sources) {
    // Payments need their linked canonical invoice; an unapplied credit is not
    // proof that this particular maintenance month has been paid.
    if (!["invoice", "payment"].includes(source.kind)) return hold("maintenance-payment-evidence-unverified");
    const invoice = sourceInvoice(source, invoices, client, clients);
    if (!invoice || !invoiceSettled(invoice) || resolved.has(invoice)) return hold("maintenance-payment-evidence-unverified");
    resolved.add(invoice);
    let assignedCents = 0;
    for (const cells of Object.values(ledger.allocations)) {
      for (const cell of Object.values(cells)) {
        for (const candidate of cell.sources) {
          if ((candidate.invoiceId && text(candidate.invoiceId) === text(invoice.id))
            || (candidate.qbInvoiceId && text(candidate.qbInvoiceId) === text(invoice.qbId || invoice.Id))
            || (!candidate.invoiceId && !candidate.qbInvoiceId && candidate.invoiceNumber
              && text(candidate.invoiceNumber) === text(invoice.number || invoice.DocNumber))) {
            if (!Number.isSafeInteger(candidate.amountCents) || candidate.amountCents < 0) return hold("maintenance-payment-evidence-unverified");
            assignedCents += candidate.amountCents;
          }
        }
      }
    }
    if (assignedCents > invoiceTotalCents(invoice)) return hold("maintenance-payment-overallocated");
  }
  return {
    covered: true,
    reason: "maintenance-month-covered",
    invoiceEvidenceRequired: true,
    snapshot: { version: 1, mode: "month-allocation", clientId: text(client.id), month, status: "paid", sources: copy(allocation.sources) },
  };
}

export function prepareCoveredMaintenanceEntry(options = {}) {
  let decision = maintenanceCoverageForService(options);
  if (!decision.covered && !decision.blocked) return { entry: options.entry, decision };
  if (decision.blocked) {
    const month = normalizeMonthKey(options.scheduledDate);
    if (!month || !text(options.client?.id)) return { entry: options.entry, decision };
    decision = { ...decision, snapshot: { version: 1, mode: "review", clientId: text(options.client.id), month, reason: decision.reason } };
  }
  const entry = options.entry || {};
  const date = text(options.scheduledDate);
  const mdy = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const serviceDate = mdy ? `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}` : date.slice(0, 10);
  return {
    entry: {
      ...entry,
      invoice: (() => {
        const extraCents = list(entry.services).filter(isMaintenanceServiceExtra).reduce((sum, service) => sum
          + Math.round(Number(service.qty ?? 1) * moneyToCents(service.price ?? service.unitPrice)), 0);
        return extraCents > 0 ? `$${(extraCents / 100).toFixed(2)}` : "$0";
      })(),
      ...(entry.quoted_price == null ? { quoted_price: moneyToCents(entry.invoice) / 100 } : {}),
      billingDisposition: decision.blocked ? REVIEW_MAINTENANCE_DISPOSITION
        : decision.snapshot.mode === "prepaid" ? "prepaid-maintenance" : COVERED_MAINTENANCE_DISPOSITION,
      maintenanceBillingSnapshot: copy(decision.snapshot),
      maintenanceBillingServiceDate: serviceDate,
    },
    decision,
  };
}

function sourceIds(value, single, plural) { return [text(value?.[single]), ...list(value?.[plural]).map(text)].filter(Boolean); }

// Advisory in the browser; pass the protected ledger and canonical invoices to
// enforce the same decision server-side. An invoice's issue date is only a
// fallback for explicitly described maintenance, never for arbitrary charges.
export function invoiceMaintenanceCoverageIssue({ invoice, client, clients = [], ledger, invoices = [], schedule = [] } = {}) {
  if (!invoice || !client) return null;
  const ledgerValue = normalizeMaintenancePaymentLedger(ledger);
  const policy = ledgerValue?.policies?.[text(client.id)];
  const canonicalMatches = list(invoices).filter(candidate => text(invoice.id) && text(candidate?.id) === text(invoice.id));
  const canonicalCurrent = canonicalMatches.length === 1
    ? sourceInvoice({ invoiceId: text(invoice.id) }, invoices, client, clients) : null;
  // An editable invoice number or a supplied QB ID is not proof that a new
  // invoice is the protected prepayment. Exempt only a saved, owned record.
  const ownSource = policy && canonicalCurrent && (
    (policy.sourceInvoiceId && [canonicalCurrent.id, canonicalCurrent.qbId].map(text).includes(text(policy.sourceInvoiceId)))
    || (policy.sourceInvoiceNumber && text(canonicalCurrent.number) === text(policy.sourceInvoiceNumber))
  );
  if (ownSource) return null;
  const decisions = [];
  for (const line of list(invoice.lineItems)) {
    if (["part", "product", "treatment", "bundle"].includes(text(line.kind).toLowerCase())) continue;
    if (!(Number(line.qty ?? 1) * Number(line.unitPrice ?? 0) > 0)) continue;
    if (isMaintenanceServiceExtra(line)) continue;
    const stopIds = [...sourceIds(line, "sourceStopId", "sourceStopIds"), ...sourceIds(invoice, "sourceStopId", "sourceStopIds")];
    const receiptIds = [...sourceIds(line, "sourceCompletionReceiptId", "sourceCompletionReceiptIds"), ...sourceIds(invoice, "sourceCompletionReceiptId", "sourceCompletionReceiptIds")];
    const visits = list(client.history).filter(entry => stopIds.includes(text(entry.sid || entry.stopId))
      || receiptIds.includes(text(entry.completionReceiptId || entry.receiptId)));
    for (const entry of visits) {
      const saved = savedMaintenanceCoverage(entry, { clientId: client.id });
      if (saved?.covered || saved?.blocked) decisions.push({ ...saved, month: normalizeMonthKey(entry.maintenanceBillingServiceDate || entry.date) });
    }
    const recognized = text(invoice.source) === "monthly-maintenance" || maintenanceWording(line.desc || line.description);
    const maintenanceVisits = visits.filter(entry => isRecurringMaintenanceStop(entry, client, entry));
    if (!recognized && !maintenanceVisits.length) continue;
    const dates = maintenanceVisits.map(entry => entry.maintenanceBillingServiceDate || entry.date).filter(Boolean);
    for (const day of list(schedule)) for (const stop of list(day?.stops)) {
      if (stopIds.includes(text(stop.sid)) && text(stop.clientId ?? stop.id) === text(client.id)
        && isRecurringMaintenanceStop(stop, client)) dates.push(day.date);
    }
    if (!dates.length && recognized) dates.push(invoice.autoPeriod || invoice.serviceMonth || invoice.date);
    for (const date of [...new Set(dates)]) {
      const decision = maintenanceCoverageForService({ client, clients, stop: { type: "Monthly Service", clientId: client.id }, scheduledDate: date, ledger, invoices, schedule });
      // The original settled source invoice remains editable/syncable; it is
      // coverage evidence, not a duplicate invoice for the same service month.
      if (decision.covered && canonicalCurrent && list(decision.snapshot?.sources).some(source =>
        sourceInvoice(source, invoices, client, clients) === canonicalCurrent)) continue;
      if (decision.covered || decision.blocked) decisions.push({ ...decision, month: normalizeMonthKey(date) });
    }
  }
  if (!decisions.length) return null;
  const covered = decisions.some(decision => decision.covered);
  return {
    code: covered ? "maintenance-already-covered" : "maintenance-coverage-review",
    message: covered
      ? "Maintenance on this invoice is already covered. Remove the covered service charge; billable extras can stay."
      : "Maintenance coverage needs review before this invoice can be billed. Check the covered month and payment evidence.",
    covered,
    reviewRequired: true,
    months: [...new Set(decisions.map(decision => decision.month).filter(Boolean))],
    decisions,
  };
}
