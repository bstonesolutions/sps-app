import { createHash } from "node:crypto";
import { requireCapability } from "./_staff-auth.js";
import { compareAndSetStopCompletionBatch, readAppStatesVersioned } from "./_app-state.js";
import { STOP_REVERSAL_LEDGER_KEY, isNonnegativeMoneyString, validateStopReceipt } from "../stopCompletion.js";
import { stableReportJSON, STOP_REPORT_EDIT_FIELDS, STOP_REPORT_RECOVERY_FIELDS } from "../stopReport.js";

const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);
const sameId = (a, b) => String(a) === String(b);
const same = (a, b) => stableReportJSON(a ?? null) === stableReportJSON(b ?? null);
const financialFields = new Set(["invoice", "quoted_price", "breakdown"]);
const reportHash = entry => createHash("sha256").update(stableReportJSON(entry)).digest("hex");

export function canEditReportFinancials(member) {
  const role = String(member?.role || "field").toLowerCase();
  if (role === "owner") return true;
  if (member?.tabAccess) return ["view", "edit"].includes(member.tabAccess.reports);
  return role === "full" || (role === "custom" && member?.perms?.canSeeProfit === true);
}

function validChanges(changes, recovery) {
  if (!isRecord(changes)) return false;
  const allowed = new Set(recovery ? STOP_REPORT_RECOVERY_FIELDS : STOP_REPORT_EDIT_FIELDS);
  if (Object.keys(changes).some(key => !allowed.has(key))) return false;
  for (const key of ["type", "tech", "notes", "officeNotes", "date", "assigneeId"]) {
    if (Object.hasOwn(changes, key) && typeof changes[key] !== "string" && !(key === "assigneeId" && typeof changes[key] === "number")) return false;
  }
  for (const key of ["services", "products", "photos", "checklist"]) {
    if (Object.hasOwn(changes, key) && !Array.isArray(changes[key])) return false;
  }
  for (const key of ["readings", "readingStatus", "breakdown"]) {
    if (Object.hasOwn(changes, key) && !isRecord(changes[key])) return false;
  }
  if (Object.hasOwn(changes, "invoice") && !isNonnegativeMoneyString(changes.invoice)) return false;
  if (Object.hasOwn(changes, "quoted_price") && (typeof changes.quoted_price !== "number" || !Number.isFinite(changes.quoted_price) || changes.quoted_price < 0)) return false;
  try { return Buffer.byteLength(JSON.stringify(changes), "utf8") <= 3_500_000; } catch (_) { return false; }
}

function unchangedRequestedFields(entry, changes) {
  return Object.entries(changes).every(([key, value]) => same(entry[key], value));
}

function receiptReport(snapshot, { sid, clientId, receiptId }) {
  const completed = snapshot.sps_completed?.value;
  const clients = snapshot.sps_clients?.value;
  if (!isRecord(completed) || !Array.isArray(clients)) return { code: "shared-report-data-invalid" };
  const marker = completed[sid];
  const receipt = completed[STOP_REVERSAL_LEDGER_KEY]?.[receiptId];
  if (!isRecord(marker) || marker.v !== 2 || marker.receiptId !== receiptId
    || !validateStopReceipt(receipt).ok || receipt.id !== receiptId
    || !sameId(receipt.sid, sid) || !sameId(receipt.clientId, clientId)
    || marker.completedAt !== receipt.completedAt) return { code: "report-receipt-mismatch" };
  const clientMatches = clients.filter(row => row && sameId(row.id, clientId));
  if (clientMatches.length !== 1) return { code: "report-client-ambiguous" };
  const client = clientMatches[0];
  const history = Array.isArray(client.history) ? client.history : [];
  const allMatches = clients.flatMap(row => Array.isArray(row?.history) ? row.history : [])
    .filter(row => row?.completionReceiptId === receiptId);
  if (allMatches.length > 1) return { code: "report-ambiguous" };
  const entry = history.find(row => row?.completionReceiptId === receiptId);
  if ((allMatches.length && !entry) || (entry && !sameId(entry.sid, sid))) return { code: "report-receipt-mismatch" };
  if (!entry && history.some(row => sameId(row?.sid, sid))) return { code: "report-ambiguous" };
  return { receipt, client, history, entry };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  const staff = await requireCapability(req, res, "editHistory", "editing saved service reports");
  if (!staff) return;
  const { clientId, sid, receiptId, expectedHash, changes } = req.body || {};
  const recovery = expectedHash === null;
  if (![clientId, sid, receiptId].every(value => ["string", "number"].includes(typeof value) && String(value).trim() && String(value).length <= 320)
    || (!recovery && (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash))) || !validChanges(changes, recovery)) {
    return res.status(400).json({ ok: false, code: "invalid-report-edit", error: "The report edit is invalid. Keep your edits open and reopen the saved report before trying again." });
  }
  if (!canEditReportFinancials(staff.teamMember) && Object.keys(changes).some(key => financialFields.has(key)
    && !(recovery && ((key === "invoice" && Number(changes[key].slice(1)) === 0) || (key === "quoted_price" && changes[key] === 0) || (key === "breakdown" && Object.keys(changes[key]).length === 0))))) {
    return res.status(403).json({ ok: false, code: "report-financial-access-required", error: "Your permissions do not allow changing the report's financial snapshot." });
  }

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await readAppStatesVersioned(["sps_clients", "sps_completed"]);
      const current = receiptReport(snapshot, { sid, clientId, receiptId });
      if (current.code) return res.status(409).json({ ok: false, code: current.code, error: "This saved report could not be identified safely. Your edits are still here; refresh its saved version before retrying." });
      if (current.entry && unchangedRequestedFields(current.entry, changes)) {
        return res.status(200).json({ ok: true, applied: false, alreadyApplied: true, receiptId, entry: current.entry });
      }
      if ((recovery && current.entry) || (!recovery && (!current.entry || reportHash(current.entry) !== expectedHash))) {
        return res.status(409).json({ ok: false, code: "report-changed", error: "Someone changed this report while you were editing it. Your edits are still here; review the latest saved report before trying again." });
      }
      const nextEntry = recovery ? {
        invoice: "$0", notes: "", officeNotes: "", photos: [], readings: {}, readingStatus: {},
        services: [], products: [], checklist: [], ...changes,
        sid: current.receipt.sid, completionReceiptId: current.receipt.id,
        recoveredFromSchedule: true, recoveredAt: new Date().toISOString(),
      } : { ...current.entry, ...changes };
      if (recovery && !String(nextEntry.notes || "").trim() && !nextEntry.photos.length
        && !Object.values(nextEntry.readings).some(value => value != null && value !== "" && value !== "—")) {
        return res.status(400).json({ ok: false, code: "report-recovery-empty", error: "Add visit notes, a reading, or a photo before saving this rebuilt report." });
      }
      const nextHistory = recovery ? [nextEntry, ...current.history]
        : current.history.map(row => row === current.entry ? nextEntry : row);
      const nextClients = snapshot.sps_clients.value.map(row => row === current.client ? { ...row, history: nextHistory } : row);
      const saved = await compareAndSetStopCompletionBatch([
        { key: "sps_clients", expectedVersion: snapshot.sps_clients.version, value: nextClients },
        { key: "sps_completed", expectedVersion: snapshot.sps_completed.version, checkOnly: true },
      ], { mode: "edit", sid, receiptId });
      if (saved.applied) return res.status(200).json({ ok: true, applied: true, receiptId, entry: nextEntry });
      if (saved.outcome !== "conflict") throw new Error("unexpected_report_edit_outcome");
    }
    return res.status(409).json({ ok: false, code: "report-contention", error: "The shared report changed again. Your edits are still here; retry saving." });
  } catch (error) {
    console.error("[stop-report] save failed", String(error?.code || error?.name || "report-save-error"));
    return res.status(503).json({ ok: false, code: "report-save-unconfirmed", error: "The report save could not be confirmed. Keep your edits open and retry saving." });
  }
}
