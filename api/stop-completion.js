// Narrow, staff-authorized transaction for completing and reopening scheduled stops.
// Browsers never receive service-role access and field staff never receive the generic owner-only
// batch primitive. The server derives every changed app_state value from the latest shared rows,
// then commits clients/catalog/completed together with version checks.

import { randomUUID } from "node:crypto";
import { requireCapability } from "./_staff-auth.js";
import { compareAndSetAppStateBatch, readAppStateVersioned } from "./_app-state.js";
import { applyStopCompletion, hasPositiveTrackedUsage, isNonnegativeMoneyString, reverseStopCompletion } from "../stopCompletion.js";
import {
  assertScheduledEstimateInventoryApplied,
  claimScheduledEstimateCompletion,
  prepareScheduledEstimateCompletionEntry,
  releaseScheduledEstimateCompletion,
} from "../estimateScheduleLink.js";

const MAX_ATTEMPTS = 6;
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
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
      if (stop && sameId(stop.sid, sid)) matches.push(stop);
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

async function readBaseline() {
  const [clients, catalog, completed, schedule, invoices] = await Promise.all([
    readAppStateVersioned("sps_clients"),
    readAppStateVersioned("sps_catalog"),
    readAppStateVersioned("sps_completed"),
    readAppStateVersioned("sps_schedule"),
    readAppStateVersioned("sps_invoices"),
  ]);
  if (!clients.exists || !Array.isArray(clients.value)) throw new Error("shared_clients_invalid");
  if (!catalog.exists || !isRecord(catalog.value)) throw new Error("shared_catalog_invalid");
  if (completed.exists && !isRecord(completed.value)) throw new Error("shared_completions_invalid");
  if (!schedule.exists || !Array.isArray(schedule.value)) throw new Error("shared_schedule_invalid");
  return { clients, catalog, completed, schedule, invoices };
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
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const staff = await requireCapability(req, res, "completeStops", "completing or reopening service stops");
  if (!staff) return;

  const mode = String((req.body && req.body.mode) || "");
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
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const baseline = await readBaseline();
      const stopMatches = scheduledStops(baseline.schedule.value, sid);
      if (!stopMatches.length) return res.status(409).json({ ok: false, code: "stop-not-found", error: "This stop is no longer on the shared schedule." });
      if (stopMatches.length !== 1) return res.status(409).json({ ok: false, code: "stop-id-ambiguous", error: "This stop ID appears more than once on the shared schedule. Nothing was changed." });
      const stop = stopMatches[0];
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
        if (mutation.code === "legacy-completion") {
          return res.status(409).json({ ok: false, code: mutation.code, legacy: true, error: "This older completion has no exact reversal receipt." });
        }
        return res.status(409).json({ ok: false, code: mutation.code, error: mutationMessage(mutation.code, mutation.itemName) });
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
      if (mutation.alreadyCompleted || mutation.alreadyReversed) {
        return res.status(200).json({
          ok: true,
          applied: false,
          alreadyCompleted: !!mutation.alreadyCompleted,
          alreadyReversed: !!mutation.alreadyReversed,
          sameRequest: !!mutation.sameRequest,
          clientName: client && client.name ? String(client.name).slice(0, 160) : "",
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

      const operations = [
        { key: "sps_clients", expectedVersion: baseline.clients.version, value: mutation.clients },
        { key: "sps_completed", expectedVersion: baseline.completed.exists ? baseline.completed.version : 0, value: mutation.completed },
        // Estimate-linked stops also advance/release their fulfillment receipt here. Regular
        // stops keep the same value as a version fence, so a concurrent edit still conflicts.
        { key: "sps_schedule", expectedVersion: baseline.schedule.version, value: nextSchedule },
      ];
      if (estimateInvoiceFenceRequired) operations.push({
        key: "sps_invoices",
        expectedVersion: baseline.invoices.version,
        value: baseline.invoices.value,
      });
      const catalogFenceRequired = mode === "complete"
        ? hasPositiveTrackedUsage(completionEntry)
        : !!mutation.receipt?.inventory?.length;
      if (catalogFenceRequired) operations.push({
        key: "sps_catalog",
        expectedVersion: baseline.catalog.version,
        value: mutation.catalog,
      });
      const saved = await compareAndSetAppStateBatch(operations);
      if (saved.applied) {
        return res.status(200).json({
          ok: true,
          applied: true,
          mode,
          receiptId: mutation.receipt && mutation.receipt.id,
          legacy: !!mutation.legacy,
          clientName: client && client.name ? String(client.name).slice(0, 160) : "",
          inventoryDeducted: mode === "complete" ? mutation.inventoryDeducted : [],
          inventoryRestored: mode === "reverse" ? mutation.inventoryRestored : [],
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
    return res.status(409).json({ ok: false, code: "contention", error: "Another employee is changing this stop right now. Nothing was changed; please try again." });
  } catch (error) {
    console.error("[stop-completion]", error && error.message ? error.message : error);
    return res.status(502).json({ ok: false, error: "The shared stop data could not be saved. Nothing was changed; please try again." });
  }
}
