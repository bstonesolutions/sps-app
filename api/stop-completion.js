// Narrow, staff-authorized transaction for completing and reopening scheduled stops.
// Browsers never receive service-role access and field staff never receive the generic owner-only
// batch primitive. The server derives every changed app_state value from the latest shared rows,
// then commits clients/catalog/completed together with version checks.

import { randomUUID } from "node:crypto";
import { requireCapability } from "./_staff-auth.js";
import { compareAndSetAppStateBatch, readAppStateVersioned } from "./_app-state.js";
import { applyStopCompletion, hasPositiveTrackedUsage, isNonnegativeMoneyString, reverseStopCompletion } from "../stopCompletion.js";

const MAX_ATTEMPTS = 6;
const ENTRY_KEYS = new Set([
  "date", "tech", "type", "assigneeId", "notes", "officeNotes", "services", "checklist",
  "readings", "readingStatus", "ph", "ammonia", "nitrite", "temp", "invoice", "photos",
  "treatmentsUsed", "productsUsed", "productsPurchased", "partsUsed", "usageLoc",
  "quoted_price", "actual_hours", "target_hourly_rate", "arrivedAt", "breakdown",
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
  };
  return messages[code] || "The stop could not be changed safely.";
}

async function readBaseline() {
  const [clients, catalog, completed, schedule] = await Promise.all([
    readAppStateVersioned("sps_clients"),
    readAppStateVersioned("sps_catalog"),
    readAppStateVersioned("sps_completed"),
    readAppStateVersioned("sps_schedule"),
  ]);
  if (!clients.exists || !Array.isArray(clients.value)) throw new Error("shared_clients_invalid");
  if (!catalog.exists || !isRecord(catalog.value)) throw new Error("shared_catalog_invalid");
  if (completed.exists && !isRecord(completed.value)) throw new Error("shared_completions_invalid");
  if (!schedule.exists || !Array.isArray(schedule.value)) throw new Error("shared_schedule_invalid");
  return { clients, catalog, completed, schedule };
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
      const mutation = mode === "complete"
        ? applyStopCompletion({
          clients: baseline.clients.value,
          catalog: baseline.catalog.value,
          completed: completedValue,
          clientId,
          entry,
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

      const operations = [
        { key: "sps_clients", expectedVersion: baseline.clients.version, value: mutation.clients },
        { key: "sps_completed", expectedVersion: baseline.completed.exists ? baseline.completed.version : 0, value: mutation.completed },
        // Unchanged value, version fence: if the stop is deleted, cancelled, or assigned to a
        // different client after validation, the whole transaction conflicts and is recomputed.
        { key: "sps_schedule", expectedVersion: baseline.schedule.version, value: baseline.schedule.value },
      ];
      const catalogFenceRequired = mode === "complete"
        ? hasPositiveTrackedUsage(entry)
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
