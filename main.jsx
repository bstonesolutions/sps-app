import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./supabaseClient";
import App from "./App.jsx";

const BG = "#F5F5F7";
const PRIMARY = "#B81D24";

// Cover the full screen including areas behind the keyboard — no red bleed-through
const wrap = {
  position: "fixed", inset: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)) 24px",
  background: BG,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  overflowY: "auto",
  boxSizing: "border-box",
};
const card = { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.08)", padding: 28 };
const inp = { width: "100%", padding: "13px 14px", border: "1px solid #e5e7eb", borderRadius: 12, fontSize: 15, marginBottom: 10, boxSizing: "border-box", outline: "none", fontFamily: "inherit", background: "#fff", color: "#111" };
const btn = { width: "100%", padding: "13px", border: "none", borderRadius: 12, background: PRIMARY, color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit", marginTop: 4 };
const linkBtn = { background: "none", border: "none", color: PRIMARY, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 };

function hasMagicLinkToken() {
  const hash = window.location.hash || "";
  return hash.includes("access_token") || hash.includes("type=magiclink") || hash.includes("type=recovery");
}

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("password");
  const [brand, setBrand] = useState({ type: "image", image: "/icon-192.png", name: "Stone Property Solutions" });

  useEffect(() => {
    // Keep body background matching login so no color bleeds through behind keyboard
    document.body.style.background = BG;
    document.documentElement.style.background = BG;
    try { const raw = localStorage.getItem("sps_brand_logo"); if (raw) setBrand(JSON.parse(raw)); } catch (e) {}
    return () => {
      document.body.style.background = "";
      document.documentElement.style.background = "";
    };
  }, []);

  const signInPassword = async () => {
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  };

  const sendMagicLink = async () => {
    if (!email.trim()) { setErr("Enter your email address."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
    if (error) { setErr(error.message); setBusy(false); return; }
    setMode("sent");
    setBusy(false);
  };

  const hasImg = brand && brand.type === "image" && brand.image;

  return (
    <div style={wrap}>
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
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button style={linkBtn} onClick={() => { setMode("magic"); setErr(""); }}>Client? Sign in with email link</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (hasMagicLinkToken()) {
      supabase.auth.getSession().then(({ data }) => setSession(data.session));
    } else {
      supabase.auth.getSession().then(({ data }) => setSession(data.session));
    }
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
  return <App authEmail={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
}

createRoot(document.getElementById("root")).render(<Root />);
