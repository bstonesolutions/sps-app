// Client-side chat access after direct table RLS is locked to staff. The verified account owns
// exactly one client thread; client_id, sender, sender_name, and read timestamps are server-pinned.
import { resolveFrom } from "./_sender.js";
import {
  portalServiceHeaders,
  readAppState,
  requirePortalClient,
  setPortalCors,
  SUPABASE_URL,
} from "./_portal-auth.js";

const MESSAGE_FIELDS = "id,client_id,sender,sender_name,body,created_at,read_at";
const MARKER_RE = /\[\[(?:invcard|svccard|inv):|\[\[echo\]\]/i;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const cleanBody = (value) => String(value == null ? "" : value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
  .trim();
const cleanLine = (value, max) => String(value == null ? "" : value)
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function publicMessage(message) {
  return {
    id: message.id,
    client_id: String(message.client_id),
    sender: message.sender === "staff" ? "staff" : "client",
    sender_name: String(message.sender_name || ""),
    body: String(message.body || ""),
    created_at: message.created_at || null,
    read_at: message.read_at || null,
  };
}

async function tooManyRecentMessages(clientId) {
  const now = Date.now();
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const query = [
    "select=id,created_at",
    `client_id=eq.${encodeURIComponent(String(clientId))}`,
    "sender=eq.client",
    `created_at=gte.${encodeURIComponent(since)}`,
    "order=created_at.desc",
    "limit=31",
  ].join("&");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_messages?${query}`, {
    headers: portalServiceHeaders(),
  });
  // Fail closed when the limiter cannot read its window. Allowing the insert on a read failure
  // would turn a transient database error into an unbounded client-message path.
  if (!r.ok) throw new Error("message_rate_limit_unavailable");
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error("message_rate_limit_invalid_response");
  const lastMinute = rows.filter((row) => now - Date.parse(row && row.created_at || "") <= 60 * 1000).length;
  return rows.length >= 30 || lastMinute >= 10;
}

async function sendClientMessageOwnerEmail(client, body) {
  try {
    const [emailValue, brandingValue] = await Promise.all([
      readAppState("sps_email"),
      readAppState("sps_branding"),
    ]);
    const email = isRecord(emailValue) ? emailValue : {};
    const branding = isRecord(brandingValue) ? brandingValue : {};
    const notify = isRecord(email.notify) ? email.notify : {};
    const events = isRecord(notify.events) ? notify.events : {};
    const event = isRecord(events.client_message) ? events.client_message : null;
    if (!event || event.email !== true || !process.env.RESEND_API_KEY) return;

    const configuredRecipient = [notify.ownerEmail, email.ownerEmail, branding.companyEmail]
      .map((value) => String(value || "").trim())
      .find(validEmail);
    if (!configuredRecipient) return;
    let recipient = configuredRecipient;
    let subjectPrefix = "";
    const testMode = isRecord(email.testMode) ? email.testMode : {};
    if (testMode.on) {
      if (testMode.mode === "hold") return;
      const redirect = [testMode.email, notify.ownerEmail, email.ownerEmail, branding.companyEmail]
        .map((value) => String(value || "").trim())
        .find(validEmail);
      if (!redirect) return;
      recipient = redirect;
      subjectPrefix = `[TEST → ${configuredRecipient}] `;
    }

    const clientName = cleanLine(client && client.name, 120) || "Client";
    const company = cleanLine(branding.companyName, 120) || "Stone Property Solutions";
    const rawAccent = String(branding.accentColor || (branding.custom && branding.custom.primary) || "");
    const accent = /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent : "#B81D24";
    const subject = `New message from ${clientName}`;
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111827">
      <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;font-size:17px;font-weight:800">${escapeHtml(company)}</div>
      <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
        <div style="font-size:16px;font-weight:800;margin-bottom:10px">${escapeHtml(subject)}</div>
        <div style="font-size:14px;color:#374151;line-height:1.55;white-space:pre-wrap">${escapeHtml(body.slice(0, 4000))}</div>
        <div style="margin-top:18px"><a href="spsway://messages" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;font-size:14px">Open messages</a></div>
      </div>
    </div>`;
    const from = resolveFrom(
      { fromName: cleanLine(email.fromName, 100), fromAddress: email.fromAddress },
      process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>"
    );
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: subjectPrefix + subject,
        html,
        text: `${subject}\n\n${body.slice(0, 4000)}\n\nOpen in the SPS app: spsway://messages`,
      }),
    });
    if (!r.ok) console.warn("portal client-message owner email failed:", r.status);
  } catch (error) {
    console.warn("portal client-message owner email failed:", error && error.message ? error.message : error);
  }
}

export default async function handler(req, res) {
  setPortalCors(res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST", "PATCH"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const portal = await requirePortalClient(req, res);
  if (!portal) return;
  const clientId = String(portal.client.id);

  try {
    if (req.method === "GET") {
      const query = [
        `select=${MESSAGE_FIELDS}`,
        `client_id=eq.${encodeURIComponent(clientId)}`,
        "order=created_at.desc",
        "limit=1000",
      ].join("&");
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_messages?${query}`, {
        headers: portalServiceHeaders(),
      });
      if (!r.ok) return res.status(502).json({ error: "Could not load messages." });
      const rows = await r.json().catch(() => []);
      return res.status(200).json({ messages: (Array.isArray(rows) ? rows : []).reverse().map(publicMessage) });
    }

    const input = isRecord(req.body) ? req.body : {};
    if (req.method === "POST") {
      if (!Object.keys(input).every((key) => key === "body") || typeof input.body !== "string") {
        return res.status(400).json({ error: "Invalid message." });
      }
      const body = cleanBody(input.body);
      if (!body || body.length > 4000) {
        return res.status(400).json({ error: "Messages must be between 1 and 4,000 characters." });
      }
      // Card/echo markers are reserved for trusted staff-created system messages. Without this,
      // a client could forge a payment card or suppress the owner notification for their message.
      if (MARKER_RE.test(body)) return res.status(400).json({ error: "That message contains reserved formatting." });
      if (await tooManyRecentMessages(clientId)) {
        return res.status(429).json({ error: "Too many recent messages. Please wait and try again." });
      }

      const row = {
        client_id: clientId,
        sender: "client",
        sender_name: cleanLine(portal.client.name, 120),
        body,
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_messages?select=${MESSAGE_FIELDS}`, {
        method: "POST",
        headers: portalServiceHeaders({
          "Content-Type": "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify(row),
      });
      if (!r.ok) return res.status(502).json({ error: "Could not send the message." });
      const rows = await r.json().catch(() => []);
      const inserted = Array.isArray(rows) ? rows[0] : null;
      if (!inserted) return res.status(502).json({ error: "Could not send the message." });
      // The existing sps_messages database webhook handles the owner push. The optional email
      // channel is sent here because the client may no longer call the staff-only mail endpoint.
      await sendClientMessageOwnerEmail(portal.client, body);
      return res.status(200).json({ message: publicMessage(inserted) });
    }

    if (!Object.keys(input).every((key) => key === "ids") || !Array.isArray(input.ids)) {
      return res.status(400).json({ error: "Invalid message ids." });
    }
    const ids = [...new Set(input.ids.map((id) => String(id)).filter((id) => /^\d{1,20}$/.test(id)))].slice(0, 200);
    if (!ids.length || ids.length !== input.ids.length) {
      return res.status(400).json({ error: "Invalid message ids." });
    }
    const query = [
      `id=in.(${ids.join(",")})`,
      `client_id=eq.${encodeURIComponent(clientId)}`,
      "sender=eq.staff",
      "read_at=is.null",
    ].join("&");
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_messages?${query}`, {
      method: "PATCH",
      headers: portalServiceHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
    if (!r.ok) return res.status(502).json({ error: "Could not mark messages as read." });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("portal-messages failed:", error && error.message ? error.message : error);
    return res.status(502).json({ error: "Could not update messages." });
  }
}
