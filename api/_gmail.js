// api/_gmail.js — shared helper (underscore-prefixed → NOT an HTTP route, so it doesn't count
// toward the Vercel function limit). Appends a copy of an email the app sends (through Resend) into
// the owner's real Gmail "Sent" mailbox over IMAP, so composed/replied mail shows up in Gmail Sent
// (and Apple Mail Sent) — the last piece of the two-way email client. Reuses the same app-password
// IMAP creds as gmail-action / gmail-backfill.
//
// SAFETY: best-effort and BOUNDED. It never throws, times out fast (so a slow IMAP server can't hold
// the API response hostage), and returns { ok, ... } so the caller ignores failures — the email has
// already gone out through Resend regardless of whether this Sent copy lands.

import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const IMAP_USER = process.env.GMAIL_IMAP_USER;
const IMAP_PASS = process.env.GMAIL_IMAP_PASSWORD;

export const gmailSyncConfigured = () => !!(IMAP_USER && IMAP_PASS);

// Resolve the Sent mailbox by its RFC 6154 special-use flag (localized names vary); fall back to the
// common Gmail path.
async function findSent(client) {
  try {
    const boxes = await client.list();
    const hit = (boxes || []).find(b => b.specialUse === "\\Sent");
    return (hit && hit.path) || "[Gmail]/Sent Mail";
  } catch { return "[Gmail]/Sent Mail"; }
}

// A Message-ID must be angle-bracketed in In-Reply-To / References headers; stored ids may lack them.
const angle = (m) => { const s = String(m || "").trim(); return s ? (s.startsWith("<") ? s : `<${s}>`) : undefined; };

// Build a proper RFC822 message (headers + multipart/alternative) with nodemailer — no hand-rolled
// MIME. inReplyTo/references thread the copy into the original conversation for replies.
function buildRaw({ from, to, subject, html, text, inReplyTo, references }) {
  const irt = angle(inReplyTo), refs = angle(references);
  return new Promise((resolve, reject) => {
    new MailComposer({
      from, to, subject: subject || "(no subject)",
      text: text || "",
      ...(html ? { html } : {}),
      ...(irt ? { inReplyTo: irt } : {}),
      ...(refs ? { references: refs } : {}),
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}

export async function appendToGmailSent(opts) {
  if (!gmailSyncConfigured()) return { ok: false, skipped: "imap-not-configured" };
  // Tight IMAP timeouts so a slow Gmail can't outlive the request, and the client is hoisted so the
  // outer 15s race-timeout can force client.close() — Promise.race alone can't cancel the in-flight op.
  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true, auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false, connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 12000,
  });
  let settled = false;
  const work = (async () => {
    try {
      const raw = await buildRaw(opts);
      await client.connect();
      const sent = await findSent(client);
      await client.append(sent, raw, ["\\Seen"], new Date());
      try { await client.logout(); } catch (_) {}
      return { ok: true };
    } catch (e) {
      try { await client.logout(); } catch (_) {}
      return { ok: false, error: String((e && e.message) || e) };
    } finally { settled = true; }
  })();
  const bail = new Promise(resolve => setTimeout(() => {
    if (!settled) { try { client.close(); } catch (_) {} }
    resolve({ ok: false, error: "imap-timeout" });
  }, 15000));
  return Promise.race([work, bail]);
}
