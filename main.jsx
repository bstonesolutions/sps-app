import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./supabaseClient";
import { PROD_URL } from "./config";
import App from "./App.jsx";

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)) 24px", background: "#F5F5F7", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" };
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

function Login() {
  useEffect(() => { document.body.classList.add('auth-active'); return () => document.body.classList.remove('auth-active'); }, []);
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
    // Prefer the branded SPS email delivered via Resend. The magic link itself is
    // still minted by Supabase server-side — only the delivery switches to Resend.
    // Fall back to Supabase's built-in email if the endpoint isn't configured (501)
    // or is unreachable, so login never breaks.
    try {
      const r = await fetch("/api/send-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr, redirectTo: PROD_URL }),
      });
      if (r.ok) { setMode("sent"); setBusy(false); return; }
    } catch (_) { /* network error — fall through to Supabase */ }
    const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: false, emailRedirectTo: PROD_URL } });
    if (error) { setErr(error.message); setBusy(false); return; }
    setMode("sent");
    setBusy(false);
  };

  const hasImg = brand && brand.type === "image" && brand.image;

  return (
    <div style={{ ...wrap, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          {hasImg
            ? <img src={brand.image} alt="" style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover" }} />
            : <div style={{ width: 72, height: 72, borderRadius: 18, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>{(brand && brand.emoji) || "💧"}</div>}
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 800, textAlign: "center", margin: "0 0 4px", color: "#111" }}>{(brand && brand.name) || "Stone Property Solutions"}</h1>

        {mode === "sent" ? (
          <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📬</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111", marginBottom: 8 }}>Check your email</div>
            <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.6, marginBottom: 20 }}>We sent a login link to <b>{email}</b>. Tap the link to sign in.</div>
            <button style={linkBtn} onClick={() => { setMode("magic"); setErr(""); }}>Try a different email</button>
          </div>
        ) : mode === "reset_sent" ? (
          <div style={{ textAlign: "center", padding: "16px 0 8px" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🔑</div>
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
          <>
            <p style={{ textAlign: "center", color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>Sign in to your account</p>
            <input style={inp} placeholder="Email" type="email" autoCapitalize="none" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
            <input style={inp} placeholder="Password" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && signInPassword()} />
            {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "2px 0 10px" }}>{err}</div>}
            <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={signInPassword} disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <button style={linkBtn} onClick={sendReset} disabled={busy}>Forgot password?</button>
            </div>
            <div style={{ textAlign: "center", marginTop: 10, paddingTop: 10, borderTop: "1px solid #f1f5f9" }}>
              <button style={linkBtn} onClick={() => { setMode("magic"); setErr(""); }}>Client? Sign in with email link</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// First-login / password-reset screen — staff set a password so they can sign in
// with email + password from then on (instead of a fresh magic link each time).
function SetPassword({ email, recovery, onDone }) {
  useEffect(() => { document.body.classList.add('auth-active'); return () => document.body.classList.remove('auth-active'); }, []);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState({ type: "image", image: "/icon-192.png", name: "Stone Property Solutions" });
  useEffect(() => {
    try { const raw = localStorage.getItem("sps_brand_logo"); if (raw) setBrand(JSON.parse(raw)); } catch (e) {}
  }, []);
  const hasImg = brand && brand.type === "image" && brand.image;

  const submit = async () => {
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    if (pw !== pw2) { setErr("The passwords don't match."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: pw, data: { password_set: true } });
    if (error) { setErr(error.message); setBusy(false); return; }
    onDone();
  };

  return (
    <div style={{ ...wrap, position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          {hasImg
            ? <img src={brand.image} alt="" style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover" }} />
            : <div style={{ width: 72, height: 72, borderRadius: 18, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>{(brand && brand.emoji) || "💧"}</div>}
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
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s && window.location.hash.includes("access_token")) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    });
    return () => sub.subscription.unsubscribe();
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

createRoot(document.getElementById("root")).render(<Root />);
