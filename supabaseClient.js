import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Cache — loads ALL app data in ONE query instead of 15+ separate ones.
// This is what was hammering the free tier.
let _cache = {};
let _loaded = false;
let _loadPromise = null;

async function _init() {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = supabase.from("app_state").select("key, value").then(({ data, error }) => {
    if (error) console.error("store.init", error.message);
    if (data) data.forEach(row => { _cache[row.key] = row.value; });
    _loaded = true;
  });
  return _loadPromise;
}

export const store = {
  async get(key) {
    await _init();                           // one DB round-trip total, then cache
    const val = _cache[key];
    return val !== undefined ? { value: val } : null;
  },
  async set(key, value) {
    _cache[key] = value;                     // update cache immediately (fast UI)
    const { error } = await supabase.from("app_state")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error("store.set", key, error.message);
    return null;
  },
  async remove(key) {
    delete _cache[key];
    const { error } = await supabase.from("app_state").delete().eq("key", key);
    if (error) console.error("store.remove", key, error.message);
    return null;
  },
};
