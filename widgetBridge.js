// widgetBridge.js
// Transport layer for the native iOS home-screen widgets. Keeps all the Capacitor
// plumbing out of App.jsx — App.jsx only builds a plain payload object and calls
// sendWidgetPayload(). No-ops cleanly on web / non-native so nothing breaks there.

import { registerPlugin, Capacitor } from "@capacitor/core";

// Matches @objc(SPSWidgetBridge) in ios/App/App/SPSWidgetBridge.swift.
const SPSWidgetBridge = registerPlugin("SPSWidgetBridge");

// Drop anything we don't actually know — the widgets must never show a fake default.
// Removes undefined/null, non-finite numbers, and empty arrays/strings.
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const isNative = () => {
  try { return !!(Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()); }
  catch (_) { return false; }
};

// Build + push the App Group snapshot. Best-effort: any failure is swallowed so the
// widget bridge can never disrupt the app.
export async function sendWidgetPayload(payload) {
  if (!isNative()) return { ok: false, native: false, skipped: true, reason: "Widgets run on the iOS app only." };
  try {
    const body = clean(payload);
    // role is the one field we always need; without it there's nothing to render.
    if (!body.role) return { ok: false, native: true, skipped: true, reason: "No data to show yet." };
    await SPSWidgetBridge.update({ json: JSON.stringify(body) });
    return { ok: true, native: true, skipped: false, reason: "" };
  } catch (e) {
    const msg = (e && e.message) || "Widget bridge unavailable";
    if (typeof console !== "undefined") console.debug("[widgets] payload skipped:", msg);
    return { ok: false, native: true, skipped: false, reason: msg };
  }
}

// Wipe the cached snapshot (e.g. on sign-out, or a Reconnect from the Sync tab) so a
// widget never shows stale data from a previous account. Returns { ok, native }.
export async function clearWidgetPayload() {
  if (!isNative()) return { ok: false, native: false };
  try { await SPSWidgetBridge.clear(); return { ok: true, native: true }; }
  catch (e) { return { ok: false, native: true, reason: (e && e.message) || "" }; }
}
