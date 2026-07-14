// api/inbox.js — the owner's work-email inbox, served to the app (Comms → Email).
//
// OWNER-ONLY on every verb (requireOwner — same fail-closed, API_AUTH_ENFORCED-independent
// posture as bank data): sps_inbox is the owner's PRIVATE mail, so it has no RLS read policy
// at all — the shared supabase client gets nothing, and this endpoint is the only door.
//
//   GET  ?limit=100&kind=lead&unimported=1   → { ok, rows: [...] } (newest first)
//   POST { action: "markRead", ids: [...] }
//   POST { action: "markImported", id, leadId }   ← the app stamps this AFTER the lead is
//        confirmed in sps_leads (two-phase, like the website bridge — a merge that never
//        persisted can't get acked)
//   POST { action: "setKind", id, kind }          ← owner reclassifies a mis-triaged email

//   POST { action: "reply", id, body }            ← send a real reply via Resend, FROM the
//        configured Sending Identity (Comms → Settings), threaded (In-Reply-To) onto the
//        original, with a copy dropped into the owner's real Gmail "Sent" over IMAP
//        (api/_gmail.js appendToGmailSent — best-effort; replaces the old inbox BCC).

import { requireOwner } from "./plaid/_plaid.js";
import { resolveFrom } from "./_sender.js";
import { appendToGmailSent } from "./_gmail.js";
import { mutateAppState, NO_APP_STATE_CHANGE, readAppStateVersioned } from "./_app-state.js";

// Sending also drops a copy into Gmail "Sent" over IMAP — give the function room for that round-trip.
export const config = { maxDuration: 30 };

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const sbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const parseVal = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const INBOX_OPERATION_FIELD = "_spsInboxOperation";
const INBOX_OPERATION_TTL_MS = 90_000;
const newOperationId = (type) => `${type}_${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
const operationMarker = (lead) => {
  const marker = lead && lead[INBOX_OPERATION_FIELD];
  return marker && typeof marker === "object" ? marker : null;
};
const operationIsFresh = (marker) => {
  const startedAt = Number(marker && marker.startedAt);
  return !Number.isFinite(startedAt) || startedAt > Date.now() - INBOX_OPERATION_TTL_MS;
};
const withoutOperationMarker = (lead) => {
  if (!lead || typeof lead !== "object" || !Object.prototype.hasOwnProperty.call(lead, INBOX_OPERATION_FIELD)) return lead;
  const clean = { ...lead };
  delete clean[INBOX_OPERATION_FIELD];
  return clean;
};
const operationConflict = () => {
  const error = new Error("lead_inbox_operation_in_progress");
  error.code = "LEAD_INBOX_OPERATION_IN_PROGRESS";
  return error;
};
async function sbGet(key, fallback) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders() });
    if (!r.ok) return fallback;
    const rows = await r.json().catch(() => []);
    const v = rows && rows[0] ? parseVal(rows[0].value) : null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}
const escapeHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Shared email look + helpers for send/reply. The rich composer sends real HTML (bold/italic/
// lists/links); strip only scripts/styles (the owner authors it, so this is a light guard).
const EMAIL_FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#111827;line-height:1.6";
const stripHtml = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").slice(0, 300000);
const sigHtml = (sig) => sig ? `<br><br>${escapeHtml(sig).replace(/\n/g, "<br>")}` : "";
// Build the html part: use the composer's HTML when present, else pre-wrap the plain text.
const emailHtml = (htmlIn, textOut, sig) => htmlIn
  ? `<div style="${EMAIL_FONT}">${htmlIn}${sigHtml(sig)}</div>`
  : `<div style="${EMAIL_FONT};white-space:pre-wrap">${escapeHtml(textOut)}</div>`;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Composer attachments → Resend format ([{ filename, content(base64) }]). Hard-capped: Vercel's
// request body is ~4.5MB, so we bound total base64 well under that and keep headroom for the message.
const cleanAttachments = (arr) => {
  const out = [];
  let total = 0;
  for (const a of (Array.isArray(arr) ? arr : []).slice(0, 5)) {
    const content = String((a && a.content) || "");
    if (!content) continue;
    total += content.length;
    if (total > 4_000_000) break; // ~3MB of raw bytes across all files — a backstop below Vercel's ~4.5MB body limit
    out.push({ filename: String((a && a.filename) || "attachment").replace(/[\r\n"\\]+/g, " ").slice(0, 200), content });
  }
  return out;
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!SERVICE_KEY) return res.status(501).json({ error: "Server missing SUPABASE_SERVICE_ROLE_KEY", missingEnv: true });

  const u = await requireOwner(req, res, "the email inbox");
  if (!u) return;

  try {
    if (req.method === "GET") {
      const q = req.query || {};
      const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
      let filter = `order=created_at.desc&limit=${limit}`;
      if (q.kind && /^[a-z]+$/.test(String(q.kind))) filter += `&kind=eq.${q.kind}`;
      if (q.unimported === "1") filter += `&lead_id=eq.`;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?select=*&${filter}`, { headers: sbHeaders() });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const hint = /relation .*sps_inbox|42P01/i.test(t) ? "The sps_inbox table hasn't been created yet — run the SQL in CLAUDE.md." : t.slice(0, 200);
        return res.status(502).json({ error: hint });
      }
      return res.status(200).json({ ok: true, rows: (await r.json().catch(() => [])) || [] });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    const b = req.body || {};
    const patch = async (idFilter, fields, expectedIds = null) => {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?${idFilter}`, {
          method: "PATCH",
          headers: expectedIds ? { ...sbHeaders(), Prefer: "return=representation" } : sbHeaders(),
          body: JSON.stringify(fields),
        });
        if (!r.ok) return false;
        if (!expectedIds) return true;
        const rows = await r.json().catch(() => []);
        const returned = new Set((Array.isArray(rows) ? rows : []).map((row) => String((row && row.id) || "")));
        return expectedIds.every((id) => returned.has(String(id)));
      } catch (_) { return false; }
    };
    const eqFilter = (field, value) => value == null
      ? `${field}=is.null`
      : `${field}=eq.${encodeURIComponent(String(value))}`;
    const readInboxRows = async (ids) => {
      try {
        const safeIds = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
        if (!safeIds.length) return { ok: true, rows: [] };
        const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?select=id,kind,lead_id&id=in.(${safeIds.map(encodeURIComponent).join(",")})`, { headers: sbHeaders() });
        return r.ok ? { ok: true, rows: (await r.json().catch(() => [])) || [] } : { ok: false, rows: [] };
      } catch (_) { return { ok: false, rows: [] }; }
    };
    const inboxMatches = async (expectedRows) => {
      const expected = Array.isArray(expectedRows) ? expectedRows : [];
      const current = await readInboxRows(expected.map((row) => row.id));
      if (!current.ok || current.rows.length !== expected.length) return false;
      const byId = new Map(current.rows.map((row) => [String(row.id), row]));
      return expected.every((row) => {
        const saved = byId.get(String(row.id));
        return saved && String(saved.kind == null ? "" : saved.kind) === String(row.kind == null ? "" : row.kind)
          && String(saved.lead_id == null ? "" : saved.lead_id) === String(row.lead_id == null ? "" : row.lead_id);
      });
    };
    const clearOwnedLeadMarkers = async (operationId) => mutateAppState("sps_leads", (current) => {
      const leads = Array.isArray(current) ? current : [];
      let changed = false;
      const next = leads.map((lead) => {
        const marker = operationMarker(lead);
        if (!marker || marker.id !== operationId) return lead;
        changed = true;
        return withoutOperationMarker(lead);
      });
      return changed ? next : NO_APP_STATE_CHANGE;
    });
    if (b.action === "markRead") {
      // b.read: true (default) or false — same action handles "mark unread".
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: "No ids." });
      const ok = await patch(`id=in.(${ids.map(encodeURIComponent).join(",")})`, { read: b.read !== false });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "markImported") {
      if (!b.id || !b.leadId) return res.status(400).json({ error: "Need id + leadId." });
      const ok = await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { lead_id: String(b.leadId) });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "markReplied") {
      if (!b.id) return res.status(400).json({ error: "Need id." });
      const ok = await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { replied: true });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "setKind") {
      // Accepts a single id or a batch of ids (bulk reclassify from the inbox select mode).
      const ids = (Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : [])).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length || !["lead", "bill", "client", "other"].includes(b.kind)) return res.status(400).json({ error: "Need id(s) + a valid kind." });
      const ok = await patch(`id=in.(${ids.map(encodeURIComponent).join(",")})`, { kind: b.kind });
      return res.status(ok ? 200 : 502).json({ ok });
    }
    if (b.action === "repairImportedLeads") {
      // Linked, owner-confirmed cleanup for false email/SMS leads. Removing the funnel records and
      // unlinking their inbox rows in one server request avoids the split state the old client-side
      // delete path could leave behind. The CAS mutation preserves concurrent lead edits.
      const repairs = (Array.isArray(b.repairs) ? b.repairs : []).slice(0, 200)
        .map((item) => ({
          id: String((item && item.id) || ""),
          kind: item && item.kind === "client" ? "client" : "other",
          leadId: String((item && item.leadId) || ""),
          hasExpectedUpdatedAt: !!item && Object.prototype.hasOwnProperty.call(item, "expectedUpdatedAt"),
          expectedUpdatedAt: String((item && item.expectedUpdatedAt) || ""),
          hasExpectedStatus: !!item && Object.prototype.hasOwnProperty.call(item, "expectedStatus"),
          expectedStatus: String((item && item.expectedStatus) || ""),
          hasExpectedConvertedClientId: !!item && Object.prototype.hasOwnProperty.call(item, "expectedConvertedClientId"),
          expectedConvertedClientId: String((item && item.expectedConvertedClientId) || ""),
        }))
        .filter((item, index, all) => item.id && item.leadId && all.findIndex((candidate) => candidate.id === item.id) === index);
      if (!repairs.length) return res.status(400).json({ error: "No linked leads selected." });
      const originalRead = await readInboxRows(repairs.map((item) => item.id));
      if (!originalRead.ok) return res.status(502).json({ error: "Inbox could not be checked. Nothing was changed; try again." });
      const originalInbox = originalRead.rows;
      const originalById = new Map(originalInbox.map((row) => [String(row.id), row]));
      if (repairs.some((item) => !originalById.has(item.id))) {
        return res.status(409).json({ error: "One of those source messages no longer exists. Nothing was changed; refresh and try again." });
      }
      const repairById = new Map(repairs.map((item) => [item.id, item]));
      const staleInbox = repairs.some((repair) => {
        const row = originalById.get(repair.id);
        const kind = String((row && row.kind) || "").toLowerCase();
        const leadId = String((row && row.lead_id) || "");
        const stillLinked = kind === "lead" && leadId === repair.leadId;
        const alreadyRepaired = ["client", "other"].includes(kind) && !leadId;
        // A previous partial Fix (or a deliberate owner reclassification) already chose a safe
        // repaired category. Preserve that newer choice instead of overwriting it with stale UI.
        if (alreadyRepaired) repair.kind = kind;
        return !stillLinked && !alreadyRepaired;
      });
      if (staleInbox) {
        return res.status(409).json({ ok: false, error: "That Inbox message was reclassified or linked somewhere else. Nothing was changed; refresh before using Fix." });
      }
      const sourceIds = new Set(repairs.map((item) => `em_${item.id}`));
      const operationId = newOperationId("repair");
      const lockedSnapshots = [];

      // Claim the lead records through app_state CAS before touching Inbox. The marker serializes a
      // stale Fix against Undo without another table or SQL migration. A crashed marker can be taken
      // over after its short lease; normal completion or failure always clears it.
      try {
        await mutateAppState("sps_leads", (current) => {
          const leads = Array.isArray(current) ? current : [];
          const counts = new Map();
          for (const lead of leads) {
            const srcId = String((lead && lead.srcId) || "");
            if (sourceIds.has(srcId)) counts.set(srcId, (counts.get(srcId) || 0) + 1);
          }
          if ([...counts.values()].some((count) => count > 1)) {
            const conflict = new Error("duplicate_lead_source");
            conflict.code = "LEAD_CHANGED_SINCE_REVIEW";
            throw conflict;
          }
          lockedSnapshots.length = 0;
          let marked = false;
          const next = leads.map((lead) => {
            const srcId = String((lead && lead.srcId) || "");
            if (!sourceIds.has(srcId)) return lead;
            const repair = repairById.get(srcId.slice(3));
            const changed = (repair.leadId && String(lead.id || "") !== repair.leadId)
              || String(lead.status || "").toLowerCase() === "won"
              || !!lead.convertedClientId
              || (repair.hasExpectedUpdatedAt && String(lead.updatedAt || "") !== repair.expectedUpdatedAt)
              || (repair.hasExpectedStatus && String(lead.status || "") !== repair.expectedStatus)
              || (repair.hasExpectedConvertedClientId && String(lead.convertedClientId || "") !== repair.expectedConvertedClientId);
            if (changed) {
              const conflict = new Error("lead_changed_since_review");
              conflict.code = "LEAD_CHANGED_SINCE_REVIEW";
              throw conflict;
            }
            const marker = operationMarker(lead);
            if (marker && marker.id !== operationId && operationIsFresh(marker)) throw operationConflict();
            const clean = withoutOperationMarker(lead);
            lockedSnapshots.push(clean);
            marked = true;
            return { ...clean, [INBOX_OPERATION_FIELD]: { id: operationId, type: "repair", startedAt: Date.now() } };
          });
          return marked ? next : NO_APP_STATE_CHANGE;
        });
      } catch (error) {
        const busy = error && error.code === "LEAD_INBOX_OPERATION_IN_PROGRESS";
        const changed = error && error.code === "LEAD_CHANGED_SINCE_REVIEW";
        if (busy || changed) {
          return res.status(409).json({ ok: false, error: busy
            ? "Another Fix or Undo is already finishing for that message. Wait a moment, then try again."
            : "That lead changed or was converted on another device. Nothing was changed; refresh and review it again." });
        }
        // The CAS response can be lost after Postgres committed the marker. Recover only when every
        // source that existed in our updater is still the exact record owned by this operation.
        try {
          const latest = await readAppStateVersioned("sps_leads");
          const leads = latest.exists && Array.isArray(latest.value) ? latest.value : [];
          const currentSources = leads.filter((lead) => sourceIds.has(String((lead && lead.srcId) || "")));
          const snapshotBySource = new Map(lockedSnapshots.map((lead) => [String((lead && lead.srcId) || ""), lead]));
          const recovered = currentSources.length === lockedSnapshots.length
            && currentSources.every((lead) => {
              const snapshot = snapshotBySource.get(String((lead && lead.srcId) || ""));
              return snapshot && String(lead.id || "") === String(snapshot.id || "") && operationMarker(lead)?.id === operationId;
            });
          if (!recovered) {
            const ownedCount = currentSources.filter((lead) => operationMarker(lead)?.id === operationId).length;
            return res.status(ownedCount ? 500 : 502).json({ ok: false, ...(ownedCount ? { partial: true } : {}), error: ownedCount
              ? "The safety lock only partially settled. Wait a moment, then use Fix again."
              : "The safety lock could not be confirmed. Wait a moment, then try again." });
          }
        } catch (_) {
          return res.status(502).json({ ok: false, error: "The safety lock could not be confirmed. Wait a moment, then try again." });
        }
      }

      const inboxResults = await Promise.all(originalInbox.map((row) => {
        const repair = repairById.get(String(row.id));
        return patch(
          `id=eq.${encodeURIComponent(String(row.id))}&${eqFilter("kind", row.kind)}&${eqFilter("lead_id", row.lead_id)}`,
          { kind: repair.kind, lead_id: "" },
          [String(row.id)],
        );
      }));
      const repairedInbox = originalInbox.map((row) => ({
        id: String(row.id),
        kind: repairById.get(String(row.id)).kind,
        lead_id: "",
      }));
      // A zero-row PATCH can mean a concurrent request already wrote the exact desired state.
      // Accept that state as complete; it is safe for either request to finish the idempotent CAS.
      const inboxUpdated = inboxResults.every(Boolean) || await inboxMatches(repairedInbox);
      if (!inboxUpdated) {
        // Keep every funnel record intact and keep any Inbox progress already made. Rolling a row
        // backward is unsafe here: another device may have observed that repaired row and removed
        // its lead. The next Fix retries only the unfinished work and converges forward.
        let release;
        try { release = await clearOwnedLeadMarkers(operationId); }
        catch (_) {
          return res.status(500).json({ ok: false, partial: true, error: "Inbox only partially updated and the safety lock is still settling. Wait a moment, then use Fix again." });
        }
        if (await inboxMatches(originalInbox)) {
          return res.status(502).json({ ok: false, unchanged: true, error: "Inbox could not be updated, so the cleanup did not run. Nothing changed; try again.", leads: release.value });
        }
        return res.status(500).json({ ok: false, partial: true, error: "Inbox labels only partially updated. This request did not remove any leads, and Fix is still available to finish safely.", leads: release.value });
      }

      // With every source still protected by our marker, remove only the exact records this request
      // claimed. An opposing Undo cannot observe an unmarked lead and race this final CAS.
      const lockedBySource = new Map(lockedSnapshots.map((lead) => [String((lead && lead.srcId) || ""), JSON.stringify(lead)]));
      let mutation;
      try {
        mutation = await mutateAppState("sps_leads", (current) => {
          const leads = Array.isArray(current) ? current : [];
          const next = [];
          for (const lead of leads) {
            const srcId = String((lead && lead.srcId) || "");
            if (!lead || !sourceIds.has(srcId)) { next.push(lead); continue; }
            const marker = operationMarker(lead);
            if (!marker || marker.id !== operationId) throw operationConflict();
            if (JSON.stringify(withoutOperationMarker(lead)) !== lockedBySource.get(srcId)) {
              const conflict = new Error("lead_changed_since_review");
              conflict.code = "LEAD_CHANGED_SINCE_REVIEW";
              throw conflict;
            }
          }
          return next.length === leads.length ? NO_APP_STATE_CHANGE : next;
        });
      } catch (error) {
        let currentLeads = null;
        try {
          const latest = await readAppStateVersioned("sps_leads");
          if (latest.exists) currentLeads = latest.value;
        } catch (_) { /* explicit partial response below */ }
        // A lost CAS response may have applied even though the network failed. The durable state is
        // authoritative; preserve the exact pre-lock snapshots so Undo remains truthful.
        const sourceStillExists = Array.isArray(currentLeads)
          ? currentLeads.some((lead) => sourceIds.has(String((lead && lead.srcId) || "")))
          : true;
        if (!sourceStillExists && await inboxMatches(repairedInbox)) {
          return res.status(200).json({ ok: true, removed: lockedSnapshots, removedCount: lockedSnapshots.length, leads: currentLeads, inboxUpdated: true, recovered: true });
        }
        let release = null;
        try { release = await clearOwnedLeadMarkers(operationId); }
        catch (_) { /* a stale marker remains recoverable after its short lease */ }
        const releaseStillHasSource = release && Array.isArray(release.value)
          ? release.value.some((lead) => sourceIds.has(String((lead && lead.srcId) || "")))
          : true;
        if (!releaseStillHasSource && await inboxMatches(repairedInbox)) {
          return res.status(200).json({ ok: true, removed: lockedSnapshots, removedCount: lockedSnapshots.length, leads: release.value, inboxUpdated: true, recovered: true });
        }
        const changedAfterLock = error && error.code === "LEAD_CHANGED_SINCE_REVIEW";
        return res.status(changedAfterLock ? 409 : 500).json({
          ok: false,
          partial: true,
          inboxUpdated: true,
          error: changedAfterLock
            ? "That lead changed while Fix was running. It was not removed; refresh and review the repaired Inbox label."
            : release
              ? "Inbox labels were saved, but the lead cleanup could not finish. No lead was removed; use Fix again to retry safely."
              : "Inbox labels were saved, but the safety lock is still settling. Wait a moment, then use Fix again.",
          ...(release && Array.isArray(release.value) ? { leads: release.value } : {}),
        });
      }
      return res.status(200).json({ ok: true, removed: lockedSnapshots, removedCount: lockedSnapshots.length, leads: mutation.value, inboxUpdated: true });
    }
    if (b.action === "restoreImportedLeads") {
      // Short-lived Undo from the Leads screen. Only records returned by the repair action are
      // accepted, and only email/SMS-linked srcIds can be restored through this door.
      const records = (Array.isArray(b.records) ? b.records : []).slice(0, 200)
        .filter((lead) => lead && /^em_.+/.test(String(lead.srcId || "")) && lead.id)
        .filter((lead, index, all) => all.findIndex((candidate) => String(candidate.srcId) === String(lead.srcId)) === index);
      if (!records.length) return res.status(400).json({ error: "No repaired leads to restore." });
      const inboxIds = records.map((lead) => String(lead.srcId).slice(3));
      const originalRead = await readInboxRows(inboxIds);
      if (!originalRead.ok) return res.status(502).json({ error: "Inbox could not be checked. Undo did not run; try again." });
      const originalInbox = originalRead.rows;
      const originalById = new Map(originalInbox.map((row) => [String(row.id), row]));
      if (inboxIds.some((id) => !originalById.has(id))) {
        return res.status(409).json({ error: "A source message no longer exists. Undo did not run; refresh and try again." });
      }
      const staleInbox = records.some((record) => {
        const row = originalById.get(String(record.srcId).slice(3));
        const kind = String((row && row.kind) || "").toLowerCase();
        const leadId = String((row && row.lead_id) || "");
        const repairedState = ["client", "other"].includes(kind) && !leadId;
        const alreadyRestored = kind === "lead" && leadId === String(record.id);
        return !repairedState && !alreadyRestored;
      });
      if (staleInbox) {
        return res.status(409).json({ ok: false, error: "That Inbox message was reclassified or linked somewhere else. Undo did not run; refresh and review it." });
      }
      const operationId = newOperationId("undo");
      const added = [];
      try {
        await mutateAppState("sps_leads", (current) => {
          const leads = Array.isArray(current) ? current : [];
          const recordBySource = new Map(records.map((record) => [String(record.srcId), record]));
          const counts = new Map();
          for (const lead of leads) {
            const srcId = String((lead && lead.srcId) || "");
            if (recordBySource.has(srcId)) counts.set(srcId, (counts.get(srcId) || 0) + 1);
          }
          if ([...counts.values()].some((count) => count > 1)) {
            const conflict = new Error("lead_source_reused");
            conflict.code = "LEAD_SOURCE_REUSED";
            throw conflict;
          }
          for (const record of records) {
            const matches = leads.filter((lead) => String((lead && lead.srcId) || "") === String(record.srcId));
            if (matches.length === 1 && String(matches[0].id || "") !== String(record.id)) {
              const conflict = new Error("lead_source_reused");
              conflict.code = "LEAD_SOURCE_REUSED";
              throw conflict;
            }
            const marker = matches.length ? operationMarker(matches[0]) : null;
            if (marker && marker.id !== operationId && operationIsFresh(marker)) throw operationConflict();
          }
          added.length = 0;
          const markedExisting = leads.map((lead) => {
            const record = recordBySource.get(String((lead && lead.srcId) || ""));
            if (!record) return lead;
            const clean = withoutOperationMarker(lead);
            return { ...clean, [INBOX_OPERATION_FIELD]: { id: operationId, type: "undo", startedAt: Date.now() } };
          });
          const existingSources = new Set(leads.map((lead) => String((lead && lead.srcId) || "")));
          const add = records.filter((record) => !existingSources.has(String(record.srcId))).map((record) => {
            const clean = withoutOperationMarker(record);
            added.push(clean);
            return { ...clean, [INBOX_OPERATION_FIELD]: { id: operationId, type: "undo", startedAt: Date.now() } };
          });
          return [...add, ...markedExisting];
        });
      } catch (error) {
        const reused = error && error.code === "LEAD_SOURCE_REUSED";
        const busy = error && error.code === "LEAD_INBOX_OPERATION_IN_PROGRESS";
        if (reused || busy) {
          return res.status(409).json({ error: reused
            ? "That source message is linked to a different lead now. Undo did not run; refresh and review it."
            : "Another Fix or Undo is already finishing for that message. Wait a moment, then try again." });
        }
        // As with Fix, a failed HTTP response does not prove the marker CAS failed. Continue only
        // when every requested source is the exact lead now owned by this operation.
        try {
          const latest = await readAppStateVersioned("sps_leads");
          const leads = latest.exists && Array.isArray(latest.value) ? latest.value : [];
          const ownedCount = records.filter((record) => leads.some((lead) => String((lead && lead.srcId) || "") === String(record.srcId)
            && String((lead && lead.id) || "") === String(record.id)
            && operationMarker(lead)?.id === operationId)).length;
          if (ownedCount !== records.length) {
            return res.status(ownedCount ? 500 : 502).json({ ok: false, ...(ownedCount ? { partial: true } : {}), error: ownedCount
              ? "Undo's safety lock only partially settled. Wait a moment, then try again."
              : "Undo could not be confirmed. Wait a moment, then try again." });
          }
        } catch (_) {
          return res.status(502).json({ ok: false, error: "Undo could not be confirmed. Wait a moment, then try again." });
        }
      }
      const inboxResults = await Promise.all(records.map((lead) => {
        const inboxId = String(lead.srcId).slice(3);
        const original = originalById.get(inboxId);
        return patch(
          `id=eq.${encodeURIComponent(inboxId)}&${eqFilter("kind", original.kind)}&${eqFilter("lead_id", original.lead_id)}`,
          { kind: "lead", lead_id: String(lead.id) },
          [inboxId],
        );
      }));
      // A concurrent Undo may have restored the exact links after our conditional PATCH lost the
      // race (or after the response was lost). In that case the desired durable state already exists:
      // the desired state is complete even if our PATCH did not return its row.
      const restoredInbox = records.map((lead) => ({
        id: String(lead.srcId).slice(3),
        kind: "lead",
        lead_id: String(lead.id),
      }));
      const inboxUpdated = inboxResults.every(Boolean) || await inboxMatches(restoredInbox);
      if (!inboxUpdated) {
        // Restoration remains additive. Clear only our marker, keep every lead and successful link,
        // and let a retry finish forward without deleting data another request could rely on.
        try {
          const release = await clearOwnedLeadMarkers(operationId);
          const leads = Array.isArray(release.value) ? release.value : [];
          const allPresent = records.every((record) => leads.some((lead) => String((lead && lead.srcId) || "") === String(record.srcId)
            && String((lead && lead.id) || "") === String(record.id)));
          const inboxComplete = await inboxMatches(restoredInbox);
          return res.status(500).json({
            ok: false,
            partial: true,
            inboxUpdated: inboxComplete,
            error: allPresent
              ? "The lead was restored, but its Inbox link only partially saved. Use Undo again to finish safely."
              : "Undo only partially saved and the restored lead could not be confirmed. Use Undo again to finish safely.",
            leads,
          });
        } catch (_) {
          const inboxComplete = await inboxMatches(restoredInbox);
          return res.status(500).json({ ok: false, partial: true, inboxUpdated: inboxComplete, error: "Undo partially saved and its safety lock is still settling. Wait a moment, then use Undo again." });
        }
      }

      // The Inbox link is durable; publish the restored lead by clearing only this operation's
      // marker. A stale Fix cannot remove it before this CAS completes.
      try {
        const finalized = await clearOwnedLeadMarkers(operationId);
        const leads = Array.isArray(finalized.value) ? finalized.value : [];
        const allPresent = records.every((record) => leads.some((lead) => String((lead && lead.srcId) || "") === String(record.srcId)
          && String((lead && lead.id) || "") === String(record.id)));
        const inboxComplete = await inboxMatches(restoredInbox);
        if (allPresent && inboxComplete) {
          return res.status(200).json({ ok: true, restoredCount: added.length, leads, inboxUpdated: true });
        }
        return res.status(500).json({
          ok: false,
          partial: true,
          inboxUpdated: inboxComplete,
          error: !allPresent && inboxComplete
            ? "The Inbox link saved, but the restored lead could not be confirmed. Use Undo again to finish safely."
            : allPresent
              ? "The lead was restored, but its Inbox link could not be confirmed. Use Undo again to finish safely."
              : "Undo could not confirm both the restored lead and its Inbox link. Use Undo again to finish safely.",
          leads,
        });
      } catch (_) {
        try {
          const latest = await readAppStateVersioned("sps_leads");
          const leads = latest.exists && Array.isArray(latest.value) ? latest.value : [];
          const stillOwned = leads.some((lead) => operationMarker(lead)?.id === operationId);
          const allPresent = records.every((record) => leads.some((lead) => String((lead && lead.srcId) || "") === String(record.srcId) && String((lead && lead.id) || "") === String(record.id)));
          if (!stillOwned && allPresent && await inboxMatches(restoredInbox)) {
            return res.status(200).json({ ok: true, restoredCount: added.length, leads, inboxUpdated: true, recovered: true });
          }
        } catch (_) { /* explicit settling error below */ }
        return res.status(500).json({ ok: false, partial: true, inboxUpdated: true, error: "Undo saved, but its safety lock is still settling. Wait a moment, then refresh." });
      }
    }
    if (b.action === "delete") {
      // Owner deletes mail from their own inbox (single or bulk). Hard delete — sps_inbox is the
      // system of record, so there's no soft-delete; the UI confirms before calling this.
      const ids = (Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : [])).map(String).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: "No ids." });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=in.(${ids.map(encodeURIComponent).join(",")})&select=id`, {
        method: "DELETE",
        headers: { ...sbHeaders(), Prefer: "return=representation" },
      });
      if (!r.ok) return res.status(502).json({ ok: false, deleted: 0, deletedIds: [], error: "Inbox delete was not saved." });
      const deletedRows = await r.json().catch(() => []);
      const deletedIds = (Array.isArray(deletedRows) ? deletedRows : []).map(row => String(row && row.id || "")).filter(Boolean);
      const deletedSet = new Set(deletedIds);
      const complete = ids.every(id => deletedSet.has(id));
      return res.status(complete ? 200 : 409).json({ ok: complete, deleted: deletedIds.length, deletedIds, missingIds: ids.filter(id => !deletedSet.has(id)) });
    }
    if (b.action === "reply") {
      if (!RESEND_KEY) return res.status(501).json({ error: "Email sending isn't configured (RESEND_API_KEY).", missingEnv: true });
      const replyBody = String(b.body || "").trim().slice(0, 10000);
      if (!b.id || !replyBody) return res.status(400).json({ error: "Need id + a reply body." });
      // Load the original for the address, subject, and threading id.
      const rr = await fetch(`${SUPABASE_URL}/rest/v1/sps_inbox?id=eq.${encodeURIComponent(String(b.id))}&select=from_email,from_name,subject,message_id`, { headers: sbHeaders() });
      const orig = ((await rr.json().catch(() => [])) || [])[0];
      if (!orig || !orig.from_email) return res.status(404).json({ error: "That email isn't in the inbox anymore." });
      // Defense in depth: SMS rows store a formatted phone in from_email — never try to email
      // that. The UI hides email-reply for texts (shows "Text back"), but guard the API too.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(orig.from_email).trim())) {
        return res.status(400).json({ error: "This is a text message — reply with “Text back,” not email." });
      }
      // FROM = the configured Sending Identity (Comms → Settings) on the verified domain — same canon
      // as every other send. The sent copy lands in the owner's real Gmail "Sent" over IMAP below
      // (no BCC — that used to drop a copy into the Inbox instead, which just cluttered it).
      const email = await sbGet("sps_email", {});
      const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
      const sig = String(email.signature || "").trim();
      const bodyOut = replyBody + (sig ? `\n\n${sig}` : "");
      const htmlIn = b.html ? stripHtml(b.html) : "";
      const subject = /^re:/i.test(orig.subject || "") ? orig.subject : `Re: ${orig.subject || ""}`.trim();
      const atts = cleanAttachments(b.attachments);
      const replyHtmlOut = emailHtml(htmlIn, bodyOut, sig);
      const sr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [orig.from_email], subject,
          text: bodyOut,
          html: replyHtmlOut,
          ...(atts.length ? { attachments: atts } : {}),
          ...(orig.message_id ? { headers: { "In-Reply-To": orig.message_id, References: orig.message_id } } : {}),
        }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) return res.status(502).json({ error: sd?.message || `Resend ${sr.status}` });
      // Drop the sent copy into the owner's real Gmail "Sent" (and Apple Mail), threaded to the
      // original. Best-effort — the reply already went out; never fail the request on this.
      try { await appendToGmailSent({ from, to: orig.from_email, subject, html: replyHtmlOut, text: bodyOut, inReplyTo: orig.message_id || undefined, references: orig.message_id || undefined }); } catch (_) {}
      await patch(`id=eq.${encodeURIComponent(String(b.id))}`, { replied: true }).catch(() => {});
      // Comms → Log entry (outbound record, like any other send). Legacy-shape fallback for
      // installs that haven't added the origin/recipient columns yet.
      try {
        const base = { client_id: "", type: "Email reply", channel: "email", body: `${subject} — ${replyBody.slice(0, 600)}`, ok: true };
        const lr = await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, {
          method: "POST", headers: sbHeaders(),
          body: JSON.stringify({ ...base, origin: "work-email reply (Comms → Email)", recipient: orig.from_email }),
        });
        if (lr.status === 400 && /column/i.test(await lr.text().catch(() => ""))) {
          await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(base) });
        }
      } catch { /* best-effort */ }
      return res.status(200).json({ ok: true, id: sd.id || null });
    }
    if (b.action === "send") {
      // Compose a brand-new email from the app (Comms → Email → Compose). Same send canon as reply:
      // FROM the Sending Identity, signature appended, and the sent copy dropped into Gmail "Sent".
      if (!RESEND_KEY) return res.status(501).json({ error: "Email sending isn't configured (RESEND_API_KEY).", missingEnv: true });
      const to = String(b.to || "").trim();
      const subject = String(b.subject || "").trim().slice(0, 300);
      const bodyIn = String(b.body || "").trim().slice(0, 10000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Enter a valid recipient email address." });
      if (!bodyIn) return res.status(400).json({ error: "Write a message first." });
      const email = await sbGet("sps_email", {});
      const from = resolveFrom({ fromName: email.fromName, fromAddress: email.fromAddress }, process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>");
      const sig = String(email.signature || "").trim();
      const bodyOut = bodyIn + (sig ? `\n\n${sig}` : "");
      const htmlIn = b.html ? stripHtml(b.html) : "";
      const atts = cleanAttachments(b.attachments);
      const sendHtmlOut = emailHtml(htmlIn, bodyOut, sig);
      const sr = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [to], subject: subject || "(no subject)",
          text: bodyOut,
          html: sendHtmlOut,
          ...(atts.length ? { attachments: atts } : {}),
        }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) return res.status(502).json({ error: sd?.message || `Resend ${sr.status}` });
      // Land the sent copy in the owner's real Gmail "Sent" (and Apple Mail). Best-effort.
      try { await appendToGmailSent({ from, to, subject: subject || "(no subject)", html: sendHtmlOut, text: bodyOut }); } catch (_) {}
      try {
        const base = { client_id: "", type: "Email sent", channel: "email", body: `${subject || "(no subject)"} — ${bodyIn.slice(0, 600)}`, ok: true };
        const lr = await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify({ ...base, origin: "work-email compose (Comms → Email)", recipient: to }) });
        if (lr.status === 400 && /column/i.test(await lr.text().catch(() => ""))) {
          await fetch(`${SUPABASE_URL}/rest/v1/sps_comms_log`, { method: "POST", headers: sbHeaders(), body: JSON.stringify(base) });
        }
      } catch { /* best-effort */ }
      return res.status(200).json({ ok: true, id: sd.id || null });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
