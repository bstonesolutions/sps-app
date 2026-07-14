import { createClient } from "@supabase/supabase-js";
import { idb } from "./idbStore.js";
import { describeStateConflicts, mergeStoredState, normalizeStoredValue } from "./stateMerge.js";

const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const SNAP_KEY = "snapshot";
const PENDING_KEY = "sps_pending_writes";
const MAX_CAS_ATTEMPTS = 6;

let _uid = null;
let _identityVersion = 0;
let _cache = {};       // optimistic values displayed by the app
let _confirmed = {};   // last values confirmed by Supabase
let _versions = {};    // database-controlled version for each confirmed value
let _exists = {};
let _pending = {};     // durable three-way-merge intents
let _conflicts = {};
let _loaded = false;
let _initialReadConfirmed = false;
let _loadPromise = null;
let _flushing = false;
let _ensureHydratePromise = null;
let _pendingPersistTail = Promise.resolve();
let _snapshotPersistTail = Promise.resolve();
let _lastErrorAt = 0;
let _initSelectAt = 0;
let _cacheReadyState = { ready: false, hasData: false };
const _cacheAt = {};
const _chains = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const sameStored = (a, b) => a === b;
const pendingIdbKey = (uid = _uid) => (uid ? `pending-v2:${uid}` : "");
const pendingStorageKey = (uid = _uid) => (uid ? `${PENDING_KEY}:${uid}` : "");
const snapshotIdbKey = (uid = _uid) => (uid ? `snapshot-v2:${uid}` : SNAP_KEY);
const newOpId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function clearObject(obj) {
  for (const key of Object.keys(obj)) delete obj[key];
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
  return (conflicts || []).map((item) => ({ path: item.path, kind: item.kind }));
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

function mergePendingSources(source) {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(source)) {
    const incoming = normalizeEnvelope(source[key]);
    if (!incoming) continue;
    const current = _pending[key];
    if (!current || Number(incoming.updatedAt || 0) >= Number(current.updatedAt || 0)) _pending[key] = incoming;
  }
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
  if (!uid) return;
  const storageKey = pendingStorageKey(uid);
  try {
    if (Object.keys(data).length) localStorage.setItem(storageKey, JSON.stringify(data));
    else localStorage.removeItem(storageKey);
  } catch (error) {
    // Large client files can exceed localStorage. IndexedDB below remains the primary durable copy.
    try { console.warn("store: local pending-write fallback unavailable:", error && error.message); } catch (_) {}
  }
  try {
    const key = pendingIdbKey(uid);
    if (!key) return;
    if (Object.keys(data).length) await idb.set(key, { uid, at: Date.now(), data });
    else await idb.del(key);
  } catch (_) {}
}

function persistPending() {
  // Capture both account and value now. A sign-out during this write must still preserve the old
  // account's intent, never write it under the next signed-in account, and never drop it.
  const uid = _uid;
  const data = { ..._pending };
  const run = _pendingPersistTail.then(
    () => writePendingSnapshot(uid, data),
    () => writePendingSnapshot(uid, data)
  );
  _pendingPersistTail = run.then(() => {}, () => {});
  return run;
}

async function awaitPendingDurability() {
  // If another local edit is staged while the current IndexedDB write is completing, wait for that
  // newer envelope too. The network must never get ahead of the durable intent it is committing.
  let observed;
  do {
    observed = _pendingPersistTail;
    await observed;
  } while (observed !== _pendingPersistTail);
}

function notifyCache(hasData) {
  _cacheReadyState = { ready: true, hasData: !!hasData };
  try { document.dispatchEvent(new CustomEvent("sps-cache-ready", { detail: { hasData: !!hasData } })); } catch (_) {}
}

async function hydrateFromIDB() {
  try {
    if (!_uid) return;
    const identityVersion = _identityVersion;
    const [scopedSnap, pendingSnap] = await Promise.all([idb.get(snapshotIdbKey()), idb.get(pendingIdbKey())]);
    if (identityVersion !== _identityVersion || !_uid) return;
    const legacySnap = await idb.get(SNAP_KEY);
    let snap = scopedSnap;
    if (!snap) {
      if (legacySnap && legacySnap.uid === _uid) {
        snap = legacySnap;
        try { await idb.set(snapshotIdbKey(), legacySnap); } catch (_) {}
      }
    }
    if (identityVersion !== _identityVersion || !_uid) return;
    if (snap && snap.uid === _uid && snap.data) {
      for (const key of Object.keys(snap.data)) {
        const value = normalizeStoredValue(snap.data[key]);
        if (value === undefined) continue;
        if (!hasOwn(_confirmed, key)) _confirmed[key] = value;
        if (!hasOwn(_cache, key)) _cache[key] = value;
        if (snap.versions && Number(snap.versions[key]) > 0) {
          _versions[key] = Number(snap.versions[key]);
          _exists[key] = true;
        }
      }
    }
    if (pendingSnap && pendingSnap.uid === _uid) mergePendingSources(pendingSnap.data);
    // One-time safe migration from the old global queue: only the UID stamped on the matching
    // legacy snapshot may claim it, and only when neither scoped storage source has a newer queue.
    // Without that ownership evidence it remains quarantined and is never displayed or replayed.
    if (legacySnap && legacySnap.uid === _uid && Object.keys(_pending).length === 0) {
      try {
        const legacyRaw = localStorage.getItem(PENDING_KEY);
        if (legacyRaw) {
          mergePendingSources(JSON.parse(legacyRaw));
          localStorage.removeItem(PENDING_KEY);
          await persistPending();
          await idb.del(SNAP_KEY);
        }
      } catch (_) {}
    }
    for (const key of Object.keys(_pending)) {
      const value = pendingDisplayValue(_pending[key]);
      if (_pending[key].deleteIntent && _pending[key].status !== "conflict") delete _cache[key];
      else if (_pending[key].deleteIntent && hasOwn(_confirmed, key)) _cache[key] = _confirmed[key];
      else if (value !== undefined) _cache[key] = value;
      if (_pending[key].status === "conflict" || _pending[key].status === "legacy") {
        _conflicts[key] = _pending[key];
        notifyConflict(key, _pending[key].conflicts || [{ path: "$", kind: "legacy-base-unknown" }]);
      }
    }
  } catch (_) {}
}

function ensureHydrate() {
  if (_ensureHydratePromise) return _ensureHydratePromise;
  const identityVersion = _identityVersion;
  _ensureHydratePromise = hydrateFromIDB().then(() => {
    if (identityVersion === _identityVersion && _uid) notifyCache(Object.keys(_cache).length > 0);
  });
  return _ensureHydratePromise;
}

function saveSnapshot() {
  const uid = _uid;
  if (!uid) return _snapshotPersistTail;
  const snap = { uid, at: Date.now(), data: { ..._confirmed }, versions: { ..._versions } };
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
  _exists = {};
  _pending = {};
  _conflicts = {};
  _loaded = false;
  _initialReadConfirmed = false;
  _loadPromise = null;
  _flushing = false;
  _ensureHydratePromise = null;
  _cacheReadyState = { ready: false, hasData: false };
  _initSelectAt = 0;
  clearObject(_cacheAt);
  clearObject(_chains);
}

function isAuthError(error) {
  return /jwt|token|expired|session/i.test((error && error.message) || "");
}

async function refreshForAuthError(error) {
  if (!isAuthError(error)) return;
  try { await supabase.auth.refreshSession(); } catch (_) {}
}

async function readRemote(key, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.from("app_state")
      .select("key, value, version, updated_at")
      .eq("key", key)
      .maybeSingle();
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      if (!data) return { ok: true, exists: false, value: undefined, version: 0 };
      return {
        ok: true,
        exists: true,
        value: normalizeStoredValue(data.value),
        version: Number(data.version) || 0,
        updatedAt: data.updated_at || null,
      };
    }
    lastError = error;
    await refreshForAuthError(error);
    if (attempt < 2) await sleep(300 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

async function readRemoteVersions(keys, identityVersion = _identityVersion) {
  const safeKeys = Array.from(new Set((keys || []).filter((key) => typeof key === "string" && key)));
  if (!safeKeys.length) return { ok: true, versions: new Map() };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.from("app_state")
      .select("key, version")
      .in("key", safeKeys);
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      return {
        ok: true,
        versions: new Map((data || []).map((row) => [row.key, Number(row.version) || 0])),
      };
    }
    lastError = error;
    await refreshForAuthError(error);
    if (attempt < 2) await sleep(300 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function compareAndSwap(key, expectedVersion, value, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc("sps_app_state_cas", {
      p_key: key,
      p_expected_version: expectedVersion,
      p_value: value,
    });
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      const row = rpcRow(data) || {};
      return {
        ok: true,
        applied: row.applied === true,
        outcome: row.outcome || (row.applied ? "updated" : "conflict"),
        version: row.current_version == null ? 0 : Number(row.current_version),
        updatedAt: row.changed_at || null,
      };
    }
    lastError = error;
    await refreshForAuthError(error);
    if (attempt < 2) await sleep(350 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

async function compareAndDelete(key, expectedVersion, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc("sps_app_state_delete_cas", {
      p_key: key,
      p_expected_version: expectedVersion,
    });
    if (identityVersion !== _identityVersion || !_uid) return { staleIdentity: true };
    if (!error) {
      const row = rpcRow(data) || {};
      return { ok: true, applied: row.applied === true, outcome: row.outcome || "conflict", version: Number(row.current_version) || 0 };
    }
    lastError = error;
    await refreshForAuthError(error);
    if (attempt < 2) await sleep(350 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

async function compareAndSwapBatch(operations, identityVersion = _identityVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc("sps_app_state_batch_cas", {
      p_operations: operations.map((operation) => ({
        key: operation.key,
        expected_version: operation.expectedVersion,
        value: operation.value,
      })),
    });
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
    await refreshForAuthError(error);
    if (attempt < 2) await sleep(350 * (attempt + 1));
  }
  return { ok: false, error: lastError };
}

function adoptRemote(key, remote, updateDisplay = true) {
  if (remote.exists) {
    _confirmed[key] = remote.value;
    _versions[key] = remote.version;
    _exists[key] = true;
    if (updateDisplay) _cache[key] = remote.value;
  } else {
    delete _confirmed[key];
    _versions[key] = 0;
    _exists[key] = false;
    if (updateDisplay) delete _cache[key];
  }
}

async function init() {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  const identityVersion = _identityVersion;
  _initSelectAt = Date.now();
  _loadPromise = (async () => {
    try {
      const { data, error } = await supabase.from("app_state").select("key, value, version");
      if (identityVersion !== _identityVersion || !_uid) return;
      if (error) {
        console.error("store.init failed:", error.message);
        const denied = /row.level security|permission denied|not authorized|insufficient privilege/i.test(error.message || "");
        if (denied) notify("restricted", "Using scoped account access.");
        else notify("error", "Cannot reach the database.");
        return;
      }
      if (!data || data.length === 0) {
        const deletedKeys = Object.keys(_confirmed).filter((key) => !_pending[key]);
        _confirmed = {};
        _versions = {};
        _exists = {};
        deletedKeys.forEach((key) => { delete _cache[key]; notifyReconciled(key, true); });
        saveSnapshot();
        notify("restricted", "Using scoped account access.");
        return;
      }
      const remoteKeys = new Set(data.map((row) => row.key));
      const deletedKeys = [];
      for (const key of Object.keys(_confirmed)) {
        if (remoteKeys.has(key)) continue;
        delete _confirmed[key];
        _versions[key] = 0;
        _exists[key] = false;
        if (!_pending[key]) {
          delete _cache[key];
          deletedKeys.push(key);
        }
      }
      for (const row of data) {
        const value = normalizeStoredValue(row.value);
        if (value === undefined) continue;
        _confirmed[row.key] = value;
        _versions[row.key] = Number(row.version) || 0;
        _exists[row.key] = true;
        const pending = _pending[row.key];
        if (pending && pending.deleteIntent && pending.status === "conflict") _cache[row.key] = value;
        else if (!pending && !(_cacheAt[row.key] > _initSelectAt)) _cache[row.key] = value;
      }
      _initialReadConfirmed = true;
      notify("read-ok", "Connected");
      saveSnapshot();
      notifyReconciled();
      deletedKeys.forEach((key) => notifyReconciled(key, true));
      flush();
    } catch (error) {
      if (identityVersion !== _identityVersion || !_uid) return;
      try { console.error("store.init error:", error && error.message); } catch (_) {}
      notify("error", "Cannot reach the database.");
    } finally {
      if (identityVersion === _identityVersion) _loaded = true;
    }
  })();
  return _loadPromise;
}

function stagePending(key, value, options = {}) {
  const localValue = normalizeStoredValue(value);
  if (localValue === undefined) throw new Error("store.set requires a JSON value");
  const now = Date.now();
  const existing = _pending[key];
  let envelope;
  if (existing && existing.v !== 2) {
    // A pre-versioning queue item has no trustworthy merge base. Preserve it as a visible conflict
    // even if the user makes another edit; silently upgrading it would discard part of that work.
    envelope = { ...existing, opId: newOpId(), localValue, status: "legacy", updatedAt: now };
  } else if (existing && existing.v === 2) {
    envelope = {
      ...existing,
      opId: newOpId(),
      localValue,
      deleteIntent: false,
      // Force belongs only to this explicit restore/reset call. A failed destructive operation must
      // never make a later ordinary edit inherit whole-value overwrite behavior.
      force: !!options.force,
      forceExpectedVersion: options.force && hasOwn(options, "expectedVersion")
        ? Math.max(0, Number(options.expectedVersion) || 0)
        : null,
      status: existing.status === "conflict" && !options.force ? "conflict" : "pending",
      conflicts: existing.status === "conflict" && !options.force ? existing.conflicts : [],
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
  _pending[key] = envelope;
  if (envelope.status === "conflict" || envelope.status === "legacy") _conflicts[key] = envelope;
  else delete _conflicts[key];
  _cache[key] = localValue;
  _cacheAt[key] = now;
  persistPending();
  return envelope;
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
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
  _pending[key] = envelope;
  delete _conflicts[key];
  delete _cache[key];
  _cacheAt[key] = now;
  persistPending();
  return envelope;
}

function setConflict(key, envelope, conflicts) {
  const safe = publicConflicts(conflicts);
  const next = { ...envelope, status: "conflict", conflicts: safe, updatedAt: Date.now() };
  _pending[key] = next;
  _conflicts[key] = next;
  if (next.deleteIntent) {
    if (hasOwn(_confirmed, key)) _cache[key] = _confirmed[key];
    else delete _cache[key];
  } else _cache[key] = next.localValue;
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
  if (newer.force) {
    return { ...newer, baseExists: true, baseValue: appliedValue, baseVersion: appliedVersion, status: "pending", conflicts: [] };
  }
  const rebased = mergeStoredState(key, completedEnvelope.localValue, newer.localValue, appliedValue, { prefer: "remote" });
  const next = {
    ...newer,
    baseExists: true,
    baseValue: appliedValue,
    baseVersion: appliedVersion,
    localValue: rebased.value,
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
  await persistPending();
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
  await persistPending();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  saveSnapshot();
  if (options.notify !== false && !hasNewerIntent) notifyReconciled(key, true);
  notify("save-ok", "Saved");
  return { ok: true, value: undefined, version: 0, deleted: true };
}

async function commitKey(key, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  await awaitPendingDurability();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  await ensureHydrate();
  await init();
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const envelope = _pending[key];
  if (!envelope) return { ok: true, value: _confirmed[key], version: Number(_versions[key]) || 0 };
  if (envelope.status === "conflict") return { ok: false, conflict: true, key, conflicts: envelope.conflicts || [] };

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
    if (merged.conflicts.length) return setConflict(key, envelope, merged.conflicts);
    const candidate = normalizeStoredValue(merged.value);
    if (candidate === undefined) return finishDeleted(key, envelope, identityVersion);
    if (remote.exists && sameStored(candidate, remote.value)) {
      return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
    }

    const result = await compareAndSwap(key, remote.exists ? remote.version : 0, candidate, identityVersion);
    if (result.staleIdentity) return { ok: false, staleIdentity: true };
    if (!result.ok) return commitFailure(key, envelope, result.error);
    if (result.applied) return finishApplied(key, envelope, candidate, result.version, identityVersion);

    remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) return commitFailure(key, envelope, remote.error);
    adoptRemote(key, remote, false);
  }
  return commitFailure(key, envelope, new Error("Several people are saving this section at once. Retrying shortly."));
}

function queueFailure(key, error) {
  persistPending();
  try { console.error("store.set failed (kept for retry):", key, error && error.message); } catch (_) {}
  throttledError(`Save failed: ${(error && error.message) || "your changes aren't syncing — retrying."}`);
  return { ok: false, error };
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
  return queueFailure(key, error);
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
    await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };

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

    // A local edit may already be staged or committing. Update its confirmed merge target, but keep
    // the optimistic value on screen; the serialized CAS path will merge/rebase it safely. Replacing
    // _cache here would make a foreground/realtime pull erase work that has not landed yet.
    adoptRemote(key, remote, !_pending[key]);
    saveSnapshot();
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
    await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };

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
  if (_flushing || !Object.keys(_pending).some((key) => _pending[key] && _pending[key].status === "pending")) return;
  const identityVersion = _identityVersion;
  _flushing = true;
  try {
    for (const key of Object.keys(_pending)) {
      if (identityVersion !== _identityVersion || !_uid) return;
      if (!_pending[key] || _pending[key].status !== "pending") continue;
      await enqueueCommit(key, identityVersion);
    }
  } finally {
    if (identityVersion === _identityVersion) _flushing = false;
  }
}

async function resolveConflict(key, strategy, identityVersion = _identityVersion) {
  if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
  const envelope = _pending[key];
  if (!envelope) return { ok: true, value: _confirmed[key], version: Number(_versions[key]) || 0 };
  if (strategy !== "local" && strategy !== "remote") throw new Error("Unknown conflict resolution");

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = _pending[key];
    if (!current || current.opId !== envelope.opId) return { ok: false, superseded: true };
    const remote = await readRemote(key, identityVersion);
    if (remote.staleIdentity) return { ok: false, staleIdentity: true };
    if (!remote.ok) return queueFailure(key, remote.error);
    if (!_pending[key] || _pending[key].opId !== envelope.opId) return { ok: false, superseded: true };
    adoptRemote(key, remote, false);

    if (envelope.deleteIntent) {
      if (strategy === "remote" || !remote.exists) {
        if (!remote.exists) return finishDeleted(key, envelope, identityVersion);
        return finishApplied(key, envelope, remote.value, remote.version, identityVersion);
      }
      const deleted = await compareAndDelete(key, remote.version, identityVersion);
      if (deleted.staleIdentity) return { ok: false, staleIdentity: true };
      if (!deleted.ok) return queueFailure(key, deleted.error);
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
        return setConflict(key, envelope, fresh);
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
    if (!result.ok) return queueFailure(key, result.error);
    if (result.applied) return finishApplied(key, envelope, candidate, result.version, identityVersion);
  }
  return queueFailure(key, new Error("The shared version changed again. Please choose once more."));
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

function replaceMany(changes) {
  if (!Array.isArray(changes) || !changes.length) return Promise.resolve({ ok: false, error: new Error("No sections to replace") });
  const identityVersion = _identityVersion;
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
      return { key, value, expectedVersion };
    });
  } catch (error) { return Promise.resolve({ ok: false, error }); }

  const keys = operations.map((operation) => operation.key);
  const priors = keys.map((key) => _chains[key] || Promise.resolve());
  const run = (async () => {
    try { await Promise.all(priors); } catch (_) {}
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    await ensureHydrate();
    await init();
    if (identityVersion !== _identityVersion || !_uid) return { ok: false, staleIdentity: true };
    const blockedKey = keys.find((key) => _pending[key]);
    if (blockedKey) return { ok: false, conflict: true, conflictKey: blockedKey, error: new Error("A local edit is still pending") };

    let result = await compareAndSwapBatch(operations, identityVersion);
    if (result.staleIdentity) return { ok: false, staleIdentity: true };
    if (!result.ok || !result.applied) {
      // A response can be lost after PostgreSQL committed the whole transaction. Re-read every key;
      // if all exact values landed, treat it as success instead of inviting a duplicate restore.
      const verified = await verifyBatchValues(operations, identityVersion);
      if (verified.staleIdentity) return { ok: false, staleIdentity: true };
      if (!verified.matched) {
        if (!result.ok) throttledError(`Save failed: ${(result.error && result.error.message) || "the atomic replacement did not complete."}`);
        return { ok: false, conflict: !!result.ok, conflictKey: result.conflictKey || null, error: result.error };
      }
      result = { ok: true, applied: true, outcome: "already-applied", versions: verified.versions };
    }

    for (const operation of operations) {
      const key = operation.key;
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
        updatedAt: Date.now(),
      };
      _pending[key] = next;
      _cache[key] = next.localValue;
      if (next.status === "conflict") {
        _conflicts[key] = next;
        notifyConflict(key, next.conflicts);
      }
    }
    await persistPending();
    saveSnapshot();
    operations.forEach((operation) => { if (!_pending[operation.key]) notifyReconciled(operation.key, true); });
    notify("save-ok", "Saved");
    return { ok: true, atomic: true, versions: result.versions };
  })();

  const tail = run.then(() => {}, () => {});
  keys.forEach((key) => { _chains[key] = tail; });
  return run;
}

export const store = {
  setUser(uid) {
    const nextUid = uid || null;
    if (nextUid === _uid) return;
    resetForIdentity();
    _uid = nextUid;
    notify("identity", "Loading this account's shared data.");
    if (_uid) loadPendingFallback();
  },

  cacheReady() { return _cacheReadyState; },

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

  set(key, value, options = {}) {
    const identityVersion = _identityVersion;
    stagePending(key, value, options);
    return enqueueCommit(key, identityVersion);
  },

  async flush() { return flush(); },

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

  replaceMany(changes) { return replaceMany(changes); },

  async remove(key, options = {}) {
    const identityVersion = _identityVersion;
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
    _ensureHydratePromise = null;
    _cacheReadyState = { ready: false, hasData: false };
    clearObject(_cacheAt);
    for (const key of Object.keys(pending)) {
      const value = pendingDisplayValue(pending[key]);
      if (value !== undefined) _cache[key] = value;
    }
  },
};
