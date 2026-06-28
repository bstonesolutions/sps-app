import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { supabase, store } from "./supabaseClient";
import { PROD_URL } from "./config";
import { Capacitor } from "@capacitor/core";
import App, { LiveTrack } from "./App.jsx";

// Remove the static boot splash (in index.html) once a real React screen is up.
// The React content rendered underneath it is identical, so the handoff is invisible.
const removeBootSplash = () => { const b = document.getElementById("boot-splash"); if (b) b.remove(); };

const wrap = { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)) 24px", background: "#F5F5F7", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" };
const card = { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.08)", padding: 28 };
const inp = { width: "100%", padding: "13px 14px", border: "1px solid #e5e7eb", borderRadius: 12, fontSize: 15, marginBottom: 10, boxSizing: "border-box", outline: "none", fontFamily: "inherit" };
const btn = { width: "100%", padding: "13px", border: "none", borderRadius: 12, background: "#B81D24", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit" };
const linkBtn = { background: "none", border: "none", color: "#B81D24", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 };

function hasMagicLinkToken() {
  const hash = window.location.hash || "";
  return hash.includes("access_token") || hash.includes("type=magiclink") || hash.includes("type=recovery");
}

// Snapshot how the user arrived, captured before the hash is cleared after sign-in.
// magic  = followed an invite / magic login link (first login → set a password)
// recovery = followed a password-reset link (→ choose a new password)
const INITIAL_HASH = typeof window !== "undefined" ? (window.location.hash || "") : "";
const AUTH_FLAGS = {
  magic: INITIAL_HASH.includes("access_token") || INITIAL_HASH.includes("type=magiclink") || INITIAL_HASH.includes("type=recovery"),
  recovery: INITIAL_HASH.includes("type=recovery"),
};

// ── Native deep-link auth ─────────────────────────────────────────────────────
// A magic / password-reset link requested from the app redirects to
// spsway://login#<tokens> (see sendMagicLink). On the web, Supabase's
// detectSessionInUrl reads window.location automatically — but in the native shell
// the location is capacitor://localhost, so it never sees the redirect. Here we
// catch the incoming URL, mirror the same magic/recovery routing the web uses, and
// establish the session explicitly. No change to supabaseClient.js — we only call
// the existing client's auth methods.
async function handleAuthDeepLink(rawUrl) {
  if (!rawUrl || rawUrl.indexOf("spsway://") !== 0) return false;
  let url;
  try { url = new URL(rawUrl); } catch (_) { return false; }
  const hp = new URLSearchParams((url.hash || "").replace(/^#/, ""));
  const qp = url.searchParams;
  const type = hp.get("type") || qp.get("type") || "";
  const access_token = hp.get("access_token");
  const refresh_token = hp.get("refresh_token");
  // Mirror the web's first-login routing so set-password still triggers for staff.
  if (type === "recovery") { AUTH_FLAGS.recovery = true; AUTH_FLAGS.magic = true; }
  else if (type === "magiclink" || access_token) { AUTH_FLAGS.magic = true; }
  try {
    if (access_token && refresh_token) {
      await supabase.auth.setSession({ access_token, refresh_token });
      return true;
    }
    const code = qp.get("code"); // PKCE fallback (default magic links are implicit)
    if (code) { await supabase.auth.exchangeCodeForSession(code); return true; }
  } catch (e) {
    if (typeof console !== "undefined") console.error("auth deep link failed:", (e && e.message) || e);
  }
  return false;
}

// Route in-app deep links (spsway://alerts, spsway://schedule, spsway://invoices, and the
// widgets' spsway://… URLs) to the right screen. Stash the target so a cold start can pick
// it up after the app mounts, and broadcast an event for a warm app. Auth links
// (spsway://login#tokens) are handled by handleAuthDeepLink above and skipped here.
function handleAppDeepLink(rawUrl) {
  if (!rawUrl || rawUrl.indexOf("spsway://") !== 0) return;
  let host = "";
  try { host = (new URL(rawUrl).host || "").toLowerCase(); } catch (_) { return; }
  if (!host || host === "login") return; // login = auth deep link, not a navigation target
  try { localStorage.setItem("sps_deeplink", host); } catch (_) {}
  try { window.dispatchEvent(new CustomEvent("sps-deeplink", { detail: host })); } catch (_) {}
}

// Subscribe to inbound spsway:// URLs (warm app) and the launch URL (cold start).
// No-op on web and if @capacitor/app isn't present.
if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
  import("@capacitor/app")
    .then(({ App: CapApp }) => {
      CapApp.addListener("appUrlOpen", (event) => { const u = event && event.url; handleAuthDeepLink(u); handleAppDeepLink(u); });
      CapApp.getLaunchUrl().then((res) => { if (res && res.url) { handleAuthDeepLink(res.url); handleAppDeepLink(res.url); } }).catch(() => {});
    })
    .catch(() => {});
}

// Bug 4: lift the auth card above the iOS keyboard. Mirrors the App-side useKeyboardInset
// (same visual-viewport math); kept local so main.jsx stays decoupled from App.jsx.
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    // Only track the on-screen keyboard on touch devices. Desktop and the Mac app have
    // no soft keyboard, and their visual-viewport can report spurious insets on focus —
    // which would shift the centered card. Never lift/reflow there.
    const isTouch = typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 1;
    const vv = window.visualViewport;
    if (!vv || !isTouch) return;
    const update = () => setInset(Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);
  return inset;
}
// When the keyboard is up, pin the centered card to the TOP and reserve the keyboard's
// height at the bottom, so the active field + primary button stay visible above it.
// Use alignItems (the cross/VERTICAL axis) — NOT justifyContent — otherwise on a wide
// screen (iPad) this row-flex container shoves the narrow card to the LEFT instead of up.
// And ignore tiny insets (the iPad password-autofill bar, ~80px) so the card doesn't lift
// or hop just because that suggestion bar flickers; only a real keyboard (≳150px) lifts it.
const kbLift = (kb) => kb > 150
  ? { alignItems: "flex-start", paddingTop: "max(16px, env(safe-area-inset-top))", paddingBottom: kb + 12 }
  : null;

function Login() {
  useEffect(() => { removeBootSplash(); document.body.classList.add('auth-active'); return () => document.body.classList.remove('auth-active'); }, []);
  // React's onTouchMove is passive, so its preventDefault is a no-op. Attach a
  // non-passive native touchmove listener so the card truly can't be dragged.
  const wrapRef = useRef(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const block = (e) => e.preventDefault();
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("password");
  const [brand, setBrand] = useState({ type: "image", image: "/icon-192.png", name: "Stone Property Solutions" });

  useEffect(() => {
    try { const raw = localStorage.getItem("sps_brand_logo"); if (raw) setBrand(JSON.parse(raw)); } catch (e) {}
  }, []);

  const signInPassword = async () => {
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) { setErr(error.message); setBusy(false); return; }
    // Mark that this account has a password set, so it's never asked to create one.
    supabase.auth.updateUser({ data: { password_set: true } }).catch(() => {});
    setBusy(false);
  };

  const sendReset = async () => {
    if (!email.trim()) { setErr("Enter your email address first."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: PROD_URL });
    if (error) { setErr(error.message); setBusy(false); return; }
    setMode("reset_sent");
    setBusy(false);
  };

  const sendMagicLink = async () => {
    if (!email.trim()) { setErr("Enter your email address."); return; }
    setBusy(true); setErr("");
    const addr = email.trim();
    // When the request comes from the NATIVE app, redirect the link back into the app
    // via the spsway:// custom scheme (handled below) so the user lands where they
    // asked to sign in. On the web it stays the normal https host.
    const redirectTo = Capacitor.isNativePlatform() ? "spsway://login" : PROD_URL;
    // Prefer the branded SPS email delivered via Resend. The magic link itself is
    // still minted by Supabase server-side — only the delivery switches to Resend.
    // Fall back to Supabase's built-in email if the endpoint isn't configured (501)
    // or is unreachable, so login never breaks.
    try {
      const r = await fetch(`${PROD_URL}/api/send-magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr, redirectTo }),
      });
      if (r.ok) { setMode("sent"); setBusy(false); return; }
    } catch (_) { /* network error — fall through to Supabase */ }
    const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
    if (error) { setErr(error.message); setBusy(false); return; }
    setMode("sent");
    setBusy(false);
  };

  const hasImg = brand && brand.type === "image" && brand.image;
  const kb = useKeyboardInset();

  return (
    <div ref={wrapRef} onTouchMove={(e) => e.preventDefault()} style={{ ...wrap, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", touchAction: "none", overscrollBehavior: "none", transition: "padding 0.18s ease", ...kbLift(kb) }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          {hasImg
            ? <img src={brand.image} alt="" style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover" }} />
            : <div style={{ width: 72, height: 72, borderRadius: 18, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 32, fontWeight: 800, color: "#B81D24" }}>{((brand && brand.name) || "S").trim().charAt(0).toUpperCase() || "S"}</span></div>}
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 800, textAlign: "center", margin: "0 0 4px", color: "#111" }}>{(brand && brand.name) || "Stone Property Solutions"}</h1>

        {mode === "sent" ? (
          <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
            <div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}><svg viewBox="0 0 24 24" width={40} height={40} fill="none" stroke="#B81D24" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg></div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 8 }}>Check your email</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6, marginBottom: 20 }}>We sent a login link to <b>{email}</b>. Tap the link to sign in.</div>
            <button style={linkBtn} onClick={() => { setMode("magic"); setErr(""); }}>Try a different email</button>
          </div>
        ) : mode === "reset_sent" ? (
          <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
            <div style={{ marginBottom: 12, display: "flex", justifyContent: "center" }}><svg viewBox="0 0 24 24" width={40} height={40} fill="none" stroke="#B81D24" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 8 }}>Check your email</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6, marginBottom: 20 }}>We sent a password-reset link to <b>{email}</b>. Tap it to choose a new password.</div>
            <button style={linkBtn} onClick={() => { setMode("password"); setErr(""); }}>Back to sign in</button>
          </div>
        ) : mode === "magic" ? (
          <>
            <p style={{ textAlign: "center", color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>Enter your email and we'll send you a link to sign in.</p>
            <input style={inp} placeholder="Email" type="email" autoCapitalize="none" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMagicLink()} />
            {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "2px 0 10px" }}>{err}</div>}
            <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={sendMagicLink} disabled={busy}>{busy ? "Sending…" : "Send Login Link"}</button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button style={linkBtn} onClick={() => { setMode("password"); setErr(""); }}>Sign in with password instead</button>
            </div>
          </>
        ) : (
          <form onSubmit={e => { e.preventDefault(); signInPassword(); }}>
            <p style={{ textAlign: "center", color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>Sign in to your account</p>
            {/* name + autocomplete + a real form submit = the OS/browser offers to save the password */}
            <input style={inp} placeholder="Email" type="email" name="username" autoCapitalize="none" autoComplete="username" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} />
            <input style={inp} placeholder="Password" type="password" name="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
            {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "2px 0 10px" }}>{err}</div>}
            <button type="submit" style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button type="button" style={linkBtn} onClick={sendReset} disabled={busy}>Forgot password?</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// First-login / password-reset screen — staff set a password so they can sign in
// with email + password from then on (instead of a fresh magic link each time).
function SetPassword({ email, recovery, onDone }) {
  useEffect(() => { removeBootSplash(); document.body.classList.add('auth-active'); return () => document.body.classList.remove('auth-active'); }, []);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState({ type: "image", image: "/icon-192.png", name: "Stone Property Solutions" });
  useEffect(() => {
    try { const raw = localStorage.getItem("sps_brand_logo"); if (raw) setBrand(JSON.parse(raw)); } catch (e) {}
  }, []);
  const hasImg = brand && brand.type === "image" && brand.image;
  const kb = useKeyboardInset();

  const submit = async () => {
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    if (pw !== pw2) { setErr("The passwords don't match."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: pw, data: { password_set: true } });
    if (error) { setErr(error.message); setBusy(false); return; }
    onDone();
  };

  return (
    <div style={{ ...wrap, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", transition: "padding 0.18s ease", ...kbLift(kb) }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          {hasImg
            ? <img src={brand.image} alt="" style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover" }} />
            : <div style={{ width: 72, height: 72, borderRadius: 18, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 32, fontWeight: 800, color: "#B81D24" }}>{((brand && brand.name) || "S").trim().charAt(0).toUpperCase() || "S"}</span></div>}
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 800, textAlign: "center", margin: "0 0 4px", color: "#111" }}>{recovery ? "Reset your password" : "Create your password"}</h1>
        <p style={{ textAlign: "center", color: "#6b7280", fontSize: 13, margin: "0 0 20px", lineHeight: 1.5 }}>
          {recovery ? "Choose a new password for your account." : `Set a password for ${email || "your account"} so you can sign in with email and password from now on.`}
        </p>
        <input style={inp} type="password" placeholder="New password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus />
        <input style={inp} type="password" placeholder="Confirm password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
        {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "2px 0 10px" }}>{err}</div>}
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save Password"}</button>
      </div>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState(undefined);
  const [pwdDone, setPwdDone] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (s && s.user) { try { store.setUser(s.user.id); } catch (_) {} }  // namespace the read cache BEFORE <App> mounts
      setSession(s);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      // Clear the on-disk cache ONLY on a real sign-out (not TOKEN_REFRESHED/USER_UPDATED), so a shared
      // device never serves the prior account's cached data; otherwise keep the cache uid-namespaced.
      if (_e === "SIGNED_OUT") { try { store.clearCache(); } catch (_) {} }
      else if (s && s.user) { try { store.setUser(s.user.id); } catch (_) {} }
      setSession(s);
      if (s && window.location.hash.includes("access_token")) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Scale the whole UI up on a real DESKTOP browser (≥1024px, not iPad, not the native app):
  // the layout is pixel-based, so it reads tiny on large Mac screens. CSS zoom scales
  // everything uniformly — including modals (they portal onto <body>). Tiered so bigger
  // screens get more, while widths near the breakpoint stay conservative (no overflow).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let native = false; try { native = Capacitor.isNativePlatform(); } catch (_) {}
    if (native) return;
    const apply = () => {
      const w = window.innerWidth;
      // Touch devices (iPad, touchscreen laptops) keep native size — zoom + position:fixed
      // shifts the login off-center there. True desktops (Mac/PC) report 0 touch points.
      const touch = (navigator.maxTouchPoints || 0) > 0;
      document.body.style.zoom = (!touch && w >= 1024) ? (w >= 1600 ? "1.2" : w >= 1280 ? "1.15" : "1.08") : "";
    };
    apply();
    window.addEventListener("resize", apply);
    return () => { window.removeEventListener("resize", apply); document.body.style.zoom = ""; };
  }, []);

  if (session === undefined) return <div style={{ ...wrap, color: "#6b7280", fontSize: 14 }}>Loading…</div>;
  if (!session) return <Login />;
  // First login via invite link (no password yet), or a password-reset link →
  // make them set a password before continuing into the app.
  const meta = session.user.user_metadata || {};
  const needsPassword = !pwdDone && (AUTH_FLAGS.recovery || (AUTH_FLAGS.magic && !meta.password_set));
  if (needsPassword) return <SetPassword email={session.user.email} recovery={AUTH_FLAGS.recovery} onDone={() => setPwdDone(true)} />;
  return <App authEmail={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
}

// Public live-tracking page — ?track=<token> opens the tech's live map with no login,
// bypassing the auth gate entirely.
const _trackToken = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("track") : null;
createRoot(document.getElementById("root")).render(_trackToken ? <LiveTrack token={_trackToken} /> : <Root />);

// Native (Capacitor): the iOS launch screen stays up (launchAutoHide:false) until
// the web is painted, then hands off to the boot/React splash — no white flash.
// No-op on the web. Runs on the next frame so the web content has painted first.
requestAnimationFrame(() => {
  import("@capacitor/splash-screen")
    .then(({ SplashScreen }) => SplashScreen.hide())
    .catch(() => {});
});
