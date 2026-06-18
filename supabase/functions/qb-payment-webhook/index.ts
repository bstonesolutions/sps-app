// supabase/functions/qb-payment-webhook/index.ts
// Build 15, Item 6 — out-of-app PUSH when an invoice is paid.
//
// Flow: QuickBooks fires a webhook on a Payment event → this Edge Function verifies the
// signature, fetches the payment (amount + customer + linked invoice) from the QB API, looks
// up the owner's iOS device token(s), and sends an Apple Push Notification naming who paid,
// the invoice number, and the amount.
//
// This is INFRASTRUCTURE — it does nothing until it's deployed and wired up. See SETUP.md in
// this folder for the full checklist (tables, env vars, APNs key, QB webhook registration,
// and the client-side device-token registration snippet).
//
// Env vars (set with `supabase secrets set ...`):
//   QB_WEBHOOK_VERIFIER_TOKEN   — from the Intuit webhook config (verifies the signature)
//   QB_API_BASE                 — https://quickbooks.api.intuit.com (prod) or sandbox host
//   APNS_KEY_ID, APNS_TEAM_ID   — from the APNs Auth Key (.p8) in the Apple Developer account
//   APNS_BUNDLE_ID              — e.g. com.stonepropertysolutions.app  (the apns-topic)
//   APNS_PRIVATE_KEY            — the .p8 contents (PEM, newlines preserved or \n-escaped)
//   APNS_HOST                   — https://api.push.apple.com (prod) or api.sandbox.push.apple.com
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — to read qb_connections + device_tokens
//
// Supabase tables it reads (create per SETUP.md):
//   qb_connections(realm_id text pk, access_token text, ...)   — a valid QB access token per realm
//   device_tokens(token text pk, role text, updated_at timestamptz)  — owner device tokens

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";

// ── QB webhook signature: base64(HMAC-SHA256(body, verifierToken)) === intuit-signature ──
async function verifySignature(rawBody: string, signature: string): Promise<boolean> {
  const token = env("QB_WEBHOOK_VERIFIER_TOKEN");
  if (!token || !signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === signature;
}

// ── APNs JWT (ES256, signed with the .p8 key) ──
function pemToArrayBuffer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function apnsJwt(): Promise<string> {
  const header = { alg: "ES256", kid: env("APNS_KEY_ID") };
  const payload = { iss: env("APNS_TEAM_ID"), iat: Math.floor(Date.now() / 1000) };
  const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const keyData = pemToArrayBuffer(env("APNS_PRIVATE_KEY").replace(/\\n/g, "\n"));
  const key = await crypto.subtle.importKey("pkcs8", keyData, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${sigB64}`;
}
async function sendPush(token: string, title: string, body: string, jwt: string) {
  const res = await fetch(`${env("APNS_HOST") || "https://api.push.apple.com"}/3/device/${token}`, {
    method: "POST",
    headers: { authorization: `bearer ${jwt}`, "apns-topic": env("APNS_BUNDLE_ID"), "apns-push-type": "alert" },
    body: JSON.stringify({ aps: { alert: { title, body }, sound: "default", badge: 1 } }),
  });
  if (!res.ok) console.error("APNs error", res.status, await res.text().catch(() => ""));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok"); // health check
  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("intuit-signature") || ""))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const money = (n: number) => "$" + (Number(n) || 0).toFixed(2);

  for (const note of (payload.eventNotifications || [])) {
    const realmId = note.realmId;
    const payments = (note.dataChangeEvent?.entities || []).filter((e: any) => e.name === "Payment");
    if (!payments.length) continue;

    // A valid QB access token for this realm (the app refreshes + stores it).
    const { data: conn } = await sb.from("qb_connections").select("access_token").eq("realm_id", String(realmId)).maybeSingle();
    const token = conn?.access_token;
    // Owner device tokens to push to.
    const { data: devices } = await sb.from("device_tokens").select("token").eq("role", "owner");
    if (!devices?.length) continue;
    const jwt = await apnsJwt();

    for (const ent of payments) {
      let title = "Payment received";
      let body = "A payment was recorded in QuickBooks — open SPS Way for details.";
      if (token) {
        try {
          const pr = await fetch(`${env("QB_API_BASE")}/v3/company/${realmId}/payment/${ent.id}?minorversion=65`, {
            headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          });
          const pd = await pr.json();
          const pm = pd?.Payment;
          if (pm) {
            const who = pm.CustomerRef?.name || "A client";
            const inv = (pm.Line || []).flatMap((l: any) => l.LinkedTxn || []).find((lt: any) => lt.TxnType === "Invoice");
            title = `Payment received — ${money(pm.TotalAmt)}`;
            body = `${who} paid${inv?.TxnId ? ` invoice ${inv.TxnId}` : ""}.`;
          }
        } catch (e) { console.error("QB payment fetch failed", e); }
      }
      for (const d of devices) await sendPush(d.token, title, body, jwt);
    }
  }
  return new Response("ok");
});
