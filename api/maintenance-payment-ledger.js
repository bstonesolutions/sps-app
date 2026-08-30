// Protected accounting endpoint for assigning canonical invoice evidence to
// recurring-maintenance months. The browser never supplies authoritative
// invoice totals, balances, statuses, or client linkage.

import { requireCapability } from "./_staff-auth.js";
import { compareAndSetAppStateBatch, readAppStatesVersioned, readAppStateVersioned } from "./_app-state.js";
import {
  assignMaintenanceInvoiceMonths,
  clearMaintenancePaymentMonths,
  emptyMaintenancePaymentLedger,
  moneyToCents,
  normalizeMaintenancePaymentLedger,
  normalizeMonthKey,
  reconcileMaintenancePaymentHistory,
  setMaintenancePaymentMonthOverride,
} from "../maintenancePaymentLedger.js";

const MAX_ATTEMPTS = 6;
const MAX_MONTHS = 120;
const STATE_KEYS = ["sps_clients", "sps_invoices", "sps_maintenance_billing"];
const RECONCILE_STATE_KEYS = [...STATE_KEYS, "sps_schedule"];
const MIN_RECONCILE_YEAR = 2000;
const MAX_RECONCILE_YEARS = 25;
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value) => String(value == null ? "" : value).trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

function cleanId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const id = String(value).trim();
  return id && id.length <= 220 ? id : "";
}

function cleanMonthKeys(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MONTHS) return null;
  const months = [];
  const seen = new Set();
  for (const rawMonth of value) {
    if (typeof rawMonth !== "string" || !/^\d{4}-\d{2}$/.test(rawMonth)) return null;
    const month = normalizeMonthKey(rawMonth);
    if (!month || month !== rawMonth) return null;
    if (!seen.has(month)) {
      seen.add(month);
      months.push(month);
    }
  }
  return months;
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clientIdOf(client) {
  return cleanId(client?.id || client?.clientId);
}

function clientNameOf(client) {
  return normalizedName(client?.name || client?.clientName || client?.displayName);
}

function canonicalClient(clients, clientId) {
  const matches = clients.filter((client) => isRecord(client) && clientIdOf(client) === clientId);
  if (!matches.length) return { error: "missing" };
  if (matches.length !== 1) return { error: "duplicate" };
  return { client: matches[0] };
}

function matchesForField(invoices, field, value) {
  if (!value) return [];
  return invoices.filter((invoice) => isRecord(invoice) && text(invoice[field]) === value);
}

function canonicalInvoice(invoices, invoiceId) {
  for (const field of ["id", "qbId", "number"]) {
    const matches = matchesForField(invoices, field, invoiceId);
    if (matches.length === 1) return { invoice: matches[0] };
    if (matches.length > 1) return { error: "duplicate" };
  }
  return { error: "missing" };
}

function invoiceBelongsToClient(invoice, client, clients, requestedClientId) {
  const directClientId = cleanId(invoice?.clientId);
  if (directClientId) return directClientId === requestedClientId;

  const invoiceQbCustomerId = cleanId(invoice?.qbCustomerId);
  if (invoiceQbCustomerId) {
    const qbMatches = clients.filter((candidate) => (
      isRecord(candidate)
      && cleanId(candidate?.qbId || candidate?.qbCustomerId) === invoiceQbCustomerId
    ));
    if (qbMatches.length) {
      return qbMatches.length === 1 && clientIdOf(qbMatches[0]) === requestedClientId;
    }
  }

  const invoiceName = normalizedName(invoice?.clientName || invoice?.customerName);
  if (!invoiceName || clientNameOf(client) !== invoiceName) return false;
  const nameMatches = clients.filter((candidate) => isRecord(candidate) && clientNameOf(candidate) === invoiceName);
  return nameMatches.length === 1 && clientIdOf(nameMatches[0]) === requestedClientId;
}

function canonicalInvoiceTotalCents(invoice) {
  const candidate = invoice?.total ?? invoice?.amount ?? invoice?.subtotal;
  return Math.max(0, moneyToCents(candidate));
}

function canonicalInvoiceStatus(invoice, totalCents) {
  const status = text(invoice?.status).toLowerCase();
  if (status === "paid" || text(invoice?.paidDate)) return "paid";
  if (hasOwn(invoice, "balance")) {
    const balanceCents = Math.max(0, moneyToCents(invoice.balance));
    if (balanceCents === 0) return "paid";
    if (balanceCents < totalCents) return "partial";
  }
  return "due";
}

function canonicalExpectedCents(client) {
  const expected = moneyToCents(client?.monthlyRate ?? client?.maintenanceRate ?? client?.price);
  return expected > 0 ? expected : undefined;
}

function sourceForInvoice(invoice) {
  return {
    kind: "invoice",
    invoiceId: text(invoice?.id),
    qbInvoiceId: text(invoice?.qbId),
    invoiceNumber: text(invoice?.number),
  };
}

function invoiceSummary(invoice) {
  return {
    id: text(invoice?.id),
    qbId: text(invoice?.qbId),
    number: text(invoice?.number),
    totalCents: canonicalInvoiceTotalCents(invoice),
  };
}

async function readMutationBaseline({ includeSchedule = false } = {}) {
  const snapshot = await readAppStatesVersioned(includeSchedule ? RECONCILE_STATE_KEYS : STATE_KEYS);
  const clients = snapshot.sps_clients;
  const invoices = snapshot.sps_invoices;
  const billing = snapshot.sps_maintenance_billing;
  if (!clients.exists || !Array.isArray(clients.value)) throw new Error("shared_clients_invalid");
  if (!invoices.exists || !Array.isArray(invoices.value)) throw new Error("shared_invoices_invalid");
  const ledger = billing.exists
    ? normalizeMaintenancePaymentLedger(billing.value)
    : emptyMaintenancePaymentLedger();
  if (!ledger) throw new Error("shared_maintenance_billing_invalid");
  const schedule = snapshot.sps_schedule;
  if (includeSchedule && (!schedule?.exists || !Array.isArray(schedule.value))) {
    throw new Error("shared_schedule_invalid");
  }
  return {
    clients,
    invoices,
    billing: { ...billing, value: ledger },
    ...(includeSchedule ? { schedule } : {}),
  };
}

function yearFromDateLike(value) {
  const monthKey = normalizeMonthKey(value);
  if (!monthKey) return null;
  const year = Number(monthKey.slice(0, 4));
  return Number.isSafeInteger(year) ? year : null;
}

function canonicalEvidenceYears(baseline, currentYear) {
  const years = [];
  const addYear = (value) => {
    const year = yearFromDateLike(value);
    if (year != null && year >= MIN_RECONCILE_YEAR && year <= currentYear + 1) years.push(year);
  };
  for (const invoice of baseline.invoices.value) {
    if (!isRecord(invoice)) continue;
    addYear(invoice.date || invoice.issueDate || invoice.issuedDate || invoice.createdAt || invoice.created_at);
  }
  for (const day of baseline.schedule.value) {
    if (!isRecord(day)) continue;
    addYear(day.date || day.scheduledDate || day.day);
    for (const stop of Array.isArray(day.stops) ? day.stops : []) {
      if (!isRecord(stop)) continue;
      addYear(stop.date || stop.scheduledDate || stop.completedAt || stop.completedDate);
    }
  }
  for (const policy of Object.values(baseline.billing.value.policies || {})) {
    if (!isRecord(policy)) continue;
    addYear(policy.coveredFrom);
    addYear(policy.coveredThrough);
  }
  for (const months of Object.values(baseline.billing.value.allocations || {})) {
    if (!isRecord(months)) continue;
    for (const monthKey of Object.keys(months)) addYear(monthKey);
  }
  return years;
}

function canonicalScheduleStops(schedule) {
  const stops = [];
  for (const entry of Array.isArray(schedule) ? schedule : []) {
    if (!isRecord(entry)) continue;
    if (!Array.isArray(entry.stops)) {
      stops.push(entry);
      continue;
    }
    const dayDate = text(entry.date || entry.scheduledDate || entry.day);
    for (const stop of entry.stops) {
      if (!isRecord(stop)) continue;
      const hasStopDate = !!text(stop.date || stop.scheduledDate || stop.visitDate || stop.startAt || stop.start);
      stops.push(hasStopDate || !dayDate ? stop : { ...stop, date: dayDate });
    }
  }
  return stops;
}

function requestedYear(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || !/^\d{4}$/.test(String(raw))) return NaN;
  const year = Number(raw);
  return Number.isSafeInteger(year) ? year : NaN;
}

function reconcileYearRange(body, baseline, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const requestedFrom = requestedYear(body?.fromYear);
  const requestedTo = requestedYear(body?.toYear);
  if (Number.isNaN(requestedFrom) || Number.isNaN(requestedTo)) return null;

  const evidenceYears = canonicalEvidenceYears(baseline, currentYear);
  const evidenceFrom = evidenceYears.length ? Math.min(...evidenceYears) : currentYear;
  const evidenceTo = evidenceYears.length ? Math.max(...evidenceYears) : currentYear;
  const fromYear = requestedFrom ?? evidenceFrom;
  const toYear = requestedTo ?? Math.max(evidenceTo, currentYear);
  if (
    fromYear < MIN_RECONCILE_YEAR
    || toYear > currentYear + 1
    || fromYear > toYear
    || (toYear - fromYear + 1) > MAX_RECONCILE_YEARS
  ) return null;
  return { fromYear, toYear };
}

function sameLedger(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateInvoiceEvidence(baseline, clientId, invoiceId) {
  const clientResult = canonicalClient(baseline.clients.value, clientId);
  if (clientResult.error) return { error: `client_${clientResult.error}` };
  const invoiceResult = canonicalInvoice(baseline.invoices.value, invoiceId);
  if (invoiceResult.error) return { error: `invoice_${invoiceResult.error}` };
  if (!invoiceBelongsToClient(
    invoiceResult.invoice,
    clientResult.client,
    baseline.clients.value,
    clientId,
  )) return { error: "invoice_client_mismatch" };
  return { client: clientResult.client, invoice: invoiceResult.invoice };
}

function evidenceError(res, error) {
  if (error === "client_missing") {
    return res.status(404).json({ ok: false, error: "The client no longer exists." });
  }
  if (error === "invoice_missing") {
    return res.status(404).json({ ok: false, error: "The invoice no longer exists." });
  }
  if (error === "client_duplicate") {
    return res.status(409).json({ ok: false, error: "This client ID appears more than once. Merge the duplicate client records first." });
  }
  if (error === "invoice_duplicate") {
    return res.status(409).json({ ok: false, error: "This invoice identifier is not unique. Resolve the duplicate invoice records first." });
  }
  return res.status(409).json({ ok: false, error: "This invoice is not linked to the selected client." });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const capability = req.method === "GET" ? "invoiceView" : "invoiceCreate";
  const staff = await requireCapability(req, res, capability, "maintenance payment accounting");
  if (!staff) return;

  if (req.method === "GET") {
    try {
      const billing = await readAppStateVersioned("sps_maintenance_billing");
      const ledger = billing.exists
        ? normalizeMaintenancePaymentLedger(billing.value)
        : emptyMaintenancePaymentLedger();
      if (!ledger) throw new Error("shared_maintenance_billing_invalid");
      return res.status(200).json({
        ok: true,
        maintenancePaymentLedger: ledger,
        version: billing.exists ? billing.version : 0,
        updatedAt: billing.updatedAt || null,
      });
    } catch (error) {
      console.error("[maintenance-payment-ledger:get]", error && error.message ? error.message : error);
      return res.status(502).json({ ok: false, error: "Maintenance payment records could not be loaded safely." });
    }
  }

  const body = isRecord(req.body) ? req.body : null;
  const action = text(body?.action).toLowerCase();
  if (!body || !["assign", "clear", "reconcile"].includes(action)) {
    return res.status(400).json({ ok: false, error: "Choose a valid maintenance accounting action." });
  }

  if (action === "reconcile") {
    const requestedAt = new Date();
    const actor = text(staff.email || staff.id);
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const baseline = await readMutationBaseline({ includeSchedule: true });
        const range = reconcileYearRange(body, baseline, requestedAt);
        if (!range) {
          return res.status(400).json({
            ok: false,
            error: `Choose a valid year range of no more than ${MAX_RECONCILE_YEARS} years, ending no later than next year.`,
          });
        }

        const result = reconcileMaintenancePaymentHistory({
          clients: baseline.clients.value,
          invoices: baseline.invoices.value,
          payments: [],
          schedule: canonicalScheduleStops(baseline.schedule.value),
          ledger: structuredClone(baseline.billing.value),
          ...range,
          actor,
          updatedAt: requestedAt.toISOString(),
        });
        const nextLedger = normalizeMaintenancePaymentLedger(result?.ledger);
        if (!nextLedger || !isRecord(result?.receipt)) throw new Error("maintenance_reconciliation_invalid");

        if (sameLedger(nextLedger, baseline.billing.value)) {
          return res.status(200).json({
            ok: true,
            action,
            changed: false,
            ...range,
            maintenancePaymentLedger: nextLedger,
            reconciliationReceipt: result.receipt,
          });
        }

        const saved = await compareAndSetAppStateBatch([
          { key: "sps_clients", expectedVersion: baseline.clients.version, checkOnly: true },
          { key: "sps_invoices", expectedVersion: baseline.invoices.version, checkOnly: true },
          { key: "sps_schedule", expectedVersion: baseline.schedule.version, checkOnly: true },
          {
            key: "sps_maintenance_billing",
            expectedVersion: baseline.billing.exists ? baseline.billing.version : 0,
            value: nextLedger,
          },
        ]);
        if (saved.applied) {
          return res.status(200).json({
            ok: true,
            action,
            changed: true,
            ...range,
            maintenancePaymentLedger: nextLedger,
            reconciliationReceipt: result.receipt,
          });
        }
        if (saved.outcome !== "conflict") throw new Error(`unexpected_batch_outcome:${saved.outcome || "unknown"}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 20)));
        }
      }
      return res.status(409).json({
        ok: false,
        error: "Another employee changed these accounting records at the same time. Nothing was changed; please try again.",
      });
    } catch (error) {
      console.error("[maintenance-payment-ledger:reconcile]", error && error.message ? error.message : error);
      return res.status(502).json({
        ok: false,
        error: "Maintenance payment history could not be reconciled safely. Nothing was changed; please try again.",
      });
    }
  }

  const actionType = action === "assign" ? (text(body?.actionType).toLowerCase() || "invoice") : "";
  const clientId = cleanId(body?.clientId);
  const invoiceId = cleanId(body?.invoiceId);
  const monthKeys = cleanMonthKeys(body?.monthKeys);
  const note = body?.note == null ? "" : (typeof body.note === "string" ? body.note.trim().slice(0, 1200) : null);
  if (
    (action === "assign" && !["invoice", "waived"].includes(actionType))
    || !clientId
    || !monthKeys
    || note == null
  ) {
    return res.status(400).json({ ok: false, error: "A valid action, client, and one or more maintenance months are required." });
  }
  if (action === "assign" && actionType === "invoice" && !invoiceId) {
    return res.status(400).json({ ok: false, error: "Choose an invoice to assign to these maintenance months." });
  }
  if (hasOwn(body, "invoiceId") && body.invoiceId != null && !invoiceId) {
    return res.status(400).json({ ok: false, error: "The invoice identifier is invalid." });
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const baseline = await readMutationBaseline();
      let client = null;
      let invoice = null;
      if (invoiceId && (action !== "assign" || actionType === "invoice")) {
        const evidence = validateInvoiceEvidence(baseline, clientId, invoiceId);
        if (evidence.error) return evidenceError(res, evidence.error);
        ({ client, invoice } = evidence);
      } else {
        const result = canonicalClient(baseline.clients.value, clientId);
        if (result.error) return evidenceError(res, `client_${result.error}`);
        client = result.client;
      }

      let nextLedger;
      if (action === "assign" && actionType === "invoice") {
        const totalCents = canonicalInvoiceTotalCents(invoice);
        if (totalCents <= 0) {
          return res.status(409).json({ ok: false, error: "The saved invoice does not contain a positive canonical total." });
        }
        nextLedger = assignMaintenanceInvoiceMonths(baseline.billing.value, {
          clientId,
          monthKeys,
          invoice,
          expectedCents: canonicalExpectedCents(client),
          status: canonicalInvoiceStatus(invoice, totalCents),
          note,
          actor: text(staff.email || staff.id),
          updatedAt: new Date().toISOString(),
        });
      } else if (action === "assign") {
        nextLedger = baseline.billing.value;
        for (const monthKey of monthKeys) {
          nextLedger = setMaintenancePaymentMonthOverride(nextLedger, {
            clientId,
            monthKey,
            status: "waived",
            source: { kind: "waiver", waiverId: `waiver:${clientId}:${monthKey}` },
            expectedCents: canonicalExpectedCents(client),
            allocatedCents: 0,
            note,
            actor: text(staff.email || staff.id),
            updatedAt: new Date().toISOString(),
          });
          if (!nextLedger) break;
        }
      } else {
        nextLedger = clearMaintenancePaymentMonths(baseline.billing.value, {
          clientId,
          monthKeys,
          ...(invoice ? { source: sourceForInvoice(invoice) } : {}),
        });
      }
      if (!nextLedger) throw new Error("shared_maintenance_billing_invalid");

      const saved = await compareAndSetAppStateBatch([
        { key: "sps_clients", expectedVersion: baseline.clients.version, checkOnly: true },
        { key: "sps_invoices", expectedVersion: baseline.invoices.version, checkOnly: true },
        {
          key: "sps_maintenance_billing",
          expectedVersion: baseline.billing.exists ? baseline.billing.version : 0,
          value: nextLedger,
        },
      ]);
      if (saved.applied) {
        return res.status(200).json({
          ok: true,
          action,
          ...(actionType ? { actionType } : {}),
          clientId,
          monthKeys,
          maintenancePaymentLedger: nextLedger,
          ...(invoice ? { invoice: invoiceSummary(invoice) } : {}),
        });
      }
      if (saved.outcome !== "conflict") throw new Error(`unexpected_batch_outcome:${saved.outcome || "unknown"}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 20)));
      }
    }
    return res.status(409).json({
      ok: false,
      error: "Another employee changed these accounting records at the same time. Nothing was changed; please try again.",
    });
  } catch (error) {
    console.error("[maintenance-payment-ledger:post]", error && error.message ? error.message : error);
    return res.status(502).json({
      ok: false,
      error: "Maintenance payment records could not be saved safely. Nothing was changed; please try again.",
    });
  }
}
