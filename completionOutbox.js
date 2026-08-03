import { idb } from "./idbStore.js";

const OUTBOX_PREFIX = "sps-completion-outbox:v1:";
const DRAFT_PREFIX = "sps-stop-draft:v1:";
const SAVED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;

const writeTails = new Map();

const cleanPart = (value) => String(value == null ? "" : value).trim();
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function completionOutboxKey(uid) {
  const scope = cleanPart(uid);
  if (!scope) throw new Error("A signed-in account is required to save this report on the device.");
  return `${OUTBOX_PREFIX}${scope}`;
}

export function stopDraftKey(uid, sid) {
  const scope = cleanPart(uid);
  const stopId = cleanPart(sid);
  if (!scope || !stopId) throw new Error("A signed-in account and stop are required to save this draft.");
  return `${DRAFT_PREFIX}${scope}:${stopId}`;
}

function serialize(key, work) {
  const previous = writeTails.get(key) || Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(() => {}, () => {});
  writeTails.set(key, settled);
  settled.finally(() => {
    if (writeTails.get(key) === settled) writeTails.delete(key);
  });
  return run;
}

function normalizeItems(value) {
  const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
  return rows.filter(item => item && item.v === 1 && item.id && item.uid && item.sid && item.idempotencyKey);
}

function retainItems(items, now = Date.now()) {
  return items.filter(item => item.state !== "saved" || now - Number(item.savedAt || item.updatedAt || 0) < SAVED_RETENTION_MS);
}

async function readItems(uid, storage) {
  const snapshot = await storage.get(completionOutboxKey(uid));
  return normalizeItems(snapshot);
}

async function writeItems(uid, items, storage) {
  const key = completionOutboxKey(uid);
  const snapshot = { v: 1, uid: cleanPart(uid), updatedAt: Date.now(), items: clone(items) };
  await storage.set(key, snapshot);
  const verified = await storage.get(key);
  const confirmed = normalizeItems(verified);
  if (confirmed.length !== items.length || items.some(item => !confirmed.some(saved => saved.id === item.id && saved.idempotencyKey === item.idempotencyKey))) {
    throw new Error("This report could not be saved safely on this device. Keep this screen open and try again.");
  }
  return confirmed;
}

export async function readCompletionOutbox(uid, { storage = idb, now = Date.now() } = {}) {
  const scope = cleanPart(uid);
  const key = completionOutboxKey(scope);
  return serialize(key, async () => {
    const items = await readItems(scope, storage);
    const retained = retainItems(items, now);
    if (retained.length !== items.length) await writeItems(scope, retained, storage);
    return clone(retained);
  });
}

export async function enqueueCompletionIntent({ uid, clientId, sid, entry, idempotencyKey, delivery = null }, { storage = idb, now = Date.now() } = {}) {
  const scope = cleanPart(uid);
  const stopId = cleanPart(sid);
  const retryKey = cleanPart(idempotencyKey);
  if (!scope || !stopId || retryKey.length < 8 || !entry || typeof entry !== "object") {
    throw new Error("This report is missing the information required for a safe local save.");
  }
  const id = `completion:${scope}:${stopId}:${retryKey}`;
  const item = {
    v: 1,
    id,
    uid: scope,
    sid: stopId,
    clientId: cleanPart(clientId),
    idempotencyKey: retryKey,
    request: {
      mode: "complete",
      clientId: cleanPart(clientId),
      sid: stopId,
      entry: clone(entry),
      idempotencyKey: retryKey,
    },
    delivery: delivery ? clone(delivery) : null,
    state: "queued",
    retryCount: 0,
    retryAt: 0,
    lastError: "",
    createdAt: now,
    updatedAt: now,
  };
  const key = completionOutboxKey(scope);
  return serialize(key, async () => {
    const current = retainItems(await readItems(scope, storage), now);
    const existing = current.find(row => row.id === id);
    const nextItem = existing
      ? { ...existing, request: item.request, delivery: existing.delivery || item.delivery, updatedAt: now }
      : item;
    const next = [...current.filter(row => row.id !== id), nextItem];
    await writeItems(scope, next, storage);
    return clone(nextItem);
  });
}

export async function updateCompletionIntent(uid, id, updater, { storage = idb } = {}) {
  const scope = cleanPart(uid);
  const itemId = cleanPart(id);
  const key = completionOutboxKey(scope);
  return serialize(key, async () => {
    const current = retainItems(await readItems(scope, storage));
    const index = current.findIndex(item => item.id === itemId);
    if (index < 0) return null;
    const patch = typeof updater === "function" ? updater(clone(current[index])) : updater;
    if (!patch || typeof patch !== "object") return clone(current[index]);
    const nextItem = {
      ...current[index],
      ...clone(patch),
      // These fields identify the exact server operation and are immutable across every retry.
      id: current[index].id,
      uid: current[index].uid,
      sid: current[index].sid,
      clientId: current[index].clientId,
      idempotencyKey: current[index].idempotencyKey,
      request: current[index].request,
      updatedAt: Number(patch.updatedAt) || Date.now(),
    };
    const next = current.slice();
    next[index] = nextItem;
    await writeItems(scope, next, storage);
    return clone(nextItem);
  });
}

export async function removeCompletionIntent(uid, id, { storage = idb } = {}) {
  const scope = cleanPart(uid);
  const itemId = cleanPart(id);
  const key = completionOutboxKey(scope);
  return serialize(key, async () => {
    const current = retainItems(await readItems(scope, storage));
    const next = current.filter(item => item.id !== itemId);
    await writeItems(scope, next, storage);
    return current.length !== next.length;
  });
}

export function completionRetryDelay(retryCount) {
  const count = Math.max(1, Number(retryCount) || 1);
  return Math.min(MAX_RETRY_MS, 1500 * (2 ** Math.min(8, count - 1)));
}

export function classifyCompletionFailure(error) {
  const status = Number(error?.status) || 0;
  const code = cleanPart(error?.code);
  const message = cleanPart(error?.message) || "The completed stop could not be synced.";
  // A contention response means the server committed nothing and another
  // versioned write merely won this attempt. Replaying the exact idempotent
  // request is safe; business conflicts still stop for human review.
  if (status === 409 && code === "contention") {
    return { retryable: true, needsReview: false, status, code, message };
  }
  if (status === 409) return { retryable: false, needsReview: true, status, code, message };
  if (!status || status === 408 || status === 425 || status === 429 || status >= 500) {
    return { retryable: true, needsReview: false, status, code, message };
  }
  return { retryable: false, needsReview: true, status, code, message };
}

export function completionOutboxSummary(items, now = Date.now()) {
  const rows = Array.isArray(items) ? items : [];
  return {
    queued: rows.filter(item => ["queued", "syncing"].includes(item.state) && Number(item.retryAt || 0) <= now).length,
    waiting: rows.filter(item => item.state === "queued" && Number(item.retryAt || 0) > now).length,
    needsReview: rows.filter(item => item.state === "needs_review" || item.deliveryNeedsReview).length,
    saved: rows.filter(item => item.state === "saved").length,
  };
}

export async function persistStopDraft(uid, sid, payload, { storage = idb, now = Date.now() } = {}) {
  const key = stopDraftKey(uid, sid);
  const value = { v: 1, uid: cleanPart(uid), sid: cleanPart(sid), updatedAt: now, payload: clone(payload) };
  await storage.set(key, value);
  const verified = await storage.get(key);
  if (!verified || verified.v !== 1 || verified.uid !== value.uid || verified.sid !== value.sid || !verified.payload) {
    throw new Error("This stop draft could not be saved safely on this device.");
  }
  return clone(verified);
}

export async function readStopDraft(uid, sid, { storage = idb } = {}) {
  const value = await storage.get(stopDraftKey(uid, sid));
  if (!value || value.v !== 1 || !value.payload) return null;
  return clone(value);
}

export async function removeStopDraft(uid, sid, { storage = idb } = {}) {
  await storage.del(stopDraftKey(uid, sid));
}
