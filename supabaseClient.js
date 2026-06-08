import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Cache — loads all app data in ONE query on startup, then reads from memory.
let _cache = {};
let _loaded = false;
let _loadPromise = null;
let _lastErrorAt = 0;

function _notify(type, msg) {
  try {
    document.dispatchEvent(new CustomEvent("sps-db-status", { detail: { type, msg } }));
  } catch {}
}

function _throttledError(msg) {
  const now = Date.now();
  if (now - _lastErrorAt > 10000) {
    _lastErrorAt = now;
    _notify("error", msg);
  }
}

async function _init() {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = supabase.from("app_state").select("key, value").then(({ data, error }) => {
    if (error) {
      console.error("store.init failed:", error.message);
      _notify("error", "Cannot reach the database. Your changes won't save until the connection is restored. Tap ↻ to retry.");
    } else {
      if (data) data.forEach(row => { _cache[row.key] = row.value; });
      _notify("ok", "Connected");
    }
    _loaded = true;
  });
  return _loadPromise;
}

export const store = {
  async get(key) {
    await _init();
    const val = _cache[key];
    return val !== undefined ? { value: val } : null;
  },

  async set(key, value) {
    _cache[key] = value;
    const { error } = await supabase.from("app_state")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) {
      console.error("store.set failed:", key, error.message);
      _throttledError("Save failed — your changes aren't syncing. Check your connection and tap ↻ to reload.");
    }
    return null;
  },

  async remove(key) {
    delete _cache[key];
    const { error } = await supabase.from("app_state").delete().eq("key", key);
    if (error) console.error("store.remove failed:", key, error.message);
    return null;
  },

  // Force a fresh load from the database (called by the ↻ sync button via page reload)
  reset() {
    _cache = {};
    _loaded = false;
    _loadPromise = null;
  },
};
