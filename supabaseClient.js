import { createClient } from "@supabase/supabase-js";
import { idb } from "./idbStore.js";
import { requestAppState } from "./appStateRequest.js";
import { describeStateConflicts, mergeStoredState, normalizeStoredValue } from "./stateMerge.js";
import { isTransientAppStateError, nextAppStateRetry } from "./appStateBackoff.js";
import { normalizeInvoiceProjectionIntent, projectInvoiceAccountingAuthority } from "./invoiceAuthorityProjection.js";
import { stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";
import { invoiceDeletionReviewMatches, unlinkUnpaidInvoiceCoverage } from "./invoiceBulkDeletion.js";
import { unlinkInvoiceDeletionReferences } from "./invoiceDeletionGuard.js";
import { buildSharedStateIntent } from "./sharedStateIntent.js";
import { sendSharedStateIntent } from "./sharedStateWriteClient.js";

const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const SNAP_KEY = "snapshot";
const PENDING_KEY = "sps_pending_writes";
const MAX_CAS_ATTEMPTS = 6;
const MAX_INIT_BACKOFF_STEP = 7;
// Startup sync. Values are fetched only for rows whose (version, write time) differ from this
// device's confirmed snapshot, in small parallel batches, so a field device on a weak cell
// connection no longer has to download the entire workspace in one 20s request on every launch.
// Value batches get a longer budget than the tiny version probe because they run behind the
// cache-first UI, and every batch that does arrive is kept so a retry only fetches what's missing.
const INIT_VALUE_CHUNK_SIZE = 8;
const INIT_VALUE_CONCURRENCY = 3;
const INIT_VALUE_TIMEOUT_MS = 60_000;

let _uid = null;
let _identityVersion = 0;
let _cache = {};       // optimistic values displayed by the app
let _confirmed = {};   // last values confirmed by Supabase
let _versions = {};    // database-controlled version for each confirmed value
// Database write time recorded TOGETHER with a confirmed (value, version) from the same server row.
// A version alone can repeat after a row is deleted and recreated; (version, updated_at) cannot.
let _updatedAt = {};
let _exists = {};
let _pending = {};     // durable three-way-merge intents
let _conflicts = {};
let _loaded = false;
let _initialReadConfirmed = false;
let _loadPromise = null;
let _flushing = false;
let _ensureHydratePromise = null;
let _pendingHydratedIdentity = -1;
let _pendingHydrationFailedIdentity = -1;
const _hydrationHeldKeys = new Set();
let _pendingPersistTail = Promise.resolve({ durable: true, empty: true });
let _snapshotPersistTail = Promise.resolve();
let _lastErrorAt = 0;
let _initSelectAt = 0;
let _initRetryCount = 0;
let _initRetryAt = 0;
let _initLastError = null;
let _cacheReadyState = { ready: false, hasData: false };
let _retryAfterAt = 0;
// Targeted receipts can be newer than the reconstructable whole-ledger snapshot.
// A slower full refresh must not roll those confirmed choices back on this device.
let _invoiceReceiptVersion = 0;
const _confirmedInvoiceDeletions = new Set();
const _cacheAt = {};
const _chains = {};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const sameStored = (a, b) => a === b;
const serverProtectedKeys = new Set(["sps_clients", "sps_schedule", "sps_completed", "sps_invoices"]);
const fieldIntentKeys = new Set(["sps_clients", "sps_schedule"]);
// Other sections (inventory, estimates, team, settings, …) keep saving around an overlap: only the
// fields two people changed differently are held on this device for review, every other change is
// saved right away, and the device keeps receiving everyone else's updates. Clients and the schedule
// already merge per field on the server; invoices keep their dedicated accounting review.
const HOLDABLE_CONFLICT_KINDS = new Set(["same-field-edit", "delete-vs-edit", "same-identity-add", "concurrent-array-edit", "concurrent-reorder"]);
const committable = (envelope) => !!envelope
  && (envelope.status === "pending" || (envelope.heldConflicts === true && envelope.heldDirty === true));
function canHoldConflicts(key, envelope, remote, conflicts) {
  return key !== "sps_invoices" && !fieldIntentKeys.has(key) && envelope.v === 2 && !envelope.deleteIntent
    && !envelope.force && !envelope.saveRejection && remote.exists && conflicts.length > 0
    && conflicts.every((item) => HOLDABLE_CONFLICT_KINDS.has(item && item.kind) && typeof item.path === "string" && item.path !== "$");
}
function normalizeRemoteStoredValue(key, value) {
  const raw = normalizeStoredValue(value);
  if (!serverProtectedKeys.has(key) || typeof raw !== "string") return raw;
  // PostgreSQL jsonb::text adds whitespace and orders keys. React's save fence uses
  // JSON.stringify, so use that same representation after reading a guarded section.
  try { return JSON.stringify(JSON.parse(raw)); } catch (_) { return raw; }
}
function projectAcceptedReports(key, displayedValue, remoteValue) {
  if (key !== "sps_clients" || displayedValue === undefined || remoteValue === undefined) return displayedValue;
  try {
    const displayed = JSON.parse(displayedValue), remote = JSON.parse(remoteValue);
    if (!Array.isArray(displayed) || !Array.isArray(remote)) return displayedValue;
    const receiptId = entry => typeof entry?.completionReceiptId === "string" && entry.completionReceiptId;
    const byId = new Map(remote.filter(client => client?.id != null).map(client => [String(client.id), client]));
    if (byId.size !== remote.length) return displayedValue;
    const projected = displayed.map(client => {
      const saved = byId.get(String(client?.id));
      const savedReports = new Map((Array.isArray(saved?.history) ? saved.history : []).filter(receiptId).map(entry => [receiptId(entry), entry]));
      const seen = new Set();
      const history = (Array.isArray(client?.history) ? client.history : []).flatMap(entry => {
        const id = receiptId(entry);
        if (!id) return [entry]; // Receipt-less legacy reports keep ordinary local merge behavior.
        if (seen.has(id) || !savedReports.has(id)) return [];
        seen.add(id); return [savedReports.get(id)];
      });
      for (const [id, entry] of savedReports) if (!seen.has(id)) history.push(entry);
      return client && (Object.hasOwn(client, "history") || history.length) ? { ...client, history } : client;
    });
    const displayedIds = new Set(displayed.map(client => String(client?.id)));
    for (const client of remote) {
      if (!displayedIds.has(String(client.id)) && Array.isArray(client.history) && client.history.some(receiptId)) projected.push(client);
    }
    return JSON.stringify(projected);
  } catch (_) { return displayedValue; }
}
const pendingIdbKey = (uid = _uid) => (uid ? `pending-v2:${uid}` : "");
const pendingStorageKey = (uid = _uid) => (uid ? `${PENDING_KEY}:${uid}` : "");
const snapshotIdbKey = (uid = _uid) => (uid ? `snapshot-v2:${uid}` : SNAP_KEY);
const newOpId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function clearObject(obj) {
  for (const key of Object.keys(obj)) delete obj[key];
}

function recalculateRetryWindow() {
  _retryAfterAt = Object.values(_pending).reduce((latest, envelope) => {
    if (!committable(envelope)) return latest;
    return Math.max(latest, Math.max(0, Number(envelope.retryAt) || 0));
  }, 0);
  return _retryAfterAt;
}

function notify(type, msg) {
  try { document.dispatchEvent(new CustomEvent("sps-db-status", { detail: { type, msg } })); } catch (_) {}
}

function notifyReconciled(key, forceRemote = false, remoteMissing = false) {
  try { document.dispatchEvent(new CustomEvent("sps-reconciled", { detail: { key, forceRemote, remoteMissing } })); } catch (_) {}
}

function throttledError(msg) {
  const now = Date.now();
  if (now - _lastErrorAt > 10000) {
    _lastErrorAt = now;
    notify("error", msg);
  }
}

function publicConflicts(conflicts) {
  return (conflicts || []).map((item) => ({
    path: Array.isArray(item.path)
      ? `${item.entity || "record"}[${item.entityId || "unknown"}]${item.path.length ? `.${item.path.join(".")}` : ""}` : item.path,
    kind: item.kind,
  }));
}

function conflictSignature(item) {
  return `${(item && item.path) || "$"}|${(item && item.kind) || "conflict"}`;
}

function notifyConflict(key, conflicts) {
  const safe = publicConflicts(conflicts);
  try {
    document.dispatchEvent(new CustomEvent("sps-conflict", {
      detail: { key, count: safe.length, paths: safe.map((item) => item.path), summary: describeStateConflicts(safe) },
    }));
  } catch (_) {}
}

function normalizeEnvelope(raw) {
  if (raw && raw.v === 2 && typeof raw.localValue === "string" && raw.opId) {
    return {
      ...raw,
      baseExists: !!raw.baseExists,
      baseVersion: Number(raw.baseVersion) || 0,
      status: raw.status === "conflict" ? "conflict" : "pending",
      conflicts: publicConflicts(raw.conflicts),
      retryCount: Math.max(0, Number(raw.retryCount) || 0),
      retryAt: Math.max(0, Number(raw.retryAt) || 0),
    };
  }
  // Previous builds stored only the desired whole value. Without its original base it cannot be
  // replayed safely. It is retained and shown as a conflict unless it already equals the server.
  const localValue = normalizeStoredValue(raw);
  if (localValue === undefined) return null;
  return {
    v: 1,
    opId: newOpId(),
    localValue,
    status: "legacy",
    updatedAt: Date.now(),
  };
}

function pendingDisplayValue(envelope) {
  if (envelope && envelope.deleteIntent) return undefined;
  return envelope && typeof envelope.localValue === "string" ? envelope.localValue : undefined;
}

function invoicePendingNeedsRecovery(envelope) {
  if (!envelope) return false;
  if (envelope.v !== 2 || envelope.deleteIntent || envelope.force) return true;
  try {
    return ![envelope.baseExists ? envelope.baseValue : "[]", envelope.localValue]
      .every(value => Array.isArray(JSON.parse(value)));
  } catch (_) { return true; }
}

function projectInvoicePending(envelope, remoteValue) {
  if (!envelope || typeof remoteValue !== "string") return null;
  try {
    const canonical = JSON.parse(remoteValue);
    if (!Array.isArray(canonical)) return null;
    // An old queue without a trustworthy base is recoverable work, not evidence
    // that its whole ledger should hide current payments on unrelated invoices.
    if (invoicePendingNeedsRecovery(envelope)) return remoteValue;
    const base = JSON.parse(envelope.baseExists ? envelope.baseValue : "[]"), local = JSON.parse(envelope.localValue);
    if (!Array.isArray(base) || !Array.isArray(local)) return remoteValue;
    const normalized = normalizeInvoiceProjectionIntent(base, local, canonical);
    const merged = mergeStoredState("sps_invoices", envelope.baseExists ? envelope.baseValue : undefined,
      JSON.stringify(normalized), remoteValue, { prefer: "local" }).value;
    let authorityBase = base;
    try {
      const retained = JSON.parse(envelope.invoiceProjectionBaseValue);
      if (Array.isArray(retained)) authorityBase = retained;
    } catch (_) {}
    const deleted = new Set(envelope.confirmedDeletedInvoiceIds || []);
    return JSON.stringify(projectInvoiceAccountingAuthority(authorityBase, JSON.parse(merged), canonical)
      .filter(invoice => !deleted.has(String(invoice?.id ?? ""))));
  } catch (_) { return null; }
}

function projectInvoiceDisplay(displayedValue, remoteValue) {
  const pending = _pending.sps_invoices;
  if (!pending) return displayedValue;
  const projection = projectInvoicePending(pending, _confirmed.sps_invoices ?? remoteValue);
  if (projection === null) return displayedValue;
  // A React edit may not have reached its save effect yet. Only replace fields
  // still equal to the retained intent; changes since that intent stay visible
  // and will be saved as real new work by the hook.
  try {
    const merged = mergeStoredState("sps_invoices", pending.localValue, displayedValue, projection, { prefer: "local" }).value;
    // The hook's save fence compares serialized values. Preserve the receipt's
    // exact field order when the merged display has no real unstaged change.
    return stableInvoiceReviewJSON(JSON.parse(merged)) === stableInvoiceReviewJSON(JSON.parse(projection)) ? projection : merged;
  } catch (_) { return displayedValue; }
}

function mergePendingSources(source) {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(source)) {
    const incoming = normalizeEnvelope(source[key]);
    if (!incoming) continue;
    const current = _pending[key];
    if (!current || Number(incoming.updatedAt || 0) >= Number(current.updatedAt || 0)) _pending[key] = incoming;
  }
  recalculateRetryWindow();
}

function loadPendingFallback() {
  const storageKey = pendingStorageKey();
  if (!storageKey) return;
  try {
    // Never attach the old, unnamespaced queue to whichever account happens to sign in first.
    // It has no trustworthy owner or merge base, so silently replaying it would be both a data leak
    // and an overwrite risk. UID-scoped v2 queues below are the only replayable format.
    const raw = localStorage.getItem(storageKey);
    if (raw) mergePendingSources(JSON.parse(raw));
  } catch (_) {}
  for (const key of Object.keys(_pending)) {
    const display = pendingDisplayValue(_pending[key]);
    if (_pending[key].deleteIntent && _pending[key].status !== "conflict") delete _cache[key];
    else if (_pending[key].deleteIntent && hasOwn(_confirmed, key)) _cache[key] = _confirmed[key];
    else if (display !== undefined) _cache[key] = display;
    if (_pending[key].status === "conflict" || _pending[key].status === "legacy") _conflicts[key] = _pending[key];
  }
}

async function writePendingSnapshot(uid, data) {
  if (!uid) return { durable: false, error: new Error("A signed-in account is required to save pending work") };
  const hasPending = Object.keys(data).length > 0;
  if (!hasPending) {
    // Both replay sources must be absent or hold an explicit empty tombstone. Otherwise an older
    // pending envelope can come back on the next launch after the server-confirmed write completed.
    const storageKey = pendingStorageKey(uid);
    let localStorageCleared = false;
    let indexedDbCleared = false;
    let localStorageError = null;
    let indexedDbError = null;
    try {
      localStorage.removeItem(storageKey);
      if (localStorage.getItem(storageKey) !== null) localStorage.setItem(storageKey, "{}");
      const stored = localStorage.getItem(storageKey);
      localStorageCleared = stored === null || stored === "{}";
    } catch (error) {
      localStorageError = error;
    }
    try {
      const key = pendingIdbKey(uid);
      if (key) {
        try { await idb.del(key); } catch (_) {}
        let stored = await idb.getVerified(key);
        if (stored) {
          await idb.set(key, { uid, at: Date.now(), data: {} });
          stored = await idb.getVerified(key);
        }
        indexedDbCleared = !stored || !!(
          stored.uid === uid
          && stored.data
          && Object.keys(stored.data).length === 0
        );
      }
    } catch (error) {
      indexedDbError = error;
    }
    const durable = localStorageCleared && indexedDbCleared;
    return {
      durable,
      empty: true,
      localStorageDurable: localStorageCleared,
      indexedDbDurable: indexedDbCleared,
      error: durable
        ? null
        : (indexedDbError || localStorageError || new Error("The confirmed pending copy could not be cleared on this device")),
    };
  }

  const serialized = JSON.stringify(data);
  let localStorageDurable = false;
  let indexedDbDurable = false;
  let localStorageError = null;
  let indexedDbError = null;
  const storageKey = pendingStorageKey(uid);
  try {
    localStorage.setItem(storageKey, serialized);
    localStorageDurable = localStorage.getItem(storageKey) === serialized;
  } catch (error) {
    // Large client files can exceed localStorage. IndexedDB below remains the primary durable copy.
    localStorageError = error;
    try { console.warn("store: local pending-write fallback unavailable:", error && error.message); } catch (_) {}
  }
  try {
    const key = pendingIdbKey(uid);
    if (key) {
      await idb.set(key, { uid, at: Date.now(), data });
      const stored = await idb.getVerified(key);
      indexedDbDurable = !!(
        stored
        && stored.uid === uid
        && stored.data
        && JSON.stringify(stored.data) === serialized
      );
    }
  } catch (error) {
    indexedDbError = error;
  }

  const durable = localStorageDurable || indexedDbDurable;
  return {
    durable,
    localStorageDurable,
    indexedDbDurable,
    error: durable
      ? null
      : (indexedDbError || localStorageError || new Error("Pending work could not be verified on this device")),
  };
}

function persistPending() {
  // Capture both account and value now. A sign-out during this write must still preserve the old
  // account's intent, never write it under the next signed-in account, and never drop it.
  const uid = _uid;
  const identityVersion = _identityVersion;
  const data = { ..._pending };
  const hydrated = _pendingHydratedIdentity === identityVersion;
  const write = async () => {
    if (!hydrated) {
      const recovery = await ensureHydrate();
      if (!recovery?.ok) return { durable: false, error: recovery?.error || new Error("Pending work could not be recovered") };
      if (identityVersion !== _identityVersion || uid !== _uid) return { durable: false, staleIdentity: true };
    }
    // No snapshot may replace an unread account queue. If hydration was still in progress, include
    // the recovered intents as well as the changes waiting in memory before touching either store.
    return writePendingSnapshot(uid, hydrated ? data : { ..._pending });
  };
  const run = _pendingPersistTail.then(
    write,
    write
  );
  _pendingPersistTail = run.then(
    (result) => result,
    (error) => ({ durable: false, error })
  );
  return _pendingPersistTail;
}

async function awaitPendingDurability() {
  // Fence the intent captured by the caller, not global queue quiescence. Unrelated autosaves
  // may keep extending the tail indefinitely. Callers check that same opId after this receipt
  // before committing, so a newer edit cannot borrow an older intent's durability proof.
  let result = await _pendingPersistTail;
  if (result?.durable === true) return;
  // A suspended WebView must make one real retry after storage recovers. Do not repeatedly await
  // the same failed receipt, or chase later unrelated writes after this retry is protected.
  result = await persistPending();
  if (result?.durable === true) return;
  const error = result?.error || new Error("Pending work could not be verified on this device");
  error.code = error.code || "pending_durability_unavailable";
  throw error;
}

function pendingDurabilityFailure(error) {
  const durabilityError = new Error("This change could not be saved on this device. Keep this screen open and retry before continuing.");
  durabilityError.code = (error && error.code) || "pending_durability_unavailable";
  throttledError(durabilityError.message);
  return { ok: false, error: durabilityError, durabilityFailed: true, review: true, queued: false };
}

function notifyCache(hasData) {
  _cacheReadyState = { ready: true, hasData: !!hasData };
  try { document.dispatchEvent(new CustomEvent("sps-cache-ready", { detail: { hasData: !!hasData } })); } catch (_) {}
}

async function hydrateFromIDB() {
  try {
    if (!_uid) return { ok: false, noUser: true };
    const identityVersion = _identityVersion;
    const [scopedSnap, pendingSnap] = await Promise.all([idb.get(snapshotIdbKey()), idb.getVerified(pendingIdbKey())]);
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (pendingSnap != null && (pendingSnap.uid !== _uid || !pendingSnap.data || typeof pendingSnap.data !== "object" || Array.isArray(pendingSnap.data))) {
      throw new Error("The saved pending work needs recovery before this device can save another change.");
    }
    const legacySnap = await idb.get(SNAP_KEY);
    let snap = scopedSnap;
    if (!snap) {
      if (legacySnap && legacySnap.uid === _uid) {
        snap = legacySnap;
        try { await idb.set(snapshotIdbKey(), legacySnap); } catch (_) {}
      }
    }
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (snap && snap.uid === _uid && snap.data) {
      for (const key of Object.keys(snap.data)) {
        const value = normalizeRemoteStoredValue(key, snap.data[key]);
        if (value === undefined) continue;
        const adoptedValue = !hasOwn(_confirmed, key);
        if (adoptedValue) _confirmed[key] = value;
        if (!hasOwn(_cache, key)) _cache[key] = value;
        if (snap.versions && Number(snap.versions[key]) > 0) {
          _versions[key] = Number(snap.versions[key]);
          _exists[key] = true;
          // Older snapshots have no write times; those rows are simply re-fetched once at startup.
          if (adoptedValue && snap.updatedAt && snap.updatedAt[key]) _updatedAt[key] = String(snap.updatedAt[key]);
          else if (!adoptedValue) delete _updatedAt[key];
        }
      }
    }
    if (pendingSnap && pendingSnap.uid === _uid) mergePendingSources(pendingSnap.data);
    _pendingHydratedIdentity = identityVersion;
    // One-time safe migration from the old global queue: only the UID stamped on the matching
    // legacy snapshot may claim it, and only when neither scoped storage source has a newer queue.
    // Without that ownership evidence it remains quarantined and is never displayed or replayed.
    if (legacySnap && legacySnap.uid === _uid && Object.keys(_pending).length === 0) {
      try {
        const legacyRaw = localStorage.getItem(PENDING_KEY);
        if (legacyRaw) {
          mergePendingSources(JSON.parse(legacyRaw));
          const saved = await writePendingSnapshot(_uid, { ..._pending });
          if (saved.durable) {
            localStorage.removeItem(PENDING_KEY);
            await idb.del(SNAP_KEY);
          }
        }
      } catch (_) {}
    }
    for (const key of Object.keys(_pending)) {
      const value = pendingDisplayValue(_pending[key]);
      if (_pending[key].deleteIntent && _pending[key].status !== "conflict") delete _cache[key];
      else if (_pending[key].deleteIntent && hasOwn(_confirmed, key)) _cache[key] = _confirmed[key];
      else if (value !== undefined) _cache[key] = key === "sps_invoices"
        ? (projectInvoicePending(_pending[key], _confirmed[key]) ?? value) : value;
      if (_pending[key].status === "conflict" || _pending[key].status === "legacy") {
        _conflicts[key] = _pending[key];
        notifyConflict(key, _pending[key].conflicts || [{ path: "$", kind: "legacy-base-unknown" }]);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function ensureHydrate() {
  if (_ensureHydratePromise) return _ensureHydratePromise;
  const identityVersion = _identityVersion;
  const run = hydrateFromIDB().then(result => {
    if (identityVersion === _identityVersion && _uid) {
      if (result?.ok) {
        // A background read may recover the queue while a form still holds an edit entered before
        // recovery. Protect those original intents on its later save, not only on the read's caller.
        if (_pendingHydrationFailedIdentity === identityVersion) {
          Object.keys(_pending).forEach(key => _hydrationHeldKeys.add(key));
          _pendingHydrationFailedIdentity = -1;
        }
        notifyCache(Object.keys(_cache).length > 0);
      } else {
        _pendingHydrationFailedIdentity = identityVersion;
        if (_ensureHydratePromise === run) _ensureHydratePromise = null;
      }
    }
    return result;
  });
  _ensureHydratePromise = run;
  return _ensureHydratePromise;
}

function saveSnapshot() {
  const uid = _uid;
  if (!uid) return _snapshotPersistTail;
  const snap = { uid, at: Date.now(), data: { ..._confirmed }, versions: { ..._versions }, updatedAt: { ..._updatedAt } };
  const run = _snapshotPersistTail.then(
    () => idb.set(snapshotIdbKey(uid), snap),
    () => idb.set(snapshotIdbKey(uid), snap)
  );
  _snapshotPersistTail = run.then(() => {}, () => {});
  return run;
}

function resetForIdentity() {
  _identityVersion += 1;
  _cache = {};
  _confirmed = {};
  _versions = {};
  _updatedAt = {};
  _exists = {};
  _pending = {};
  _conflicts = {};
  _loaded = false;
  _initialReadConfirmed = false;
  _loadPromise = null;
  _flushing = false;
  _ensureHydratePromise = null;
  _pendingHydratedIdentity = -1;
  _pendingHydrationFailedIdentity = -1;
  _hydrationHeldKeys.clear();
  _cacheReadyState = { ready: false, hasData: false };
  _initSelectAt = 0;
  _initRetryCount = 0;
  _initRetryAt = 0;
  _initLastError = null;
  _retryAfterAt = 0;
  _invoiceReceiptVersion = 0;
  _confirmedInvoiceDeletions.clear();
  clearObject(_cacheAt);
  clearObject(_chains);
}

function isAuthError(error) {
  return /jwt|token|expired|session/i.test((error && error.message) || "");
}

async function refreshForAuthError(error) {
  if (!isAuthError(error)) return;
  try { await requestAppState("refresh-session", () => supabase.auth.refreshSession()); } catch (_) {}
}

async function readRemote(key, identityVersion = _identityVersion) {
  let lastError = null;
  // supabase-js already retries transient GET failures. Repeating the same read three more times
  // here multiplied outage traffic, so the only client-level replay left is one post-refresh auth
  // attempt. Infrastructure failures are returned to the caller and writes enter the durable
  // exponential retry lane below.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    const { data, error } = await requestAppState("read", () => supabase.from("app_state")
      .select("key, value, version, updated_at")
      .eq("key", key)
      .maybeSingle());
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      if (!data) return { ok: true, exists: false, value: undefined, version: 0 };
      return {
        ok: true,
        exists: true,
        value: normalizeRemoteStoredValue(key, data.value),
        version: Number(data.version) || 0,
        updatedAt: data.updated_at || null,
      };
    }
    lastError = error;
    const authError = isAuthError(error);
    await refreshForAuthError(error);
    if (!authError) break;
  }
  return { ok: false, error: lastError };
}

async function readRemoteVersions(keys, identityVersion = _identityVersion) {
  const safeKeys = Array.from(new Set((keys || []).filter((key) => typeof key === "string" && key)));
  if (!safeKeys.length) return { ok: true, versions: new Map() };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    const { data, error } = await requestAppState("versions", () => supabase.from("app_state")
      .select("key, version")
      .in("key", safeKeys));
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      return {
        ok: true,
        versions: new Map((data || []).map((row) => [row.key, Number(row.version) || 0])),
      };
    }
    lastError = error;
    const authError = isAuthError(error);
    await refreshForAuthError(error);
    if (!authError) break;
  }
  return { ok: false, error: lastError };
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function readAppliedValue(key, version, identityVersion) {
  // The database may preserve accepted reports when an older snapshot tries to remove them.
  // CAS acknowledges the write/version, not that its submitted JSON was stored unchanged.
  const remote = await readRemote(key, identityVersion);
  if (remote.staleIdentity) return remote;
  if (!remote.ok) return remote;
  if (!remote.exists || remote.version < version) {
    return { ok: false, error: new Error("The saved shared version could not be confirmed. Retry saving.") };
  }
  return remote;
}

async function compareAndSwap(key, expectedVersion, value, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    const { data, error } = await requestAppState("cas", () => supabase.rpc("sps_app_state_cas", {
      p_key: key,
      p_expected_version: expectedVersion,
      p_value: value,
    }));
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      const row = rpcRow(data) || {};
      const actual = row.applied === true && serverProtectedKeys.has(key)
        ? await readAppliedValue(key, Number(row.current_version) || 0, identityVersion) : null;
      if (actual && !actual.ok) return actual;
      return {
        ok: true,
        applied: row.applied === true,
        outcome: row.outcome || (row.applied ? "updated" : "conflict"),
        version: actual ? actual.version : row.current_version == null ? 0 : Number(row.current_version),
        value: actual ? actual.value : value,
        updatedAt: row.changed_at || null,
      };
    }
    lastError = error;
    const authError = isAuthError(error);
    await refreshForAuthError(error);
    if (!authError) break;
  }
  return { ok: false, error: lastError };
}

async function compareAndDelete(key, expectedVersion, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    const { data, error } = await requestAppState("delete-cas", () => supabase.rpc("sps_app_state_delete_cas", {
      p_key: key,
      p_expected_version: expectedVersion,
    }));
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      const row = rpcRow(data) || {};
      return { ok: true, applied: row.applied === true, outcome: row.outcome || "conflict", version: Number(row.current_version) || 0 };
    }
    lastError = error;
    const authError = isAuthError(error);
    await refreshForAuthError(error);
    if (!authError) break;
  }
  return { ok: false, error: lastError };
}

async function compareAndSwapBatch(operations, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    const { data, error } = await requestAppState("batch-cas", () => supabase.rpc("sps_app_state_batch_cas", {
      p_operations: operations.map((operation) => ({
        key: operation.key,
        expected_version: operation.expectedVersion,
        value: operation.value,
      })),
    }));
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      const row = rpcRow(data) || {};
      return {
        ok: true,
        applied: row.applied === true,
        outcome: row.outcome || (row.applied ? "updated" : "conflict"),
        conflictKey: row.conflict_key || null,
        versions: row.current_versions && typeof row.current_versions === "object" ? row.current_versions : {},
      };
    }
    lastError = error;
    const authError = isAuthError(error);
    await refreshForAuthError(error);
    if (!authError) break;
  }
  return { ok: false, error: lastError };
}

function adoptRemote(key, remote, updateDisplay = true) {
  if (remote.exists) {
    _confirmed[key] = remote.value;
    _versions[key] = remote.version;
    if (remote.updatedAt) _updatedAt[key] = String(remote.updatedAt);
    else delete _updatedAt[key];
    _exists[key] = true;
    if (updateDisplay) _cache[key] = remote.value;
  } else {
    delete _confirmed[key];
    _versions[key] = 0;
    delete _updatedAt[key];
    _exists[key] = false;
    if (updateDisplay) delete _cache[key];
  }
}

// Identical to the original startup read-failure handling, shared by the version probe and the
// batched value fetch so both fail exactly the way a single whole-table read used to.
async function initReadFailed(error, identityVersion) {
  console.error("store.init failed:", error && error.message);
  const denied = /row.level security|permission denied|not authorized|insufficient privilege/i.test((error && error.message) || "");
  if (denied) notify("restricted", "Using scoped account access.");
  else notify("error", "Cannot reach the database.");
  await refreshForAuthError(error);
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, loaded: false, staleIdentity: true };
  const retry = nextAppStateRetry(Math.min(_initRetryCount, MAX_INIT_BACKOFF_STEP - 1));
  _initRetryCount = Math.min(retry.retryCount, MAX_INIT_BACKOFF_STEP);
  _initRetryAt = retry.retryAt;
  _initLastError = error;
  _loaded = false;
  return {
    ok: false,
    loaded: false,
    retryable: isTransientAppStateError(error) || isAuthError(error),
    retryAt: _initRetryAt,
    retryCount: _initRetryCount,
    error,
  };
}

// Fetch full values for only the rows startup actually needs, in small parallel batches. Rows that
// arrive are always returned (even when another batch fails) so callers can keep that progress.
async function fetchInitValues(keys, identityVersion) {
  const rows = [];
  if (!keys.length) return { ok: true, rows };
  const chunks = [];
  for (let i = 0; i < keys.length; i += INIT_VALUE_CHUNK_SIZE) chunks.push(keys.slice(i, i + INIT_VALUE_CHUNK_SIZE));
  let next = 0;
  let firstError = null;
  const worker = async () => {
    while (!firstError && next < chunks.length) {
      const chunk = chunks[next++];
      const { data, error } = await requestAppState("initialize-values", () => supabase.from("app_state")
        .select("key, value, version, updated_at")
        .in("key", chunk), { timeoutMs: INIT_VALUE_TIMEOUT_MS });
      if (identityVersion !== _identityVersion || !_uid) return;
      if (error) { firstError = firstError || error; return; }
      for (const row of data || []) rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(INIT_VALUE_CONCURRENCY, chunks.length) }, worker));
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true, rows: [] };
  return firstError ? { ok: false, rows, error: firstError } : { ok: true, rows };
}

async function init() {
  if (_loaded) return { ok: true, loaded: true, alreadyLoaded: true };
  if (_loadPromise) return _loadPromise;
  if (!_uid) return { ok: false, loaded: false, noUser: true, error: new Error("No signed-in account") };
  if (_initRetryAt > Date.now()) {
    return {
      ok: false,
      loaded: false,
      deferred: true,
      retryable: isTransientAppStateError(_initLastError) || isAuthError(_initLastError),
      retryAt: _initRetryAt,
      retryCount: _initRetryCount,
      error: _initLastError || new Error("The shared data connection is retrying shortly"),
    };
  }
  const identityVersion = _identityVersion;
  _initSelectAt = Date.now();
  const run = (async () => {
    try {
      // 1) Probe the tiny (version, write time) stamps for every row this account can read.
      const { data: stamps, error } = await requestAppState("initialize", () => supabase.from("app_state").select("key, version, updated_at"));
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, loaded: false, staleIdentity: true };
      if (error) return initReadFailed(error, identityVersion);
      if (!stamps || stamps.length === 0) {
        const deletedKeys = Object.keys(_confirmed).filter((key) => !_pending[key]);
        _confirmed = {};
        _versions = {};
        _updatedAt = {};
        _exists = {};
        deletedKeys.forEach((key) => { delete _cache[key]; notifyReconciled(key, true); });
        _loaded = true;
        _initialReadConfirmed = true;
        _initRetryCount = 0;
        _initRetryAt = 0;
        _initLastError = null;
        saveSnapshot();
        // An empty result is still a fully confirmed initial read. Release the frontend's
        // write fence so a legitimate new workspace can create its first shared records.
        notify("read-ok", "Connected");
        notify("restricted", "Using scoped account access.");
        notifyReconciled();
        flush();
        return { ok: true, loaded: true, empty: true, rowCount: 0 };
      }
      // 2) Reuse every confirmed value this device already holds for the exact same server write
      //    (same version AND same write time), and fetch only rows that changed or were never cached.
      const reused = [];
      const needed = [];
      for (const row of stamps) {
        const version = Number(row.version) || 0;
        const stamp = row.updated_at == null ? "" : String(row.updated_at);
        if (version > 0 && stamp && hasOwn(_confirmed, row.key)
          && Number(_versions[row.key]) === version && _updatedAt[row.key] === stamp) {
          reused.push({ key: row.key, value: _confirmed[row.key], version, updated_at: row.updated_at });
        } else needed.push(row.key);
      }
      const fetched = await fetchInitValues(needed, identityVersion);
      if (fetched.staleIdentity || identityVersion !== _identityVersion || !_uid) {
        return { ok: false, loaded: false, staleIdentity: true };
      }
      if (!fetched.ok) {
        // Keep every confirmed row that did arrive so the next attempt only fetches what is still
        // missing. Display values and deletions wait for a complete, consistent read.
        for (const row of fetched.rows) {
          const value = normalizeRemoteStoredValue(row.key, row.value);
          if (value === undefined) continue;
          _confirmed[row.key] = value;
          _versions[row.key] = Number(row.version) || 0;
          if (row.updated_at) _updatedAt[row.key] = String(row.updated_at);
          else delete _updatedAt[row.key];
          _exists[row.key] = true;
        }
        if (fetched.rows.length) saveSnapshot();
        return initReadFailed(fetched.error, identityVersion);
      }
      const data = [...reused, ...fetched.rows];
      const remoteKeys = new Set(data.map((row) => row.key));
      const deletedKeys = [];
      for (const key of Object.keys(_confirmed)) {
        if (remoteKeys.has(key)) continue;
        delete _confirmed[key];
        _versions[key] = 0;
        delete _updatedAt[key];
        _exists[key] = false;
        if (!_pending[key]) {
          delete _cache[key];
          deletedKeys.push(key);
        }
      }
      for (const row of data) {
        const value = normalizeRemoteStoredValue(row.key, row.value);
        if (value === undefined) continue;
        _confirmed[row.key] = value;
        _versions[row.key] = Number(row.version) || 0;
        if (row.updated_at) _updatedAt[row.key] = String(row.updated_at);
        else delete _updatedAt[row.key];
        _exists[row.key] = true;
        const pending = _pending[row.key];
        if (pending && row.key === "sps_invoices") _cache[row.key] = projectInvoicePending(pending, value) ?? pendingDisplayValue(pending);
        else if (pending && pending.deleteIntent && pending.status === "conflict") _cache[row.key] = value;
        else if (pending && pending.heldConflicts) {
          _cache[row.key] = normalizeStoredValue(mergeEnvelopeWithRemote(row.key, pending, { exists: true, value }, "local").value) ?? pending.localValue;
        }
        else if (!pending && !(_cacheAt[row.key] > _initSelectAt)) _cache[row.key] = value;
      }
      _loaded = true;
      _initialReadConfirmed = true;
      _initRetryCount = 0;
      _initRetryAt = 0;
      _initLastError = null;
      notify("read-ok", "Connected");
      saveSnapshot();
      notifyReconciled();
      deletedKeys.forEach((key) => notifyReconciled(key, true));
      flush();
      return { ok: true, loaded: true, empty: false, rowCount: data.length };
    } catch (error) {
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, loaded: false, staleIdentity: true };
      try { console.error("store.init error:", error && error.message); } catch (_) {}
      notify("error", "Cannot reach the database.");
      const retry = nextAppStateRetry(Math.min(_initRetryCount, MAX_INIT_BACKOFF_STEP - 1));
      _initRetryCount = Math.min(retry.retryCount, MAX_INIT_BACKOFF_STEP);
      _initRetryAt = retry.retryAt;
      _initLastError = error;
      _loaded = false;
      return {
        ok: false,
        loaded: false,
        retryable: isTransientAppStateError(error) || isAuthError(error),
        retryAt: _initRetryAt,
        retryCount: _initRetryCount,
        error,
      };
    }
  })();
  _loadPromise = run;
  run.then(() => {
    if (_loadPromise === run) _loadPromise = null;
  });
  return run;
}

function stagePending(key, value, options = {}) {
  let localValue = normalizeStoredValue(value);
  if (localValue === undefined) throw new Error("store.set requires a JSON value");
  const now = Date.now();
  const existing = _pending[key];
  // Reconcile events may submit the exact same dirty React value repeatedly. It is still the
  // same durable intent, not another edit or permission to supersede an in-flight review choice.
  // A projected base and explicit force are meaningful operations even when the value matches.
  if (existing && existing.localValue === localValue && !existing.deleteIntent
    && !existing.force && !options.force && !hasOwn(options, "projectedBaseValue")) return existing;
  const shownValue = hasOwn(options, "baseValue") ? normalizeStoredValue(options.baseValue)
    : hasOwn(options, "projectedBaseValue") ? normalizeStoredValue(options.projectedBaseValue) : _cache[key];
  const heldRebase = existing && existing.v === 2 && existing.heldConflicts && !existing.deleteIntent && !options.force
    ? rebaseOntoHeld(key, shownValue, localValue, existing) : null;
  if (heldRebase && heldRebase.localValue === existing.localValue && heldRebase.baseValue === existing.baseValue) return existing;
  let envelope;
  if (existing && existing.v !== 2) {
    // A pre-versioning queue item has no trustworthy merge base. Preserve it as a visible conflict
    // even if the user makes another edit; silently upgrading it would discard part of that work.
    if (key === "sps_invoices" && hasOwn(options, "projectedBaseValue")) {
      localValue = mergeStoredState(key, normalizeStoredValue(options.projectedBaseValue), localValue,
        existing.localValue, { prefer: "local" }).value;
    }
    envelope = { ...existing, opId: newOpId(), localValue, status: "legacy", updatedAt: now };
  } else if (heldRebase) {
    // The held fields stay paused for review; the rest of this new edit commits on its own.
    envelope = { ...existing, opId: newOpId(), baseValue: heldRebase.baseValue, localValue: heldRebase.localValue, heldDirty: true, updatedAt: now };
  } else if (existing && existing.v === 2) {
    // Display-only refreshes can include server changes that were never part of the user's intent.
    // On a subsequent real edit, reverse the original local delta out of that projection to build
    // its new base. Remote-only records then remain base data and cannot be resurrected by a later
    // conflict choice after another device removes them. Overlapping fields retain their old base.
    const projectedBase = hasOwn(options, "projectedBaseValue")
      ? mergeStoredState(
        key,
        existing.localValue,
        existing.baseExists ? existing.baseValue : undefined,
        normalizeStoredValue(options.projectedBaseValue),
        { prefer: "local" }
      ).value
      : undefined;
    if (key === "sps_invoices" && hasOwn(options, "projectedBaseValue") && typeof _confirmed[key] === "string") {
      // The displayed canonical accounting may deliberately hide a held device
      // proposal. Apply only the newly typed delta to that recoverable intent;
      // saving an unrelated note must not silently erase its proposed charges.
      const retained = mergeStoredState(key, existing.baseExists ? existing.baseValue : undefined,
        existing.localValue, _confirmed[key], { prefer: "local" }).value;
      localValue = mergeStoredState(key, normalizeStoredValue(options.projectedBaseValue), localValue,
        retained, { prefer: "local" }).value;
    }
    envelope = {
      ...existing,
      ...(hasOwn(options, "projectedBaseValue") ? {
        baseExists: projectedBase !== undefined,
        baseValue: projectedBase === undefined ? null : projectedBase,
        ...(key === "sps_invoices" ? { invoiceProjectionBaseValue: existing.invoiceProjectionBaseValue
          ?? (existing.baseExists ? existing.baseValue : "[]") } : {}),
      } : {}),
      opId: newOpId(),
      localValue,
      deleteIntent: false,
      // Force belongs only to this explicit restore/reset call. A failed destructive operation must
      // never make a later ordinary edit inherit whole-value overwrite behavior.
      force: !!options.force,
      forceExpectedVersion: options.force && hasOwn(options, "expectedVersion")
        ? Math.max(0, Number(options.expectedVersion) || 0)
        : null,
      status: existing.status === "conflict" && !options.force && !fieldIntentKeys.has(key) ? "conflict" : "pending",
      conflicts: existing.status === "conflict" && !options.force && !fieldIntentKeys.has(key) ? existing.conflicts : [],
      ...(fieldIntentKeys.has(key) ? { sharedReviewConflicts: undefined, sharedResolutions: undefined } : {}),
      heldConflicts: false,
      heldDirty: false,
      updatedAt: now,
    };
  } else {
    const optionHasBase = hasOwn(options, "baseValue");
    const rawBase = optionHasBase ? options.baseValue : _confirmed[key];
    const baseValue = normalizeStoredValue(rawBase);
    envelope = {
      v: 2,
      opId: newOpId(),
      baseExists: baseValue !== undefined,
      baseValue: baseValue === undefined ? null : baseValue,
      baseVersion: Number(_versions[key]) || 0,
      localValue,
      status: "pending",
      conflicts: [],
      force: !!options.force,
      forceExpectedVersion: options.force && hasOwn(options, "expectedVersion")
        ? Math.max(0, Number(options.expectedVersion) || 0)
        : null,
      createdAt: now,
      updatedAt: now,
    };
  }
  // A fresh user edit is a new intent and gets one immediate commit attempt. It must not inherit
  // an outage cooldown from the older value it replaced.
  envelope = { ...envelope, retryCount: 0, retryAt: 0 };
  if (key === "sps_invoices" && _confirmedInvoiceDeletions.size) {
    const deletedIds = [...new Set([...(envelope.confirmedDeletedInvoiceIds || []), ..._confirmedInvoiceDeletions])];
    envelope.confirmedDeletedInvoiceIds = deletedIds;
    try {
      if (JSON.parse(localValue).some(invoice => deletedIds.includes(String(invoice?.id || "")))) {
        envelope.status = "conflict";
        envelope.conflicts = [{ path: "$", kind: "deleted-invoice-local-work" }];
      }
    } catch (_) {}
  }
  _pending[key] = envelope;
  recalculateRetryWindow();
  if (envelope.status === "conflict" || envelope.status === "legacy") _conflicts[key] = envelope;
  else delete _conflicts[key];
  _cache[key] = key === "sps_invoices" && (envelope.v !== 2 || envelope.invoiceProjectionBaseValue || envelope.confirmedDeletedInvoiceIds?.length)
    ? (projectInvoicePending(envelope, _confirmed[key]) ?? localValue) : localValue;
  _cacheAt[key] = now;
  persistPending();
  return envelope;
}

// Apply an editor's newest change to a held envelope. `shownValue` is the copy the editor started
// from, so only the edits made since then are applied to the held copy. Where someone else changed
// the same thing meanwhile, the merge base keeps what this device showed, so that field also pauses
// for review instead of silently overwriting work this device never displayed.
function rebaseOntoHeld(key, shownValue, nextLocal, held) {
  if (shownValue === undefined || !held.baseExists) return null;
  const localValue = normalizeStoredValue(mergeStoredState(key, shownValue, nextLocal, held.localValue, { prefer: "local" }).value);
  const baseValue = normalizeStoredValue(mergeStoredState(key, shownValue, nextLocal, held.baseValue, { prefer: "base", dropLocal: true }).value);
  return localValue === undefined || baseValue === undefined ? null : { localValue, baseValue };
}

function stageDelete(key, options = {}) {
  const now = Date.now();
  const existing = _pending[key];
  const optionHasBase = hasOwn(options, "baseValue");
  const rawBase = optionHasBase
    ? options.baseValue
    : (existing && existing.v === 2 && existing.baseExists ? existing.baseValue : _confirmed[key]);
  const baseValue = normalizeStoredValue(rawBase);
  const envelope = {
    v: 2,
    opId: newOpId(),
    baseExists: baseValue !== undefined,
    baseValue: baseValue === undefined ? null : baseValue,
    baseVersion: Number((existing && existing.baseVersion) || _versions[key]) || 0,
    // Kept only so a legacy UI can describe the prior value; deleteIntent prevents it from being
    // displayed or interpreted as the desired write value.
    localValue: normalizeStoredValue((existing && existing.localValue) || _confirmed[key]) || "null",
    deleteIntent: true,
    force: !!options.force,
    status: "pending",
    conflicts: [],
    retryCount: 0,
    retryAt: 0,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
  _pending[key] = envelope;
  recalculateRetryWindow();
  delete _conflicts[key];
  delete _cache[key];
  _cacheAt[key] = now;
  persistPending();
  return envelope;
}

function setConflict(key, envelope, conflicts, { held = false } = {}) {
  const safe = publicConflicts(conflicts);
  const next = {
    ...envelope,
    status: "conflict",
    conflicts: safe,
    // Only a held envelope (everything else already saved) may keep committing new edits.
    heldConflicts: held,
    heldDirty: false,
    retryCount: 0,
    retryAt: 0,
    updatedAt: Date.now(),
  };
  _pending[key] = next;
  recalculateRetryWindow();
  _conflicts[key] = next;
  if (next.deleteIntent) {
    if (hasOwn(_confirmed, key)) _cache[key] = _confirmed[key];
    else delete _cache[key];
  } else _cache[key] = key === "sps_invoices" ? (projectInvoicePending(next, _confirmed[key]) ?? next.localValue) : next.localValue;
  persistPending();
  notifyConflict(key, safe);
  return { ok: false, conflict: true, key, conflicts: safe };
}

function mergeEnvelopeWithRemote(key, envelope, remote, prefer = "remote") {
  if (envelope.force) return { value: envelope.localValue, conflicts: [], merged: !sameStored(envelope.localValue, remote.value) };
  const baseValue = envelope.baseExists ? envelope.baseValue : undefined;
  return mergeStoredState(key, baseValue, envelope.localValue, remote.exists ? remote.value : undefined, { prefer });
}

function rebaseNewerEnvelope(key, completedEnvelope, appliedValue, appliedVersion, newer) {
  if (!newer || newer.opId === completedEnvelope.opId) return null;
  if (newer.force && !fieldIntentKeys.has(key)) {
    return { ...newer, baseExists: true, baseValue: appliedValue, baseVersion: appliedVersion, status: "pending", conflicts: [] };
  }
  const rebased = mergeStoredState(key, completedEnvelope.localValue, newer.localValue, appliedValue, { prefer: "local" });
  // An overlap here keeps the newer edit's own base; on a holdable section its next commit saves
  // the non-overlapping part and holds the rest instead of pausing the whole section.
  const hold = rebased.conflicts.length > 0 && key !== "sps_invoices" && !fieldIntentKeys.has(key) && !newer.deleteIntent;
  const next = {
    ...newer,
    heldConflicts: hold,
    heldDirty: hold,
    // A user can type again while a reviewed choice is in flight. If that text
    // overlaps the response, preserve its original base and exact local value.
    // Rebasing it onto the response would either erase it or authorize a stale overwrite.
    baseExists: rebased.conflicts.length ? newer.baseExists : true,
    baseValue: rebased.conflicts.length ? newer.baseValue : appliedValue,
    baseVersion: rebased.conflicts.length ? newer.baseVersion : appliedVersion,
    localValue: rebased.conflicts.length ? newer.localValue : rebased.value,
    status: rebased.conflicts.length ? "conflict" : "pending",
    conflicts: publicConflicts(rebased.conflicts),
    updatedAt: Date.now(),
  };
  if (next.status === "conflict") {
    _conflicts[key] = next;
    notifyConflict(key, next.conflicts);
  }
  return next;
}

// Everything except the overlapping fields was just saved (or already matched the saved copy).
// Keep only those fields on this device for review. `mergedAgainst` is the saved copy the merge
// used, `candidate` what was written for it, and `applied` the database's confirmation.
async function holdConflicts(key, envelope, mergedAgainst, candidate, applied, conflicts, identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const base = envelope.baseExists ? envelope.baseValue : undefined;
  // A protected section can be adjusted by the database as it is stored; carry that adjustment.
  const settle = (value, prefer) => (sameStored(applied.value, candidate) ? value
    : mergeStoredState(key, candidate, value, applied.value, { prefer }).value);
  const heldBase = normalizeStoredValue(settle(mergeStoredState(key, base, envelope.localValue, mergedAgainst, { prefer: "base" }).value, "remote"));
  const heldLocal = normalizeStoredValue(settle(mergeStoredState(key, base, envelope.localValue, mergedAgainst, { prefer: "local" }).value, "local"));
  _confirmed[key] = applied.value;
  _versions[key] = applied.version;
  _exists[key] = true;
  if (heldBase === undefined || heldLocal === undefined) return setConflict(key, envelope, conflicts);
  const current = _pending[key];
  const newer = current && current.opId !== envelope.opId ? current : null;
  if (!newer && sameStored(heldBase, heldLocal)) return finishApplied(key, envelope, applied.value, applied.version, identityVersion);
  let next = { ...envelope, baseExists: true, baseValue: heldBase, baseVersion: applied.version, localValue: heldLocal };
  if (newer) {
    // An edit made during this save rebases onto the held copy. A newer delete/restore, or one that
    // cannot be rebased, keeps its own base and re-merges with the saved copy when it commits.
    const rebased = newer.v === 2 && !newer.deleteIntent && !newer.force
      ? rebaseOntoHeld(key, envelope.localValue, newer.localValue, next) : null;
    if (!rebased) {
      saveSnapshot();
      return { ok: false, superseded: true };
    }
    next = { ...newer, baseExists: true, baseValue: rebased.baseValue, baseVersion: applied.version, localValue: rebased.localValue };
  }
  next = {
    ...next,
    status: "conflict",
    conflicts: publicConflicts(conflicts),
    heldConflicts: true,
    heldDirty: !!newer,
    retryCount: 0,
    retryAt: 0,
    updatedAt: Date.now(),
  };
  _pending[key] = next;
  _conflicts[key] = next;
  _cache[key] = next.localValue;
  recalculateRetryWindow();
  persistPending();
  saveSnapshot();
  notifyConflict(key, next.conflicts);
  // Show everyone else's saved changes (plus this device's held fields) on the open screen.
  notifyReconciled(key, true);
  return { ok: false, conflict: true, held: true, key, conflicts: next.conflicts, value: applied.value, version: applied.version };
}

async function finishApplied(key, envelope, value, version, identityVersion, options = {}) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  _confirmed[key] = value;
  _versions[key] = version;
  _exists[key] = true;
  const current = _pending[key];
  const hasNewerIntent = !!(current && current.opId !== envelope.opId);
  if (hasNewerIntent) {
    const rebased = rebaseNewerEnvelope(key, envelope, value, version, current);
    if (rebased) {
      _pending[key] = rebased;
      _cache[key] = rebased.localValue;
    }
  } else {
    delete _pending[key];
    delete _conflicts[key];
    _cache[key] = value;
  }
  recalculateRetryWindow();
  const pendingPersistence = await persistPending();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (!pendingPersistence || pendingPersistence.durable !== true) {
    if (!hasNewerIntent) {
      _pending[key] = {
        ...envelope,
        baseExists: true,
        baseValue: value,
        baseVersion: version,
        status: "pending",
        conflicts: [],
        retryCount: 0,
        retryAt: 0,
        updatedAt: Date.now(),
      };
      _cache[key] = value;
      recalculateRetryWindow();
    }
    const restored = await persistPending();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const error = new Error("The change reached the server, but this device could not clear its pending copy. Keep this screen open and retry sync.");
    error.code = "pending_cleanup_unavailable";
    throttledError(error.message);
    return {
      ok: false,
      error,
      durabilityFailed: true,
      cleanupFailed: true,
      serverConfirmed: true,
      review: true,
      queued: !!(restored && restored.durable),
      value,
      version,
    };
  }
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  saveSnapshot();
  // A newer local edit remains optimistic in _cache. Do not tell React to adopt the just-confirmed
  // intermediate value; the queued follow-up commit will publish the final merged value.
  if (options.notify !== false && !hasNewerIntent) notifyReconciled(key, true);
  notify("save-ok", "Saved");
  return { ok: true, value, version, merged: value !== envelope.localValue };
}

async function finishDeleted(key, envelope, identityVersion, options = {}) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  delete _confirmed[key];
  _versions[key] = 0;
  delete _updatedAt[key];
  _exists[key] = false;
  const current = _pending[key];
  const hasNewerIntent = !!(current && current.opId !== envelope.opId);
  if (hasNewerIntent && !current.deleteIntent) {
    // A set issued after the delete began is a deliberate recreation. Rebase it on the now-missing
    // row so its queued chain performs an insert instead of being cleared by the older response.
    _pending[key] = {
      ...current,
      baseExists: false,
      baseValue: null,
      baseVersion: 0,
      status: "pending",
      conflicts: [],
      updatedAt: Date.now(),
    };
    delete _conflicts[key];
    _cache[key] = current.localValue;
  } else {
    delete _pending[key];
    delete _conflicts[key];
    delete _cache[key];
  }
  recalculateRetryWindow();
  const pendingPersistence = await persistPending();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (!pendingPersistence || pendingPersistence.durable !== true) {
    if (!hasNewerIntent) {
      _pending[key] = {
        ...envelope,
        baseExists: false,
        baseValue: null,
        baseVersion: 0,
        status: "pending",
        conflicts: [],
        retryCount: 0,
        retryAt: 0,
        updatedAt: Date.now(),
      };
      delete _cache[key];
      recalculateRetryWindow();
    }
    const restored = await persistPending();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const error = new Error("The deletion reached the server, but this device could not clear its pending copy. Keep this screen open and retry sync.");
    error.code = "pending_cleanup_unavailable";
    throttledError(error.message);
    return {
      ok: false,
      error,
      durabilityFailed: true,
      cleanupFailed: true,
      serverConfirmed: true,
      review: true,
      queued: !!(restored && restored.durable),
      value: undefined,
      version: 0,
      deleted: true,
    };
  }
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  saveSnapshot();
  if (options.notify !== false && !hasNewerIntent) notifyReconciled(key, true);
  notify("save-ok", "Saved");
  return { ok: true, value: undefined, version: 0, deleted: true };
}

// Retire only the confirmed client edit. A conflict on another client keeps its
// original comparison base and recoverable local copy, rather than blocking this save.
async function finishSharedClient(submitted, clientId, value, version, identityVersion) {
  const key = "sps_clients";
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const prior = _pending[key];
  const actual = JSON.parse(value), pick = rows => rows.find(client => String(client?.id) === clientId);
  const saved = pick(actual);
  if (!saved) return commitFailure(key, submitted, new Error("This client was removed while saving. Reopen the saved client list."));
  adoptRemote(key, { exists: true, value, version }, false);
  if (prior?.v === 2 && prior.baseExists && !prior.deleteIntent) {
    const base = JSON.parse(prior.baseValue), local = JSON.parse(prior.localValue);
    const submittedClient = pick(JSON.parse(submitted.localValue));
    const newerClient = pick(local);
    const target = mergeStoredState(key, [submittedClient], newerClient ? [newerClient] : [], [saved], { prefer: "local" });
    const targetRows = JSON.parse(target.value);
    const replace = (rows, next) => rows.flatMap(client => String(client?.id) === clientId ? next : [client]);
    const nextBase = target.conflicts.length ? prior.baseValue : JSON.stringify(replace(base, [saved]));
    const nextLocal = target.conflicts.length ? prior.localValue : JSON.stringify(replace(local, targetRows));
    if (stableInvoiceReviewJSON(JSON.parse(nextBase)) === stableInvoiceReviewJSON(JSON.parse(nextLocal))) {
      delete _pending[key]; delete _conflicts[key]; _cache[key] = value;
    } else {
      const retained = (prior.sharedReviewConflicts || []).filter(conflict => conflict.entityId !== clientId);
      const next = { ...prior, baseValue: nextBase, localValue: nextLocal, baseVersion: version,
        status: retained.length ? "conflict" : "pending", conflicts: publicConflicts(retained), sharedReviewConflicts: retained,
        sharedResolutions: undefined, retryCount: 0, retryAt: 0, updatedAt: Date.now() };
      _pending[key] = next;
      if (retained.length) _conflicts[key] = next; else delete _conflicts[key];
      _cache[key] = projectAcceptedReports(key, mergeStoredState(key, nextBase, nextLocal, value, { prefer: "local" }).value, value);
    }
  } else {
    // Do not clear a different legacy or destructive intent that appeared during the request.
    _cache[key] = prior ? prior.localValue : value;
  }
  recalculateRetryWindow();
  const persisted = await persistPending();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (!persisted?.durable) {
    if (!_pending[key] && prior) _pending[key] = prior;
    await persistPending();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    return { ...pendingDurabilityFailure(new Error("The client reached the server, but this device could not confirm its pending copy. Retry the same save.")), serverConfirmed: true };
  }
  saveSnapshot();
  return { ok: true, value: _cache[key], parsedValue: JSON.parse(_cache[key]), confirmedClient: saved,
    confirmedValue: value, version, pending: !!_pending[key] };
}

function patchClient(baselineClient, updatedClient) {
  const key = "sps_clients", identityVersion = _identityVersion;
  // Snapshot caller-owned form values before waiting behind any other request.
  const baseline = structuredClone(baselineClient), updated = structuredClone(updatedClient);
  const clientId = String(baseline?.id ?? "");
  const priorChain = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await priorChain; } catch (_) {}
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!clientId || String(updated?.id ?? "") !== clientId) return { ok: false, error: new Error("A unique client is required for this save.") };
    const hydration = await ensureHydrate();
    if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
    const initialized = await init();
    if (!initialized.ok || identityVersion !== _identityVersion || !_uid) return { ...initialized, ok: false };
    const previous = _pending[key];
    if (previous && (previous.v !== 2 || !previous.baseExists || previous.deleteIntent)) {
      return { ok: false, error: new Error("An older pending client copy needs review before editing this client. Your choices are still here.") };
    }
    let base, local;
    try {
      base = JSON.parse(previous?.baseValue || _confirmed[key]);
      local = JSON.parse(previous?.localValue || _confirmed[key]);
      if (!Array.isArray(base) || !Array.isArray(local)) throw new Error("Invalid client roster");
      const byId = rows => rows.filter(client => String(client?.id) === clientId);
      if (byId(base).length !== 1 || byId(local).length !== 1) throw new Error("This client is missing or duplicated. Reopen the client before saving.");
      const baseClient = byId(base)[0], localClient = byId(local)[0];
      const same = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);
      const sameRetry = previous && same(baseClient, baseline) && same(localClient, updated);
      if (previous && !same(baseClient, localClient) && !sameRetry) {
        return { ok: false, conflict: true, error: new Error("This client already has pending edits. Review that client's saved changes before replacing them.") };
      }
      const envelope = sameRetry ? previous : {
        ...(previous || {}), v: 2, opId: newOpId(), baseExists: true,
        baseValue: JSON.stringify(base.map(client => String(client.id) === clientId ? baseline : client)),
        localValue: JSON.stringify(local.map(client => String(client.id) === clientId ? updated : client)),
        baseVersion: Number(_versions[key]) || 0, deleteIntent: false, force: false,
        status: previous?.status === "conflict" ? "conflict" : "pending",
        conflicts: previous?.conflicts || [], sharedReviewConflicts: previous?.sharedReviewConflicts,
        sharedResolutions: undefined, retryCount: 0, retryAt: 0, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(),
      };
      _pending[key] = envelope;
      if (envelope.status === "conflict") _conflicts[key] = envelope; else delete _conflicts[key];
      recalculateRetryWindow();
      _cache[key] = mergeStoredState(key, envelope.baseValue, envelope.localValue, _confirmed[key], { prefer: "local" }).value;
      const persisted = await persistPending();
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
      if (!persisted?.durable) return pendingDurabilityFailure(persisted?.error);
      return commitSharedEnvelope(key, envelope, identityVersion, null, clientId);
    } catch (error) { return { ok: false, error }; }
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

async function commitSharedEnvelope(key, envelope, identityVersion, strategy = null, targetClientId = null) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (envelope.v !== 2 || !envelope.baseExists || envelope.deleteIntent) {
    return setConflict(key, envelope, [{ path: "$", kind: "original-fields-required" }]);
  }
  let intent;
  try {
    intent = await buildSharedStateIntent(key, JSON.parse(envelope.baseValue), JSON.parse(envelope.localValue), { operationId: envelope.opId });
  } catch (error) { return commitFailure(key, envelope, error); }
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (_pending[key]?.opId !== envelope.opId) return { ok: false, superseded: true };
  if (targetClientId !== null) intent.operations = intent.operations.filter(operation => operation.entity === "client" && operation.entityId === targetClientId);
  const resolutions = strategy && Array.isArray(envelope.sharedReviewConflicts)
    ? envelope.sharedReviewConflicts.flatMap(conflict => {
      const operation = intent.operations.find(item => item.entity === conflict.entity && item.entityId === conflict.entityId
        && JSON.stringify(item.path || []) === JSON.stringify(conflict.path || []));
      return operation ? [{ operationId: operation.id, choice: strategy, reviewed: conflict.current }] : [];
    })
    : envelope.sharedResolutions;
  if (strategy && resolutions?.length) {
    envelope = { ...envelope, sharedResolutions: resolutions, status: "pending" };
    _pending[key] = envelope; delete _conflicts[key];
    const persisted = await persistPending();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!persisted?.durable) return pendingDurabilityFailure(persisted?.error);
    if (_pending[key]?.opId !== envelope.opId) return { ok: false, superseded: true };
  }
  const actorId = _uid;
  const result = await sendSharedStateIntent(intent, { getSession: () => supabase.auth.getSession(), resolutions,
    expectedActorId: actorId, isCurrentIdentity: () => _uid === actorId && _identityVersion === identityVersion });
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (result.error) return commitFailure(key, envelope, result.error);
  const receipt = result.data;
  if (receipt?.actorId !== _uid || receipt?.key !== key || receipt?.operationId !== envelope.opId) {
    return commitFailure(key, envelope, new Error("The save receipt did not match this account and change. Your pending work is preserved."));
  }
  if (receipt.ok === false && receipt.code === "shared-state-field-conflict") {
    if (_pending[key]?.opId !== envelope.opId) return { ok: false, superseded: true };
    const conflicts = Array.isArray(receipt.conflicts) ? receipt.conflicts : [];
    if (!conflicts.length) return commitFailure(key, envelope, new Error("The changed fields could not be identified. Retry to read the saved record."));
    const combined = targetClientId !== null
      ? [...(envelope.sharedReviewConflicts || []).filter(conflict => conflict.entityId !== targetClientId), ...conflicts]
      : conflicts;
    return setConflict(key, { ...envelope, sharedReviewConflicts: combined, sharedResolutions: undefined }, combined);
  }
  const version = Number(receipt.afterVersion), before = Number(receipt.beforeVersion);
  if (receipt.ok !== true || receipt.complete !== true || !Array.isArray(receipt.value)
    || !Number.isSafeInteger(version) || !Number.isSafeInteger(before) || before < 1 || version < before) {
    return commitFailure(key, envelope, new Error("The saved record could not be verified. Retry to check the same change."));
  }
  let value = normalizeRemoteStoredValue(key, receipt.value);
  if (version < (Number(_versions[key]) || 0)) {
    // A later complete snapshot already arrived. Do not roll the device back
    // when an earlier request's response is slow.
    value = _confirmed[key];
    return targetClientId !== null
      ? finishSharedClient(envelope, targetClientId, value, Number(_versions[key]), identityVersion)
      : finishApplied(key, envelope, value, Number(_versions[key]), identityVersion);
  }
  return targetClientId !== null ? finishSharedClient(envelope, targetClientId, value, version, identityVersion)
    : finishApplied(key, envelope, value, version, identityVersion);
}

async function commitKey(key, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const hydration = await ensureHydrate();
  if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
  const envelope = _pending[key];
  try {
    await awaitPendingDurability();
  } catch (error) {
    return pendingDurabilityFailure(error);
  }
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if ((_pending[key]?.opId || null) !== (envelope?.opId || null)) return { ok: false, superseded: true };
  await ensureHydrate();
  const initialized = await init();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if ((_pending[key]?.opId || null) !== (envelope?.opId || null)) return { ok: false, superseded: true };
  if (!initialized.ok) {
    if (initialized.staleIdentity) return { ok: false, staleIdentity: true };
    if (!envelope || initialized.deferred) {
      return {
        ...initialized,
        ok: false,
        initFailed: true,
        queued: !!envelope,
      };
    }
    const queued = queueFailure(key, initialized.error, envelope);
    return {
      ...queued,
      initFailed: true,
      retryAt: Math.max(Number(queued.retryAt) || 0, Number(initialized.retryAt) || 0),
    };
  }
  if (!envelope) return { ok: true, value: _confirmed[key], version: Number(_versions[key]) || 0 };
  if (envelope.status === "conflict" && !committable(envelope)) return { ok: false, conflict: true, key, conflicts: envelope.conflicts || [] };
  if (fieldIntentKeys.has(key)) return commitSharedEnvelope(key, envelope, identityVersion);

  let remote;
  if (hasOwn(_exists, key) && (_exists[key] === false || Number(_versions[key]) > 0)) {
    remote = { ok: true, exists: !!_exists[key], value: _confirmed[key], version: Number(_versions[key]) || 0 };
  } else {
    remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) return commitFailure(key, envelope, remote.error);
    adoptRemote(key, remote, !_pending[key]);
  }

  if (envelope.v !== 2) {
    if (remote.exists && sameStored(envelope.localValue, remote.value)) {
      _pending[key] = envelope;
      return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
    }
    return setConflict(key, envelope, [{ path: "$", kind: "legacy-base-unknown" }]);
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const current = _pending[key];
    if (!current || current.opId !== envelope.opId) return { ok: false, superseded: true };

    if (envelope.deleteIntent) {
      if (!remote.exists) return finishDeleted(key, envelope, identityVersion);
      if (!envelope.force && (!envelope.baseExists || !sameStored(envelope.baseValue, remote.value))) {
        return setConflict(key, envelope, [{ path: "$", kind: envelope.baseExists ? "delete-vs-edit" : "delete-vs-add" }]);
      }
      const deleted = await compareAndDelete(key, remote.version, identityVersion);
      if (deleted.staleIdentity) return { ok: false, staleIdentity: true };
      if (!deleted.ok) return commitFailure(key, envelope, deleted.error);
      if (deleted.applied) return finishDeleted(key, envelope, identityVersion);
      remote = await readRemote(key, identityVersion);
      if (remote.staleIdentity) return { ok: false, staleIdentity: true };
      if (!remote.ok) return commitFailure(key, envelope, remote.error);
      adoptRemote(key, remote, false);
      continue;
    }

    if (envelope.force && envelope.forceExpectedVersion != null) {
      const actualVersion = remote.exists ? remote.version : 0;
      if (actualVersion !== envelope.forceExpectedVersion) {
        if (remote.exists && sameStored(envelope.localValue, remote.value)) {
          return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
        }
        return setConflict(
          key,
          { ...envelope, force: false },
          [{ path: "$", kind: "restore-baseline-changed" }]
        );
      }
    }

    const merged = mergeEnvelopeWithRemote(key, envelope, remote);
    // The merge keeps the saved value wherever both sides changed the same field, so `candidate`
    // carries every non-overlapping change from this device and nothing that overwrites others.
    const holding = merged.conflicts.length > 0;
    if (holding && !canHoldConflicts(key, envelope, remote, merged.conflicts)) return setConflict(key, envelope, merged.conflicts);
    const candidate = normalizeStoredValue(merged.value);
    if (candidate === undefined) {
      return holding ? setConflict(key, envelope, merged.conflicts) : finishDeleted(key, envelope, identityVersion);
    }
    if (remote.exists && sameStored(candidate, remote.value)) {
      return holding ? holdConflicts(key, envelope, remote.value, candidate, remote, merged.conflicts, identityVersion)
        : finishApplied(key, envelope, remote.value, remote.version, identityVersion);
    }

    const result = await compareAndSwap(key, remote.exists ? remote.version : 0, candidate, identityVersion);
    if (result.staleIdentity) return { ok: false, staleIdentity: true };
    if (!result.ok) return commitFailure(key, envelope, result.error);
    if (result.applied) {
      return holding ? holdConflicts(key, envelope, remote.value, candidate, result, merged.conflicts, identityVersion)
        : finishApplied(key, envelope, result.value, result.version, identityVersion);
    }

    remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) return commitFailure(key, envelope, remote.error);
    adoptRemote(key, remote, false);
  }
  return commitFailure(key, envelope, new Error("Several people are saving this section at once. Retrying shortly."));
}

function queueFailure(key, error, envelope = null) {
  const current = _pending[key];
  const sameIntent = !!(current && (!envelope || current.opId === envelope.opId));
  // A rejected protected write is not a network outage. Replaying it on every
  // refresh can saturate the database and cannot change the decision.
  if (sameIntent && /^(SHARED_STATE_PATCH_PROTECTED_CHANGE|SHARED_STATE_DELETED_IDENTITY|shared-state-protected-change|shared-state-save-needs-review)$/.test(error?.code || "")) {
    return { ...setConflict(key, { ...current, saveRejection: { code: error.code, message: error.message } },
      [{ path: "$", kind: "server-rejected" }]), error, queued: false };
  }
  let retry = null;
  if (sameIntent && committable(current) && isTransientAppStateError(error)) {
    retry = nextAppStateRetry(current.retryCount);
    _pending[key] = {
      ...current,
      retryCount: retry.retryCount,
      retryAt: retry.retryAt,
    };
  } else if (sameIntent && committable(current) && (current.retryAt || current.retryCount)) {
    // Do not let an expired infrastructure cooldown hide a different, non-transient problem.
    _pending[key] = { ...current, retryCount: 0, retryAt: 0 };
  }
  recalculateRetryWindow();
  persistPending();
  try { console.error("store.set failed (kept for retry):", key, error && error.message); } catch (_) {}
  throttledError(`Save failed: ${(error && error.message) || "your changes aren't syncing — retrying."}`);
  return {
    ok: false,
    error,
    queued: sameIntent,
    transient: !!retry,
    retryAt: retry ? retry.retryAt : 0,
  };
}

function commitFailure(key, envelope, error) {
  if (envelope && envelope.force) {
    // A restore/reset is an exceptional destructive intent. If it did not land during the user's
    // confirmed operation, pause it for an explicit choice instead of replaying it invisibly later.
    return setConflict(
      key,
      { ...envelope, force: false },
      [{ path: "$", kind: "destructive-operation-interrupted" }]
    );
  }
  return queueFailure(key, error, envelope);
}

function enqueueCommit(key, identityVersion = _identityVersion) {
  const prior = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await prior; } catch (_) {}
    return commitKey(key, identityVersion);
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

async function refreshKey(key, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  try {
    await ensureHydrate();
    const initialized = await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!initialized.ok) return { ...initialized, ok: false, initFailed: true };

    const remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) {
      throttledError(`Refresh failed: ${(remote.error && remote.error.message) || "the latest shared data could not be loaded."}`);
      return { ok: false, error: remote.error };
    }

    const priorExists = hasOwn(_confirmed, key) || !!_exists[key];
    const priorValue = _confirmed[key];
    const priorVersion = Number(_versions[key]) || 0;
    const changed = priorExists !== remote.exists
      || priorVersion !== Number(remote.version || 0)
      || (remote.exists && !sameStored(priorValue, remote.value));

    // Preserve unresolved edits, while allowing independent server changes (such as a completed
    // report) to appear in the display cache. Keep the original durable intent and conflict choice
    // untouched: this projection is not a new edit, a rebase, or permission to commit either side.
    const pending = _pending[key];
    adoptRemote(key, remote, !pending);
    if (pending && key === "sps_invoices") {
      const projected = projectInvoicePending(pending, remote.value);
      if (projected !== null) _cache[key] = projected;
    } else if (pending?.v === 2 && !pending.deleteIntent && !pending.force) {
      const projected = projectAcceptedReports(key, mergeEnvelopeWithRemote(key, pending, remote, "local").value, remote.value);
      if (projected === undefined) delete _cache[key];
      else _cache[key] = projected;
    }
    saveSnapshot();
    // A held section stays live: show others' saved changes alongside this device's held fields.
    // Not forceRemote — the dirty-aware path rebases any edit the screen has not staged yet.
    if (changed && pending?.heldConflicts && _pending[key] === pending) notifyReconciled(key, false);
    // Do not let a successful one-key refresh certify an earlier FAILED full-app read. Doing so
    // would lift App.jsx's write fence while other sections still hold their defaults. Once the
    // initial shared snapshot was confirmed, this lighter signal can clear a transient refresh error.
    if (_initialReadConfirmed) notify("refresh-ok", "Connected");

    if (!_pending[key]) {
      // Deliberately NOT forceRemote: React may have a just-entered edit whose effect has not staged
      // its pending envelope yet. useStoredState detects that dirty value and merges it first;
      // otherwise it adopts this refreshed cache value. Always send this keyed signal even when the
      // database version is unchanged: the initial cache-first reconcile may have arrived before the
      // hook listener mounted, leaving React one snapshot behind the already-current store cache.
      notifyReconciled(key, false, !remote.exists);
    }
    return {
      ok: true,
      changed,
      pending: !!_pending[key],
      exists: remote.exists,
      value: remote.value,
      version: Number(remote.version) || 0,
    };
  } catch (error) {
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    throttledError(`Refresh failed: ${(error && error.message) || "the latest shared data could not be loaded."}`);
    return { ok: false, error };
  }
}

function enqueueRefresh(key, identityVersion = _identityVersion) {
  // Share the per-key chain with writes. This prevents an older, slower refresh from landing after
  // a newer save and makes refresh-vs-edit ordering deterministic across visibility/realtime events.
  const prior = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await prior; } catch (_) {}
    return refreshKey(key, identityVersion);
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

async function refreshChangedKeys(keys, options = {}, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const safeKeys = Array.from(new Set((keys || []).filter((key) => typeof key === "string" && key)));
  if (!safeKeys.length) return { ok: true, changedKeys: [], results: [] };
  try {
    await ensureHydrate();
    const initialized = await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!initialized.ok) return { ...initialized, ok: false, initFailed: true };

    // Poll only the tiny version counters. Full JSON values are fetched through enqueueRefresh only
    // for rows whose version/existence changed, preserving the same dirty-aware, per-key ordering as
    // realtime refreshes and writes.
    const probe = await readRemoteVersions(safeKeys, identityVersion);
    if (probe.staleIdentity) return { ok: false, staleIdentity: true };
    if (!probe.ok) {
      throttledError(`Refresh check failed: ${(probe.error && probe.error.message) || "the latest shared versions could not be loaded."}`);
      return { ok: false, error: probe.error };
    }

    const changedKeys = safeKeys.filter((key) => {
      const remoteExists = probe.versions.has(key);
      const localExists = hasOwn(_exists, key) ? !!_exists[key] : hasOwn(_confirmed, key);
      return remoteExists !== localExists
        || (remoteExists && Number(probe.versions.get(key) || 0) !== Number(_versions[key] || 0));
    });
    if (options.reconcileUnchanged) {
      safeKeys.forEach((key) => {
        if (!changedKeys.includes(key) && !_pending[key]) notifyReconciled(key, false, !probe.versions.has(key));
      });
    }
    const results = await Promise.all(changedKeys.map((key) => enqueueRefresh(key, identityVersion)));
    if (results.some((result) => result && result.staleIdentity)) {
      return { ok: false, staleIdentity: true, changedKeys, results };
    }
    return {
      ok: results.every((result) => result && result.ok),
      changedKeys,
      results,
    };
  } catch (error) {
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    throttledError(`Refresh check failed: ${(error && error.message) || "the latest shared versions could not be loaded."}`);
    return { ok: false, error };
  }
}

async function flush() {
  if (_flushing) return { ok: false, busy: true };
  const pendingKeys = Object.keys(_pending).filter((key) => committable(_pending[key]));
  if (!pendingKeys.length) {
    _retryAfterAt = 0;
    return { ok: true, empty: true };
  }
  recalculateRetryWindow();
  const now = Date.now();
  if (_retryAfterAt > now) {
    return { ok: false, deferred: true, retryAt: _retryAfterAt };
  }
  const identityVersion = _identityVersion;
  _flushing = true;
  const results = [];
  try {
    for (const key of pendingKeys) {
      if (identityVersion !== _identityVersion || !_uid) return;
      if (!committable(_pending[key])) continue;
      const result = await enqueueCommit(key, identityVersion);
      results.push({ key, result });
      // A shared infrastructure failure is unlikely to be key-specific. Stop this drain after one
      // failed request instead of hammering every large app_state row in the queue.
      if (result && (result.transient || result.initFailed)) break;
    }
    const initRetryAt = results.reduce(
      (latest, { result }) => Math.max(latest, Number(result && result.retryAt) || 0),
      0
    );
    return {
      ok: results.every(({ result }) => result && result.ok),
      deferred: results.some(({ result }) => result && (result.transient || result.deferred || result.initFailed)),
      retryAt: Math.max(_retryAfterAt, initRetryAt),
      results,
    };
  } finally {
    if (identityVersion === _identityVersion) _flushing = false;
  }
}

// Finish one shared section without draining unrelated queued work. This is for actions that must
// establish a narrow write fence (for example, reconciling one invoice against QuickBooks) but
// should not be blocked by an offline photo, schedule, or client edit elsewhere in the app.
// The normal per-key chain still serializes an in-flight save ahead of this call, and commitKey
// keeps the same conflict, identity, initialization, and durable-retry protections as store.set().
async function flushKey(key) {
  if (!key || typeof key !== "string") {
    return { ok: false, error: new Error("A storage key is required") };
  }
  const identityVersion = _identityVersion;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const pending = _pending[key];
    const retryAt = Number(pending && pending.retryAt) || 0;
    if (committable(pending) && retryAt > Date.now()) {
      return { ok: false, deferred: true, queued: true, key, retryAt };
    }

    const result = await enqueueCommit(key, identityVersion);
    if (result && result.superseded) continue;
    if (!result || result.ok !== true) return { ...(result || { ok: false }), key };
    if (!_pending[key]) return { ...result, ok: true, key };

    const remaining = _pending[key];
    if (remaining.status === "conflict" || remaining.status === "legacy") {
      return { ok: false, conflict: true, conflictKey: key, key, conflicts: remaining.conflicts || [] };
    }
  }
  return { ok: false, busy: true, key };
}

async function resolveConflict(key, strategy, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const hydration = await ensureHydrate();
  if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const envelope = _pending[key];
  if (!envelope) return { ok: true, value: _confirmed[key], version: Number(_versions[key]) || 0 };
  if (strategy !== "local" && strategy !== "remote") throw new Error("Unknown conflict resolution");
  try {
    await awaitPendingDurability();
  } catch (error) {
    return pendingDurabilityFailure(error);
  }
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  if (!_pending[key] || _pending[key].opId !== envelope.opId) return { ok: false, superseded: true };

  if (fieldIntentKeys.has(key)) {
    if ((envelope.v !== 2 || !envelope.baseExists || envelope.deleteIntent || envelope.saveRejection) && strategy === "remote") {
      const remote = await readRemote(key, identityVersion);
      if (remote.staleIdentity) return { ok: false, staleIdentity: true };
      if (!remote.ok) return queueFailure(key, remote.error, envelope);
      return remote.exists ? finishApplied(key, envelope, remote.value, remote.version, identityVersion)
        : finishDeleted(key, envelope, identityVersion);
    }
    return commitSharedEnvelope(key, envelope, identityVersion, strategy);
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = _pending[key];
    if (!current || current.opId !== envelope.opId) return { ok: false, superseded: true };
    const remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) return queueFailure(key, remote.error, envelope);
    if (!_pending[key] || _pending[key].opId !== envelope.opId) return { ok: false, superseded: true };
    adoptRemote(key, remote, false);

    if (envelope.deleteIntent) {
      if (strategy === "remote" || !remote.exists) {
        if (!remote.exists) return finishDeleted(key, envelope, identityVersion);
        return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
      }
      const deleted = await compareAndDelete(key, remote.version, identityVersion);
      if (deleted.staleIdentity) return { ok: false, staleIdentity: true };
      if (!deleted.ok) return queueFailure(key, deleted.error, envelope);
      if (deleted.applied) return finishDeleted(key, envelope, identityVersion);
      continue;
    }

    let candidate;
    if (envelope.v !== 2) candidate = strategy === "local" ? envelope.localValue : remote.value;
    else {
      const resolvedMerge = mergeEnvelopeWithRemote(key, envelope, remote, strategy);
      const known = new Set((envelope.conflicts || []).map(conflictSignature));
      const fresh = publicConflicts(resolvedMerge.conflicts);
      if (known.size && fresh.some((item) => !known.has(conflictSignature(item)))) {
        // A third writer introduced a different overlapping field after the banner appeared. Show
        // the expanded set and require a fresh choice instead of stretching the old click to it.
        return setConflict(key, envelope, fresh, {
          held: envelope.heldConflicts === true && canHoldConflicts(key, envelope, remote, resolvedMerge.conflicts),
        });
      }
      candidate = resolvedMerge.value;
    }
    candidate = normalizeStoredValue(candidate);
    if (candidate === undefined) {
      if (!remote.exists) {
        return finishDeleted(key, envelope, identityVersion);
      }
      candidate = remote.value;
    }
    if (remote.exists && sameStored(candidate, remote.value)) {
      return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
    }
    const result = await compareAndSwap(key, remote.exists ? remote.version : 0, candidate, identityVersion);
    if (result.staleIdentity) return { ok: false, staleIdentity: true };
    if (!result.ok) return queueFailure(key, result.error, envelope);
    if (result.applied) return finishApplied(key, envelope, result.value, result.version, identityVersion);
  }
  return queueFailure(key, new Error("The shared version changed again. Please choose once more."), envelope);
}

async function verifyBatchValues(operations, identityVersion) {
  const rows = await Promise.all(operations.map((operation) => readRemote(operation.key, identityVersion)));
  if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
  if (rows.some((row) => !row.ok || row.staleIdentity)) return { matched: false };
  const matched = rows.every((row, index) => row.exists && sameStored(row.value, operations[index].value));
  return {
    matched,
    versions: matched ? Object.fromEntries(rows.map((row, index) => [operations[index].key, row.version])) : {},
  };
}

function replaceMany(changes, options = {}) {
  if (!Array.isArray(changes) || !changes.length) return Promise.resolve({ ok: false, error: new Error("No sections to replace") });
  const identityVersion = _identityVersion;
  const actorId = _uid, operationId = newOpId(), action = options.action;
  const seen = new Set();
  let operations;
  try {
    operations = changes.map((change) => {
      const key = String((change && change.key) || "");
      const value = normalizeStoredValue(change && change.value);
      const expectedVersion = Number(change && change.expectedVersion);
      if (!key || seen.has(key) || value === undefined || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error("Invalid atomic replacement request");
      }
      seen.add(key);
      return { key, value, expectedVersion,
        ...(hasOwn(change, "baseValue") ? { baseValue: normalizeStoredValue(change.baseValue) } : {}) };
    });
  } catch (error) { return Promise.resolve({ ok: false, error }); }

  const keys = operations.map((operation) => operation.key);
  const priors = keys.map((key) => _chains[key] || Promise.resolve());
  const run = (async () => {
    try { await Promise.all(priors); } catch (_) {}
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const hydration = await ensureHydrate();
    if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
    const initialized = await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!initialized.ok) return { ...initialized, ok: false, initFailed: true };
    const blockedKey = keys.find((key) => _pending[key]);
    if (blockedKey) return { ok: false, conflict: true, conflictKey: blockedKey, error: new Error("A local edit is still pending") };

    const protectedBatch = operations.some(operation => fieldIntentKeys.has(operation.key));
    let result;
    if (protectedBatch) {
      let requestOperations;
      try {
        requestOperations = await Promise.all(operations.map(async operation => {
          if (!fieldIntentKeys.has(operation.key)) return { key: operation.key, expectedVersion: operation.expectedVersion, value: JSON.parse(operation.value) };
          const original = hasOwn(operation, "baseValue") ? operation.baseValue
            : Number(_versions[operation.key]) === operation.expectedVersion ? _confirmed[operation.key] : undefined;
          if (original === undefined) throw new Error("The original records are required for this change. Reload them before trying again.");
          const intent = await buildSharedStateIntent(operation.key, JSON.parse(original), JSON.parse(operation.value), { operationId: `${operationId}:${operation.key}` });
          return { key: operation.key, expectedVersion: operation.expectedVersion, intent };
        }));
      } catch (error) { return { ok: false, error }; }
      const response = await sendSharedStateIntent({ protocol: 1, mode: "batch", operationId, action, operations: requestOperations }, {
        getSession: () => supabase.auth.getSession(), expectedActorId: actorId,
        isCurrentIdentity: () => _uid === actorId && _identityVersion === identityVersion,
      });
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
      const receipt = response.data;
      if (!response.error && receipt?.ok === true && receipt.actorId === actorId && receipt.operationId === operationId
        && receipt.complete === true && operations.every(operation => Number.isSafeInteger(receipt.versions?.[operation.key])
          && receipt.versions[operation.key] >= operation.expectedVersion && hasOwn(receipt.values || {}, operation.key))) {
        result = { ok: true, applied: true, versions: receipt.versions };
      } else result = { ok: false, conflict: response.error?.status === 409 || receipt?.code === "shared-state-field-conflict",
        error: response.error || new Error("The atomic save receipt was not confirmed. The original records are unchanged on this device.") };
    } else result = await compareAndSwapBatch(operations, identityVersion);
    if (result.staleIdentity) return { ok: false, staleIdentity: true };
    if (!result.ok || !result.applied) {
      // A response can be lost after PostgreSQL committed the whole transaction. Re-read every key;
      // if all exact values landed, treat it as success instead of inviting a duplicate restore.
      const verified = await verifyBatchValues(operations, identityVersion);
      if (verified.staleIdentity) return { ok: false, staleIdentity: true };
      if (!verified.matched) {
        if (!result.ok) throttledError(`Save failed: ${(result.error && result.error.message) || "the atomic replacement did not complete."}`);
        return { ok: false, conflict: !!result.ok || !!result.conflict, conflictKey: result.conflictKey || null, error: result.error };
      }
      result = { ok: true, applied: true, outcome: "already-applied", versions: verified.versions };
    }

    // Guarded sections can differ from the requested restoration while the transaction succeeds.
    // Confirm all of them before advancing any cache or pending-edit base.
    const protectedValues = new Map();
    for (const operation of operations.filter(item => serverProtectedKeys.has(item.key))) {
      const actual = await readAppliedValue(operation.key, Number(result.versions[operation.key]) || 0, identityVersion);
      if (!actual.ok) return { ...actual, ok: false, unconfirmed: true };
      protectedValues.set(operation.key, actual.value);
      result.versions[operation.key] = actual.version;
    }
    for (const operation of operations) {
      const key = operation.key;
      if (protectedValues.has(key)) operation.value = protectedValues.get(key);
      const version = Number(result.versions[key]) || operation.expectedVersion + 1 || 1;
      _confirmed[key] = operation.value;
      _versions[key] = version;
      _exists[key] = true;
      const pending = _pending[key];
      if (!pending) {
        _cache[key] = operation.value;
        continue;
      }
      if (pending.deleteIntent) {
        _pending[key] = {
          ...pending,
          baseExists: true,
          baseValue: operation.value,
          baseVersion: version,
          status: "pending",
          conflicts: [],
          updatedAt: Date.now(),
        };
        delete _cache[key];
        continue;
      }
      const rebased = pending.force
        ? { value: pending.localValue, conflicts: [] }
        : mergeStoredState(
          key,
          pending.baseExists ? pending.baseValue : undefined,
          pending.localValue,
          operation.value,
          { prefer: "remote" }
        );
      const next = {
        ...pending,
        baseExists: true,
        baseValue: operation.value,
        baseVersion: version,
        localValue: rebased.value,
        status: rebased.conflicts.length ? "conflict" : "pending",
        conflicts: publicConflicts(rebased.conflicts),
        heldConflicts: false,
        heldDirty: false,
        updatedAt: Date.now(),
      };
      _pending[key] = next;
      _cache[key] = next.localValue;
      if (next.status === "conflict") {
        _conflicts[key] = next;
        notifyConflict(key, next.conflicts);
      }
    }
    const durability = await persistPending();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    if (!durability?.durable) return { ...pendingDurabilityFailure(durability?.error), serverConfirmed: true };
    saveSnapshot();
    operations.forEach((operation) => { if (!_pending[operation.key]) notifyReconciled(operation.key, true); });
    notify("save-ok", "Saved");
    return { ok: true, atomic: true, versions: result.versions };
  })();

  const tail = run.then(() => {}, () => {});
  keys.forEach((key) => { _chains[key] = tail; });
  return run;
}

function isCurrentIdentity(identity) {
  return !!_uid && identity?.uid === _uid && identity?.generation === _identityVersion;
}

// A compact server receipt proves one client, not the contents of an entire roster. Only
// advance the roster version when its exact predecessor is available locally. Otherwise
// show the saved addition while leaving the confirmed snapshot and every pending edit intact.
function acceptCreatedClient(receipt, identity) {
  const key = "sps_clients";
  const prior = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await prior; } catch (_) {}
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    const client = receipt?.client;
    const before = Number(receipt?.beforeVersion), after = Number(receipt?.afterVersion);
    if (!client || typeof client !== "object" || Array.isArray(client)
      || typeof client.id !== "string" || !client.id || typeof client.name !== "string" || !client.name.trim()
      || !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < before
      || (!receipt.replayed && after <= before)) {
      return { ok: false, error: new Error("The saved client receipt is incomplete. Retry to confirm the same client.") };
    }
    let displayed, confirmed;
    try {
      displayed = JSON.parse(_cache[key] || "[]");
      confirmed = JSON.parse(_confirmed[key] || "[]");
      if (!Array.isArray(displayed) || !Array.isArray(confirmed)) throw new Error("Invalid roster");
    } catch (_) {
      return { ok: false, error: new Error("The client was saved. Refresh the client list to display it.") };
    }
    const currentVersion = Number(_versions[key]) || 0;
    if (currentVersion >= after) {
      // A late replay must not replace newer edits or resurrect a client that was removed later.
      return { ok: true, value: _cache[key] || "[]", parsedValue: displayed, superseded: true, projected: false };
    }
    const hasClient = list => list.some(item => String(item?.id) === client.id);
    const canReconstruct = !receipt.replayed && !receipt.clientProjection
      && currentVersion === before && after === before + 1
      && !_pending[key] && !hasClient(confirmed);
    if (!hasClient(displayed)) displayed = [...displayed, client];
    _cache[key] = JSON.stringify(displayed);
    _cacheAt[key] = Date.now();
    if (canReconstruct) {
      _confirmed[key] = JSON.stringify([...confirmed, client]);
      _versions[key] = after;
      _exists[key] = true;
      // Persistence failure cannot turn a confirmed server creation into a failed creation.
      saveSnapshot().catch(() => {});
    }
    // The caller adopts this display through the hook's dirty-aware projection. No forced
    // reconcile event and no full-roster network request are needed to finish the form.
    return { ok: true, value: _cache[key], parsedValue: displayed, projected: !canReconstruct };
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

// An accounting choice confirms one invoice, not the full ledger. Adopt that exact
// record and retire only the local intent the owner actually reviewed. Unrelated
// drafts and conflicts keep their original three-way-merge bases and durable queue.
function acceptInvoiceReviewResolution(receipt, identity, options = {}) {
  const key = "sps_invoices";
  const prior = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await prior; } catch (_) {}
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    const hydration = await ensureHydrate();
    if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
    try { await awaitPendingDurability(); }
    catch (error) { return pendingDurabilityFailure(error); }
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };

    const invoice = receipt?.invoice, beforeInvoice = receipt?.beforeInvoice;
    const expected = options.expectedInvoice;
    const before = Number(receipt?.beforeVersion), after = Number(receipt?.afterVersion);
    const id = String(invoice?.id ?? "");
    const isRecord = item => !!item && typeof item === "object" && !Array.isArray(item);
    // Object key order differs between PostgreSQL JSON and JS. Compare values,
    // retaining line order and every field rather than comparing serialization.
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
    const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    if (receipt?.ok !== true || !isRecord(invoice) || !id || !isRecord(beforeInvoice)
      || String(beforeInvoice.id ?? "") !== id || !isRecord(expected) || String(expected.id ?? "") !== id
      || !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < before
      || after > before + 1 || (after === before && !equal(beforeInvoice, invoice))) {
      return { ok: false, error: new Error("The saved invoice choice could not be verified. Check this invoice again.") };
    }
    const readList = (value, allowMissing = false) => {
      const list = JSON.parse(value || "[]");
      if (!Array.isArray(list)) throw new Error("Invalid invoice list");
      const matches = list.filter(item => String(item?.id ?? "") === id).length;
      if (matches > 1 || (!allowMissing && matches !== 1)) throw new Error("Invoice identity is not unique");
      return list;
    };
    let displayed, confirmed;
    try {
      displayed = readList(_cache[key]);
      confirmed = readList(_confirmed[key], true);
    } catch (_) {
      return { ok: false, serverConfirmed: true, error: new Error("The invoice choice was saved. Refresh the invoice list to display it safely.") };
    }
    const target = list => list.find(item => String(item?.id ?? "") === id);
    const replace = list => list.map(item => String(item?.id ?? "") === id ? invoice : item);
    const currentVersion = Number(_versions[key]) || 0;
    if (currentVersion > after || (currentVersion === after && !equal(target(confirmed), invoice))) {
      return { ok: true, superseded: true, value: _cache[key], parsedValue: displayed, invoice: target(displayed), projected: false };
    }
    const changedResult = () => ({
      ok: false, serverConfirmed: true, targetChanged: true,
      error: new Error("The QuickBooks choice was saved, but this invoice was edited again on this device. Your newer work is preserved; reopen the invoice to compare it."),
    });
    const pending = _pending[key];
    let unchangedPendingProjection = false;
    try {
      const originalTarget = pending && target(readList(pending.localValue));
      const projected = pending && projectInvoicePending(pending, _confirmed[key]);
      unchangedPendingProjection = equal(originalTarget, expected) && projected !== null
        && equal(target(displayed), target(readList(projected)));
    } catch (_) {}
    if (!equal(target(displayed), expected) && !equal(target(displayed), invoice) && !unchangedPendingProjection) return changedResult();

    let nextPending = pending;
    let pendingBase, pendingLocal;
    if (pending) {
      if (pending.deleteIntent || pending.force) return changedResult();
      try {
        pendingLocal = readList(pending.localValue);
        if (!equal(target(pendingLocal), expected) && !equal(target(pendingLocal), invoice)) return changedResult();
        if (pending.v === 2) pendingBase = readList(pending.baseValue, true);
      } catch (_) { return changedResult(); }
      const lists = [displayed, confirmed, pendingLocal, ...(pendingBase ? [pendingBase] : [])];
      const qbIds = [...new Set([invoice.qbId, beforeInvoice.qbId, expected.qbId].filter(value => value != null && String(value)).map(String))];
      const prefixes = [`$.id:${id}`];
      // A QB identity is safe to retire only when every stored occurrence belongs
      // to this exact app record. A duplicate link must keep its own review.
      for (const qbId of qbIds) {
        if (lists.every(list => list.every(item => String(item?.qbId ?? "") !== qbId || String(item?.id ?? "") === id))) prefixes.push(`$.qb:${qbId}`);
      }
      // Conflict paths use printable identities, so unusual ids containing a dot
      // or bracket can share a prefix. Keep those ambiguous paths for review.
      const unambiguousPrefixes = prefixes.filter(prefix => lists.every(list => list.every(item => {
        if (String(item?.id ?? "") === id) return true;
        return [`$.id:${String(item?.id ?? "")}`, `$.qb:${String(item?.qbId ?? "")}`]
          .every(otherPrefix => otherPrefix !== prefix && !otherPrefix.startsWith(`${prefix}.`) && !otherPrefix.startsWith(`${prefix}[`));
      })));
      const conflicts = (pending.conflicts || []).filter(conflict => !unambiguousPrefixes.some(prefix => (
        conflict.path === prefix || conflict.path?.startsWith(`${prefix}.`) || conflict.path?.startsWith(`${prefix}[`)
      )));
      nextPending = {
        ...pending,
        opId: newOpId(),
        localValue: JSON.stringify(replace(pendingLocal)),
        ...(pendingBase ? { baseExists: true, baseValue: JSON.stringify(target(pendingBase) ? replace(pendingBase) : [...pendingBase, invoice]) } : {}),
        conflicts,
        status: pending.v !== 2 ? "legacy" : conflicts.length ? "conflict" : "pending",
        updatedAt: Math.max(Date.now(), (Number(pending.updatedAt) || 0) + 1),
      };
      // No remaining local delta means the selected invoice was the only intent.
      // Emptying this queue uses the store's verified two-store cleanup below.
      if (pendingBase && !conflicts.length && equal(JSON.parse(nextPending.baseValue), JSON.parse(nextPending.localValue))) nextPending = null;
    }

    const canReconstruct = currentVersion === before && after === before + 1 && equal(target(confirmed), beforeInvoice);
    const nextDisplay = replace(displayed);
    _invoiceReceiptVersion = Math.max(_invoiceReceiptVersion, after);
    // Mutate before persisting so concurrent edits queued during the disk write
    // start from the resolved record. They receive a newer opId and stay intact.
    if (nextPending) {
      _pending[key] = nextPending;
      if (nextPending.status === "conflict" || nextPending.status === "legacy") _conflicts[key] = nextPending;
      else delete _conflicts[key];
    } else if (pending) {
      delete _pending[key];
      delete _conflicts[key];
    }
    _cache[key] = JSON.stringify(nextDisplay);
    _cacheAt[key] = Date.now();
    if (canReconstruct) {
      _confirmed[key] = JSON.stringify(replace(confirmed));
      _versions[key] = after;
      _exists[key] = true;
    }
    recalculateRetryWindow();
    if (pending) {
      const durability = await persistPending();
      if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
      if (durability?.durable !== true) {
        return { ...pendingDurabilityFailure(durability?.error), serverConfirmed: true };
      }
    }
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    if (canReconstruct) saveSnapshot().catch(() => {});
    let latestDisplay;
    try { latestDisplay = readList(_cache[key]); } catch (_) { return changedResult(); }
    if (!equal(target(latestDisplay), invoice)) return changedResult();
    // No forced event: the React hook must preserve edits which have not reached
    // its save effect yet when adopting this display projection.
    return {
      ok: true, value: _cache[key], parsedValue: latestDisplay, invoice,
      projected: !canReconstruct, pending: !!_pending[key],
    };
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

// A server refresh receipt contains the entire canonical ledger at one confirmed
// revision. It is a read/adoption operation, never a new local whole-array edit.
// Keep the original pending delta so a conflict on A cannot block fresh B, and so
// choosing a side later still compares against the actual original merge base.
function acceptInvoiceRefreshSnapshot(receipt, identity) {
  const key = "sps_invoices";
  let captured;
  try { captured = JSON.parse(JSON.stringify(receipt)); } catch (_) {}
  const prior = _chains[key] || Promise.resolve();
  const run = (async () => {
    try { await prior; } catch (_) {}
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    const before = captured?.beforeVersion, after = captured?.afterVersion;
    const invoices = captured?.invoices;
    const validIds = Array.isArray(invoices) && invoices.every(invoice => invoice
      && typeof invoice === "object" && !Array.isArray(invoice)
      && typeof invoice.id === "string" && invoice.id.trim());
    if (captured?.ok !== true || captured.actorId !== identity.uid || captured.key !== key || captured.complete !== true || !validIds
      || new Set(invoices.map(invoice => invoice.id)).size !== invoices.length
      || !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < before) {
      return { ok: false, error: new Error("The refreshed invoice snapshot could not be verified. Retry QuickBooks refresh.") };
    }
    const hydration = await ensureHydrate();
    if (!hydration?.ok) return pendingDurabilityFailure(hydration?.error);
    try { await awaitPendingDurability(); }
    catch (error) { return pendingDurabilityFailure(error); }
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    const currentVersion = Number(_versions[key]) || 0;
    const currentValue = () => {
      let parsedValue, confirmedParsedValue;
      try { parsedValue = JSON.parse(_cache[key] || "[]"); } catch (_) {}
      try { confirmedParsedValue = JSON.parse(_confirmed[key] || "[]"); } catch (_) {}
      const confirmedUsable = (Number(_versions[key]) || 0) >= _invoiceReceiptVersion && Array.isArray(confirmedParsedValue);
      return { value: _cache[key], parsedValue: Array.isArray(parsedValue) ? parsedValue : null,
        confirmedValue: confirmedUsable ? _confirmed[key] : null,
        confirmedParsedValue: confirmedUsable ? confirmedParsedValue : null,
        version: Number(_versions[key]) || 0, pending: !!_pending[key],
        recoveryPending: invoicePendingNeedsRecovery(_pending[key]) };
    };
    if (after < Math.max(currentVersion, _invoiceReceiptVersion)) {
      return { ok: true, superseded: true, ...currentValue() };
    }
    const value = JSON.stringify(invoices);
    const canonical = item => Array.isArray(item) ? item.map(canonical)
      : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(name => [name, canonical(item[name])])) : item;
    const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    let confirmed;
    try { confirmed = JSON.parse(_confirmed[key]); } catch (_) {}
    if (currentVersion === after && _exists[key] && !equal(confirmed, invoices)) {
      return { ok: false, error: new Error("The invoice refresh disagrees with an already confirmed revision. Retry QuickBooks refresh.") };
    }
    adoptRemote(key, { exists: true, value, version: after }, !_pending[key]);
    _invoiceReceiptVersion = Math.max(_invoiceReceiptVersion, after);
    const projectCurrent = () => {
      const pending = _pending[key];
      if (!pending) return false;
      const projected = projectInvoicePending(pending, _confirmed[key]);
      if (projected === null) return true;
      _cache[key] = projected;
      return false;
    };
    let projectionBlocked = projectCurrent();
    _cacheAt[key] = Date.now();
    // saveSnapshot captures the account and exact confirmed data before its first
    // await. Verify its durable revision; a newer same-account snapshot is safe.
    try {
      await saveSnapshot();
      const saved = await idb.getVerified(snapshotIdbKey(identity.uid));
      if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
      const savedVersion = saved?.versions?.[key];
      if (saved?.uid !== identity.uid || !Number.isSafeInteger(savedVersion) || savedVersion < after
        || (savedVersion === after && !equal(JSON.parse(saved.data?.[key]), invoices))) {
        throw new Error("The refreshed invoice copy could not be verified on this device.");
      }
    } catch (error) {
      if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
      return { ...pendingDurabilityFailure(error), serverConfirmed: true, ...currentValue() };
    }
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    // A form may stage more work while IndexedDB is writing. Project that newest
    // intent rather than restoring the display captured at refresh start.
    projectionBlocked = projectCurrent();
    return { ok: true, serverConfirmed: true, durable: true, projectionBlocked,
      ...currentValue(), superseded: (Number(_versions[key]) || 0) > after };
  })();
  _chains[key] = run.then(() => {}, () => {});
  return run;
}

// A deletion receipt is already committed on the server. Adopt it without
// flushing unrelated drafts or asking another whole-ledger write to confirm it.
function acceptInvoiceDeletionSnapshot(receipt, identity, options = {}) {
  const keys = ["sps_invoices", "sps_estimates", "sps_schedule", "sps_maintenance_billing"];
  let captured, expected;
  try { captured = structuredClone(receipt); expected = structuredClone(options.expectedInvoice); } catch (_) {}
  const priors = keys.map(key => _chains[key] || Promise.resolve());
  const run = (async () => {
    try { await Promise.all(priors); } catch (_) {}
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    const equal = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);
    const id = String(captured?.deletedInvoiceId || "");
    const validList = value => Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item));
    const invalid = () => ({ ok: false, error: new Error("The complete invoice deletion receipt could not be verified. Retry to check the same deletion.") });
    if (captured?.success !== true || captured.complete !== true || captured.actorId !== identity.uid
      || !id || String(expected?.id || "") !== id || String(captured.beforeInvoice?.id || "") !== id
      || !invoiceDeletionReviewMatches(expected, captured.beforeInvoice)
      || String(captured.qbId || "") !== String(expected.qbId || "")
      || keys.some(key => !Number.isSafeInteger(captured.beforeVersions?.[key]) || captured.beforeVersions[key] < 0
        || !Number.isSafeInteger(captured.versions?.[key]) || captured.versions[key] < captured.beforeVersions[key])
      || !validList(captured.values?.sps_invoices) || !validList(captured.values?.sps_estimates) || !validList(captured.values?.sps_schedule)
      || !captured.values?.sps_maintenance_billing || typeof captured.values.sps_maintenance_billing !== "object"
      || Array.isArray(captured.values.sps_maintenance_billing)
      || captured.values.sps_invoices.some(invoice => String(invoice.id || "") === id || (captured.qbId && String(invoice.qbId || "") === captured.qbId))
      || new Set(captured.values.sps_invoices.map(invoice => invoice.id)).size !== captured.values.sps_invoices.length) return invalid();
    const hydration = await ensureHydrate();
    if (!hydration?.ok) return { ...pendingDurabilityFailure(hydration?.error), serverConfirmed: true };
    try { await awaitPendingDurability(); } catch (error) { return { ...pendingDurabilityFailure(error), serverConfirmed: true }; }
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    // Check every section before advancing any confirmed value. A late receipt
    // never replaces a newer local confirmation learned through realtime.
    for (const key of keys) {
      if (Number(_versions[key]) === captured.versions[key] && _exists[key]) {
        try { if (!equal(JSON.parse(_confirmed[key]), captured.values[key])) return invalid(); } catch (_) { return invalid(); }
      }
    }
    const strip = (key, value) => {
      if (key === "sps_invoices") return value.filter(invoice => String(invoice?.id || "") !== id);
      if (key === "sps_estimates") return unlinkInvoiceDeletionReferences(expected, value, []).estimates;
      if (key === "sps_schedule") return unlinkInvoiceDeletionReferences(expected, [], value).schedule;
      return unlinkUnpaidInvoiceCoverage(expected, value) || value;
    };
    _confirmedInvoiceDeletions.add(id);
    let recoveryPending = false;
    for (const key of keys) {
      if ((Number(_versions[key]) || 0) <= captured.versions[key]) {
        adoptRemote(key, { exists: true, value: JSON.stringify(captured.values[key]), version: captured.versions[key] }, !_pending[key]);
      }
      const pending = _pending[key];
      if (!pending) continue;
      let next = pending;
      try {
        if (pending.v !== 2 || pending.force || pending.deleteIntent) throw new Error("Original intent unavailable");
        const base = JSON.parse(pending.baseExists ? pending.baseValue : key === "sps_maintenance_billing" ? "{}" : "[]");
        const local = JSON.parse(pending.localValue);
        const target = key === "sps_invoices" && local.find(invoice => String(invoice?.id || "") === id);
        if (target && !invoiceDeletionReviewMatches(expected, target)) throw new Error("Newer invoice edits remain");
        const nextBase = strip(key, base), nextLocal = strip(key, local);
        // Retire only exact target paths. Do not clear an ambiguous prefix
        // which could also describe another record with a dot in its id.
        const prefixes = [`$.id:${id}`, ...(expected.qbId ? [`$.qb:${expected.qbId}`] : [])];
        const safe = key === "sps_invoices" ? prefixes.filter(prefix => [...base, ...local].every(invoice => String(invoice?.id || "") === id
          || [`$.id:${invoice?.id || ""}`, `$.qb:${invoice?.qbId || ""}`].every(other => other !== prefix && !other.startsWith(`${prefix}.`) && !other.startsWith(`${prefix}[`)))) : [];
        const conflicts = (pending.conflicts || []).filter(item => !safe.some(prefix => item.path === prefix || item.path?.startsWith(`${prefix}.`) || item.path?.startsWith(`${prefix}[`)));
        next = { ...pending, opId: newOpId(), baseValue: JSON.stringify(nextBase), localValue: JSON.stringify(nextLocal),
          ...(pending.invoiceProjectionBaseValue ? { invoiceProjectionBaseValue: JSON.stringify(strip(key, JSON.parse(pending.invoiceProjectionBaseValue))) } : {}),
          conflicts, status: conflicts.length ? "conflict" : "pending", updatedAt: Date.now() };
        if (equal(nextBase, nextLocal) && !conflicts.length) next = null;
      } catch (_) {
        recoveryPending = true;
        next = { ...pending, status: "conflict", retryAt: 0, retryCount: 0,
          ...(key === "sps_invoices" ? { confirmedDeletedInvoiceIds: [...new Set([...(pending.confirmedDeletedInvoiceIds || []), id])] } : {}),
          conflicts: [...(pending.conflicts || []), { path: `$.id:${id}`, kind: "deleted-invoice-local-work" }] };
      }
      if (next) {
        _pending[key] = next;
        if (next.status === "conflict" || next.status === "legacy") _conflicts[key] = next;
        else delete _conflicts[key];
      } else { delete _pending[key]; delete _conflicts[key]; }
    }
    _invoiceReceiptVersion = Math.max(_invoiceReceiptVersion, captured.versions.sps_invoices);
    const project = () => {
      const values = {}, confirmedValues = {};
      for (const key of keys) {
        const pending = _pending[key];
        const remote = _confirmed[key];
        let displayed = remote;
        if (pending) displayed = key === "sps_invoices" ? (projectInvoicePending(pending, remote) ?? remote)
          : pending.v === 2 && !pending.force && !pending.deleteIntent
            ? mergeStoredState(key, pending.baseExists ? pending.baseValue : undefined, pending.localValue, remote, { prefer: "local" }).value : remote;
        // Late local edits remain in the durable envelope but cannot resurrect
        // the removed record or its old backlinks in the visible list.
        values[key] = strip(key, JSON.parse(displayed));
        confirmedValues[key] = JSON.parse(remote);
        _cache[key] = JSON.stringify(values[key]); _cacheAt[key] = Date.now();
      }
      return { values, confirmedValues, parsedValue: values.sps_invoices, versions: Object.fromEntries(keys.map(key => [key, _versions[key]])) };
    };
    project(); recalculateRetryWindow();
    const durable = await persistPending();
    if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
    if (!durable?.durable) return { ...pendingDurabilityFailure(durable?.error), serverConfirmed: true, ...project() };
    try {
      await saveSnapshot();
      const saved = await idb.getVerified(snapshotIdbKey(identity.uid));
      if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
      if (saved?.uid !== identity.uid || keys.some(key => !Number.isSafeInteger(saved.versions?.[key]) || saved.versions[key] < captured.versions[key])) throw new Error("The deletion receipt was not saved on this device");
    } catch (error) {
      if (!isCurrentIdentity(identity)) return { ok: false, staleIdentity: true };
      return { ...pendingDurabilityFailure(error), serverConfirmed: true, ...project() };
    }
    recoveryPending ||= (_pending.sps_invoices?.confirmedDeletedInvoiceIds || []).includes(id);
    return { ok: true, serverConfirmed: true, durable: true, recoveryPending, ...project() };
  })();
  const tail = run.then(() => {}, () => {}); keys.forEach(key => { _chains[key] = tail; });
  return run;
}

export const store = {
  captureIdentity() { return { uid: _uid, generation: _identityVersion }; },
  isCurrentIdentity,
  acceptCreatedClient,
  patchClient,
  acceptInvoiceReviewResolution,
  acceptInvoiceRefreshSnapshot,
  acceptInvoiceDeletionSnapshot,
  // Display-only overlay; neither stages nor resolves the original durable local intent.
  projectDisplay(key, displayedValue, remoteValue) {
    return key === "sps_invoices" ? projectInvoiceDisplay(displayedValue, remoteValue)
      : projectAcceptedReports(key, displayedValue, remoteValue);
  },
  setUser(uid) {
    const nextUid = uid || null;
    if (nextUid === _uid) return;
    resetForIdentity();
    _uid = nextUid;
    notify("identity", "Loading this account's shared data.");
    if (_uid) loadPendingFallback();
  },

  cacheReady() { return _cacheReadyState; },

  // Awaitable readiness contract for callers that must not mutate or refresh shared state until
  // the complete initial snapshot has been confirmed. Cache-first reads should continue using get().
  initialize() { return init(); },

  async get(key) {
    await ensureHydrate();
    init();
    const value = _cache[key];
    return value !== undefined ? { value, version: Number(_versions[key]) || 0 } : null;
  },

  // Pull one shared section again without reloading the app. Reads are serialized with writes for
  // the same key and never replace an optimistic/pending value, so foreground and realtime refreshes
  // cannot erase an in-progress edit.
  refresh(key) {
    if (!key || typeof key !== "string") return Promise.resolve({ ok: false, error: new Error("A storage key is required") });
    return enqueueRefresh(key, _identityVersion);
  },

  // Efficient fallback sync for groups of large shared records. One version-only query determines
  // which rows need the existing full, dirty-aware refresh path.
  refreshChanged(keys, options = {}) {
    return refreshChangedKeys(keys, options, _identityVersion);
  },

  async set(key, value, options = {}) {
    const identityVersion = _identityVersion;
    if (_pendingHydratedIdentity !== identityVersion) {
      const recovered = await ensureHydrate();
      if (!recovered?.ok) return pendingDurabilityFailure(recovered?.error);
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
      // Finish the recovered intent before staging a form entered from an older screen. Its
      // submitted base then merges the new change with the recovered server value instead of
      // replacing the old offline edit in the account's pending envelope.
      if (_pending[key]) _hydrationHeldKeys.add(key);
    }
    if (_hydrationHeldKeys.has(key)) {
      if (_pending[key]) {
        const prior = await enqueueCommit(key, identityVersion);
        // A held section already saved everything but its overlap, and new edits rebase onto it.
        if (!prior?.ok && !(prior?.conflict && _pending[key]?.heldConflicts)) return prior;
      }
      _hydrationHeldKeys.delete(key);
    }
    stagePending(key, value, options);
    return enqueueCommit(key, identityVersion);
  },

  async flush() { return flush(); },

  async flushKey(key) { return flushKey(key); },

  listConflicts() {
    return Object.keys(_conflicts).map((key) => ({ key, conflicts: _conflicts[key].conflicts || [] }));
  },

  async resolveConflict(key, strategy) {
    const identityVersion = _identityVersion;
    const prior = _chains[key] || Promise.resolve();
    const run = (async () => {
      try { await prior; } catch (_) {}
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
      return resolveConflict(key, strategy, identityVersion);
    })();
    _chains[key] = run.then(() => {}, () => {});
    return run;
  },

  replaceMany(changes, options) { return replaceMany(changes, options); },

  async remove(key, options = {}) {
    const identityVersion = _identityVersion;
    if (_pendingHydratedIdentity !== identityVersion) {
      const recovered = await ensureHydrate();
      if (!recovered?.ok) return pendingDurabilityFailure(recovered?.error);
      if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    }
    stageDelete(key, options);
    return enqueueCommit(key, identityVersion);
  },

  async clearCache() {
    const priorUid = _uid;
    resetForIdentity();
    _uid = null;
    notify("identity", "Signed out.");
    try {
      const run = _snapshotPersistTail.then(async () => {
        if (priorUid) await idb.del(snapshotIdbKey(priorUid));
        const legacySnap = await idb.get(SNAP_KEY);
        if (legacySnap && legacySnap.uid === priorUid) await idb.del(SNAP_KEY);
      });
      _snapshotPersistTail = run.then(() => {}, () => {});
      await run;
    } catch (_) {}
  },

  reset() {
    const pending = { ..._pending };
    _cache = {};
    _confirmed = {};
    _versions = {};
    _exists = {};
    _loaded = false;
    _initialReadConfirmed = false;
    _loadPromise = null;
    _initRetryCount = 0;
    _initRetryAt = 0;
    _initLastError = null;
    _ensureHydratePromise = null;
    _cacheReadyState = { ready: false, hasData: false };
    clearObject(_cacheAt);
    for (const key of Object.keys(pending)) {
      const value = pendingDisplayValue(pending[key]);
      if (value !== undefined) _cache[key] = value;
    }
  },
};
