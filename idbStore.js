// IndexedDB cache and account-scoped pending-write storage. Cache operations
// degrade to null; pending cleanup uses getVerified so a failed read cannot be
// mistaken for a successfully deleted durable intent.
const DB_NAME = "sps-cache";
const STORE = "kv";
export const IDB_OPERATION_TIMEOUT_MS = 5_000;

export function createIndexedDbStore({
  getIndexedDB = () => globalThis.indexedDB,
  timeoutMs = IDB_OPERATION_TIMEOUT_MS,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let opening = null;
  let connection = null;
  const failed = (message, code = "IDB_UNAVAILABLE") => Object.assign(new Error(message), { code });
  function invalidate(db) {
    if (connection === db) { connection = null; opening = null; }
    if (db) { db.onclose = null; db.onversionchange = null; }
    try { db?.close(); } catch (_) {}
  }
  function open() {
    if (opening) return opening;
    let factory;
    try { factory = getIndexedDB(); } catch (error) { return Promise.reject(error); }
    if (!factory) return Promise.resolve(null);
    const pending = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => finish(failed("Device storage did not open in time.", "IDB_TIMEOUT")), timeoutMs);
      function finish(error, db) {
        if (settled) { if (db) invalidate(db); return; }
        settled = true; clearTimer(timer);
        if (error) { reject(error); return; }
        connection = db;
        db.onversionchange = () => invalidate(db);
        db.onclose = () => invalidate(db);
        resolve(db);
      }
      try {
        const req = factory.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); }
          catch (error) { try { req.transaction?.abort(); } catch (_) {} finish(error); }
        };
        req.onsuccess = () => finish(null, req.result);
        req.onerror = () => finish(req.error || failed("Device storage could not be opened."));
        req.onblocked = () => finish(failed("Device storage is temporarily blocked."));
      } catch (error) { finish(error); }
    });
    opening = pending;
    pending.catch(() => { if (opening === pending) opening = null; });
    return pending;
  }
  async function run(mode, make, required = false) {
    const db = await open();
    if (!db) {
      if (required) throw failed("Device storage is not available.");
      return undefined;
    }
    return new Promise((resolve, reject) => {
      let tx, req, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimer(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimer(() => {
        finish(failed("Device storage did not finish in time.", "IDB_TIMEOUT"));
        try { tx?.abort(); } catch (_) {}
        invalidate(db);
      }, timeoutMs);
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => {
          try { finish(null, req?.result); } catch (error) { finish(error); }
        };
        tx.onerror = () => finish(tx.error || failed("Device storage failed."));
        tx.onabort = () => finish(tx.error || failed("Device storage was interrupted."));
        req = make(tx.objectStore(STORE));
      } catch (error) {
        finish(error);
        try { tx?.abort(); } catch (_) {}
        invalidate(db);
      }
    });
  }
  const cache = operation => operation.catch(() => null);
  return {
    get(key) { return cache(run("readonly", os => os.get(key))); },
    getVerified(key) { return run("readonly", os => os.get(key), true); },
    set(key, value) { return cache(run("readwrite", os => os.put(value, key))); },
    del(key) { return cache(run("readwrite", os => os.delete(key))); },
    clear() { return cache(run("readwrite", os => os.clear())); },
    available() { return open().then(db => !!db).catch(() => false); },
  };
}

export const idb = createIndexedDbStore();
