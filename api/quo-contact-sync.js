// Owner-only, bounded Quo contact backfill.
//
// GET reports whether the server-side sync is available. POST fetches at most four Quo pages /
// 200 contacts, writes only changed phone-keyed identities, and returns counts only. Contact names,
// phone numbers, provider avatar URLs, private Storage paths, and all credentials stay server-side.

import { requireOwner } from "./_staff-auth.js";
import { QUO_CONTACT_SYNC_LIMITS, syncQuoContacts } from "./_quo-contacts.js";

const SUPABASE_URL = (
  process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || "https://ysqarusrewceezckawlo.supabase.co"
).replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const QUO_API_KEY = process.env.QUO_API_KEY || "";

function bodyObject(req) {
  if (req?.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (typeof req?.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function publicResult(result) {
  return {
    ok: !!result.ok,
    scanned: Math.max(0, Number(result.scanned) || 0),
    cached: Math.max(0, Number(result.cached) || 0),
    changed: Math.max(0, Number(result.changed) || 0),
    named: Math.max(0, Number(result.named) || 0),
    avatarsStored: Math.max(0, Number(result.avatarsStored) || 0),
    ambiguousPhones: Math.max(0, Number(result.ambiguousPhones) || 0),
    skipped: Math.max(0, Number(result.skipped) || 0),
    pages: Math.max(0, Number(result.pages) || 0),
    nextPageToken: result.nextPageToken || null,
    complete: !!result.complete,
    ...(result.schemaSkipped ? { note: "The SMS contact cache is not installed yet." } : {}),
    ...(!result.ok ? { error: result.error || "Contact sync failed." } : {}),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  }

  const owner = await requireOwner(req, res, req.method === "POST" ? "syncing Quo contacts" : "viewing Quo contact sync status");
  if (!owner) return;

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      configured: {
        quoApi: !!QUO_API_KEY,
        contactCache: !!SERVICE_KEY,
      },
      limits: QUO_CONTACT_SYNC_LIMITS,
    });
  }

  const body = bodyObject(req);
  const result = await syncQuoContacts({
    apiKey: QUO_API_KEY,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    pageToken: body.pageToken,
    maxContacts: body.maxContacts,
    maxPages: body.maxPages,
    maxAvatars: body.includeAvatars === false ? 0 : 8,
  });
  const status = result.ok ? 200 : Math.max(400, Math.min(599, Number(result.status) || 502));
  return res.status(status).json(publicResult(result));
}
