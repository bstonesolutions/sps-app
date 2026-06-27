// idbStore.js — tiny, dependency-free IndexedDB key/value helper for the offline-first cache.
//
// Used ONLY as a fast local CACHE under supabaseClient's store; Supabase's app_state table remains
// the single source of truth. Every operation DEGRADES TO A NO-OP on any failure (private mode,
// quota exceeded, blocked upgrade, WKWebView eviction) so it can NEVER throw into the storage path —
// if IndexedDB is unavailable the app simply falls back to today's network-first behavior.
//
// NOTE: this is NOT the durable write queue (that stays in supabaseClient.js). This is the read-side
// snapshot cache that lets the app paint instantly from last-known-good instead of waiting on the
// network SELECT of all of app_state. No business logic lives here.

const DB_NAME = "sps-cache";
const STORE = "kv";

let _dbPromise = null;
function _open() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); } catch (_) {}
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return _dbPromise;
}

function _run(mode, make) {
  return _open().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const os = tx.objectStore(STORE);
        let req = null;
        try { req = make(os); } catch (_) { req = null; }
        tx.oncomplete = () => { try { resolve(req ? req.result : null); } catch (_) { resolve(null); } };
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }).catch(() => null);
}

export const idb = {
  get(key)        { return _run("readonly",  (os) => os.get(key)); },
  set(key, value) { return _run("readwrite", (os) => os.put(value, key)); },
  del(key)        { return _run("readwrite", (os) => os.delete(key)); },
  clear()         { return _run("readwrite", (os) => os.clear()); },
  // Resolves true if IndexedDB is usable on this device/origin, false if we must fall back to network-first.
  available()     { return _open().then((db) => !!db).catch(() => false); },
};
