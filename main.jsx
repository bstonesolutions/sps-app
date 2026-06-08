import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./supabaseClient";
import App from "./App.jsx";

const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#F5F5F7", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" };
const card = { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.08)", padding: 28 };
const inp = { width: "100%", padding: "13px 14px", border: "1px solid #e5e7eb", borderRadius: 12, fontSize: 15, marginBottom: 10, boxSizing: "border-box", outline: "none", fontFamily: "inherit" };
const btn = { width: "100%", padding: "13px", border: "none", borderRadius: 12, background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit" };

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  };
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 42, textAlign: "center", marginBottom: 6 }}>💧</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, textAlign: "center", margin: "0 0 4px", color: "#111" }}>Stone Property Solutions</h1>
        <p style={{ textAlign: "center", color: "#6b7280", fontSize: 13, margin: "0 0 20px" }}>Sign in to your account</p>
        <input style={inp} placeholder="Email" type="email" autoCapitalize="none" value={email} onChange={e => setEmail(e.target.value)} />
        <input style={inp} placeholder="Password" type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
        {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "2px 0 10px" }}>{err}</div>}
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>{busy ? "Signing in…" : "Sign In"}</button>
      </div>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (session === undefined) return <div style={{ ...wrap, color: "#6b7280", fontSize: 14 }}>Loading…</div>;
  if (!session) return <Login />;
  return <App authEmail={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
}

createRoot(document.getElementById("root")).render(<Root />);
