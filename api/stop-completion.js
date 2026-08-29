// Narrow, staff-authorized transaction for completing and reopening scheduled stops.
// Browsers never receive service-role access and field staff never receive the generic owner-only
// batch primitive. The server derives every changed app_state value from the latest shared rows,
// then commits clients/catalog/completed/schedule and any generated invoice together with version
// checks.

import { randomUUID } from "node:crypto";
import { requireCapability } from "./_staff-auth.js";
import { compareAndSetAppStateBatch, readAppStatesVersioned } from "./_app-state.js";
import {
  STOP_REVERSAL_LEDGER_KEY,
  applyStopCompletion,
  hasPositiveTrackedUsage,
  isNonnegativeMoneyString,
  reverseStopCompletion,
} from "../stopCompletion.js";
import { planCompletionInvoice } from "../completionInvoice.js";
import {
  emptyMaintenanceBillingStore,
  maintenanceBillingPolicyForClient,
  normalizeMaintenanceBillingStore,
  prepaidMaintenanceCoverage,
  preparePrepaidMaintenanceEntry,
} from "../maintenanceBilling.js";
import {
  assertScheduledEstimateInventoryApplied,
  claimScheduledEstimateCompletion,
  prepareScheduledEstimateCompletionEntry,
  releaseScheduledEstimateCompletion,
} from "../estimateScheduleLink.js";

const MAX_ATTEMPTS = 6;
const STOP_COMPLETION_DATA_DEADLINE_MS = 24_000;
const MIN_STOP_COMPLETION_FETCH_TIMEOUT_MS = 250;
const STOP_COMPLETION_FETCH_TIMEOUT_MS = Math.max(
  MIN_STOP_COMPLETION_FETCH_TIMEOUT_MS,
  Math.min(12_000, Math.round(Number(process.env.STOP_COMPLETION_FETCH_TIMEOUT_MS) || 12_000)),
);
const STOP_COMPLETION_RECOVERY_TIMEOUT_MS = Math.max(
  MIN_STOP_COMPLETION_FETCH_TIMEOUT_MS,
  Math.min(4_000, STOP_COMPLETION_FETCH_TIMEOUT_MS),
);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,95}$/;
const ENTRY_KEYS = new Set([
  "date", "tech", "type", "assigneeId", "notes", "officeNotes", "services", "checklist",
  "readings", "readingStatus", "ph", "ammonia", "nitrite", "temp", "invoice", "photos",
  "treatmentsUsed", "productsUsed", "productsPurchased", "partsUsed", "usageLoc",
  "quoted_price", "actual_hours", "target_hourly_rate", "arrivedAt", "breakdown",
  "sourceEstimateId", "sourceEstimateNumber", "linkedInvoiceId", "billingDisposition",
]);

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const sameId = (left, right) => String(left) === String(right);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  res.setHeader("Cache-Control", "no-store");
}

function requestHeader(req, name) {
  const headers = req?.headers || {};
  const wanted = String(name || "").toLowerCase();
  const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === wanted);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function appStateTimeoutError(operation, timeoutMs) {
  const error = new Error("app_state_request_timeout");
  error.code = "APP_STATE_REQUEST_TIMEOUT";
  error.operation = String(operation || "request");
  error.timeoutMs = Number(timeoutMs) || 0;
  return error;
}

function createRequestTelemetry(req, res) {
  const startedAt = Date.now();
  const suppliedId = String(requestHeader(req, "x-request-id") || "").trim();
  const requestId = REQUEST_ID_PATTERN.test(suppliedId) ? suppliedId : `stop-${randomUUID()}`;
  const deadlineAt = startedAt + STOP_COMPLETION_DATA_DEADLINE_MS;
  let phase = "received";
  let mode = "";
  let attempts = 0;
  let finished = false;

  res.setHeader("X-Request-Id", requestId);

  const finish = (event) => {
    if (finished) return;
    finished = true;
    console.info("[stop-completion]", JSON.stringify({
      event,
      requestId,
      method: String(req?.method || ""),
      mode,
      phase,
      attempts,
      status: Number(res.statusCode) || 0,
      durationMs: Math.max(0, Date.now() - startedAt),
    }));
  };
  if (typeof res.once === "function") {
    res.once("finish", () => finish("request_finished"));
    res.once("close", () => finish("request_closed"));
  }

  return {
    requestId,
    startedAt,
    setPhase(value) { phase = String(value || phase); },
    setMode(value) { mode = String(value || ""); },
    setAttempt(value) { attempts = Number(value) || attempts; },
    appStateOptions(operation) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < MIN_STOP_COMPLETION_FETCH_TIMEOUT_MS) {
        throw appStateTimeoutError(operation, Math.max(0, remainingMs));
      }
      return { timeoutMs: Math.min(STOP_COMPLETION_FETCH_TIMEOUT_MS, remainingMs) };
    },
    logFailure(error) {
      console.error("[stop-completion]", JSON.stringify({
        event: "request_failed",
        requestId,
        mode,
        phase,
        attempts,
        durationMs: Math.max(0, Date.now() - startedAt),
        code: String(error?.code || "STOP_COMPLETION_ERROR").slice(0, 80),
        operation: String(error?.operation || "").slice(0, 80),
      }));
    },
  };
}

function cleanId(value, max = 220) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

function cleanEntry(raw) {
  if (!isRecord(raw)) return null;
  const entry = {};
  for (const key of ENTRY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) entry[key] = raw[key];
  }
  if (!isNonnegativeMoneyString(entry.invoice)) return null;
  for (const key of ["treatmentsUsed", "partsUsed", "productsPurchased"]) {
    if (entry[key] != null && (!Array.isArray(entry[key]) || entry[key].length > 500)) return null;
  }
  // Reject pathological payloads before they are duplicated into client history. Normal reports
  // contain Storage locators and are far smaller; this still leaves room for older inline photos.
  try { if (JSON.stringify(entry).length > 3_500_000) return null; } catch (_) { return null; }
  return entry;
}

function scheduledStops(schedule, sid) {
  const matches = [];
  for (const day of Array.isArray(schedule) ? schedule : []) {
    for (const stop of Array.isArray(day && day.stops) ? day.stops : []) {
      if (stop && sameId(stop.sid, sid)) matches.push({ stop, date: day?.date });
    }
  }
  return matches;
}

function replaceScheduledStop(schedule, sid, nextStop) {
  return (Array.isArray(schedule) ? schedule : []).map((day) => ({
    ...day,
    stops: (Array.isArray(day?.stops) ? day.stops : []).map((stop) => (
      stop && sameId(stop.sid, sid) ? nextStop : stop
    )),
  }));
}

function mutationMessage(code, itemName) {
  const messages = {
    "missing-stop-id": "This stop has no stable ID.",
    "client-not-found": "The client no longer exists.",
    "client-id-ambiguous": "This client ID appears more than once. Merge the duplicate client records before changing this stop.",
    "receipt-id-collision": "A unique completion receipt could not be created.",
    "missing-idempotency-key": "This completion attempt is missing its retry key.",
    "invalid-invoice": "The visit amount must be a nonnegative dollar amount with no more than two decimal places.",
    "completion-already-owned": "Another employee already completed this stop with a different report. Your draft was kept so you can review it.",
    "completion-marker-invalid": "The saved completion marker is malformed. Nothing was changed.",
    "reversal-receipt-missing": "This completion's reversal receipt is missing or damaged.",
    "reversal-client-mismatch": "This completion receipt belongs to a different client.",
    "inventory-item-missing": `${itemName || "An inventory item"} was removed from the catalog. Restore it before reopening this stop.`,
    "inventory-item-ambiguous": `${itemName || "An inventory item"} appears more than once in the catalog. Merge the duplicates before changing this stop.`,
    "inventory-usage-id-invalid": "A tracked inventory line is missing its item ID.",
    "inventory-usage-duplicate": `${itemName || "An inventory item"} appears more than once in this report. Combine the duplicate usage lines before saving.`,
    "inventory-stock-insufficient": `${itemName || "An inventory item"} does not have enough tracked stock to save this completed report. Add or correct its inventory count, then try again.`,
    "inventory-location-missing": `A saved stock location for ${itemName || "an inventory item"} no longer exists. Restore it before reopening this stop.`,
    "history-receipt-count-invalid": "The completed report no longer has exactly one matching history record. Nothing was changed.",
    "balance-chain-unprovable": "The prior balance chain cannot be proven from the saved receipts. Nothing was changed.",
    "reversal-ledger-invalid": "The completion receipt ledger is inconsistent. Nothing was changed.",
    "estimate-materials-invalid": "This estimate stop has no reliable material plan. Reopen the estimate and schedule it again before completing the work.",
    "inventory-item-missing": `${itemName || "An estimate material"} is no longer in inventory. Restore or relink it before completing the stop.`,
    "inventory-item-ambiguous": `${itemName || "An estimate material"} appears more than once in inventory. Merge the duplicates before completing the stop.`,
    "estimate-inventory-not-applied": `${itemName || "An estimate material"} could not be fully deducted from inventory. Correct its stock quantity or location before completing the stop.`,
    "estimate-linked-invoice-missing": "The invoice linked to this estimate stop no longer exists. Restore or relink it before completing the work.",
    "estimate-linked-invoice-ambiguous": "The invoice linked to this estimate stop appears more than once. Resolve the duplicate records before completing the work.",
    "estimate-invoice-client-mismatch": "The invoice linked to this estimate belongs to a different client. Review the link before completing the work.",
    "estimate-invoice-source-mismatch": "The linked invoice does not belong to this estimate. Review the link before completing the work.",
  };
  return messages[code] || "The stop could not be changed safely.";
}

async function readBaseline(requestOptions = {}) {
  const snapshot = await readAppStatesVersioned([
    "sps_clients",
    "sps_catalog",
    "sps_completed",
    "sps_schedule",
    "sps_invoices",
    "sps_invoicing",
    "sps_maintenance_billing",
  ], requestOptions);
  const clients = snapshot.sps_clients;
  const catalog = snapshot.sps_catalog;
  const completed = snapshot.sps_completed;
  const schedule = snapshot.sps_schedule;
  const invoices = snapshot.sps_invoices;
  const invoicing = snapshot.sps_invoicing;
  const maintenanceBilling = snapshot.sps_maintenance_billing;
  if (!clients.exists || !Array.isArray(clients.value)) throw new Error("shared_clients_invalid");
  if (!catalog.exists || !isRecord(catalog.value)) throw new Error("shared_catalog_invalid");
  if (completed.exists && !isRecord(completed.value)) throw new Error("shared_completions_invalid");
  if (!schedule.exists || !Array.isArray(schedule.value)) throw new Error("shared_schedule_invalid");
  if (invoices.exists && !Array.isArray(invoices.value)) throw new Error("shared_invoices_invalid");
  if (invoicing.exists && !isRecord(invoicing.value)) throw new Error("shared_invoicing_invalid");
  const maintenanceBillingValue = maintenanceBilling.exists
    ? normalizeMaintenanceBillingStore(maintenanceBilling.value)
    : emptyMaintenanceBillingStore();
  if (!maintenanceBillingValue) throw new Error("shared_maintenance_billing_invalid");
  return {
    clients,
    catalog,
    completed,
    schedule,
    invoices,
    invoicing,
    maintenanceBilling: { ...maintenanceBilling, value: maintenanceBillingValue },
  };
}

function isUncertainBatchFailure(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  const status = Number(error?.status);
  return error?.code === "APP_STATE_REQUEST_TIMEOUT"
    || message === "app_state_batch_cas_invalid_response"
    || name === "AbortError"
    || name === "TypeError"
    || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(code)
    || code.startsWith("UND_ERR_")
    || (Number.isInteger(status) && status >= 500);
}

function invoiceReferencesCompletion(invoice, sid, receiptId, clientId) {
  if (!invoice || !sameId(invoice.clientId, clientId)) return false;
  const stopIds = Array.isArray(invoice.sourceStopIds) ? invoice.sourceStopIds : [];
  const receiptIds = Array.isArray(invoice.sourceCompletionReceiptIds)
    ? invoice.sourceCompletionReceiptIds
    : [];
  const stopMatches = sameId(invoice.sourceStopId, sid) || stopIds.some((value) => sameId(value, sid));
  const receiptMatches = sameId(invoice.sourceCompletionReceiptId, receiptId)
    || receiptIds.some((value) => sameId(value, receiptId));
  return String(invoice.autoGeneratedBy || "") === "stop-completion" && (stopMatches || receiptMatches);
}

async function confirmCompletedStopAfterUncertainBatch({
  sid,
  clientId,
  idempotencyKey,
  invoicePlan,
}) {
  const snapshot = await readAppStatesVersioned([
    "sps_completed",
    "sps_clients",
    "sps_invoices",
  ], { timeoutMs: STOP_COMPLETION_RECOVERY_TIMEOUT_MS });
  const completed = snapshot.sps_completed;
  const clients = snapshot.sps_clients;
  const invoices = snapshot.sps_invoices;
  if (!completed.exists || !isRecord(completed.value)) return null;
  if (!clients.exists || !Array.isArray(clients.value)) return null;
  if (invoices.exists && !Array.isArray(invoices.value)) return null;

  const marker = completed.value[sid];
  const receiptId = cleanId(marker?.receiptId, 320);
  const ledger = completed.value[STOP_REVERSAL_LEDGER_KEY];
  const receipt = receiptId && isRecord(ledger) ? ledger[receiptId] : null;
  if (!isRecord(marker) || !isRecord(receipt)) return null;
  if (!sameId(receipt.id, receiptId) || !sameId(receipt.sid, sid) || !sameId(receipt.clientId, clientId)) return null;
  if (receipt.idempotencyKey !== idempotencyKey || receipt.completedAt !== marker.completedAt) return null;
  const historyReceiptId = cleanId(receipt.history?.entryReceiptId, 320);
  if (!historyReceiptId) return null;

  const clientMatches = clients.value.filter((client) => client && sameId(client.id, clientId));
  if (clientMatches.length !== 1) return null;
  const client = clientMatches[0];
  const historyMatches = (Array.isArray(client.history) ? client.history : []).filter((entry) => (
    entry
    && sameId(entry.sid, sid)
    && sameId(entry.completionReceiptId, historyReceiptId)
  ));
  if (historyMatches.length !== 1) return null;

  if (invoicePlan?.changed) {
    const invoiceId = cleanId(invoicePlan.outcome?.invoiceId, 320);
    const invoiceMatches = (invoices.exists ? invoices.value : []).filter((invoice) => (
      invoice && sameId(invoice.id, invoiceId)
    ));
    if (!invoiceId || invoiceMatches.length !== 1) return null;
    if (!invoiceReferencesCompletion(invoiceMatches[0], sid, receiptId, clientId)) return null;
  }

  return { client, receipt };
}

function validateEstimateInvoiceLink(stop, invoicesState, clientId) {
  const linkedInvoiceId = cleanId(stop?.linkedInvoiceId);
  if (!linkedInvoiceId) {
    return {
      ok: false,
      code: "estimate-invoice-required",
      error: "Create or link the draft invoice from this estimate before completing the stop. Nothing was changed.",
    };
  }
  if (!invoicesState?.exists || !Array.isArray(invoicesState.value)) {
    return {
      ok: false,
      code: "estimate-linked-invoice-missing",
      error: mutationMessage("estimate-linked-invoice-missing"),
    };
  }
  const matches = invoicesState.value.filter((invoice) => invoice && sameId(invoice.id, linkedInvoiceId));
  if (!matches.length) {
    return {
      ok: false,
      code: "estimate-linked-invoice-missing",
      error: mutationMessage("estimate-linked-invoice-missing"),
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      code: "estimate-linked-invoice-ambiguous",
      error: mutationMessage("estimate-linked-invoice-ambiguous"),
    };
  }
  const invoice = matches[0];
  if (!sameId(invoice.clientId, clientId)) {
    return {
      ok: false,
      code: "estimate-invoice-client-mismatch",
      error: mutationMessage("estimate-invoice-client-mismatch"),
    };
  }
  if (!sameId(invoice.sourceEstimateId, stop.sourceEstimateId)) {
    return {
      ok: false,
      code: "estimate-invoice-source-mismatch",
      error: mutationMessage("estimate-invoice-source-mismatch"),
    };
  }
  return { ok: true, invoice };
}

export default async function handler(req, res) {
  setCors(res);
  const telemetry = createRequestTelemetry(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  telemetry.setPhase("authorize");
  const staff = await requireCapability(req, res, "completeStops", "completing or reopening service stops");
  if (!staff) return;

  const mode = String((req.body && req.body.mode) || "");
  telemetry.setMode(mode);
  telemetry.setPhase("validate");
  const sid = cleanId(req.body && req.body.sid);
  const clientId = cleanId(req.body && req.body.clientId);
  const idempotencyKey = mode === "complete" && typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  const allowLegacy = req.body && req.body.allowLegacy === true;
  if (!sid || !clientId || !["complete", "reverse"].includes(mode)) {
    return res.status(400).json({ ok: false, error: "A valid stop, client, and action are required." });
  }
  const rawEntry = req.body && req.body.entry;
  if (mode === "complete" && isRecord(rawEntry) && !isNonnegativeMoneyString(rawEntry.invoice)) {
    return res.status(400).json({ ok: false, code: "invalid-invoice", error: "The visit amount must be a nonnegative dollar amount with no more than two decimal places." });
  }
  const entry = mode === "complete" ? cleanEntry(rawEntry) : null;
  if (mode === "complete" && !entry) return res.status(400).json({ ok: false, error: "The service report is invalid or too large." });
  if (mode === "complete" && (idempotencyKey.length < 8 || idempotencyKey.length > 240)) {
    return res.status(400).json({ ok: false, error: "This completion attempt is missing a valid retry key." });
  }

  const receiptId = `stop-${sid}-${randomUUID()}`;
  const completedAt = new Date().toISOString();
  let uncertainCommit = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      telemetry.setAttempt(attempt);
      telemetry.setPhase("read-baseline");
      const baseline = await readBaseline(telemetry.appStateOptions("read-baseline"));
      const stopMatches = scheduledStops(baseline.schedule.value, sid);
      if (!stopMatches.length) return res.status(409).json({ ok: false, code: "stop-not-found", error: "This stop is no longer on the shared schedule." });
      if (stopMatches.length !== 1) return res.status(409).json({ ok: false, code: "stop-id-ambiguous", error: "This stop ID appears more than once on the shared schedule. Nothing was changed." });
      const scheduledMatch = stopMatches[0];
      const stop = scheduledMatch.stop;
      const scheduledDate = scheduledMatch.date;
      if (mode === "complete" && stop.cancelled) {
        return res.status(409).json({ ok: false, code: "stop-cancelled", error: "A cancelled stop cannot be completed." });
      }
      const scheduledClientId = stop.clientId ?? stop.id;
      if (!sameId(scheduledClientId, clientId)) {
        return res.status(409).json({ ok: false, code: "stop-client-mismatch", error: "This stop is now assigned to a different client." });
      }

      const completedValue = baseline.completed.exists ? baseline.completed.value : {};
      const isNewCompletion = mode === "complete" && !completedValue[sid];
      let completionEntry = entry;
      let maintenanceBillingDecision = null;
      let maintenanceBillingFenceRequired = false;
      let estimateInventoryRequirements = [];
      let estimateInvoiceFenceRequired = false;
      if (isNewCompletion && stop.sourceEstimateId) {
        const invoiceValidation = validateEstimateInvoiceLink(stop, baseline.invoices, clientId);
        if (!invoiceValidation.ok) {
          return res.status(409).json({
            ok: false,
            code: invoiceValidation.code,
            error: invoiceValidation.error,
          });
        }
        try {
          const prepared = prepareScheduledEstimateCompletionEntry(
            stop,
            {
              ...entry,
              sourceEstimateId: stop.sourceEstimateId,
              sourceEstimateNumber: stop.sourceEstimateNumber || "",
              linkedInvoiceId: stop.linkedInvoiceId,
              billingDisposition: "linked-invoice",
            },
            baseline.catalog.value,
          );
          completionEntry = prepared.entry;
          estimateInventoryRequirements = prepared.requirements;
          estimateInvoiceFenceRequired = true;
        } catch (error) {
          const code = error?.code || "estimate-materials-invalid";
          return res.status(409).json({
            ok: false,
            code,
            error: mutationMessage(code, error?.itemName),
          });
        }
      }
      if (isNewCompletion && !stop.sourceEstimateId) {
        const clientMatches = baseline.clients.value.filter((item) => item && sameId(item.id, clientId));
        if (clientMatches.length === 1) {
          // The client row carries a display mirror that ordinary client-editing
          // staff can update. Never let that operational row decide whether an
          // invoice is suppressed. Only the protected server-maintained ledger
          // is authoritative, and fence its version in the completion commit.
          const clientForBilling = { ...clientMatches[0] };
          const authoritativePolicy = maintenanceBillingPolicyForClient(
            baseline.maintenanceBilling.value,
            clientId,
          );
          if (authoritativePolicy) clientForBilling.maintenanceBilling = authoritativePolicy;
          else delete clientForBilling.maintenanceBilling;
          maintenanceBillingFenceRequired = true;
          const prepared = preparePrepaidMaintenanceEntry({
            client: clientForBilling,
            stop,
            entry: completionEntry,
            scheduledDate,
          });
          completionEntry = prepared.entry;
          maintenanceBillingDecision = prepared.decision;
          if (maintenanceBillingDecision?.blocked) {
            return res.status(409).json({
              ok: false,
              code: maintenanceBillingDecision.reason,
              error: "Prepaid maintenance coverage must start on the first day of a month and end on the last day of a month. Update the client's billing coverage before completing this stop. Nothing was changed.",
            });
          }
        }
      }
      const mutation = mode === "complete"
        ? applyStopCompletion({
          clients: baseline.clients.value,
          catalog: baseline.catalog.value,
          completed: completedValue,
          clientId,
          entry: completionEntry,
          sid,
          receiptId,
          idempotencyKey,
          completedAt,
        })
        : reverseStopCompletion({
          clients: baseline.clients.value,
          catalog: baseline.catalog.value,
          completed: completedValue,
          clientId,
          sid,
          allowLegacy,
        });

      if (!mutation.ok) {
        const mutationCode = isNewCompletion && stop.sourceEstimateId && mutation.code === "inventory-stock-insufficient"
          ? "estimate-inventory-not-applied"
          : mutation.code;
        if (mutation.code === "legacy-completion") {
          return res.status(409).json({ ok: false, code: mutation.code, legacy: true, error: "This older completion has no exact reversal receipt." });
        }
        return res.status(409).json({ ok: false, code: mutationCode, error: mutationMessage(mutationCode, mutation.itemName) });
      }
      if (isNewCompletion && stop.sourceEstimateId) {
        try {
          assertScheduledEstimateInventoryApplied(
            estimateInventoryRequirements,
            mutation.receipt?.inventory,
          );
        } catch (error) {
          const code = error?.code || "estimate-inventory-not-applied";
          return res.status(409).json({
            ok: false,
            code,
            error: mutationMessage(code, error?.itemName),
          });
        }
      }
      const client = mutation.clients.find((item) => item && sameId(item.id, clientId));
      const receiptEntryId = cleanId(mutation.receipt?.history?.entryReceiptId || mutation.receipt?.id);
      const durableCompletionEntry = mode === "complete"
        ? (
          (receiptEntryId && Array.isArray(client?.history)
            ? client.history.find((item) => item && sameId(item.completionReceiptId, receiptEntryId))
            : null)
          || completionEntry
        )
        : null;
      if (mode === "complete" && !isNewCompletion) {
        maintenanceBillingDecision = prepaidMaintenanceCoverage({
          client,
          stop,
          entry: durableCompletionEntry,
          scheduledDate,
          policySource: "entry",
        });
      }
      const invoicePlan = planCompletionInvoice({
        mode,
        invoices: baseline.invoices.exists ? baseline.invoices.value : [],
        invoicing: baseline.invoicing.exists ? baseline.invoicing.value : {},
        schedule: baseline.schedule.value,
        completed: mutation.completed,
        stop,
        entry: durableCompletionEntry,
        client,
        receiptId: mutation.receipt?.id || receiptId,
        completedAt: mutation.receipt?.completedAt || completedAt,
        now: completedAt,
        maintenanceBillingDecision,
      });
      if ((mutation.alreadyCompleted || mutation.alreadyReversed) && !invoicePlan.changed) {
        return res.status(200).json({
          ok: true,
          applied: false,
          alreadyCompleted: !!mutation.alreadyCompleted,
          alreadyReversed: !!mutation.alreadyReversed,
          sameRequest: !!mutation.sameRequest,
          clientName: client && client.name ? String(client.name).slice(0, 160) : "",
          invoiceOutcome: invoicePlan.outcome,
        });
      }

      let nextSchedule = baseline.schedule.value;
      let estimateFulfillment = null;
      if (stop.sourceEstimateId) {
        try {
          estimateFulfillment = mode === "complete"
            ? claimScheduledEstimateCompletion(stop, {
              completionReceiptId: mutation.receipt?.id,
              completedAt: mutation.receipt?.completedAt || completedAt,
              linkedInvoiceId: stop.linkedInvoiceId,
            })
            : releaseScheduledEstimateCompletion(stop, {
              completionReceiptId: mutation.receipt?.id,
              reopenedAt: completedAt,
            });
          if (mode === "complete" && estimateFulfillment.shouldCreateInvoice) {
            return res.status(409).json({
              ok: false,
              code: "estimate-invoice-required",
              error: "Create or link the draft invoice from this estimate before completing the stop. Nothing was changed.",
            });
          }
          nextSchedule = replaceScheduledStop(baseline.schedule.value, sid, estimateFulfillment.stop);
        } catch (error) {
          return res.status(409).json({
            ok: false,
            code: "estimate-fulfillment-conflict",
            error: error?.message || "The estimate fulfillment link could not be updated safely.",
          });
        }
      }

      const scheduleOperation = stop.sourceEstimateId
        ? { key: "sps_schedule", expectedVersion: baseline.schedule.version, value: nextSchedule }
        : { key: "sps_schedule", expectedVersion: baseline.schedule.version, checkOnly: true };
      const operations = [
        { key: "sps_clients", expectedVersion: baseline.clients.version, value: mutation.clients },
        { key: "sps_completed", expectedVersion: baseline.completed.exists ? baseline.completed.version : 0, value: mutation.completed },
        // Estimate-linked stops also advance/release their fulfillment receipt here. Regular
        // stops use a check-only row lock, so a concurrent edit still conflicts without rewriting
        // the full unchanged schedule document or advancing its version.
        scheduleOperation,
      ];
      if (invoicePlan.changed) operations.push({
        key: "sps_invoices",
        expectedVersion: baseline.invoices.exists ? baseline.invoices.version : 0,
        value: invoicePlan.invoices,
      });
      else if (estimateInvoiceFenceRequired) operations.push({
        key: "sps_invoices",
        expectedVersion: baseline.invoices.version,
        checkOnly: true,
      });
      const catalogFenceRequired = mode === "complete"
        ? hasPositiveTrackedUsage(completionEntry)
        : !!mutation.receipt?.inventory?.length;
      if (catalogFenceRequired) operations.push({
        key: "sps_catalog",
        expectedVersion: baseline.catalog.version,
        value: mutation.catalog,
      });
      if (maintenanceBillingFenceRequired) operations.push(baseline.maintenanceBilling.exists
        ? {
          key: "sps_maintenance_billing",
          expectedVersion: baseline.maintenanceBilling.version,
          checkOnly: true,
        }
        : {
          // The first completion on an older install creates the protected ledger row. Once it
          // exists, later completions use the check-only path above.
          key: "sps_maintenance_billing",
          expectedVersion: 0,
          value: baseline.maintenanceBilling.value,
        });
      uncertainCommit = mode === "complete" ? {
        sid,
        clientId,
        idempotencyKey,
        invoicePlan,
        estimateFulfillment,
      } : null;
      telemetry.setPhase("commit-batch");
      const saved = await compareAndSetAppStateBatch(operations, telemetry.appStateOptions("commit-batch"));
      uncertainCommit = null;
      if (saved.applied) {
        telemetry.setPhase("complete");
        return res.status(200).json({
          ok: true,
          applied: true,
          mode,
          receiptId: mutation.receipt && mutation.receipt.id,
          legacy: !!mutation.legacy,
          clientName: client && client.name ? String(client.name).slice(0, 160) : "",
          inventoryDeducted: mode === "complete" ? mutation.inventoryDeducted : [],
          inventoryRestored: mode === "reverse" ? mutation.inventoryRestored : [],
          invoiceOutcome: invoicePlan.outcome,
          estimateFulfillment: estimateFulfillment ? {
            sourceEstimateId: estimateFulfillment.stop.sourceEstimateId,
            state: estimateFulfillment.stop.estimateFulfillment?.state || "",
            shouldCreateInvoice: !!estimateFulfillment.shouldCreateInvoice,
          } : null,
        });
      }
      if (saved.outcome !== "conflict") throw new Error(`unexpected_batch_outcome:${saved.outcome || "unknown"}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 20)));
    }
    telemetry.setPhase("contention");
    return res.status(409).json({ ok: false, code: "contention", error: "Another employee is changing this stop right now. Nothing was changed; please try again." });
  } catch (error) {
    if (uncertainCommit && isUncertainBatchFailure(error)) {
      telemetry.setPhase("verify-uncertain-commit");
      let confirmation = null;
      try {
        confirmation = await confirmCompletedStopAfterUncertainBatch(uncertainCommit);
      } catch (verificationError) {
        console.error("[stop-completion]", JSON.stringify({
          event: "uncertain_commit_verification_failed",
          requestId: telemetry.requestId,
          code: String(verificationError?.code || verificationError?.name || "STOP_COMPLETION_VERIFICATION_ERROR").slice(0, 80),
        }));
      }
      if (confirmation) {
        telemetry.setPhase("complete-after-verification");
        return res.status(200).json({
          ok: true,
          applied: true,
          mode: "complete",
          receiptId: confirmation.receipt.id,
          legacy: false,
          clientName: confirmation.client?.name ? String(confirmation.client.name).slice(0, 160) : "",
          inventoryDeducted: Array.isArray(confirmation.receipt.inventory) ? confirmation.receipt.inventory : [],
          invoiceOutcome: uncertainCommit.invoicePlan.outcome,
          estimateFulfillment: uncertainCommit.estimateFulfillment ? {
            sourceEstimateId: uncertainCommit.estimateFulfillment.stop.sourceEstimateId,
            state: uncertainCommit.estimateFulfillment.stop.estimateFulfillment?.state || "",
            shouldCreateInvoice: !!uncertainCommit.estimateFulfillment.shouldCreateInvoice,
          } : null,
          confirmedAfterUncertainWrite: true,
        });
      }
      telemetry.setPhase("completion-save-unconfirmed");
      telemetry.logFailure(error);
      return res.status(503).json({
        ok: false,
        code: "completion-save-unconfirmed",
        retryable: true,
        commitState: "unconfirmed",
        requestId: telemetry.requestId,
        error: "The server could not confirm this completed report. Your saved report will retry automatically.",
      });
    }
    telemetry.logFailure(error);
    if (error?.code === "APP_STATE_REQUEST_TIMEOUT") {
      telemetry.setPhase("shared-data-timeout");
      return res.status(504).json({
        ok: false,
        code: "shared-data-timeout",
        retryable: true,
        commitState: "not-started",
        requestId: telemetry.requestId,
        error: "The shared data service took too long to confirm this report. Nothing was lost; the report will retry automatically.",
      });
    }
    return res.status(502).json({ ok: false, error: "The shared stop data could not be saved. Nothing was changed; please try again." });
  }
}
