import { createClient } from "@supabase/supabase-js";
import { idb } from "./idbStore";

const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // Keep the signed-in session alive across app launches + auto-refresh the token, so
  // long-running native sessions don't lapse to the anon role (which RLS blocks on writes).
  auth: { persistSession: true, autoRefreshToken: true },
});

let _cache = {};
let _loaded = false;
let _loadPromise = null;
let _lastErrorAt = 0;
// Per-key wall-clock of the last LOCAL write into _cache. A background _init() SELECT that was ISSUED
// before a local write must NOT overwrite that key with its now-stale row on arrival (the boot-window
// clobber that made freshly-added products / completed stops revert). Compared against _initSelectAt.
const _cacheAt = {};
let _initSelectAt = 0;

// Durable pending-write queue. A write that fails ALL its retries is kept here (and mirrored to
// localStorage) so it survives a reload/app-close and is re-attempted the moment the connection
// comes back — instead of being silently lost. Keyed by app_state key; last write per key wins.
const PENDING_KEY = "sps_pending_writes";
let _pending = {};
let _flushing = false;
// Per-key in-flight write chain. set(key) waits for the previous set of the SAME key before issuing
// its upsert, so a slow/failed earlier write can never physically land AFTER a newer one (last-issued
// wins). Different keys still write concurrently.
const _chains = {};

// ── Offline-first READ cache (fast boot) ───────────────────────────────────────────────────────
// A local IndexedDB snapshot of app_state lets the app paint from last-known-good INSTANTLY instead
// of waiting on the network SELECT of every key (dominated by the multi-MB sps_clients). Supabase
// stays the source of truth; the durable write QUEUE above is unchanged; writes still wait for a
// confirmed network read (DB_READ_OK). The snapshot is namespaced by signed-in user id so a shared
// device never serves another account's data, and every IDB op degrades to a no-op (idbStore) so
// this can never throw into the storage path — on failure we just fall back to network-first.
let _uid = null;
const SNAP_KEY = "snapshot";
let _cacheReadyState = { ready: false, hasData: false };
let _ensureHydratePromise = null;

function _notifyCache(hasData) {
  _cacheReadyState = { ready: true, hasData: !!hasData };
  try { document.dispatchEvent(new CustomEvent("sps-cache-ready", { detail: { hasData: !!hasData } })); } catch {}
}

// Pull the last saved snapshot into _cache, filling ONLY keys we don't already hold (the durable
// pending queue, primed synchronously at module load, always wins). Serves ONLY a snapshot stamped
// with the CURRENT uid — never cross-account; if uid is unknown we stay network-first.
async function _hydrateFromIDB() {
  try {
    if (!_uid) return;
    const snap = await idb.get(SNAP_KEY);
    if (!snap || snap.uid !== _uid || !snap.data) return;
    for (const k in snap.data) {
      if (Object.prototype.hasOwnProperty.call(snap.data, k) && _cache[k] === undefined) _cache[k] = snap.data[k];
    }
  } catch (_) {}
}

function _ensureHydrate() {
  if (_ensureHydratePromise) return _ensureHydratePromise;
  _ensureHydratePromise = _hydrateFromIDB().then(() => { _notifyCache(Object.keys(_cache).length > 0); });
  return _ensureHydratePromise;
}

// Persist the current _cache as the snapshot for the next cold boot (uid-stamped, fire-and-forget,
// off the hot path). Pending values are part of _cache, so an offline optimistic edit is captured too.
function _saveSnapshot() {
  try { if (_uid) idb.set(SNAP_KEY, { uid: _uid, at: Date.now(), data: { ..._cache } }); } catch (_) {}
}

function _loadPending() {
  try { const raw = localStorage.getItem(PENDING_KEY); if (raw) _pending = JSON.parse(raw) || {}; } catch (_) { _pending = {}; }
  // A pending write is the freshest value we have for that key — serve it from cache too, so a
  // reload shows the edit (not the stale DB row) while the retry is still in flight.
  for (const k in _pending) { if (Object.prototype.hasOwnProperty.call(_pending, k)) _cache[k] = _pending[k]; }
}
function _savePending() {
  try {
    if (Object.keys(_pending).length) localStorage.setItem(PENDING_KEY, JSON.stringify(_pending));
    else localStorage.removeItem(PENDING_KEY);
  } catch (e) {
    // localStorage full / private mode → the durable mirror is lost (in-session retry still works).
    console.warn("store: could not persist pending-write queue (durability across reload lost):", e && e.message);
  }
}
_loadPending();

function _notify(type, msg) {
  try { document.dispatchEvent(new CustomEvent("sps-db-status", { detail: { type, msg } })); } catch {}
}

function _throttledError(msg) {
  const now = Date.now();
  if (now - _lastErrorAt > 10000) { _lastErrorAt = now; _notify("error", msg); }
}

// One upsert, up to 3 attempts: a cellular blip self-heals, and an expired token is refreshed
// (writes were silently going out as the anon role → RLS rejects them) before retrying.
// Returns { ok, error, recovered } — recovered=true means it failed once then succeeded.
async function _upsert(key, value) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.from("app_state").upsert({ key, value, updated_at: new Date().toISOString() });
    if (!error) return { ok: true, recovered: attempt > 0 };
    lastErr = error;
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("jwt") || msg.includes("token") || msg.includes("expired") || msg.includes("session")) {
      try { await supabase.auth.refreshSession(); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  return { ok: false, error: lastErr };
}

// Re-attempt every queued write. Called on reconnect (_init success), after any successful save,
// and explicitly before a reload (store.flush). Single-flight so overlapping triggers don't pile up.
async function _flush() {
  if (_flushing) return;
  if (!Object.keys(_pending).length) return;
  _flushing = true;
  try {
    // Re-check _pending each pass so a key queued WHILE we were flushing is picked up too (not left
    // waiting for the next external trigger). Bounded guard so a persistent failure can't spin.
    let guard = 0;
    while (Object.keys(_pending).length && guard++ < 100) {
      let progressed = false;
      for (const key of Object.keys(_pending)) {
        const value = _pending[key];
        if (value === undefined) continue;
        const res = await _upsert(key, value);
        if (res.ok) { if (_pending[key] === value) delete _pending[key]; progressed = true; }  // keep a newer queued value
        else { _savePending(); return; } // still failing — stop and wait for the next reconnect
      }
      if (!progressed) break;
    }
    _savePending();
    if (Object.keys(_pending).length === 0) _notify("ok", "Saved");
  } finally { _flushing = false; }
}

async function _init() {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  _initSelectAt = Date.now();   // stamp when this SELECT is issued, so its (soon-stale) result can't overwrite a LOCAL write made after it
  _loadPromise = supabase.from("app_state").select("key, value").then(({ data, error }) => {
    if (error) { console.error("store.init failed:", error.message); _notify("error", "Cannot reach the database."); }
    // Don't let the DB row overwrite a key that still has a pending (not-yet-saved) write, OR a key
    // written LOCALLY after this SELECT was issued (its row is stale — the boot-window clobber).
    else {
      if (data) data.forEach(row => { if (_pending[row.key] === undefined && !(_cacheAt[row.key] > _initSelectAt)) _cache[row.key] = row.value; });
      _notify("ok", "Connected"); _flush();
      _saveSnapshot();   // refresh the cold-boot snapshot with confirmed data
      // Tell cache-first screens fresh values landed so they can reconcile CLEAN keys (App.jsx skips
      // any key with an unsaved local edit — never clobbers an in-progress change).
      try { document.dispatchEvent(new CustomEvent("sps-reconciled")); } catch {}
    }
    _loaded = true;
  }).catch((e) => { try { console.error("store.init error:", e && e.message); } catch (_) {} _loaded = true; });
  return _loadPromise;
}

// The actual write. Wrapped by store.set so calls for the same key run in issue order.
async function _doSet(key, value) {
  _cache[key] = value; _cacheAt[key] = Date.now();   // optimistic + stamp the write time (fences a stale in-flight _init)
  const res = await _upsert(key, value);
  if (res.ok) {
    if (res.recovered) _notify("ok", "Saved");
    if (_pending[key] !== undefined) { delete _pending[key]; _savePending(); }
    if (Object.keys(_pending).length) _flush();   // a save just landed → drain the rest of the queue
    return { ok: true };
  }
  // Failed every retry → queue it durably (survives reload) and surface the REAL reason
  // (e.g. "new row violates row-level security policy") so a misconfig is obvious, not a mystery.
  _pending[key] = value; _savePending();
  console.error("store.set failed (queued for retry):", key, res.error && res.error.message);
  _throttledError(`Save failed: ${(res.error && res.error.message) || "your changes aren't syncing — retrying."}`);
  return { ok: false, error: res.error };
}

export const store = {
  // Namespace the read cache to the signed-in user. MUST be called (from main.jsx, right after auth
  // resolves) BEFORE the first get(), so a snapshot is only ever served to the account that wrote it.
  setUser(uid) { _uid = uid || null; },
  // Has the local snapshot finished hydrating, and did it actually contain data? The boot splash uses
  // this to lift early ONLY when there's real cached data to show (never blank-then-wrong).
  cacheReady() { return _cacheReadyState; },
  // Cache-first read: serve the local snapshot instantly, kick the network read in the BACKGROUND
  // (not awaited) so first paint doesn't wait on the multi-MB app_state SELECT. The network result
  // reconciles in via the 'sps-reconciled' event; writes still wait for DB_READ_OK as before.
  async get(key) {
    await _ensureHydrate();
    _init();
    const val = _cache[key];
    return val !== undefined ? { value: val } : null;
  },
  // Returns { ok: true } on a confirmed save, or { ok: false, error } when the write could not be
  // persisted (it's been queued for durable retry). Callers MUST NOT treat a save as landed until ok.
  // Serialized per key: this set waits for the previous set of the SAME key, so an older write can
  // never physically land after a newer one (the concurrent-write stale-overwrite race).
  set(key, value) {
    const prior = _chains[key] || Promise.resolve();
    const run = (async () => { try { await prior; } catch (_) {} return _doSet(key, value); })();
    _chains[key] = run.then(() => {}, () => {});   // chain tail (never rejects)
    return run;
  },
  // Drain any queued failed writes now (e.g. on reconnect or just before a reload).
  async flush() { return _flush(); },
  async remove(key) {
    delete _cache[key];
    if (_pending[key] !== undefined) { delete _pending[key]; _savePending(); }  // don't resurrect a removed key
    _saveSnapshot();  // and don't let the snapshot resurrect it on the next cold boot
    await supabase.from("app_state").delete().eq("key", key);
    return { ok: true };
  },
  // Wipe the on-disk snapshot (e.g. on sign-out, so a shared device never serves the prior account's
  // cached data). Leaves the durable pending QUEUE intact — unflushed writes are still owed.
  async clearCache() { _cacheReadyState = { ready: false, hasData: false }; _ensureHydratePromise = null; try { await idb.del(SNAP_KEY); } catch (_) {} },
  reset() { _cache = {}; _loaded = false; _loadPromise = null; _ensureHydratePromise = null; _cacheReadyState = { ready: false, hasData: false }; },
};
