// api/message-intake.js — Supabase Database Webhook target for sps_messages INSERTs (Build 27).
//
// Chat messages never pass through the api/ layer (both the staff app and the client portal
// insert into sps_messages directly with the shared supabase client), so this webhook is how
// a new message becomes a push:
//   sender = "client" → owner devices   "New message from <client>"        → Comms
//   sender = "staff"  → client devices  "New message from <company>"       → portal Messages
//     …unless the body carries a hidden card marker, which gets a truer title:
//     [[invcard:…]] → "New invoice from <company>" → portal Invoices
//     [[svccard:…]] → "Service report from <company>" → portal Messages
//
// Wire-up (one-time, in the APP's Supabase project — SQL in CLAUDE.md): a trigger/webhook on
// INSERT of public.sps_messages posting here with Authorization: Bearer <MSG_WEBHOOK_SECRET>
// (falls back to LEAD_WEBHOOK_SECRET so one secret can serve both intakes).
//
// Same contract as lead-intake: authorized requests ALWAYS get 200 even when the push fails —
// Supabase retries non-2xx and a retry would double-push. Test Mode is enforced inside
// _push.js (client pushes held; owner pushes always allowed).

import { pushConfigured, pushOwner, pushClient } from "./_push.js";

const SECRET = process.env.MSG_WEBHOOK_SECRET || process.env.LEAD_WEBHOOK_SECRET;

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
// Strip the hidden markers ([[invcard:…]] / [[svccard:…]] / [[echo]]) so previews read like prose.
const stripMarkers = (s) => String(s || "").replace(/\[\[(?:invcard|svccard):[^\]]*\]\]|\[\[echo\]\]/g, "").trim();

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: { apns: pushConfigured(), secret: !!SECRET } });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!SECRET) return res.status(501).json({ error: "Server missing MSG_WEBHOOK_SECRET", missingEnv: true });
  const auth = String(req.headers.authorization || "");
  if (auth !== `Bearer ${SECRET}`) return res.status(401).json({ error: "Unauthorized" });

  // From here on: ALWAYS 200 (webhook retry contract).
  const out = { ok: true };
  try {
    const body = req.body || {};
    if (body.type && body.type !== "INSERT") return res.status(200).json({ ok: true, skipped: "not an insert" });
    const rec = body.record || {};
    const sender = String(rec.sender || "");
    const clientId = rec.client_id != null ? String(rec.client_id) : "";
    const raw = String(rec.body || "");
    const preview = clean(stripMarkers(raw), 180);

    // Freshness guard: a bulk restore (Master Backup re-inserts the whole chat history) or a
    // long-delayed webhook retry must not replay old messages as fresh pushes.
    const ts = Date.parse(rec.created_at || "");
    if (Number.isFinite(ts) && Date.now() - ts > 15 * 60 * 1000) {
      return res.status(200).json({ ok: true, skipped: "stale record — no push" });
    }

    if (sender === "client") {
      // [[echo]] marks a message that mirrors a request/upgrade alert — the office-alert push
      // already notified the owner with the richer, correctly-keyed notification; skip the
      // generic "new message" leg so one client tap never double-alerts.
      if (raw.includes("[[echo]]")) return res.status(200).json({ ok: true, skipped: "alert echo — already pushed via office alert" });
      const who = clean(rec.sender_name, 60) || "a client";
      out.push = await pushOwner("client_message", `New message from ${who}`, preview, "comms");
    } else if (sender === "staff" && clientId) {
      const company = clean(rec.sender_name, 60) || "your service team";
      let title = `New message from ${company}`, link = "messages";
      if (raw.includes("[[invcard:")) { title = `New invoice from ${company}`; link = "invoices"; }
      else if (raw.includes("[[svccard:")) { title = `Service report from ${company}`; }
      out.push = await pushClient(clientId, title, preview, link, { collapseId: `msg-${clientId}` });
    } else {
      out.skipped = "no matching audience";
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  return res.status(200).json(out);
}
