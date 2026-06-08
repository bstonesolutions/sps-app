import { createClient } from "@supabase/supabase-js";

// Your project. The anon key is the PUBLIC key, safe to ship in the app.
const SUPABASE_URL = "https://ysqarusrewceezckawlo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzcWFydXNyZXdjZWV6Y2thd2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2MjkzODEsImV4cCI6MjA5NjIwNTM4MX0.GCX-Bt3sSoDaaF-XT2xeu4h6wR4tXO2hqOydQUkl_CQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Same interface the app already used, but backed by your database.
export const store = {
  async get(key) {
    const { data, error } = await supabase.from("app_state").select("value").eq("key", key).maybeSingle();
    if (error) { console.error("store.get", key, error.message); return null; }
    return data ? { value: data.value } : null;
  },
  async set(key, value) {
    const { error } = await supabase.from("app_state").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error("store.set", key, error.message);
    return null;
  },
  async remove(key) {
    const { error } = await supabase.from("app_state").delete().eq("key", key);
    if (error) console.error("store.remove", key, error.message);
    return null;
  },
};
