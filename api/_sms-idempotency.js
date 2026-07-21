// Durable at-most-once receipts for the small set of SMS workflows that can be triggered twice
// by separate UI surfaces (currently arrival confirmation). This intentionally reuses the
// versioned app_state CAS that is already installed: no new table or SQL step is required.
//
// Only opaque SHA-256 fingerprints and delivery state are stored. Phone numbers and message text
// never enter app_state. The bounded ledger avoids adding meaningful weight to normal app loads.
import { createHash, randomUUID } from "node:crypto";
import { mutateAppState, NO_APP_STATE_CHANGE } from "./_app-state.js";

export const SMS_RECEIPT_STATE_KEY = "sps_sms_delivery_receipts";
const MAX_TERMINAL_RECEIPTS = 500;
const MAX_TOTAL_RECEIPTS = 600;
const TERMINAL_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const STATES = new Set(["sending", "accepted", "held", "failed", "uncertain"]);

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const sha256 = (value) => createHash("sha256").update(String(value || "")).digest("hex");

function ledgerValue(current) {
  if (current === undefined) return { schema: 1, receipts: {} };
  if (!current || typeof current !== "object" || Array.isArray(current)
    || current.schema !== 1 || !current.receipts || typeof current.receipts !== "object" || Array.isArray(current.receipts)) {
    throw new Error("sms_receipt_ledger_invalid");
  }
  return current;
}

export function normalizeSmsIdempotencyKey(value, messageType = "") {
  if (value == null || value === "") return "";
  const key = String(value).trim();
  // Arrival keys use encodeURIComponent(stop.sid), so percent escapes are expected. Restrict the
  // rest to a small printable alphabet and a hard maximum before any value is hashed or persisted.
  if (!/^arrival:[A-Za-z0-9._~:%-]{1,180}:sms$/.test(key)) throw new Error("invalid_sms_idempotency_key");
  if (String(messageType || "").trim().toLowerCase() !== "on site") throw new Error("invalid_sms_idempotency_scope");
  return key;
}

export function smsReceiptKey(idempotencyKey) {
  return sha256(idempotencyKey).slice(0, 40);
}

export function smsRequestFingerprint({ line, from, to, clientId, content }) {
  return sha256(JSON.stringify({
    v: 1,
    line: String(line || ""),
    from: String(from || ""),
    to: String(to || ""),
    clientId: String(clientId || ""),
    content: String(content || ""),
  }));
}

function compactReceipts(receipts, nowMs) {
  const entries = Object.entries(record(receipts)).filter(([, entry]) => {
    const value = record(entry);
    return STATES.has(value.state) && typeof value.requestHash === "string";
  });
  const protectedEntries = entries.filter(([, entry]) => entry.state === "sending" || entry.state === "uncertain");
  const terminalEntries = entries
    .filter(([, entry]) => entry.state !== "sending" && entry.state !== "uncertain")
    .filter(([, entry]) => {
      const at = Date.parse(entry.updatedAt || entry.createdAt || "");
      return !Number.isFinite(at) || nowMs - at <= TERMINAL_TTL_MS;
    })
    .sort((a, b) => Date.parse(b[1].updatedAt || b[1].createdAt || "") - Date.parse(a[1].updatedAt || a[1].createdAt || ""))
    .slice(0, MAX_TERMINAL_RECEIPTS);
  return Object.fromEntries([...protectedEntries, ...terminalEntries]);
}

export function claimSmsReceiptValue(current, { receiptKey, requestHash, token, nowIso }) {
  const latest = ledgerValue(current);
  const nowMs = Date.parse(nowIso);
  const receipts = compactReceipts(latest.receipts, Number.isFinite(nowMs) ? nowMs : Date.now());
  const existing = record(receipts[receiptKey]);
  if (existing.requestHash && existing.requestHash !== requestHash) {
    return { changed: false, outcome: "mismatch", value: { ...latest, schema: 1, receipts }, receipt: existing };
  }
  if (["sending", "accepted", "held", "uncertain"].includes(existing.state)) {
    return { changed: false, outcome: existing.state, value: { ...latest, schema: 1, receipts }, receipt: existing };
  }
  if (existing.state === "failed" && existing.retrySafe !== true) {
    return { changed: false, outcome: "failed", value: { ...latest, schema: 1, receipts }, receipt: existing };
  }
  if (!existing.requestHash && Object.keys(receipts).length >= MAX_TOTAL_RECEIPTS) {
    throw new Error("sms_receipt_ledger_full");
  }

  const receipt = {
    requestHash,
    state: "sending",
    token,
    attempt: Math.max(0, Number(existing.attempt) || 0) + 1,
    createdAt: existing.createdAt || nowIso,
    updatedAt: nowIso,
  };
  return {
    changed: true,
    outcome: "claimed",
    receipt,
    value: { ...latest, schema: 1, receipts: { ...receipts, [receiptKey]: receipt } },
  };
}

export function finalizeSmsReceiptValue(current, { receiptKey, requestHash, token, state, providerId = null, retrySafe = false, nowIso }) {
  const latest = ledgerValue(current);
  const receipts = record(latest.receipts);
  const existing = record(receipts[receiptKey]);
  if (existing.requestHash !== requestHash || existing.state !== "sending" || existing.token !== token) {
    return { changed: false, outcome: "claim_mismatch", value: latest, receipt: existing };
  }
  if (!["accepted", "held", "failed", "uncertain"].includes(state)) throw new Error("invalid_sms_receipt_state");
  const { token: _token, ...base } = existing;
  const receipt = {
    ...base,
    state,
    updatedAt: nowIso,
    ...(providerId ? { providerId: String(providerId).slice(0, 160) } : {}),
    ...(state === "failed" ? { retrySafe: retrySafe === true } : {}),
  };
  return {
    changed: true,
    outcome: state,
    receipt,
    value: { ...latest, schema: 1, receipts: { ...receipts, [receiptKey]: receipt } },
  };
}

export async function claimSmsDelivery({ idempotencyKey, requestHash, nowIso = new Date().toISOString(), token = randomUUID() }) {
  const receiptKey = smsReceiptKey(idempotencyKey);
  const mutation = await mutateAppState(SMS_RECEIPT_STATE_KEY, (current) => {
    const claimed = claimSmsReceiptValue(current, { receiptKey, requestHash, token, nowIso });
    return claimed.changed ? claimed.value : NO_APP_STATE_CHANGE;
  });
  const receipt = record(record(mutation.value).receipts)[receiptKey] || {};
  let outcome = receipt.state || "missing";
  if (receipt.requestHash && receipt.requestHash !== requestHash) outcome = "mismatch";
  else if (mutation.changed && receipt.state === "sending" && receipt.token === token) outcome = "claimed";
  return { outcome, receipt, receiptKey, requestHash, token };
}

export async function finalizeSmsDelivery(claim, { state, providerId = null, retrySafe = false, nowIso = new Date().toISOString() }) {
  const mutation = await mutateAppState(SMS_RECEIPT_STATE_KEY, (current) => {
    const finalized = finalizeSmsReceiptValue(current, {
      receiptKey: claim.receiptKey,
      requestHash: claim.requestHash,
      token: claim.token,
      state,
      providerId,
      retrySafe,
      nowIso,
    });
    return finalized.changed ? finalized.value : NO_APP_STATE_CHANGE;
  });
  const receipt = record(record(mutation.value).receipts)[claim.receiptKey] || {};
  return { changed: mutation.changed, receipt };
}
