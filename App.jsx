import { useState, useRef, useEffect, useContext, createContext } from "react";
import { store, supabase } from "./supabaseClient";

// ── PDF generation (jsPDF) ──
// Loaded lazily so it doesn't block initial render
const loadJsPDF = () => import("jspdf").then(m => m.jsPDF || m.default);

function generateEstimatePDF(estimate, branding, invoicing) {
  return loadJsPDF().then(JsPDF => {
    const doc = new JsPDF({ unit: "pt", format: "letter" });
    const primary = branding?.accentColor || "#B81D24";
    const W = doc.internal.pageSize.getWidth();
    let y = 40;

    // Header bar
    doc.setFillColor(primary);
    doc.rect(0, 0, W, 70, "F");
    doc.setTextColor("#ffffff");
    doc.setFontSize(22);
    doc.setFont("helvetica", "bold");
    doc.text(branding?.companyName || "Stone Property Solutions", 40, 38);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const contact = [branding?.companyPhone, branding?.companyEmail].filter(Boolean).join("  ·  ");
    if (contact) doc.text(contact, 40, 56);
    y = 100;

    // Estimate title + info
    doc.setTextColor("#1D1D1F");
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text(estimate.title || "Service Estimate", 40, y);
    y += 24;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor("#6B7280");
    doc.text(`Date: ${estimate.date || ""}   ·   Valid: ${estimate.validDays || 30} days`, 40, y);
    y += 10;
    doc.text(`Prepared for: ${estimate.clientName || ""}`, 40, y);
    y += 30;

    // Line items header
    doc.setFillColor("#F5F5F7");
    doc.rect(40, y, W - 80, 24, "F");
    doc.setTextColor("#1D1D1F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Description", 52, y + 16);
    doc.text("Qty", W - 160, y + 16, { align: "right" });
    doc.text("Unit Price", W - 100, y + 16, { align: "right" });
    doc.text("Amount", W - 40, y + 16, { align: "right" });
    y += 28;

    // Line items
    doc.setFont("helvetica", "normal");
    (estimate.items || []).filter(it => it.desc).forEach(item => {
      const qty = parseInt(item.qty) || 1;
      const price = parseFloat(item.price || 0);
      const amt = (qty * price).toFixed(2);
      doc.setTextColor("#1D1D1F");
      doc.text(String(item.desc), 52, y);
      doc.text(String(qty), W - 160, y, { align: "right" });
      doc.text(`$${price.toFixed(2)}`, W - 100, y, { align: "right" });
      doc.text(`$${amt}`, W - 40, y, { align: "right" });
      y += 20;
      doc.setDrawColor("#E5E7EB");
      doc.line(40, y - 4, W - 40, y - 4);
    });

    // Total
    y += 10;
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(primary);
    doc.text(`Total: ${estimate.total || "$0.00"}`, W - 40, y, { align: "right" });
    y += 30;

    // Notes
    if (estimate.notes) {
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor("#6B7280");
      const lines = doc.splitTextToSize(estimate.notes, W - 80);
      doc.text(lines, 40, y);
      y += lines.length * 14 + 10;
    }

    // Footer
    y = doc.internal.pageSize.getHeight() - 40;
    doc.setFontSize(9);
    doc.setTextColor("#9CA3AF");
    doc.text(`${branding?.companyName || "Stone Property Solutions"}  ·  ${branding?.companyAddress || "Honey Brook, PA"}`, 40, y);

    const filename = `estimate-${(estimate.clientName || "client").replace(/\s+/g, "-").toLowerCase()}.pdf`;
    doc.save(filename);
  });
}

function generateStatementPDF(client, invoices, branding) {
  return loadJsPDF().then(JsPDF => {
    const doc = new JsPDF({ unit: "pt", format: "letter" });
    const primary = branding?.accentColor || "#B81D24";
    const W = doc.internal.pageSize.getWidth();
    let y = 40;

    // Header
    doc.setFillColor(primary);
    doc.rect(0, 0, W, 70, "F");
    doc.setTextColor("#ffffff");
    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text(branding?.companyName || "Stone Property Solutions", 40, 38);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Account Statement", 40, 56);
    y = 100;

    // Client info
    doc.setTextColor("#1D1D1F");
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text(client.name || "Client", 40, y);
    y += 16;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor("#6B7280");
    if (client.address) { doc.text(client.address, 40, y); y += 14; }
    doc.text(`Statement Date: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`, 40, y);
    y += 30;

    // Invoice table header
    doc.setFillColor("#F5F5F7");
    doc.rect(40, y, W - 80, 24, "F");
    doc.setTextColor("#1D1D1F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text("Invoice #", 52, y + 16);
    doc.text("Date", 180, y + 16);
    doc.text("Due", 280, y + 16);
    doc.text("Status", 370, y + 16);
    doc.text("Amount", W - 40, y + 16, { align: "right" });
    y += 28;

    // Invoices
    let totalPaid = 0, totalOpen = 0;
    doc.setFont("helvetica", "normal");
    (invoices || []).forEach(iv => {
      const amt = parseFloat((iv.total || "0").replace(/[^0-9.-]/g, "")) || 0;
      const isPaid = iv.status === "paid";
      if (isPaid) totalPaid += amt; else totalOpen += amt;
      doc.setTextColor(isPaid ? "#6B7280" : "#1D1D1F");
      doc.text(String(iv.number || iv.id), 52, y);
      doc.text(String(iv.date || ""), 180, y);
      doc.text(String(iv.dueDate || ""), 280, y);
      doc.text(isPaid ? "Paid" : "Outstanding", 370, y);
      doc.text(`$${amt.toFixed(2)}`, W - 40, y, { align: "right" });
      y += 18;
      doc.setDrawColor("#E5E7EB");
      doc.line(40, y - 2, W - 40, y - 2);
    });

    // Summary
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor("#6B7280");
    doc.text(`Total Paid: $${totalPaid.toFixed(2)}`, W - 200, y);
    y += 18;
    doc.setTextColor(primary);
    doc.setFontSize(13);
    doc.text(`Balance Due: $${totalOpen.toFixed(2)}`, W - 200, y);

    const filename = `statement-${(client.name || "client").replace(/\s+/g, "-").toLowerCase()}.pdf`;
    doc.save(filename);
  });
}

// ─────────────────────────────────────────────
// PERSISTENT STORAGE
// Keeps app data across reloads and updates so nothing resets.
// ─────────────────────────────────────────────
// store + supabase are imported from ./supabaseClient (backed by your Supabase database)

// Like useState, but loads from / saves to persistent storage.
function useStoredState(key, initial) {
  const [value, setValue] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  // load once on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await store.get(key);
      if (alive && res && res.value != null) {
        try { setValue(JSON.parse(res.value)); } catch (e) {}
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [key]);
  // save on change, but only after the initial load (so we don't overwrite saved data with defaults)
  useEffect(() => {
    if (!loaded) return;
    store.set(key, JSON.stringify(value));
    // Notify App of a save so the sync indicator can pulse
    if (typeof window.__onSpsSync === "function") window.__onSpsSync();
  }, [key, value, loaded]);
  return [value, setValue, loaded];
}
// ─────────────────────────────────────────────
// AUTOCOMPLETE INPUT
// Remembers previously entered values and shows
// them as tappable suggestions as you type.
// historyKey: localStorage key to persist suggestions
// ─────────────────────────────────────────────
function AutocompleteInput({ value, onChange, historyKey, placeholder, style, autoFocus, maxHistory = 30 }) {
  const [history, setHistory] = useStoredState(historyKey, []);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const suggestions = (history || []).filter(h =>
    h && value && value.length > 0 &&
    h.toLowerCase().includes(value.toLowerCase()) &&
    h.toLowerCase() !== value.toLowerCase()
  ).slice(0, 6);

  const commit = (val) => {
    if (!val || !val.trim()) return;
    setHistory(prev => {
      const existing = (prev || []).filter(h => h.toLowerCase() !== val.toLowerCase());
      return [val.trim(), ...existing].slice(0, maxHistory);
    });
  };

  const pick = (suggestion) => {
    onChange(suggestion);
    commit(suggestion);
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleBlur = () => {
    // Delay so tap on suggestion fires before blur hides it
    setTimeout(() => setOpen(false), 150);
    if (value && value.trim()) commit(value.trim());
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={handleBlur}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={style}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200,
          background: "var(--sps-surface, #fff)",
          border: "1px solid rgba(0,0,0,0.1)",
          borderRadius: 12, marginTop: 4,
          boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
          overflow: "hidden",
        }}>
          {suggestions.map((s, i) => (
            <button key={i} onMouseDown={() => pick(s)} onTouchStart={() => pick(s)}
              style={{
                width: "100%", padding: "11px 14px", background: "none", border: "none",
                borderBottom: i < suggestions.length - 1 ? "1px solid rgba(0,0,0,0.07)" : "none",
                textAlign: "left", cursor: "pointer", fontFamily: "inherit", fontSize: 14,
                display: "flex", alignItems: "center", gap: 10,
                color: "var(--sps-text, #1D1D1F)",
              }}>
              <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" style={{ opacity: 0.35, flexShrink: 0 }}>
                <polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>
              </svg>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────
// THEME SYSTEM
// ─────────────────────────────────────────────
// hex -> rgba (for translucent chrome)
const hexA = (hex, a) => {
  const h = (hex || "#000000").replace("#", "");
  const f = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const _rgb = (hex) => { const h = (hex || "#000000").replace("#", ""); const f = h.length === 3 ? h.split("").map(c => c + c).join("") : h; const n = parseInt(f, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const _toHex = (arr) => "#" + arr.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const A = _rgb(a), B = _rgb(b); return _toHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]); };
const lum = (hex) => { const c = _rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const buildMapUrl = (address, app) => {
  const enc = encodeURIComponent(address || "");
  if (app === "apple") return `maps://maps.apple.com/?daddr=${enc}`;
  if (app === "google") return `https://maps.google.com/maps?daddr=${enc}`;
  if (app === "waze") return `waze://?q=${enc}&navigate=yes`;
  return `https://www.google.com/maps/dir/?api=1&destination=${enc}`;
};


// Selectable fonts (use system-available faces, no external load)
const FONTS = {
  system:  { label: "System",  stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif' },
  rounded: { label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic Pro", "Nunito", system-ui, sans-serif' },
  grotesk: { label: "Grotesk", stack: '"Inter", "Helvetica Neue", Arial, sans-serif' },
  serif:   { label: "Serif",   stack: '"New York", "Iowan Old Style", Georgia, "Times New Roman", serif' },
  mono:    { label: "Mono",    stack: '"SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, monospace' },
};
const DEFAULT_FONT_STACK = FONTS.system.stack;

const DEFAULT_CUSTOM = {
  fontFamily: "system",
  primary: "#B81D24",
  accent: "#2FA862",
  bg: "#F5F5F7",
  surface: "#FFFFFF",
  text: "#1D1D1F",
};

// Saved brand palette — pre-loaded with SPS colors, user can edit
const DEFAULT_PALETTE = [
  { name: "SPS Crimson",  hex: "#AF011A" },
  { name: "SPS Red",      hex: "#B81D24" },
  { name: "White",        hex: "#FFFFFF" },
  { name: "Slate Grey",   hex: "#6B7280" },
  { name: "Dark",         hex: "#1D1D1F" },
  { name: "Light Grey",   hex: "#F5F5F7" },
  { name: "Green",        hex: "#2FA862" },
  { name: "Gold",         hex: "#D97706" },
];

// Build a full theme object from the user's custom picks (light or dark mode)
function buildCustomTheme(c0, mode = "light") {
  const c = { ...DEFAULT_CUSTOM, ...(c0 || {}) };
  const dark = mode === "dark";
  const bg = dark ? "#000000" : c.bg;
  const surface = dark ? "#1C1C1E" : c.surface;
  const text = dark ? "#F5F5F7" : (c.text || "#1D1D1F");
  return {
    name: "Custom",
    primary: c.primary, primaryLight: mix(c.primary, "#ffffff", 0.2),
    headerBg: surface, headerText: text,
    bg, surface,
    surfaceAlt: mix(surface, dark ? "#ffffff" : "#000000", dark ? 0.07 : 0.045),
    border: hexA(dark ? "#ffffff" : "#000000", dark ? 0.14 : 0.09),
    text, textMuted: mix(text, surface, 0.45),
    accent: c.accent, warning: dark ? "#FF9F0A" : "#C2410C",
    navActiveBg: hexA(c.primary, dark ? 0.20 : 0.12),
    shadow: dark ? "0 2px 8px rgba(0,0,0,0.5), 0 12px 32px rgba(0,0,0,0.5)" : "0 2px 8px rgba(0,0,0,0.05), 0 12px 32px rgba(0,0,0,0.08)",
    shadowLg: dark ? "0 24px 64px rgba(0,0,0,0.7)" : "0 24px 64px rgba(0,0,0,0.20)",
  };
}

// follows the device's light/dark preference when appearance = "system"
function useSystemDark() {
  const [d, setD] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e) => setD(e.matches);
    if (m.addEventListener) m.addEventListener("change", h); else if (m.addListener) m.addListener(h);
    return () => { if (m.removeEventListener) m.removeEventListener("change", h); else if (m.removeListener) m.removeListener(h); };
  }, []);
  return d;
}

const lightBase = (primary, accent) => ({
  primary, primaryLight: mix(primary, "#ffffff", 0.2),
  headerBg: "#FFFFFF", headerText: "#1D1D1F",
  bg: "#F5F5F7", surface: "#FFFFFF", surfaceAlt: "#F0F0F3",
  border: "rgba(0,0,0,0.08)", text: "#1D1D1F", textMuted: "#86868B",
  accent, warning: "#C2410C", navActiveBg: hexA(primary, 0.12),
  shadow: "0 2px 8px rgba(0,0,0,0.05), 0 12px 32px rgba(0,0,0,0.08)",
  shadowLg: "0 24px 64px rgba(0,0,0,0.20)",
});
const darkBase = (primary, accent) => ({
  primary, primaryLight: mix(primary, "#ffffff", 0.2),
  headerBg: "#1C1C1E", headerText: "#F5F5F7",
  bg: "#000000", surface: "#1C1C1E", surfaceAlt: "#2C2C2E",
  border: "rgba(255,255,255,0.12)", text: "#F5F5F7", textMuted: "#98989D",
  accent, warning: "#FF9F0A", navActiveBg: hexA(primary, 0.20),
  shadow: "0 2px 8px rgba(0,0,0,0.5), 0 12px 32px rgba(0,0,0,0.5)",
  shadowLg: "0 24px 64px rgba(0,0,0,0.7)",
});

const THEMES = {
  sps:      { name: "SPS Classic", light: lightBase("#B81D24", "#2FA862"), dark: darkBase("#FF453A", "#30D158") },
  midnight: { name: "Midnight",    light: lightBase("#0A84FF", "#30D158"), dark: darkBase("#0A84FF", "#30D158") },
  forest:   { name: "Forest",      light: lightBase("#1F8A53", "#1F8A53"), dark: darkBase("#34C759", "#34C759") },
  slate:    { name: "Slate Pro",   light: lightBase("#6366F1", "#059669"), dark: darkBase("#818CF8", "#30D158") },
};
const DEFAULT_BRANDING = {
  companyName: "Stone Property Solutions",
  division: "All Divisions",
  logoType: "image",
  logoEmoji: "💧",
  logoImage: "/icon-192.png",
  themeKey: "sps",
  appearance: "system",
  custom: DEFAULT_CUSTOM,
  companyPhone: "",
  companyEmail: "",
  companyWebsite: "",
  companyAddress: "",
  portalAppName: "",
  portalTagline: "",
  accentColor: "",
  splashTagline: "",
  splashBgColor: "",       // custom bg color — defaults to T.primary if blank
  splashBgColor2: "",      // second gradient color — defaults to darkened primary
  splashBgStyle: "gradient", // "gradient" | "solid" | "image"
  splashBgImage: "",       // full-bleed background image
  splashLogoOverride: "",  // separate logo just for splash — defaults to main logo
  splashTextColor: "light", // "light" | "dark"
  splashShowGreeting: "true", // "true" | "false"
  splashGreetingPrefix: "",   // e.g. "Welcome back" or "Hey" — defaults to time-based
  portalCenterBtn: "cp_request",
  portalNavLabels: "true",   // "true" | "false" — show labels under nav icons
  portalHeroImage: "",
  staffDefaultPage: "dashboard",
  portalDefaultPage: "cp_home",
};

// Schedule layout preferences
const DEFAULT_SCHEDULE_CFG = {
  sort: "time",          // "time" | "manual"
  density: "comfortable",// "comfortable" | "compact"
  showAddress: true,
  showServices: true,
  showDuration: true,
};

// Roles & access — admin configures exactly what employees can see, change, and do
const DEFAULT_ROLES = {
  current: "admin",        // "admin" | "employee" (view-as)
  // SEE (visibility)
  canSeeProfit: false,
  canSeeCostsBudget: false,
  canSeeBalances: true,
  // CHANGE (edit)
  canEditClients: false,   // add / edit / delete clients + equipment
  canEditSchedule: true,   // add / remove / reorder stops
  canEditHistory: false,   // edit past completed visits
  canEditCatalog: false,   // services, products, treatments, stop types, tests
  canEditSettings: false,  // branding, appearance, email, schedule layout
  canImport: false,        // CSV import
  // OPERATE (do)
  canCompleteStops: true,  // run the service workspace + save reports
  canSendTexts: true,      // send On My Way texts
  canInvoice: false,       // create, send, and manage invoices
};
const ROLE_PRESETS = {
  field:    { label: "Field Crew",  canSeeProfit: false, canSeeCostsBudget: false, canSeeBalances: false, canEditClients: false, canEditSchedule: false, canEditHistory: false, canEditCatalog: false, canEditSettings: false, canImport: false, canCompleteStops: true,  canSendTexts: true,  canInvoice: false },
  lead:     { label: "Lead Tech",   canSeeProfit: false, canSeeCostsBudget: false, canSeeBalances: true,  canEditClients: true,  canEditSchedule: true,  canEditHistory: true,  canEditCatalog: false, canEditSettings: false, canImport: false, canCompleteStops: true,  canSendTexts: true,  canInvoice: true },
  viewer:   { label: "View Only",   canSeeProfit: false, canSeeCostsBudget: false, canSeeBalances: false, canEditClients: false, canEditSchedule: false, canEditHistory: false, canEditCatalog: false, canEditSettings: false, canImport: false, canCompleteStops: false, canSendTexts: false, canInvoice: false },
  full:     { label: "Full Access", canSeeProfit: true,  canSeeCostsBudget: true,  canSeeBalances: true,  canEditClients: true,  canEditSchedule: true,  canEditHistory: true,  canEditCatalog: true,  canEditSettings: true,  canImport: true,  canCompleteStops: true,  canSendTexts: true,  canInvoice: true },
};

// Team roster — each member has a login role + optional PIN, and their own hourly labor cost
const DEFAULT_TEAM = [
  { id: "e1", name: "Brandon", rate: "", role: "owner", pin: "", email: "" },
  { id: "e2", name: "David", rate: "24", role: "field", pin: "", email: "" },
];
// roles a member can hold (drives their permissions); "owner" is the admin, "custom" uses per-member toggles
const MEMBER_ROLES = [
  { key: "owner",  label: "Owner / Admin" },
  { key: "full",   label: "Full Access" },
  { key: "lead",   label: "Lead Tech" },
  { key: "field",  label: "Field Crew" },
  { key: "viewer", label: "View Only" },
  { key: "custom", label: "Custom…" },
];
const roleLabel = (key) => (MEMBER_ROLES.find(r => r.key === key) || {}).label || "Field Crew";
// resolve a member's permission set into the same shape the app reads everywhere
function memberPerms(member) {
  const role = member?.role || "field";
  const isAdmin = role === "owner";
  const src = role === "custom" ? (member?.perms || {}) : (ROLE_PRESETS[role] || ROLE_PRESETS.field);
  const P = (k, dflt) => isAdmin || (src[k] !== undefined ? !!src[k] : dflt);
  return {
    isAdmin,
    seeProfit: P("canSeeProfit", false),
    seeCostsBudget: P("canSeeCostsBudget", false),
    seeBalances: P("canSeeBalances", true),
    editClients: P("canEditClients", false),
    editSchedule: P("canEditSchedule", true),
    editHistory: P("canEditHistory", false),
    editCatalog: P("canEditCatalog", false),
    editSettings: P("canEditSettings", false),
    canImport: P("canImport", false),
    completeStops: P("canCompleteStops", true),
    sendTexts: P("canSendTexts", true),
    canInvoice: P("canInvoice", false),
  };
}
// initials for an avatar chip
const initials = (name) => (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
// the owner account the preview signs into by default (so you land in admin view, not a login wall)
const DEFAULT_OWNER_ID = (DEFAULT_TEAM.find(m => m.role === "owner") || DEFAULT_TEAM[0] || {}).id || "e1";
// the labor rate to bill for a stop: assigned member's rate if set, else the global rate
const laborRateFor = (assigneeId, team, costs) => {
  const m = (team || []).find(e => e.id === assigneeId);
  const r = m && m.rate !== "" && m.rate != null ? parseFloat(m.rate) : NaN;
  return isNaN(r) ? (parseFloat(costs?.hourlyRate) || 0) : r;
};

// Combine address parts into one line: "123 Main St, Elverson, PA 19520"
const assembleAddress = ({ street, city, state, zip } = {}) => {
  const s = (street || "").trim();
  const c = (city || "").trim();
  const st = (state || "").trim();
  const z = (zip || "").trim();
  const cityState = [c, [st, z].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s, cityState].filter(Boolean).join(", ");
};
// Best-effort split of a single address string back into parts (for older records)
const splitAddress = (addr) => {
  const blank = { street: "", city: "", state: "", zip: "" };
  if (!addr) return blank;
  const parts = String(addr).split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ...blank, street: String(addr).trim() };
  const out = { ...blank, street: parts[0] || "" };
  const pullZip = (str) => { const m = str.match(/^(.*?)\s+([\d][\d-]*)$/); return m ? { head: m[1].trim(), zip: m[2].trim() } : { head: str.trim(), zip: "" }; };
  if (parts.length >= 3) {
    out.city = parts[1];
    const { head, zip } = pullZip(parts.slice(2).join(" "));
    out.state = head; out.zip = zip;
  } else if (parts.length === 2) {
    const { head, zip } = pullZip(parts[1]);
    out.zip = zip;
    const toks = head.split(/\s+/).filter(Boolean);
    if (zip && toks.length >= 2) { out.state = toks[toks.length - 1]; out.city = toks.slice(0, -1).join(" "); }
    else if (zip) { out.state = head; }
    else { out.city = head; }
  }
  return out;
};

const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

// ─────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────
const DEMO_CLIENTS = [
  {
    id: 1, name: "Robert & Linda Harmon", division: "Pond",
    address: "412 Covered Bridge Rd, Honey Brook, PA 19344",
    phone: "(610) 555-0142", email: "rharmon@email.com",
    plan: "Signature", planFreq: "Bi-Weekly", status: "Active",
    pondType: "Koi Pond", pondSize: "3,200 gal",
    equipment: [
      { name: "Aquascape 3000 Pump", installed: "03/2021", status: "Good" },
      { name: "Atlantic TT5000 Filter", installed: "03/2021", status: "Good" },
      { name: "Aquascape LED Kit", installed: "06/2022", status: "Good" },
      { name: "Auto-Dose Feeder", installed: "05/2023", status: "Monitor" },
    ],
    history: [
      { date: "05/28/2026", tech: "B. Stone", type: "Bi-Weekly Service", notes: "Water clarity good. Added beneficial bacteria. Trimmed marginals.", ammonia: "0.0", nitrite: "0.0", ph: "7.4", temp: "68°F", invoice: "$145" },
      { date: "05/14/2026", tech: "B. Stone", type: "Bi-Weekly Service", notes: "Spring algae bloom present. Treated with EcoBlast. Cleaned filter pads.", ammonia: "0.25", nitrite: "0.0", ph: "7.2", temp: "62°F", invoice: "$145" },
      { date: "04/30/2026", tech: "B. Stone", type: "Spring Startup", notes: "Full spring opening. Cleaned entire system. Fish healthy after winter.", ammonia: "0.0", nitrite: "0.0", ph: "7.5", temp: "54°F", invoice: "$295" },
    ],
    nextService: "06/11/2026", balance: "$0.00",
  },
  {
    id: 2, name: "Thomas & Karen Wells", division: "Pond",
    address: "88 Mill Road, Coatesville, PA 19320",
    phone: "(610) 555-0287", email: "twells@email.com",
    plan: "Premium", planFreq: "Weekly", status: "Active",
    pondType: "Ecosystem Pond", pondSize: "6,800 gal",
    equipment: [
      { name: "Aquascape 6000 Pump", installed: "04/2019", status: "Good" },
      { name: "BioFalls 6000 Filter", installed: "04/2019", status: "Good" },
      { name: "Pond Aerator", installed: "07/2021", status: "Good" },
      { name: "UV Clarifier 40W", installed: "04/2023", status: "Replace Soon" },
    ],
    history: [
      { date: "05/30/2026", tech: "B. Stone", type: "Weekly Service", notes: "Algae under control. UV clarifier showing wear, flagged for replacement.", ammonia: "0.0", nitrite: "0.0", ph: "7.6", temp: "70°F", invoice: "$195" },
      { date: "05/23/2026", tech: "B. Stone", type: "Weekly Service", notes: "Net skimming done. Added barley straw extract.", ammonia: "0.0", nitrite: "0.0", ph: "7.5", temp: "67°F", invoice: "$195" },
    ],
    nextService: "06/06/2026", balance: "$195.00",
  },
  {
    id: 3, name: "Susan Moretti", division: "Pond",
    address: "7 Quarry Lane, Parkesburg, PA 19365",
    phone: "(610) 555-0399", email: "smoretti@email.com",
    plan: "Essential", planFreq: "Monthly", status: "Active",
    pondType: "Water Garden", pondSize: "1,400 gal",
    equipment: [
      { name: "Patriot 1600 Pump", installed: "05/2022", status: "Good" },
      { name: "Skimmer Filter", installed: "05/2022", status: "Good" },
    ],
    history: [
      { date: "05/10/2026", tech: "B. Stone", type: "Monthly Service", notes: "Routine check. Water very clear. Plants thriving.", ammonia: "0.0", nitrite: "0.0", ph: "7.3", temp: "65°F", invoice: "$95" },
    ],
    nextService: "06/10/2026", balance: "$0.00",
  },
];

const BLANK_CLIENT = {
  name: "", address: "", street: "", city: "", state: "", zip: "",
  phone: "", email: "", division: "Pond",
  plan: "Essential", planFreq: "Monthly", status: "Active",
  pondType: "Koi Pond", pondSize: "",
  poolType: "", poolSize: "",
  seasonalType: "", seasonalSize: "",
  servicePond: false, servicePool: false, serviceSeasonal: false,
  equipment: [], history: [],
  nextService: "", balance: "$0.00",
  referralSource: "",   // How they found SPS
  referredBy: "",       // Client name who referred them
};

const DIVISIONS = ["Pond", "Pool", "Seasonal"];

// Returns the "My ___" label for the client portal tab based on division
function pondLabel(client, withCare = false) {
  const div = (client.division || "").toLowerCase();
  const base = div === "pond" ? "My Pond" : div === "pool" ? "My Pool" : "My Property";
  return withCare ? base + " Care" : base;
}
const PLANS = ["Essential", "Signature", "Premium"];

// Returns all active service divisions for a client (primary + any extras toggled on)
function clientServices(client, tierData) {
  const all = [];
  const div = client.division || "Pond";
  all.push({ div, type: client[div.toLowerCase() + "Type"] || "", size: client[div.toLowerCase() + "Size"] || "" });
  const allDivs = getDivisions(tierData);
  allDivs.forEach(d => {
    if (d !== div && client["service" + d]) {
      all.push({ div: d, type: client[d.toLowerCase() + "Type"] || "", size: client[d.toLowerCase() + "Size"] || "" });
    }
  });
  return all;
}

// Per-division labels, icon, and type options so the app fits all three divisions.
const DIVISION_META = {
  Pond: {
    icon: "🐟", siteLabel: "Pond", typeLabel: "Pond Type", sizeLabel: "Volume",
    typeOptions: ["Koi Pond", "Ecosystem Pond", "Water Garden", "Pondless Waterfall", "Natural Pond"],
  },
  Pool: {
    icon: "🏊", siteLabel: "Pool", typeLabel: "Pool Type", sizeLabel: "Volume",
    typeOptions: ["In-Ground", "Above-Ground", "Saltwater", "Chlorine", "Spa / Hot Tub"],
  },
  Seasonal: {
    icon: "🍂", siteLabel: "Property", typeLabel: "Service Type", sizeLabel: "Property Size",
    typeOptions: ["Leaf Removal", "Gutter Cleaning", "Full Property", "Snow Removal"],
  },
};
const dMeta = (division) => DIVISION_META[division] || DIVISION_META.Pond;

// User-editable catalog: stop types, services (with required products + tests), products, and tests.
const DEFAULT_CATALOG = {
  stopTypes: [
    "Weekly Service", "Bi-Weekly Service", "Monthly Service",
    "Spring Startup", "Fall Closing", "Repair Visit",
    "Installation", "Estimate / Quote", "One-Time Cleaning",
  ],
  tests: ["pH", "Ammonia", "Nitrite", "Nitrate", "Temperature", "Alkalinity", "Phosphate"],
  services: [
    { id: "s1", name: "Pond Water Treatment", price: "45", products: ["p1", "p2"], tests: ["pH", "Ammonia", "Nitrite"] },
    { id: "s2", name: "Filter Cleaning", price: "65", products: ["p4"], tests: ["pH", "Ammonia"] },
    { id: "s3", name: "Algae Treatment", price: "55", products: ["p3", "p5"], tests: ["pH", "Phosphate", "Nitrate"] },
    { id: "s4", name: "Full System Inspection", price: "95", products: [], tests: ["pH", "Ammonia", "Nitrite", "Nitrate", "Temperature", "Alkalinity"] },
    { id: "s5", name: "Spring Opening", price: "295", products: ["p1", "p4"], tests: ["pH", "Ammonia", "Nitrite", "Temperature"] },
    { id: "s6", name: "Fall Closing", price: "265", products: ["p2"], tests: ["pH", "Temperature"] },
  ],
  products: [
    { id: "p1", name: "Beneficial Bacteria", price: "32" },
    { id: "p2", name: "Barley Straw Extract", price: "24" },
    { id: "p3", name: "EcoBlast Algae Remover", price: "38" },
    { id: "p4", name: "Filter Pad (replacement)", price: "18" },
    { id: "p5", name: "Pond Dye", price: "22" },
  ],
  // treatments are consumables tracked by the ounce, with OUR cost per oz + inventory on hand
  treatments: [
    { id: "t1", name: "Beneficial Bacteria (liquid)", costPerOz: "0.85", inventoryOz: "256" },
    { id: "t2", name: "Algaecide", costPerOz: "1.20", inventoryOz: "128" },
    { id: "t3", name: "Water Clarifier", costPerOz: "0.65", inventoryOz: "192" },
    { id: "t4", name: "Dechlorinator", costPerOz: "0.40", inventoryOz: "320" },
    { id: "t5", name: "Pond Salt", costPerOz: "0.10", inventoryOz: "512" },
  ],
};

// Admin cost assumptions. Labor is hourly. Each overhead line is either per-stop or per-month.
const DEFAULT_COSTS = {
  hourlyRate: "28",
  gas:       { amount: "9",   mode: "stop" },
  insurance: { amount: "400", mode: "month" },
  equipment: { amount: "12",  mode: "stop" },
  overhead:  { amount: "800", mode: "month" },
};
const COST_LINES = ["gas", "insurance", "equipment", "overhead"];
const costLine = (c) => (typeof c === "object" && c !== null) ? c : { amount: String(c ?? "0"), mode: "stop" };

// Per-stop portion of overhead (only lines set to per-stop apply to each job)
function perStopCosts(costs) {
  const n = (v) => parseFloat(v) || 0;
  const val = (k) => { const l = costLine(costs[k]); return l.mode === "stop" ? n(l.amount) : 0; };
  return { gas: val("gas"), insurance: val("insurance"), equipment: val("equipment"), overhead: val("overhead") };
}
// Sum of per-month overhead lines (fixed monthly cost, used in the Budget)
function monthlyFixedCosts(costs) {
  const n = (v) => parseFloat(v) || 0;
  return COST_LINES.reduce((s, k) => { const l = costLine(costs[k]); return s + (l.mode === "month" ? n(l.amount) : 0); }, 0);
}

const DEFAULT_SCHEDULE = [
  { date: "06/04/2026", day: "Today", stops: [
    { sid: "a1", time: "8:00 AM", client: "Thomas & Karen Wells", address: "88 Mill Road, Coatesville", type: "Weekly Service", duration: "90 min", id: 2, assigneeId: "e2" },
    { sid: "a2", time: "10:30 AM", client: "Robert & Linda Harmon", address: "412 Covered Bridge Rd, Honey Brook", type: "Bi-Weekly Service", duration: "75 min", id: 1, assigneeId: "e1" },
  ]},
  { date: "06/05/2026", day: "Tomorrow", stops: [
    { sid: "a3", time: "9:00 AM", client: "Susan Moretti", address: "7 Quarry Lane, Parkesburg", type: "Monthly Service", duration: "60 min", id: 3, assigneeId: "e2" },
  ]},
  { date: "06/11/2026", day: "Wed 6/11", stops: [
    { sid: "a4", time: "9:00 AM", client: "Robert & Linda Harmon", address: "412 Covered Bridge Rd, Honey Brook", type: "Bi-Weekly Service", duration: "75 min", id: 1, assigneeId: "e1" },
    { sid: "a5", time: "11:00 AM", client: "Thomas & Karen Wells", address: "88 Mill Road, Coatesville", type: "Weekly Service", duration: "90 min", id: 2, assigneeId: "e2" },
  ]},
];

// Editable service-report email/text template
const DEFAULT_EMAIL = {
  fromName: "Stone Property Solutions",
  fromAddress: "service@stonepropertysolutions.com",
  subject: "Your Service Report — {date}",
  intro: "Thanks for trusting us with your property. Here's a summary of today's visit.",
  signoff: "Questions? Just reply to this email or give us a call.",
  footer: "",                 // small print under every email (address, license #, etc.)
  showReadings: true,
  showPhotosNote: true,
  // text-message templates ({first}, {sender}, {company}, {eta}, {arrival}, {track})
  senderName: "Brandon",
  trackLink: "",
  smsOnMyWay: "Hi {first}, this is {sender} with {company}. I'm on my way and should arrive in about {eta} minutes (around {arrival}). {track}See you soon!",
  smsReminder: "Hi {first}, a friendly reminder from {company} that your service is scheduled for {date}. Reply here with any questions!",
};

// Build the report text from the template + a completed-visit record
function renderReport(email, ctx, { plain = false } = {}) {
  const lines = [];
  lines.push(`Hi ${ctx.firstName},`);
  lines.push("");
  lines.push(email.intro);
  lines.push("");
  lines.push(`Service: ${ctx.serviceType}`);
  lines.push(`Date: ${ctx.date}`);
  if (ctx.tech) lines.push(`Technician: ${ctx.tech}`);
  lines.push("");
  if (ctx.notes) { lines.push("Work completed:"); lines.push(ctx.notes); lines.push(""); }
  if (email.showReadings && (ctx.ph || ctx.ammonia || ctx.nitrite || ctx.temp)) {
    lines.push(`Water readings: pH ${ctx.ph || "-"} · Ammonia ${ctx.ammonia || "-"} · Nitrite ${ctx.nitrite || "-"} · Temp ${ctx.temp || "-"}`);
    lines.push("");
  }
  if (email.showPhotosNote && ctx.photoCount > 0) {
    const beforeCt = ctx.photosBeforeCount || 0;
    const afterCt  = ctx.photosAfterCount  || 0;
    const otherCt  = ctx.photoCount - beforeCt - afterCt;
    const parts = [];
    if (beforeCt) parts.push(`${beforeCt} before`);
    if (afterCt)  parts.push(`${afterCt} after`);
    if (otherCt)  parts.push(`${otherCt} additional`);
    const photoDesc = parts.length ? ` (${parts.join(", ")})` : "";
    lines.push(`We took ${ctx.photoCount} photo${ctx.photoCount === 1 ? "" : "s"}${photoDesc} during today's visit — you can view them anytime in your client portal.`);
    lines.push("");
  }
  lines.push(email.signoff);
  lines.push("");
  lines.push(`— The ${ctx.company} Team`);
  return lines.join("\n");
}

// Compress an image — keeps original quality unless result exceeds 1MB,
// then iteratively reduces quality by 0.05 until it fits.
function compressImage(file, maxDim = 1600) {
  const MAX_BYTES = 1 * 1024 * 1024; // 1 MB
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Only downscale if the image is very large (keep detail)
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        // Start at full quality, step down only if needed
        let quality = 0.95;
        let result  = "";
        try {
          do {
            result  = canvas.toDataURL("image/jpeg", quality);
            // base64 is ~4/3 the binary size
            const approxBytes = Math.round((result.length - 22) * 3 / 4);
            if (approxBytes <= MAX_BYTES) break;
            quality = Math.round((quality - 0.05) * 100) / 100;
          } while (quality >= 0.30);
          resolve(result);
        } catch (err) {
          resolve(e.target.result); // fallback to original
        }
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
const planMeta = (plan, T, tiers, div) => {
  if (!plan) return { bg: T.surfaceAlt, text: T.textMuted, color: T.textMuted, label: "No tier" };
  const divKey = div || "Pond";
  const divTierSet = (tiers || {})[divKey] || (tiers || {});
  const tierColor = divTierSet[plan]?.color;
  return ({
    Premium:   { bg: tierColor || T.primary,  text: "#fff", color: "#fff" },
    Signature: { bg: tierColor || "#6366F1",   text: "#fff", color: "#fff" },
    Essential: { bg: tierColor || T.surfaceAlt, text: tierColor ? "#fff" : T.text, color: tierColor ? "#fff" : T.text },
  }[plan] || { bg: T.surfaceAlt, text: T.textMuted, color: T.textMuted, label: plan });
};

const statusColor = (s, T) => ({
  Good:          T.accent,
  Monitor:       T.warning,
  "Replace Soon": T.primary,
}[s] || T.textMuted);

// Sum revenue/cost/profit from completed jobs in a given month (default: current)
function monthActuals(clients, when = new Date(), invoices = []) {
  const m = when.getMonth(), y = when.getFullYear();
  let revenue = 0, cost = 0, jobs = 0;

  // Count completed stops with breakdowns (field cost tracking)
  (clients || []).forEach(c => (c.history || []).forEach(h => {
    if (!h.breakdown) return;
    const [mm, dd, yy] = (h.date || "").split("/").map(Number);
    if (mm - 1 === m && yy === y) {
      cost += h.breakdown.total || 0;
      jobs += 1;
    }
  }));

  // Count revenue from paid invoices this month (primary revenue source)
  (invoices || []).forEach(iv => {
    if (iv.status !== "Paid" && effectiveStatus(iv) !== "Paid") return;
    const paidDate = iv.paidDate || iv.date;
    let d = null;
    if (paidDate) {
      // Handle both MM/DD/YYYY and YYYY-MM-DD formats
      if (paidDate.includes("/")) {
        const [mm, dd, yy] = paidDate.split("/").map(Number);
        d = new Date(yy, mm - 1, dd);
      } else {
        d = new Date(paidDate);
      }
    }
    if (d && d.getMonth() === m && d.getFullYear() === y) {
      revenue += invoiceTotals(iv).total;
    }
  });

  // If no invoices tracked yet, fall back to stop-based revenue
  if (revenue === 0) {
    (clients || []).forEach(c => (c.history || []).forEach(h => {
      if (!h.breakdown) return;
      const [mm, dd, yy] = (h.date || "").split("/").map(Number);
      if (mm - 1 === m && yy === y) {
        revenue += h.breakdown.revenue || 0;
      }
    }));
  }

  return { revenue, cost, profit: revenue - cost, jobs };
}

// derive outstanding balances + equipment flags into alert items
function deriveAlerts(clients, invoices, catalog) {
  const alerts = [];
  (clients || []).forEach(c => {
    (c.equipment || []).forEach(e => {
      if (e.status && e.status !== "Good") alerts.push({ icon: "warning", title: `${c.name} — ${e.name}`, sub: `Marked "${e.status}"` });
    });
    const owed = clientOutstanding(c, invoices);
    if (owed > 0) alerts.push({ icon: "dollar", title: `${c.name} — $${owed.toFixed(2)} outstanding`, sub: "Open balance" });
  });
  // Low inventory alerts
  ((catalog && catalog.treatments) || []).forEach(t => {
    const oz = parseFloat(t.inventoryOz) || 0;
    if (oz < 32) alerts.unshift({ icon: "warning", title: `Low stock: ${t.name}`, sub: `${oz}oz remaining — consider restocking`, type: "inventory" });
  });
  return alerts.slice(0, 8);
}

// ── Invoicing ──
const INVOICE_STATUSES = ["Draft", "Sent", "Paid", "Overdue"];
const invStatusColor = (s, T) => {
  const n = (s||"").charAt(0).toUpperCase() + (s||"").slice(1).toLowerCase();
  return { Draft: T.textMuted, Sent: T.primary, Paid: T.accent, Overdue: T.warning }[n] || ({ paid: T.accent, overdue: T.warning, sent: T.primary }[(s||"").toLowerCase()] || T.textMuted);
};

const DEFAULT_INVOICING = {
  taxRate: "6",            // default sales-tax rate applied to taxable lines (PA = 6%)
  dueDays: 15,             // default days until due
  terms: "Thank you for your business. Payment is due within 15 days.",
  nextNumber: 1001,        // starting invoice number
  numberPrefix: "INV-",    // invoice number prefix
  accent: "",              // optional invoice accent color (blank = use theme primary)
  showLogo: true,          // show the company logo on invoices
  showContact: true,       // show business phone/email/website/address block
  footer: "",              // small print at the bottom of every invoice
};

// date helpers (MM/DD/YYYY)
const parseMDY = (s) => { const [m, d, y] = (s || "").split("/").map(Number); return (m && d && y) ? new Date(y, m - 1, d) : null; };
const fmtMDY = (dt) => `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`;
const todayMDY = () => fmtMDY(new Date());
const addDaysMDY = (s, days) => { const dt = parseMDY(s) || new Date(); dt.setDate(dt.getDate() + (parseInt(days) || 0)); return fmtMDY(dt); };

const invoiceTotals = (inv) => {
  const n = (v) => parseFloat(v) || 0;
  // QB invoices store pre-calculated total directly
  if (inv.source === "quickbooks") {
    const total = n(inv.total);
    return { subtotal: total, taxableBase: 0, tax: 0, total };
  }
  const items = inv.lineItems || [];
  const subtotal = items.reduce((s, li) => s + n(li.qty) * n(li.unitPrice), 0);
  const taxableBase = items.reduce((s, li) => s + (li.taxable ? n(li.qty) * n(li.unitPrice) : 0), 0);
  const tax = taxableBase * (n(inv.taxRate) / 100);
  return { subtotal, taxableBase, tax, total: subtotal + tax };
};
// a Sent invoice past its due date reads as Overdue
const effectiveStatus = (inv) => {
  if (inv.status === "Sent") { const due = parseMDY(inv.dueDate); if (due && due < new Date(new Date().toDateString())) return "Overdue"; }
  return inv.status;
};
const nextInvoiceNumber = (invoices, cfg) => {
  const start = parseInt(cfg?.nextNumber) || 1001;
  const nums = (invoices || []).map(iv => parseInt(String(iv.number).replace(/\D/g, ""))).filter(x => !isNaN(x));
  const max = nums.length ? Math.max(...nums) : start - 1;
  return Math.max(max + 1, start);
};
// Sort invoices: highest invoice number first, fall back to most recent date
const sortInvoices = (arr) => [...arr].sort((a, b) => {
  const na = parseInt((String(a.number || "0")).replace(/[^0-9]/g, "")) || 0;
  const nb = parseInt((String(b.number || "0")).replace(/[^0-9]/g, "")) || 0;
  if (nb !== na) return nb - na;
  // Fall back to date
  const parseD = (s) => {
    if (!s) return 0;
    if (typeof s === "string" && s.includes("/")) { const [m,d,y] = s.split("/").map(Number); return new Date(y,m-1,d).getTime(); }
    if (typeof s === "string" && s.includes("-")) return new Date(s + "T00:00:00").getTime();
    return 0;
  };
  const da = parseD(a.date) || (a.createdAt || 0);
  const db = parseD(b.date) || (b.createdAt || 0);
  return db - da;
});

const clientInvoicesOf = (invoices, clientId, client) => {
  if (client) return (invoices || []).filter(iv => invoiceMatchesClient(iv, client));
  return (invoices || []).filter(iv => iv.clientId === clientId);
};
// what a client owes: from their unpaid invoices if any exist, else the stored balance
// Match invoice to client — by ID or by name (for QB imports)
const invoiceMatchesClient = (iv, client) =>
  iv.clientId === client.id ||
  (iv.clientId === null && iv.clientName &&
   iv.clientName.toLowerCase().trim() === (client.name || "").toLowerCase().trim());

const clientOutstanding = (client, invoices) => {
  const list = clientInvoicesOf(invoices, client.id, client);
  if (list.length) {
    const isPaidStatus = (iv) => ["Paid","paid"].includes(effectiveStatus(iv));
    return list
      .filter(iv => !isPaidStatus(iv) && iv.status !== "Draft" && iv.status !== "draft")
      .reduce((s, iv) => s + invoiceTotals(iv).total, 0);
  }
  return parseFloat((client.balance || "").replace(/[^\d.]/g, "")) || 0;
};

const DEMO_INVOICES = [
  {
    id: "inv1001", number: "INV-1001", clientId: 2, date: "05/28/2026", dueDate: "06/12/2026", status: "Sent",
    lineItems: [
      { id: "l1", desc: "Bi-Weekly Pond Service", qty: "1", unitPrice: "165", taxable: false },
      { id: "l2", desc: "Beneficial Bacteria treatment", qty: "1", unitPrice: "30", taxable: true },
    ],
    taxRate: "6", notes: "Thank you for your business. Payment is due within 15 days.", createdAt: 0,
  },
  {
    id: "inv1000", number: "INV-1000", clientId: 1, date: "05/15/2026", dueDate: "05/30/2026", status: "Paid", paidDate: "05/22/2026",
    lineItems: [{ id: "l1", desc: "Monthly Pond Maintenance", qty: "1", unitPrice: "185", taxable: false }],
    taxRate: "6", notes: "Thank you for your business.", createdAt: 0,
  },
];

const HOME_WIDGETS = { stats: "Key Stats", profit: "This Month P&L", todayRoute: "Today's Route", alerts: "Alerts" };
const DEFAULT_HOME = { items: [
  { id: "stats", on: true },
  { id: "profit", on: true },
  { id: "todayRoute", on: true },
  { id: "alerts", on: true },
] };

// Admin budget: expected monthly money in/out (customizable lines)
const DEFAULT_BUDGET = {
  income: [
    { id: "i1", label: "Service Revenue (target)", amount: "12000" },
  ],
  expenses: [
    { id: "e1", label: "Payroll", amount: "4500" },
    { id: "e2", label: "Insurance", amount: "400" },
    { id: "e3", label: "Vehicle & Gas", amount: "900" },
    { id: "e4", label: "Equipment", amount: "1200" },
    { id: "e5", label: "Software & Subscriptions", amount: "300" },
    { id: "e6", label: "Other Overhead", amount: "800" },
  ],
};

// ─────────────────────────────────────────────
// SHARED UI
// ─────────────────────────────────────────────
function Badge({ label, bg, color, sm }) {
  return (
    <span style={{
      background: bg, color,
      padding: sm ? "3px 9px" : "4px 12px",
      borderRadius: 100,
      fontSize: sm ? 9 : 10,
      fontWeight: 600,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function Card({ children, style }) {
  const { T } = useApp();
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: 20,
      overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
      ...style,
    }}>{children}</div>
  );
}

function CardHeader({ title, action }) {
  const { T } = useApp();
  return (
    <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontWeight: 700, fontSize: 13, color: T.text, letterSpacing: "-0.01em" }}>{title}</span>
      {action}
    </div>
  );
}

function Btn({ children, onClick, href, variant = "primary", sm, lg, block, disabled, style }) {
  const { T } = useApp();
  const styles = {
    primary: { background: T.primary, color: "#fff", border: "none", boxShadow: `0 1px 2px ${hexA(T.primary, 0.3)}, 0 4px 12px ${hexA(T.primary, 0.2)}` },
    accent:  { background: T.accent, color: "#fff", border: "none", boxShadow: `0 1px 2px ${hexA(T.accent, 0.3)}, 0 4px 12px ${hexA(T.accent, 0.2)}` },
    ghost:   { background: T.surfaceAlt, color: T.text, border: `1px solid ${T.border}` },
    outline: { background: "transparent", color: T.primary, border: `1.5px solid ${hexA(T.primary, 0.4)}` },
    danger:  { background: "#E5484D", color: "#fff", border: "none", boxShadow: `0 1px 2px ${hexA("#E5484D", 0.3)}, 0 4px 12px ${hexA("#E5484D", 0.2)}` },
    text:    { background: "transparent", color: T.primary, border: "none" },
  };
  const css = {
    ...(styles[variant] || styles.primary),
    borderRadius: lg ? 14 : sm ? 10 : 12,
    padding: lg ? "14px 24px" : sm ? "7px 14px" : "10px 18px",
    fontSize: lg ? 15 : sm ? 12 : 13.5,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.45 : 1,
    fontFamily: "inherit",
    letterSpacing: "-0.01em",
    width: block ? "100%" : undefined,
    display: block ? "flex" : (href ? "inline-flex" : "inline-flex"),
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    textDecoration: "none",
    boxSizing: "border-box",
    transition: "opacity 0.15s, transform 0.08s",
    ...style,
  };
  if (href) return <a href={href} onClick={onClick} style={css}>{children}</a>;
  return <button onClick={onClick} disabled={disabled} style={css}>{children}</button>;
}

function StatCard({ label, value, sub, accent, onClick }) {
  const { T } = useApp();
  const clickable = !!onClick;
  return (
    <div onClick={onClick}
      style={{
        background: T.surface,
        border: `1px solid ${clickable ? hexA(accent || T.primary, 0.25) : T.border}`,
        borderRadius: 20,
        padding: "18px 18px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
        cursor: clickable ? "pointer" : "default",
        transition: "box-shadow 0.15s, transform 0.1s",
        WebkitTapHighlightColor: "transparent",
        position: "relative",
      }}
      onMouseEnter={e => { if (clickable) e.currentTarget.style.boxShadow = "0 4px 20px rgba(0,0,0,0.12)"; }}
      onMouseLeave={e => { if (clickable) e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)"; }}
      onTouchStart={e => { if (clickable) e.currentTarget.style.transform = "scale(0.97)"; }}
      onTouchEnd={e => { if (clickable) e.currentTarget.style.transform = "scale(1)"; }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: T.textMuted, textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {label}
        {clickable && (
          <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <path d="m9 18 6-6-6-6"/>
          </svg>
        )}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, color: accent && accent !== T.surface ? accent : T.text, lineHeight: 1, letterSpacing: "-0.03em" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function Collapsible({ title, subtitle, children, defaultOpen = false }) {
  const { T } = useApp();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, overflow: "hidden", marginBottom: 14 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left", gap: 12, WebkitTapHighlightColor: "transparent" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>{title}</div>
          {subtitle && !open && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div>}
        </div>
        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transition: "transform 0.2s ease", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "16px 18px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }) {
  const { T } = useApp();
  return (
    <div>
      <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text" }) {
  const { T } = useApp();
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ width: "100%", padding: "12px 14px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 15, fontFamily: "inherit", boxSizing: "border-box", outline: "none", color: T.text, background: T.surface }} />
  );
}

function Select({ value, onChange, options }) {
  const { T } = useApp();
  return (
    <select value={value} onChange={onChange}
      style={{ width: "100%", padding: "11px 14px", border: `1px solid ${T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", appearance: "none", WebkitAppearance: "none" }}>
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

// ─────────────────────────────────────────────
// DASHBOARD (configurable home)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// UPGRADE WORKFLOW MODAL
// 4-step process for handling a client upgrade request.
// Step 1: Contact confirmation
// Step 2: Contract sent (Dropbox Sign)
// Step 3: Upload signed document
// Step 4: Apply the plan change
// ─────────────────────────────────────────────

const UPGRADE_STEPS = [
  { id: "contact",  label: "Contact Client",     sub: "Confirm interest and discuss new pricing" },
  { id: "contract", label: "Send Contract",       sub: "Send updated service agreement via Dropbox Sign" },
  { id: "document", label: "Upload Signed Doc",   sub: "Download from Dropbox Sign and attach here" },
  { id: "apply",    label: "Apply Plan Change",   sub: "Update their plan in the app — they'll see it immediately" },
];

function UpgradeWorkflowModal({ alert: a, clients, T, onConfirm, onClose }) {
  const client = (clients || []).find(c => String(c.id) === String(a.clientId));
  const completedSteps = a.upgradeStep || 0; // 0–4
  const [activeStep, setActiveStep] = useState(completedSteps);
  const [contactNote, setContactNote] = useState(a.contactNote || "");
  const [contractNote, setContractNote] = useState(a.contractNote || "");
  const [uploadedDoc, setUploadedDoc] = useState(a.signedDoc || null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const fmtSize = (bytes) => bytes > 1e6 ? `${(bytes/1e6).toFixed(1)} MB` : `${(bytes/1e3).toFixed(0)} KB`;

  const handleDocUpload = (files) => {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = e => {
      setUploadedDoc({ src: e.target.result, name: file.name, size: file.size, type: file.type });
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const completeStep = (stepIdx) => {
    const newCount = Math.max(completedSteps, stepIdx + 1);
    const updated = { ...a, upgradeStep: newCount, contactNote, contractNote, signedDoc: uploadedDoc };
    if (stepIdx === 3) updated.fullyComplete = true;
    onConfirm(updated, client ? { ...client, plan: a.requestedPlan } : null);
    if (stepIdx < 3) setActiveStep(stepIdx + 1);
  };

  const StepCheck = ({ done }) => (
    <div style={{ width: 22, height: 22, borderRadius: "50%", background: done ? "#16a34a" : T.surfaceAlt, border: `2px solid ${done ? "#16a34a" : T.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {done && <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>}
    </div>
  );

  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const lbl   = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };

  return (
    <Modal title="Process Upgrade" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Client + plan summary */}
        <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "14px 16px" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginBottom: 6 }}>{a.clientName || a.client}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, background: T.surface, borderRadius: 8, padding: "4px 12px", color: T.text }}>{a.currentPlan}</span>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            <span style={{ fontSize: 12, fontWeight: 800, background: hexA(T.primary, 0.1), borderRadius: 8, padding: "4px 12px", color: T.primary }}>{a.requestedPlan}</span>
          </div>
          {a.body && a.body !== "No additional message." && (
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8, fontStyle: "italic", lineHeight: 1.5 }}>"{a.body}"</div>
          )}
        </div>

        {/* Step list */}
        {UPGRADE_STEPS.map((step, i) => {
          const done = completedSteps > i;
          const active = activeStep === i;
          const locked = i > completedSteps;

          return (
            <div key={step.id}>
              {/* Step header */}
              <button onClick={() => !locked && setActiveStep(active ? -1 : i)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, background: "none", border: "none", cursor: locked ? "default" : "pointer", fontFamily: "inherit", padding: "4px 0", textAlign: "left" }}>
                <StepCheck done={done} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: locked ? T.textMuted : done ? "#16a34a" : T.text }}>
                    {i + 1}. {step.label}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{step.sub}</div>
                </div>
                {!locked && !done && (
                  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" style={{ transform: active ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                )}
              </button>

              {/* Step content */}
              {active && !done && (
                <div style={{ marginLeft: 34, marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  {/* ── Step 1: Contact ── */}
                  {i === 0 && (
                    <>
                      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                        Call or message {a.clientName || "the client"} to confirm they want to upgrade, discuss the new pricing, and let them know a contract is coming.
                      </div>
                      {client?.phone && (
                        <a href={`tel:${client.phone}`}
                          style={{ display: "flex", alignItems: "center", gap: 10, background: hexA(T.primary, 0.08), borderRadius: 12, padding: "12px 14px", color: T.primary, textDecoration: "none" }}>
                          <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.61 4.44 2 2 0 0 1 3.6 2.24h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.12 6.12l.95-.95a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>Call {client.phone}</span>
                        </a>
                      )}
                      <div>
                        <label style={lbl}>Contact Note <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></label>
                        <input type="text" style={field} value={contactNote} onChange={e => setContactNote(e.target.value)} placeholder="e.g. Spoke with client, confirmed $175/mo for Signature" />
                      </div>
                      <button onClick={() => completeStep(0)}
                        style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 14px ${hexA(T.primary, 0.3)}` }}>
                        Mark as Contacted — Next Step
                      </button>
                    </>
                  )}

                  {/* ── Step 2: Contract sent ── */}
                  {i === 1 && (
                    <>
                      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                        Send the updated service agreement through Dropbox Sign. Use your existing template with the new tier and pricing filled in.
                      </div>
                      <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: "12px 14px" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 4 }}>Quick checklist before sending:</div>
                        {[
                          `Updated plan: ${a.requestedPlan}`,
                          "New monthly rate confirmed",
                          "Service frequency updated",
                          "Client name and address correct",
                        ].map((item, ii) => (
                          <div key={ii} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12, color: T.textMuted }}>
                            <div style={{ width: 5, height: 5, borderRadius: "50%", background: T.primary, flexShrink: 0 }} />
                            {item}
                          </div>
                        ))}
                      </div>
                      <div>
                        <label style={lbl}>Contract Note <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></label>
                        <input type="text" style={field} value={contractNote} onChange={e => setContractNote(e.target.value)} placeholder="e.g. Sent via Dropbox Sign 1/15/25" />
                      </div>
                      <button onClick={() => completeStep(1)}
                        style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 14px ${hexA(T.primary, 0.3)}` }}>
                        Mark Contract Sent — Next Step
                      </button>
                    </>
                  )}

                  {/* ── Step 3: Upload signed doc ── */}
                  {i === 2 && (
                    <>
                      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                        Once {a.clientName || "the client"} signs, download the completed PDF from Dropbox Sign and upload it here. It will be saved to their Documents tab.
                      </div>
                      <input ref={fileInputRef} type="file" accept=".pdf,application/pdf,image/*"
                        style={{ display: "none" }}
                        onChange={e => { handleDocUpload(e.target.files); e.target.value = ""; }} />

                      {uploadedDoc ? (
                        <div style={{ background: hexA("#16a34a", 0.06), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{ width: 40, height: 40, borderRadius: 12, background: hexA("#E5484D", 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="#E5484D" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uploadedDoc.name}</div>
                            <div style={{ fontSize: 11, color: T.textMuted }}>{fmtSize(uploadedDoc.size)}</div>
                          </div>
                          <button onClick={() => setUploadedDoc(null)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4 }}>
                            <Icon name="close" size={14} />
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => fileInputRef.current?.click()}
                          style={{ padding: "20px 16px", border: `2px dashed ${T.border}`, borderRadius: 14, background: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: T.textMuted, width: "100%" }}>
                          <div style={{ width: 44, height: 44, borderRadius: 13, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <Icon name="download" size={22} />
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Upload Signed Contract</div>
                          <div style={{ fontSize: 12, color: T.textMuted }}>PDF from Dropbox Sign · tap to choose</div>
                        </button>
                      )}

                      <div style={{ display: "flex", gap: 10 }}>
                        <button onClick={() => completeStep(2)} disabled={!uploadedDoc}
                          style={{ flex: 1, background: uploadedDoc ? T.primary : T.surfaceAlt, color: uploadedDoc ? "#fff" : T.textMuted, border: "none", borderRadius: 12, padding: "13px", fontWeight: 800, fontSize: 14, cursor: uploadedDoc ? "pointer" : "default", fontFamily: "inherit", boxShadow: uploadedDoc ? `0 4px 14px ${hexA(T.primary, 0.3)}` : "none", transition: "all 0.2s" }}>
                          Save Document — Next Step
                        </button>
                        <button onClick={() => completeStep(2)}
                          style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 12, padding: "13px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                          Upload Later
                        </button>
                      </div>
                      {!uploadedDoc && (
                        <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center" }}>You can upload the document later from the client's Docs tab.</div>
                      )}
                    </>
                  )}

                  {/* ── Step 4: Apply plan change ── */}
                  {i === 3 && (
                    <>
                      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                        This is the final step. The client's plan will be changed from <strong style={{ color: T.text }}>{a.currentPlan}</strong> to <strong style={{ color: T.primary }}>{a.requestedPlan}</strong> in the app. They will see the update immediately when they open their portal.
                      </div>

                      {/* Confirmation checklist */}
                      <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                        {[
                          { label: "Client contacted and confirmed", done: completedSteps >= 1 },
                          { label: "Contract sent via Dropbox Sign", done: completedSteps >= 2 },
                          { label: "Signed document on file", done: !!uploadedDoc || (a.signedDoc != null) },
                        ].map((item, ii) => (
                          <div key={ii} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ width: 18, height: 18, borderRadius: "50%", background: item.done ? hexA("#16a34a", 0.15) : T.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              {item.done && <svg viewBox="0 0 24 24" width={10} height={10} fill="none" stroke="#16a34a" strokeWidth={3} strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>}
                            </div>
                            <span style={{ fontSize: 13, color: item.done ? T.text : T.textMuted, fontWeight: item.done ? 600 : 400 }}>{item.label}</span>
                          </div>
                        ))}
                      </div>

                      {!(uploadedDoc || a.signedDoc) && (
                        <div style={{ background: hexA("#F59E0B", 0.08), border: `1px solid ${hexA("#F59E0B", 0.2)}`, borderRadius: 12, padding: "11px 14px", fontSize: 12, color: "#92400E", display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.5 }}>
                          <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                          No signed document uploaded yet. You can still apply the plan change, but consider uploading the contract first.
                        </div>
                      )}

                      <button onClick={() => completeStep(3)}
                        style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "15px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 16px rgba(22,163,74,0.3)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                        Confirm Upgrade to {a.requestedPlan}
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Done state inline */}
              {done && i < 3 && (
                <div style={{ marginLeft: 34, marginTop: 4 }}>
                  {i === 0 && contactNote && <div style={{ fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>{contactNote}</div>}
                  {i === 1 && contractNote && <div style={{ fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>{contractNote}</div>}
                  {i === 2 && (uploadedDoc || a.signedDoc) && (
                    <div style={{ fontSize: 12, color: "#16a34a", fontWeight: 600 }}>{(uploadedDoc || a.signedDoc)?.name}</div>
                  )}
                </div>
              )}

              {/* Divider between steps */}
              {i < UPGRADE_STEPS.length - 1 && (
                <div style={{ marginLeft: 11, marginTop: 6, width: 1, height: 16, background: completedSteps > i ? "#16a34a" : T.border }} />
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function Dashboard({ clients, invoices, schedule, home, setHome, officeAlerts, onResolveAlert, onNav, catalog, onConfirmUpgrade }) {
  const { T, perms } = useApp();
  const [editing, setEditing] = useState(false);

  const today = (schedule && schedule[0]) || { stops: [] };
  const [upgradeModal, setUpgradeModal] = useState(null); // alert object being confirmed
  const ma = monthActuals(clients, new Date(), invoices);
  const derived = deriveAlerts(clients, invoices, catalog).filter(a => perms.seeBalances || !/outstanding/i.test(a.title || ""));
  const flags = (officeAlerts || []).filter(a => !a.resolved);
  const outstandingClients = (clients || []).map(c => ({ c, owed: clientOutstanding(c, invoices) })).filter(x => x.owed > 0);
  const outstandingTotal = outstandingClients.reduce((s, x) => s + x.owed, 0);
  const money = (n) => `$${Math.round(n).toLocaleString()}`;

  const items = (home && home.items) || DEFAULT_HOME.items;
  const setItems = (next) => setHome({ ...home, items: next });
  const removeWidget = (id) => setItems(items.filter(it => it.id !== id));
  const addWidget = (id) => setItems([...items, { id, on: true }]);
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  const available = Object.keys(HOME_WIDGETS).filter(id => !items.some(it => it.id === id));

  const widget = (id) => {
    if (id === "stats") {
      const tiles = [
        {
          label: "Active Clients", value: clients.length,
          sub: "All divisions", accent: T.primary,
          onClick: () => onNav("clients", {}),
        },
        {
          label: "Stops Today", value: today.stops.length,
          sub: today.stops.length === 1 ? "Tap to view" : "Tap to view schedule", accent: T.primary,
          onClick: () => onNav("schedule"),
        },
      ];
      if (perms.seeBalances) tiles.push({
        label: "Outstanding", value: money(outstandingTotal),
        sub: `${outstandingClients.length} ${outstandingClients.length === 1 ? "client" : "clients"} · tap to view`,
        accent: outstandingTotal > 0 ? T.warning : T.accent,
        onClick: () => onNav("invoices", { invoiceFilter: "Overdue" }),
      });
      if (perms.seeProfit) tiles.push({
        label: "Profit (mo)", value: money(ma.profit),
        sub: `${ma.jobs} jobs · tap for reports`, accent: ma.profit >= 0 ? T.accent : "#C0392B",
        onClick: () => onNav("reports"),
      });
      else tiles.push({
        label: "Jobs (mo)", value: ma.jobs,
        sub: "Tap to view reports", accent: T.accent,
        onClick: () => onNav("reports"),
      });
      return (
        <div key="stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {tiles.map(t => <StatCard key={t.label} label={t.label} value={t.value} sub={t.sub} accent={t.accent} onClick={t.onClick} />)}
        </div>
      );
    }
    if (id === "profit") {
      if (!perms.seeProfit) return null;
      return (
      <Card key="profit" style={{ marginBottom: 16 }}>
        <CardHeader title="This Month" action={<Btn variant="text" sm onClick={() => onNav("settings")}>Budget →</Btn>} />
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[["Revenue", ma.revenue, T.text],["Costs", ma.cost, T.textMuted],["Profit", ma.profit, ma.profit >= 0 ? T.accent : "#C0392B"]].map(([k, v, col]) => (
            <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: col, marginTop: 3 }}>{money(v)}</div>
            </div>
          ))}
        </div>
      </Card>
      );
    }
    if (id === "todayRoute") return (
      <Card key="todayRoute" style={{ marginBottom: 16 }}>
        <CardHeader title="Today's Route" action={<Btn variant="text" sm onClick={() => onNav("schedule")}>View All</Btn>} />
        {today.stops.length === 0 && <div style={{ padding: 18, fontSize: 13, color: T.textMuted }}>No stops scheduled today.</div>}
        {today.stops.map((s, i) => (
          <div key={i} style={{ padding: "14px 18px", borderBottom: i < today.stops.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "7px 10px", textAlign: "center", minWidth: 58, flexShrink: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.time.split(" ")[1]}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{s.time.split(" ")[0]}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{s.client}</div>
              <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.address}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{s.type}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>{s.duration}</div>
            </div>
          </div>
        ))}
      </Card>
    );
    if (id === "alerts") return (
      <Card key="alerts" style={{ marginBottom: 16 }}>
        <CardHeader title="Alerts" />
        {flags.length === 0 && derived.length === 0 && <div style={{ padding: 18, fontSize: 13, color: T.textMuted }}>All clear — no alerts right now.</div>}
        {/* office flags from the field (resolvable) */}
        {flags.map((a) => {
          const isUpgrade = a.type === "upgrade_request";
          return (
            <div key={a.id} style={{ padding: "16px 18px", borderBottom: `1px solid ${T.border}`, background: isUpgrade ? hexA(T.primary, 0.04) : `${T.warning}08` }}>
              {isUpgrade ? (
                /* ── Upgrade request card ── */
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <div style={{ width: 36, height: 36, borderRadius: 11, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke={T.primary} strokeWidth={2.2} strokeLinecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                      </div>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 14, color: T.text, letterSpacing: "-0.01em" }}>{a.clientName || a.client} wants to upgrade</div>
                        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{a.date}</div>
                      </div>
                    </div>
                    <button onClick={() => onResolveAlert && onResolveAlert(a.id)} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "3px 8px", fontSize: 10, fontWeight: 700, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Dismiss</button>
                  </div>
                  {/* Plan change */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, background: T.surfaceAlt, borderRadius: 8, padding: "5px 12px", color: T.text }}>{a.currentPlan}</span>
                    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    <span style={{ fontSize: 13, fontWeight: 800, background: hexA(T.primary, 0.1), borderRadius: 8, padding: "5px 12px", color: T.primary }}>{a.requestedPlan}</span>
                  </div>
                  {a.body && a.body !== "No additional message." && (
                    <div style={{ fontSize: 13, color: T.text, background: T.surfaceAlt, borderRadius: 10, padding: "10px 14px", marginBottom: 10, lineHeight: 1.5, fontStyle: "italic" }}>
                      "{a.body}"
                    </div>
                  )}
                  {/* Upgrade status badge if already in progress */}
                  {a.upgradeStep && a.upgradeStep > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      {["Contacted","Contract Sent","Doc Uploaded","Plan Updated"].slice(0, a.upgradeStep).map((s, si) => (
                        <span key={si} style={{ fontSize: 10, fontWeight: 700, background: hexA("#16a34a", 0.1), color: "#16a34a", borderRadius: 100, padding: "3px 9px" }}>{s}</span>
                      ))}
                    </div>
                  )}
                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setUpgradeModal(a)}
                      style={{ flex: 1, background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "10px 8px", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: `0 3px 12px ${hexA(T.primary, 0.3)}` }}>
                      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                      Process Upgrade
                    </button>
                    <button onClick={() => onResolveAlert && onResolveAlert(a.id)}
                      style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 10, padding: "10px 12px", fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                      Decline
                    </button>
                  </div>
                </div>
              ) : (
                /* ── Standard office alert ── */
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <Icon name="warning" size={18} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{a.client || a.clientName} — needs office attention</div>
                    <div style={{ fontSize: 12, color: T.textMuted }}>{a.message || a.body}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{a.date}</div>
                  </div>
                  <button onClick={() => onResolveAlert && onResolveAlert(a.id)} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Resolve</button>
                </div>
              )}
            </div>
          );
        })}
        {derived.map((a, i) => (
          <div key={"d" + i} style={{ padding: "14px 18px", borderBottom: i < derived.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: hexA(T.warning, 0.1), color: T.warning, display:"flex", alignItems:"center", justifyContent:"center", flexShrink: 0 }}><Icon name={a.icon || "warning"} size={17} /></div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{a.title}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{a.sub}</div>
            </div>
          </div>
        ))}
      </Card>
    );
    return null;
  };

  return (
    <div style={{ paddingBottom: 40 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 4, letterSpacing: "-0.01em" }}>{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: T.text, letterSpacing: "-0.03em" }}>Good morning, Brandon.</h2>
        </div>
        <Btn variant="ghost" sm onClick={() => setEditing(e => !e)}>{editing ? "Done" : "Edit"}</Btn>
      </div>

      {editing ? (
        <Card>
          <CardHeader title="Customize Home" />
          <div style={{ padding: 12 }}>
            {items.map((it, i) => (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 8px", borderBottom: i < items.length - 1 ? `1px solid ${T.border}` : "none" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <button onClick={() => move(i, -1)} disabled={i === 0} style={{ background: "none", border: "none", cursor: i === 0 ? "default" : "pointer", color: i === 0 ? T.border : T.textMuted, fontSize: 12, lineHeight: 1, padding: 0 }}>▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === items.length - 1} style={{ background: "none", border: "none", cursor: i === items.length - 1 ? "default" : "pointer", color: i === items.length - 1 ? T.border : T.textMuted, fontSize: 12, lineHeight: 1, padding: 0 }}>▼</button>
                </div>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: T.text }}>{HOME_WIDGETS[it.id]}</span>
                <button onClick={() => removeWidget(it.id)} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#C0392B", cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
              </div>
            ))}
            {items.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, padding: "10px 8px" }}>No widgets. Add some below.</div>}

            {available.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, padding: "0 8px 8px" }}>Add a widget</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, padding: "0 8px" }}>
                  {available.map(id => (
                    <button key={id} onClick={() => addWidget(id)}
                      style={{ padding: "8px 13px", borderRadius: 20, border: `1.5px dashed ${T.primary}`, background: T.surface, color: T.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                      + {HOME_WIDGETS[id]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: T.textMuted, padding: "12px 8px 4px" }}>Add or remove widgets and use the arrows to reorder your home screen.</div>
          </div>
        </Card>
      ) : (
        items.map(it => widget(it.id))
      )}
      {/* Upgrade workflow modal */}
      {upgradeModal && (
        <UpgradeWorkflowModal
          alert={upgradeModal}
          clients={clients}
          T={T}
          onConfirm={(updatedAlert, updatedClient) => {
            if (onConfirmUpgrade) onConfirmUpgrade(updatedAlert, updatedClient);
            if (updatedAlert.fullyComplete) {
              onResolveAlert && onResolveAlert(updatedAlert.id);
              setUpgradeModal(null);
            } else {
              setUpgradeModal(updatedAlert);
            }
          }}
          onClose={() => setUpgradeModal(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// CLIENT LIST
// ─────────────────────────────────────────────
function Checkbox({ checked, onChange, accent }) {
  const { T } = useApp();
  return (
    <div onClick={e => { e.stopPropagation(); onChange(); }}
      style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${checked ? (accent || T.primary) : T.border}`, background: checked ? (accent || T.primary) : T.surface, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", transition: "all 0.15s" }}>
      {checked && <Icon name="check" size={12} />}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  const { T } = useApp();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: T.surface, borderRadius: "26px 26px 0 0", width: "100%", maxWidth: 600, maxHeight: "92vh", overflowY: "auto", padding: "14px 22px 34px", boxShadow: T.shadowLg, border: `1px solid ${T.border}`, borderBottom: "none" }}>
        <div style={{ width: 38, height: 5, background: T.border, borderRadius: 100, margin: "0 auto 18px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 20, color: T.text, letterSpacing: "-0.02em" }}>{title}</div>
          <button onClick={onClose} style={{ background: T.surfaceAlt, border: "none", borderRadius: "50%", width: 30, height: 30, cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="close" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ClientList({ clients, onSelect, onAdd, onImport, onBatchUpdate, onBatchDelete, onBatchSchedule }) {
  const { T, perms, tiers } = useApp();
  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState({}); // { [id]: true }
  const [modal, setModal] = useState(null); // "division" | "plan" | "delete"

  const q = search.toLowerCase();
  const filtered = clients.filter(c =>
    (c.name || "").toLowerCase().includes(q) ||
    (c.address || "").toLowerCase().includes(q)
  );

  const selectedIds = Object.keys(selected).filter(k => selected[k]).map(Number);
  const selCount = selectedIds.length;
  const allSelected = filtered.length > 0 && filtered.every(c => selected[c.id]);

  const toggle = (id) => setSelected(s => ({ ...s, [id]: !s[id] }));
  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(filtered.map(c => [c.id, true])));
  };
  const exitSelect = () => { setSelectMode(false); setSelected({}); };

  const applyDivision = (div) => { onBatchUpdate(selectedIds, { division: div }); setModal(null); exitSelect(); };
  const applyPlan = (plan) => { onBatchUpdate(selectedIds, { plan }); setModal(null); exitSelect(); };
  const doDelete = () => { onBatchDelete(selectedIds); setModal(null); exitSelect(); };
  const doSchedule = () => { onBatchSchedule(selectedIds); exitSelect(); };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Clients</h2>
        {selectMode ? (
          <button onClick={exitSelect} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        ) : perms.editClients ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" sm onClick={() => setSelectMode(true)}>Select</Btn>
            <Btn sm onClick={onAdd}>+ Add Client</Btn>
          </div>
        ) : null}
      </div>

      <div style={{ position: "relative", marginBottom: 14 }}>
        <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: T.textMuted, display:"flex", pointerEvents:"none" }}>
          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input type="search" placeholder="Search by name or address…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: "11px 14px 11px 38px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
      </div>

      {!selectMode && perms.canImport && onImport && (
        <button onClick={onImport} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", marginBottom: 14, padding: "10px", borderRadius: 10, border: `1.5px dashed ${T.border}`, background: "none", color: T.primary, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
          <Icon name="download" size={16} /> Import clients from CSV
        </button>
      )}

      {selectMode && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, padding: "8px 14px", background: T.surfaceAlt, borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={toggleAll}>
            <Checkbox checked={allSelected} onChange={toggleAll} />
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Select all ({filtered.length})</span>
          </div>
          <span style={{ fontSize: 12, color: T.textMuted }}>{selCount} selected</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: selectMode && selCount > 0 ? 90 : 0 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: T.textMuted }}>
            <div style={{ width: 52, height: 52, borderRadius: 16, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="clients" size={26} /></div>
            <div style={{ fontWeight: 700, fontSize: 14, color: T.text, marginBottom: 4 }}>No clients found</div>
            <div style={{ fontSize: 13 }}>{search ? `Nothing matches "${search}"` : "Add your first client to get started"}</div>
          </div>
        )}
        {filtered.map(c => {
          const pm = planMeta(c.plan, T, tiers);
          const isSel = !!selected[c.id];
          return (
            <div key={c.id}
              onClick={() => selectMode ? toggle(c.id) : onSelect(c)}
              style={{ background: T.surface, border: `1px solid ${isSel ? T.primary : T.border}`, borderRadius: 16, padding: "15px 16px", cursor: "pointer", display: "flex", gap: 14, alignItems: "center", transition: "box-shadow 0.15s, border-color 0.15s", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.09)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.04)"}
            >
              {selectMode && <Checkbox checked={isSel} onChange={() => toggle(c.id)} />}
              {/* Division color bar instead of emoji */}
              <div style={{ width: 4, alignSelf: "stretch", borderRadius: 4, background: pm.bg, flexShrink: 0, minHeight: 44 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.text, letterSpacing: "-0.01em" }}>{c.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address || "No address"}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  {clientServices(c, tiers).map((s, si) => (
                    <span key={si} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {si > 0 && <span style={{ opacity: 0.3 }}>·</span>}
                      <span style={{ fontWeight: 600, color: T.text }}>{s.div}</span>
                      {s.type && <><span style={{ opacity: 0.3 }}>·</span><span>{s.type}</span></>}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end", flexShrink: 0 }}>
                <Badge label={c.plan || "No tier"} bg={pm.bg} color={pm.color || pm.text} sm />
                {c.nextService && <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600 }}>{c.nextService}</div>}
              </div>
              <div style={{ color: T.textMuted, flexShrink: 0 }}>
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="m9 18 6-6-6-6"/></svg>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bulk action bar */}
      {selectMode && selCount > 0 && (
        <div style={{ position: "fixed", bottom: "calc(74px + env(safe-area-inset-bottom))", left: 0, right: 0, zIndex: 95, padding: "10px 16px", maxWidth: 740, margin: "0 auto" }}>
          <div style={{ background: T.headerBg, borderRadius: 14, padding: "10px 12px", display: "flex", gap: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.25)", overflowX: "auto" }}>
            {[
              { label: "Schedule", icon: "calendar", fn: doSchedule },
              { label: "Division", icon: "tag", fn: () => setModal("division") },
              { label: "Plan", icon: "clipboard", fn: () => setModal("plan") },
              { label: "Delete", icon: "trash", fn: () => setModal("delete"), danger: true },
            ].map(a => (
              <button key={a.label} onClick={a.fn}
                style={{ flex: "1 0 auto", background: a.danger ? "rgba(255,80,80,0.15)" : "rgba(255,255,255,0.1)", color: a.danger ? "#ff8080" : "#fff", border: "none", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                <Icon name={a.icon} size={13} />{a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Division modal */}
      {modal === "division" && (
        <Modal title={`Change Division (${selCount})`} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(tiers ? getDivisions(tiers) : DIVISIONS).map(d => (
              <button key={d} onClick={() => applyDivision(d)}
                style={{ padding: "14px 16px", border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, color: T.text, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                {d} Solutions
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* Plan modal */}
      {modal === "plan" && (
        <Modal title={`Change Maintenance Plan (${selCount})`} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {PLANS.map(p => {
              const pm = planMeta(p, T, tiers);
              return (
                <button key={p} onClick={() => applyPlan(p)}
                  style={{ padding: "14px 16px", border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, color: T.text, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {p}
                  <Badge label={p} bg={pm.bg} color={pm.color || pm.text} sm />
                </button>
              );
            })}
          </div>
        </Modal>
      )}

      {/* Delete confirm */}
      {modal === "delete" && (
        <Modal title="Delete Clients?" onClose={() => setModal(null)}>
          <p style={{ fontSize: 14, color: T.text, lineHeight: 1.5, marginTop: 0 }}>
            This will remove {selCount} {selCount === 1 ? "client" : "clients"} from your list. This can't be undone.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button onClick={doDelete} style={{ flex: 1, background: "#C0392B", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Delete {selCount}</button>
            <button onClick={() => setModal(null)} style={{ background: T.surfaceAlt, color: T.text, border: "none", borderRadius: 12, padding: "13px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// CLIENT EDIT FORM
// ─────────────────────────────────────────────
function ClientEditForm({ client, onSave, onCancel, title = "Edit Client" }) {
  const { T, tiers } = useApp();
  const [form, setForm] = useState(() => {
    const base = { ...client };
    // backfill address parts: use stored components if present, else parse the address string
    if (base.street == null && base.city == null && base.state == null && base.zip == null) {
      Object.assign(base, splitAddress(base.address || ""));
    } else {
      base.street = base.street || ""; base.city = base.city || ""; base.state = base.state || ""; base.zip = base.zip || "";
    }
    return base;
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // update an address part and keep the combined address in sync
  const setAddr = (k, v) => setForm(f => {
    const next = { ...f, [k]: v };
    next.address = assembleAddress({ street: next.street, city: next.city, state: next.state, zip: next.zip });
    return next;
  });
  const combined = assembleAddress({ street: form.street, city: form.city, state: form.state, zip: form.zip });
  const halfInput = { width: "100%", padding: "11px 14px", border: `1px solid ${T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", boxSizing: "border-box", outline: "none", color: T.text, background: T.surface };

  return (
    <div>
      <button onClick={onCancel} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: "0 0 16px", display: "flex", alignItems: "center", gap: 4 }}>← Cancel</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: T.text }}>{title}</h2>
        <Btn onClick={() => onSave(form)}>{title === "Add Client" ? "Create Client" : "Save Changes"}</Btn>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {["Contact Info", "Service Details", "Service Plan"].map((sectionTitle, si) => (
          <Card key={si}>
            <CardHeader title={sectionTitle} />
            <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
              {si === 0 && <>
                <FieldRow label="Full Name"><Input value={form.name} onChange={e => set("name", e.target.value)} /></FieldRow>

                {/* Address — entered in parts, combined automatically */}
                <FieldRow label="Street Address"><Input value={form.street} onChange={e => setAddr("street", e.target.value)} placeholder="123 Main St" /></FieldRow>
                <div style={{ display: "flex", gap: 10 }}>
                  <div style={{ flex: 2 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>City</label>
                    <input type="text" style={halfInput} value={form.city} onChange={e => setAddr("city", e.target.value)} placeholder="Elverson" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>State</label>
                    <input type="text" autoCapitalize="characters" style={halfInput} value={form.state} onChange={e => setAddr("state", e.target.value)} placeholder="PA" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>ZIP</label>
                    <input type="text" inputMode="numeric" style={halfInput} value={form.zip} onChange={e => setAddr("zip", e.target.value)} placeholder="19520" />
                  </div>
                </div>
                {combined && <div style={{ fontSize: 12, color: T.textMuted, background: T.surfaceAlt, borderRadius: 9, padding: "9px 12px", display:"flex", alignItems:"center", gap:6 }}><Icon name="location" size={13} />{combined}</div>}

                <FieldRow label="Phone"><Input value={form.phone} onChange={e => set("phone", e.target.value)} /></FieldRow>
                <FieldRow label="Email"><Input value={form.email} onChange={e => set("email", e.target.value)} /></FieldRow>
                <FieldRow label="Referral Source">
                  <Select value={form.referralSource || ""} onChange={e => set("referralSource", e.target.value)}
                    options={["", "Google", "Facebook", "Instagram", "Word of Mouth", "Referral", "Door Hanger", "Direct Mail", "Other"]} />
                </FieldRow>
                {(form.referralSource === "Referral" || form.referralSource === "Word of Mouth") && (
                  <FieldRow label="Referred By">
                    <Input value={form.referredBy || ""} onChange={e => set("referredBy", e.target.value)} placeholder="Client name who referred them" />
                  </FieldRow>
                )}
              </>}
              {si === 1 && <>
                {/* Primary division — drives portal labels */}
                <FieldRow label="Primary Division">
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {getDivisions(tiers).map(d => {
                      const active = (form.division || "Pond") === d;
                      return (
                        <button key={d} type="button" onClick={() => set("division", d)}
                          style={{ flex: 1, padding: "10px 6px", borderRadius: 12, border: `1.5px solid ${active ? T.primary : T.border}`, background: active ? hexA(T.primary, 0.08) : T.surface, color: active ? T.primary : T.textMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                          {d}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 5 }}>Sets the label in their client portal (My Pond / My Pool / My Property).</div>
                </FieldRow>

                {/* Active services — can have multiple */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 }}>Services</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {getDivisions(tiers).map(div => {
                      const m = dMeta(div);
                      const serviceKey = `service${div}`; // e.g. servicePond, servicePool, serviceSeasonal
                      const detailKey  = `${div.toLowerCase()}Type`;
                      const sizeKey    = `${div.toLowerCase()}Size`;
                      const isOn = !!(form[serviceKey] || form.division === div);
                      return (
                        <div key={div} style={{ background: isOn ? hexA(T.primary, 0.04) : T.surfaceAlt, border: `1.5px solid ${isOn ? hexA(T.primary, 0.25) : T.border}`, borderRadius: 14, overflow: "hidden", transition: "all 0.15s" }}>
                          {/* Toggle row */}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px" }}>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{div} Services</div>
                              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{div === "Pond" ? "Ponds, water features, waterfalls" : div === "Pool" ? "In-ground, above-ground, spas" : "Leaf removal, gutters, snow"}</div>
                            </div>
                            <button type="button" onClick={() => {
                              if (isOn && form.division !== div) {
                                // turning off a secondary service
                                set(serviceKey, false);
                              } else if (!isOn) {
                                set(serviceKey, true);
                              }
                              // Can't turn off primary division service directly — change primary division instead
                            }}
                              style={{ width: 44, height: 26, borderRadius: 100, background: isOn ? T.primary : T.surfaceAlt, border: "none", cursor: form.division === div ? "default" : "pointer", position: "relative", flexShrink: 0, transition: "background 0.2s", opacity: form.division === div ? 0.6 : 1 }}>
                              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: isOn ? 21 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                            </button>
                          </div>
                          {/* Detail fields when on */}
                          {isOn && (
                            <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10, borderTop: `1px solid ${hexA(T.primary, 0.1)}`, paddingTop: 12 }}>
                              <div>
                                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>{m.typeLabel}</label>
                                <select value={form[detailKey] || ""} onChange={e => set(detailKey, e.target.value)}
                                  style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", appearance: "none", WebkitAppearance: "none" }}>
                                  <option value="">Select…</option>
                                  {m.typeOptions.map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                              </div>
                              <div>
                                <label style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>{m.sizeLabel}</label>
                                <input type="text" value={form[sizeKey] || ""} onChange={e => set(sizeKey, e.target.value)}
                                  placeholder={div === "Pond" ? "e.g. 3,200 gal" : div === "Pool" ? "e.g. 15,000 gal" : "e.g. 2 acres"}
                                  style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>Enable all services this client receives. Primary division sets their portal label.</div>
                </div>
              </>}
              {si === 2 && <>
                {/* Per-division plan assignments */}
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 }}>Service Plans</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {[form.division, ...getDivisions(tiers).filter(d => d !== form.division && form["service" + d])].map(div => {
                      const currentPlan = (form.plans && form.plans[div]) || (div === (form.division || "Pond") ? (form.plan || "Essential") : "Essential");
                      return (
                        <div key={div} style={{ background: T.surfaceAlt, borderRadius: 14, padding: "12px 14px" }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>{div}</div>
                          <div style={{ display: "flex", gap: 6 }}>
                            {["Essential","Signature","Premium","None"].map(p => {
                              const planVal = p === "None" ? "" : p;
                              const active  = (currentPlan || "") === planVal;
                              return (
                                <button key={p} type="button"
                                  onClick={() => {
                                    const newPlans = { ...(form.plans || {}), [div]: planVal };
                                    set("plans", newPlans);
                                    if (div === form.division) {
                                      set("plan", planVal);
                                      set("planFreq", planVal ? (TIER_FREQ[planVal] || form.planFreq) : "");
                                    }
                                  }}
                                  style={{ flex: 1, padding: "9px 4px", borderRadius: 10,
                                    border: `1.5px solid ${active ? (p === "None" ? T.textMuted : T.primary) : T.border}`,
                                    background: active ? (p === "None" ? hexA(T.textMuted, 0.08) : hexA(T.primary, 0.08)) : T.surface,
                                    color: active ? (p === "None" ? T.textMuted : T.primary) : T.textMuted,
                                    fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                                  {p}
                                </button>
                              );
                            })}
                          </div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>{currentPlan ? (TIER_FREQ[currentPlan] || "—") + " service" : "No tier assigned"}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <FieldRow label="Next Service"><Input value={form.nextService} onChange={e => set("nextService", e.target.value)} placeholder="MM/DD/YYYY" /></FieldRow>
                <FieldRow label="Monthly Rate">
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#9ca3af" }}>$</span>
                    <Input value={form.monthlyRate || ""} onChange={e => set("monthlyRate", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 150" />
                  </div>
                </FieldRow>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b7280", display: "block", marginBottom: 5 }}>Auto-Invoice</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {["Off", "Monthly", "Bi-Weekly", "Weekly"].map(opt => {
                      const on = (form.autoInvoice || "Off") === opt;
                      return (
                        <button key={opt} type="button" onClick={() => set("autoInvoice", opt)}
                          style={{ flex: 1, padding: "8px 4px", borderRadius: 10, border: `1.5px solid ${on ? "var(--ringBorder)" : "#e5e7eb"}`, background: on ? "rgba(184,29,36,0.08)" : "transparent", color: on ? "var(--ringBorder)" : "#9ca3af", fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>When enabled, invoices generate automatically on that schedule using the monthly rate above.</div>
                </div>
              </>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// CLIENT DETAIL
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// CLIENT DOCUMENTS
// Store signed contracts, agreements, and any PDF
// uploaded from Dropbox Sign or elsewhere.
// ─────────────────────────────────────────────

const DOC_CATEGORIES = [
  "Service Agreement",
  "Upgrade Agreement",
  "Proposal / Estimate",
  "Invoice",
  "Photo Report",
  "Other",
];

function ClientDocuments({ client, onChange }) {
  const { T, perms } = useApp();
  const docs = client.documents || [];
  const [uploading, setUploading] = useState(false);
  const [editingDoc, setEditingDoc] = useState(null); // doc index being renamed/categorized
  const [labelModal, setLabelModal] = useState(null); // { file, src, name, size, type }
  const [labelForm, setLabelForm] = useState({ label: "", category: "Service Agreement", note: "" });
  const fileInputRef = useRef(null);

  const fmtSize = (bytes) => {
    if (!bytes) return "";
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  const fmtDate = (ts) => {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const handleFiles = (files) => {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      setLabelModal({ src: e.target.result, name: file.name, size: file.size, type: file.type });
      setLabelForm({
        label: file.name.replace(/\.[^.]+$/, ""),
        category: file.name.toLowerCase().includes("agreement") || file.name.toLowerCase().includes("contract") ? "Service Agreement" : "Other",
        note: "",
      });
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const confirmUpload = () => {
    if (!labelModal) return;
    const doc = {
      id: `doc-${Date.now()}`,
      src: labelModal.src,
      name: labelModal.name,
      size: labelModal.size,
      type: labelModal.type,
      label: labelForm.label || labelModal.name,
      category: labelForm.category,
      note: labelForm.note,
      uploadedAt: Date.now(),
    };
    onChange([...docs, doc]);
    setLabelModal(null);
    setLabelForm({ label: "", category: "Service Agreement", note: "" });
  };

  const removeDoc = (id) => onChange(docs.filter(d => d.id !== id));

  const updateDoc = (id, changes) => onChange(docs.map(d => d.id === id ? { ...d, ...changes } : d));

  const downloadDoc = (doc) => {
    const a = document.createElement("a");
    a.href = doc.src;
    a.download = doc.name || doc.label || "document";
    a.click();
  };

  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", appearance: "none", WebkitAppearance: "none" };
  const lbl   = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };

  // Group docs by category
  const grouped = {};
  docs.forEach(d => {
    const cat = d.category || "Other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(d);
  });

  const DocIcon = ({ type }) => {
    const isPdf = (type || "").includes("pdf");
    const isImg = (type || "").startsWith("image");
    return (
      <div style={{ width: 44, height: 44, borderRadius: 13, background: isPdf ? hexA("#E5484D", 0.1) : isImg ? hexA(T.primary, 0.1) : T.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {isPdf ? (
          <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#E5484D" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          </svg>
        ) : isImg ? (
          <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke={T.primary} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke={T.textMuted} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader
        title={`Documents (${docs.length})`}
        action={perms.editClients ? (
          <button onClick={() => fileInputRef.current?.click()}
            style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="plus" size={13} /> Upload
          </button>
        ) : null}
      />

      <input ref={fileInputRef} type="file"
        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/*"
        style={{ display: "none" }}
        onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />

      {docs.length === 0 && !uploading ? (
        <div style={{ padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>No documents yet</div>
            <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, maxWidth: 260 }}>
              Upload signed service agreements from Dropbox Sign, proposals, photo reports, or any other client documents.
            </div>
          </div>
          {perms.editClients && (
            <button onClick={() => fileInputRef.current?.click()}
              style={{ marginTop: 4, background: T.primary, color: "#fff", border: "none", borderRadius: 13, padding: "12px 24px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 14px ${hexA(T.primary, 0.3)}` }}>
              Upload a Document
            </button>
          )}
        </div>
      ) : (
        <div style={{ padding: docs.length > 0 ? 0 : "16px 18px" }}>
          {Object.entries(grouped).sort().map(([cat, catDocs]) => (
            <div key={cat}>
              {/* Category header */}
              <div style={{ padding: "10px 18px 6px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, background: T.surfaceAlt, borderBottom: `1px solid ${T.border}` }}>
                {cat} · {catDocs.length}
              </div>
              {catDocs.map((doc, i) => (
                <div key={doc.id} style={{ padding: "14px 18px", borderBottom: i < catDocs.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 13 }}>
                  <DocIcon type={doc.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingDoc === doc.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <input type="text" autoFocus value={doc.label}
                          onChange={e => updateDoc(doc.id, { label: e.target.value })}
                          onBlur={() => setEditingDoc(null)}
                          onKeyDown={e => e.key === "Enter" && setEditingDoc(null)}
                          style={{ ...field, padding: "7px 11px", fontSize: 13 }} />
                        <select value={doc.category || "Other"} onChange={e => updateDoc(doc.id, { category: e.target.value })} style={{ ...field, padding: "7px 11px", fontSize: 13 }}>
                          {DOC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.label || doc.name}</div>
                        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                          {fmtDate(doc.uploadedAt)}{doc.size ? ` · ${fmtSize(doc.size)}` : ""}
                        </div>
                        {doc.note && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, fontStyle: "italic" }}>{doc.note}</div>}
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => downloadDoc(doc)}
                      style={{ background: hexA(T.primary, 0.1), color: T.primary, border: "none", borderRadius: 9, padding: "7px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}>
                      <Icon name="download" size={13} />
                    </button>
                    {perms.editClients && (
                      <button onClick={() => setEditingDoc(editingDoc === doc.id ? null : doc.id)}
                        style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 9, padding: "7px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                    {perms.editClients && (
                      <button onClick={() => removeDoc(doc.id)}
                        style={{ background: hexA("#E5484D", 0.08), color: "#E5484D", border: "none", borderRadius: 9, padding: "7px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center" }}>
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {perms.editClients && docs.length > 0 && (
            <div style={{ padding: "14px 18px" }}>
              <button onClick={() => fileInputRef.current?.click()}
                style={{ width: "100%", padding: "11px", border: `2px dashed ${T.border}`, borderRadius: 12, background: "none", color: T.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
                <Icon name="plus" size={15} /> Upload another document
              </button>
            </div>
          )}
        </div>
      )}

      {/* Label & category modal before saving */}
      {labelModal && (
        <Modal title="Add Document" onClose={() => { setLabelModal(null); setUploading(false); }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
              <DocIcon type={labelModal.type} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelModal.name}</div>
                {labelModal.size && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{fmtSize(labelModal.size)}</div>}
              </div>
            </div>
            <div>
              <label style={lbl}>Document Label</label>
              <input type="text" autoFocus style={field}
                value={labelForm.label}
                onChange={e => setLabelForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Service Agreement 2025" />
            </div>
            <div>
              <label style={lbl}>Category</label>
              <select style={field} value={labelForm.category} onChange={e => setLabelForm(f => ({ ...f, category: e.target.value }))}>
                {DOC_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Note <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}>(optional)</span></label>
              <input type="text" style={field}
                value={labelForm.note}
                onChange={e => setLabelForm(f => ({ ...f, note: e.target.value }))}
                placeholder="e.g. Signed via Dropbox Sign, Jan 2025" />
            </div>
            <Btn onClick={confirmUpload} block lg>Save Document</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function ClientDetail({ client: init, invoices, invoicing, branding, schedule, onBack, onUpdate, onSaveInvoice, onDeleteInvoice }) {
  const { T, perms, tiers } = useApp();
  const [client, setClient] = useState(init);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const pm = planMeta(client.plan, T, tiers);
  const tabs = ["overview", "equipment", "history", ...(perms.canInvoice ? ["invoices"] : []), "docs", "portal"];
  const owed = clientOutstanding(client, invoices);

  // keep local view in sync if the stored record changes (e.g. a completed stop adds history)
  useEffect(() => { setClient(init); }, [init]);

  // apply a change locally and push it up so it saves to the client list + storage
  const update = (changes) => {
    const next = { ...client, ...changes };
    setClient(next);
    if (onUpdate) onUpdate(next);
  };

  if (editing) return <ClientEditForm client={client} onSave={u => { update(u); setEditing(false); }} onCancel={() => setEditing(false)} />;

  return (
    <div>
      <button onClick={() => { onBack(); window.scrollTo({ top: 0, behavior: "instant" }); }} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: "0 0 16px", display: "flex", alignItems: "center", gap: 4 }}>← Back to Clients</button>

      <Card style={{ marginBottom: 14, overflow: "hidden" }}>
        {/* Color accent bar at top */}
        <div style={{ height: 4, background: pm.bg }} />
        <div style={{ padding: "16px 18px 14px" }}>
          {/* Name row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: "0 0 2px", fontSize: 21, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{client.name}</h2>
              <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.address}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, display: "flex", gap: 4, flexWrap: "wrap" }}>
                {clientServices(client, tiers).map((s, i) => (
                  <span key={i} style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
                    {i > 0 && <span style={{ opacity:0.3 }}>·</span>}
                    <span style={{ fontWeight:600 }}>{s.div}{s.type ? ` — ${s.type}` : ""}</span>
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "center", flexShrink: 0 }}>
              <Badge label={client.plan || "No tier"} bg={pm.bg} color={pm.color || pm.text} />
              {perms.canInvoice && (invoices||[]).filter(iv => invoiceMatchesClient(iv, client)).length > 0 && (
                <Btn variant="ghost" sm onClick={() => generateStatementPDF(client, sortInvoices((invoices||[]).filter(iv => invoiceMatchesClient(iv, client))), branding)} style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <Icon name="download" size={13} /> PDF
                </Btn>
              )}
              {perms.editClients && <Btn variant="ghost" sm onClick={() => setEditing(true)} style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="edit" size={13} /> Edit</Btn>}
            </div>
          </div>
          {/* Contact info row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
            {client.phone && <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:T.textMuted }}><Icon name="phone" size={12} />{client.phone}</span>}
            {client.email && <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:T.textMuted }}><Icon name="mail" size={12} />{client.email}</span>}
            {client.nextService && <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:T.textMuted }}><Icon name="calendar" size={12} />Next: {client.nextService}</span>}
            {perms.seeBalances && <span style={{ display:"flex", alignItems:"center", gap:4, fontSize:12, fontWeight:700, color: owed <= 0 ? T.accent : T.warning }}><Icon name="dollar" size={12} />${owed.toFixed(2)}{owed > 0 ? " due" : " balance"}</span>}
          </div>
        </div>
      </Card>

      <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 10, padding: 4, marginBottom: 16, gap: 3 }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "8px 4px", border: "none", borderRadius: 7,
            fontSize: 12, fontWeight: 700, textTransform: "capitalize", cursor: "pointer",
            background: tab === t ? T.surface : "transparent",
            color: tab === t ? T.primary : T.textMuted,
            boxShadow: tab === t ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
            fontFamily: "inherit", transition: "all 0.15s",
          }}>{t}</button>
        ))}
      </div>

      {tab === "overview" && <ClientOverview client={client} invoices={invoices} onUpdate={onUpdate} />}
      {tab === "equipment" && <ClientEquipment client={client} invoices={invoices} onChange={eq => update({ equipment: eq })} />}
      {tab === "history" && <ClientHistory client={client} onChange={hist => update({ history: hist })} />}
      {tab === "invoices" && perms.canInvoice && <ClientInvoices client={client} invoices={invoices} invoicing={invoicing} branding={branding} onSave={onSaveInvoice} onDelete={onDeleteInvoice} />}
      {tab === "docs"    && <ClientDocuments client={client} onChange={docs => update({ documents: docs })} />}
      {tab === "portal" && <ClientPortal client={client} invoices={invoices} schedule={schedule} branding={branding} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// CLIENT PHOTO PICKER
// Shared inline photo capture/upload used on overview + equipment
// ─────────────────────────────────────────────
// photos can be strings (legacy) or objects { src, caption }
// PhotoPicker normalises both so old data still works
function PhotoPicker({ photos = [], onChange, label = "Photos", maxPhotos = 10, allowCaptions = false }) {
  const { T } = useApp();
  const inputRef = useRef(null);
  const [viewer, setViewer] = useState(null);
  const [editingCaption, setEditingCaption] = useState(null); // index

  // Normalise: ensure every item is { src, caption }
  const normalised = photos.map(p => typeof p === "string" ? { src: p, caption: "" } : p);

  const addPhotos = (files) => {
    const readers = Array.from(files).slice(0, maxPhotos - normalised.length).map(file =>
      new Promise(res => {
        const r = new FileReader();
        r.onload = e => res({ src: e.target.result, caption: "" });
        r.readAsDataURL(file);
      })
    );
    Promise.all(readers).then(results => onChange([...normalised, ...results]));
  };

  const remove = (idx) => onChange(normalised.filter((_, i) => i !== idx));

  const setCaption = (idx, caption) => {
    onChange(normalised.map((p, i) => i === idx ? { ...p, caption } : p));
  };

  // Return src string for PhotoViewer (which expects strings)
  const srcs = normalised.map(p => p.src);

  return (
    <div>
      {label && <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>{label}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
        {normalised.map((p, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ position: "relative" }}>
              <img src={p.src} alt={p.caption || ""} onClick={() => setViewer(i)}
                style={{ width: 90, height: 90, borderRadius: 12, objectFit: "cover", cursor: "pointer", border: `1px solid ${T.border}`, display: "block" }} />
              <button onClick={() => remove(i)}
                style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: "50%", background: "#E5484D", border: `2px solid ${T.surface}`, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                <Icon name="close" size={10} />
              </button>
            </div>
            {allowCaptions && (
              editingCaption === i ? (
                <input
                  type="text"
                  autoFocus
                  value={p.caption}
                  onChange={e => setCaption(i, e.target.value)}
                  onBlur={() => setEditingCaption(null)}
                  onKeyDown={e => e.key === "Enter" && setEditingCaption(null)}
                  placeholder="Add label..."
                  style={{ width: 90, padding: "4px 7px", border: `1.5px solid ${T.primary}`, borderRadius: 10, fontSize: 11, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }}
                />
              ) : (
                <button onClick={() => setEditingCaption(i)}
                  style={{ width: 90, padding: "4px 7px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 11, fontWeight: p.caption ? 600 : 400, color: p.caption ? T.text : T.textMuted, background: T.surfaceAlt, cursor: "pointer", fontFamily: "inherit", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.caption || "Add label"}
                </button>
              )
            )}
          </div>
        ))}
        {normalised.length < maxPhotos && (
          <button onClick={() => inputRef.current?.click()}
            style={{ width: 90, height: 90, borderRadius: 12, border: `2px dashed ${T.border}`, background: T.surfaceAlt, color: T.textMuted, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5 }}>
            <Icon name="plus" size={22} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.02em", textAlign: "center" }}>Camera / Library</span>
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*,application/pdf,image/heic,image/heif" multiple
        style={{ display: "none" }}
        onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} />
      {viewer !== null && <PhotoViewer photos={srcs} index={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function ClientOverview({ client, onUpdate }) {
  const { T, perms } = useApp();
  const h = client.history[0];
  const m = dMeta(client.division);
  const sitePhotos = client.sitePhotos || [];
  const siteVideos = client.siteVideos || [];
  const [videoViewer, setVideoViewer] = useState(null);
  const videoInputRef = useRef(null);
  const [editingVideoCaption, setEditingVideoCaption] = useState(null);

  const updateSitePhotos = (photos) => {
    if (onUpdate) onUpdate({ ...client, sitePhotos: photos });
  };

  const MAX_VIDEO_DURATION = 20; // seconds
  const [videoError, setVideoError] = useState("");

  const addVideos = (files) => {
    setVideoError("");
    const incoming = Array.from(files).slice(0, 6 - siteVideos.length);
    const results = [];
    let checked = 0;

    incoming.forEach(file => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        if (vid.duration > MAX_VIDEO_DURATION) {
          setVideoError(`"${file.name}" is ${Math.round(vid.duration)}s — clips must be 20 seconds or under. Trim it in the Photos app first.`);
        } else {
          const r = new FileReader();
          r.onload = e => {
            results.push({ src: e.target.result, caption: "", type: file.type, name: file.name, size: file.size });
            checked++;
            if (checked === incoming.length) {
              if (results.length) onUpdate({ ...client, siteVideos: [...siteVideos, ...results] });
            }
          };
          r.readAsDataURL(file);
          return;
        }
        checked++;
        if (checked === incoming.length && results.length) {
          onUpdate({ ...client, siteVideos: [...siteVideos, ...results] });
        }
      };
      vid.src = url;
    });
  };

  const removeVideo = (idx) => {
    if (onUpdate) onUpdate({ ...client, siteVideos: siteVideos.filter((_, i) => i !== idx) });
  };

  const setVideoCaption = (idx, caption) => {
    const next = siteVideos.map((v, i) => i === idx ? { ...v, caption } : v);
    if (onUpdate) onUpdate({ ...client, siteVideos: next });
  };

  const fmtFileSize = (bytes) => {
    if (!bytes) return "";
    if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Site Photos */}
      <Card>
        <CardHeader title={`${m.siteLabel} Photos`} />
        <div style={{ padding: "16px 18px" }}>
          {sitePhotos.length === 0 && !perms.editClients ? (
            <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "16px 0" }}>No photos added yet.</div>
          ) : (
            <>
              {sitePhotos.length > 0 && !perms.editClients && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {sitePhotos.map((p, i) => {
                    const src = typeof p === "string" ? p : p.src;
                    const cap = typeof p === "object" ? p.caption : "";
                    return (
                      <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <img src={src} alt={cap || ""} style={{ width: 90, height: 90, borderRadius: 12, objectFit: "cover", border: `1px solid ${T.border}` }} />
                        {cap && <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cap}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
              {perms.editClients && (
                <PhotoPicker
                  photos={sitePhotos}
                  onChange={updateSitePhotos}
                  label={sitePhotos.length === 0 ? `Add photos of the ${m.siteLabel.toLowerCase()} to document its current state` : "Add more photos"}
                  maxPhotos={20}
                  allowCaptions={true}
                />
              )}
            </>
          )}
        </div>
      </Card>

      {/* Site Videos */}
      <Card>
        <CardHeader
          title={`${m.siteLabel} Videos`}
          action={perms.editClients && siteVideos.length < 6 ? (
            <button onClick={() => videoInputRef.current?.click()}
              style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
              <Icon name="plus" size={14} /> Add
            </button>
          ) : null}
        />
        <div style={{ padding: "16px 18px" }}>
          {siteVideos.length === 0 ? (
            perms.editClients ? (
              <button onClick={() => videoInputRef.current?.click()}
                style={{ width: "100%", padding: "24px 16px", border: `2px dashed ${T.border}`, borderRadius: 14, background: T.surfaceAlt, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, color: T.textMuted, fontFamily: "inherit" }}>
                <div style={{ width: 44, height: 44, borderRadius: 13, background: hexA(T.primary, 0.1), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.87v6.26a1 1 0 0 1-1.447.899L15 14M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 3 }}>Add a video</div>
                  <div style={{ fontSize: 12, lineHeight: 1.5 }}>Take a video, pick from your library, or upload a file. Up to 6 clips, 20 sec each.</div>
                </div>
              </button>
            ) : (
              <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "16px 0" }}>No videos added yet.</div>
            )
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {siteVideos.map((v, i) => (
                <div key={i} style={{ background: T.surfaceAlt, borderRadius: 14, overflow: "hidden", border: `1px solid ${T.border}` }}>
                  {/* Video player */}
                  <div style={{ position: "relative", background: "#000", borderRadius: "14px 14px 0 0" }}>
                    <video
                      src={v.src}
                      controls
                      playsInline
                      preload="metadata"
                      style={{ width: "100%", maxHeight: 260, borderRadius: "14px 14px 0 0", display: "block", objectFit: "contain" }}
                    />
                    {perms.editClients && (
                      <button onClick={() => removeVideo(i)}
                        style={{ position: "absolute", top: 8, right: 8, width: 28, height: 28, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Icon name="close" size={13} />
                      </button>
                    )}
                  </div>
                  {/* Caption + metadata */}
                  <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {perms.editClients ? (
                        editingVideoCaption === i ? (
                          <input
                            type="text"
                            autoFocus
                            value={v.caption || ""}
                            onChange={e => setVideoCaption(i, e.target.value)}
                            onBlur={() => setEditingVideoCaption(null)}
                            onKeyDown={e => e.key === "Enter" && setEditingVideoCaption(null)}
                            placeholder="Add a label for this clip..."
                            style={{ width: "100%", padding: "6px 10px", border: `1.5px solid ${T.primary}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }}
                          />
                        ) : (
                          <button onClick={() => setEditingVideoCaption(i)}
                            style={{ background: "none", border: "none", color: v.caption ? T.text : T.textMuted, fontWeight: v.caption ? 600 : 400, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0, textAlign: "left" }}>
                            {v.caption || "Tap to add label"}
                          </button>
                        )
                      ) : (
                        v.caption && <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{v.caption}</div>
                      )}
                      {v.size && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{fmtFileSize(v.size)}</div>}
                    </div>
                  </div>
                </div>
              ))}
              {perms.editClients && siteVideos.length < 6 && (
                <button onClick={() => videoInputRef.current?.click()}
                  style={{ padding: "12px", border: `2px dashed ${T.border}`, borderRadius: 12, background: "none", color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
                  <Icon name="plus" size={16} /> Record or select clip
                </button>
              )}
            </div>
          )}
          {/* Hidden file input — no capture attribute so it shows the full picker including existing videos */}
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/mov,video/*"
            multiple
            style={{ display: "none" }}
            onChange={e => { addVideos(e.target.files); e.target.value = ""; }}
          />
          {videoError && (
            <div style={{ background: hexA(T.warning, 0.08), border: `1px solid ${hexA(T.warning, 0.25)}`, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: T.warning, marginTop: 8, display: "flex", alignItems: "flex-start", gap: 8, lineHeight: 1.5 }}>
              <Icon name="warning" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{videoError}</span>
            </div>
          )}
          {perms.editClients && (
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 10, lineHeight: 1.5 }}>
              Max 20 seconds per clip. For best quality, record at 1080p: iPhone Settings → Camera → Record Video → 1080p HD at 60 fps.
            </div>
          )}
        </div>
      </Card>

      {/* Service Details */}
      <Card>
        <CardHeader title="Service Details" />
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {[["Division", client.division || "Pond"],[m.typeLabel, client.pondType],[m.sizeLabel, client.pondSize],["Plan", `${client.plan} (${client.planFreq})`]].map(([k,v]) => (
            <div key={k}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{k}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{v || "—"}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Last Service */}
      {h && (
        <Card>
          <CardHeader title="Last Service" />
          <div style={{ padding: 18 }}>
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>{h.date} · {h.type} · {h.tech}</div>
            <div style={{ fontSize: 13, color: T.text, marginBottom: 14, lineHeight: 1.5, borderLeft: `3px solid ${T.border}`, paddingLeft: 10 }}>{h.notes}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {[["NH₃", h.ammonia],["NO₂", h.nitrite],["pH", h.ph],["Temp", h.temp]].map(([k,v]) => (
                <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "10px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
            {h.photos && h.photos.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Visit Photos</div>
                <PhotoStrip photos={h.photos} />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function ClientEquipment({ client, invoices, onChange }) {
  const { T, perms } = useApp();
  const [modal, setModal] = useState(null);
  const [expanded, setExpanded] = useState({});
  const equipment = client.equipment || [];
  const clientInvoices = sortInvoices((invoices || []).filter(iv => invoiceMatchesClient(iv, client)));
  const STATUSES = ["Good", "Monitor", "Replace Soon"];
  const ORIGINS  = ["Installed by SPS", "Pre-existing (before SPS)", "Client-supplied"];

  const blankEq = () => ({
    name: "", installed: "", purchaseDate: "", purchasePrice: "",
    serialNumber: "", origin: "Installed by SPS", linkedInvoiceId: "",
    status: "Good", notes: "", photos: [],
  });
  const openAdd  = () => setModal({ mode: "add",  data: blankEq() });
  const openEdit = (eq, i) => { if (perms.editClients) setModal({ mode: "edit", index: i, data: { ...blankEq(), ...eq } }); };

  const save = () => {
    const d = modal.data;
    if (!d.name.trim()) return;
    let next;
    if (modal.mode === "add") next = [...equipment, d];
    else next = equipment.map((eq, i) => i === modal.index ? d : eq);
    onChange(next);
    setModal(null);
  };

  const remove = () => {
    onChange(equipment.filter((_, i) => i !== modal.index));
    setModal(null);
  };

  const setD = (k, v) => setModal(m => ({ ...m, data: { ...m.data, [k]: v } }));
  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const lbl   = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };
  const toggleExpand = (i) => setExpanded(e => ({ ...e, [i]: !e[i] }));

  const getLinkedInvoice = (id) => clientInvoices.find(iv => String(iv.id) === String(id));

  return (
    <Card>
      <CardHeader title={`Equipment (${equipment.length})`} action={perms.editClients ? <Btn sm onClick={openAdd} style={{ gap: 5 }}><Icon name="plus" size={13} /> Add</Btn> : null} />

      {equipment.length === 0 && (
        <div style={{ padding: "32px 18px", textAlign: "center", color: T.textMuted }}>
          <div style={{ width: 52, height: 52, borderRadius: 16, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="settings" size={26} /></div>
          <div style={{ fontSize: 13 }}>No equipment logged yet. Tap Add to document a pump, filter, or other gear.</div>
        </div>
      )}

      {equipment.map((eq, i) => {
        const isOpen = expanded[i];
        const photos = eq.photos || [];
        const linkedInv = getLinkedInvoice(eq.linkedInvoiceId);
        return (
          <div key={i} style={{ borderBottom: i < equipment.length - 1 ? `1px solid ${T.border}` : "none" }}>
            {/* Header row */}
            <div onClick={() => toggleExpand(i)}
              style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{eq.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {eq.installed && <span>Installed {eq.installed}</span>}
                  {eq.serialNumber && <span>S/N: {eq.serialNumber}</span>}
                  {photos.length > 0 && <span style={{ color: T.primary }}>{photos.length} photo{photos.length > 1 ? "s" : ""}</span>}
                  {eq.origin === "Pre-existing (before SPS)" && <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 700, background: T.surfaceAlt, padding: "2px 7px", borderRadius: 100 }}>Pre-SPS</span>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(eq.status, T), flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{eq.status || "Good"}</span>
                </div>
                <div style={{ color: T.textMuted, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                  <Icon name="chevronD" size={16} />
                </div>
              </div>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Photos with captions */}
                <PhotoPicker
                  photos={photos}
                  onChange={newPhotos => onChange(equipment.map((e2, j) => j === i ? { ...e2, photos: newPhotos } : e2))}
                  label="Photos"
                  maxPhotos={12}
                  allowCaptions={true}
                />

                {/* Condition notes */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Condition Notes</div>
                  {perms.editClients ? (
                    <textarea
                      value={eq.notes || ""}
                      onChange={e => onChange(equipment.map((e2, j) => j === i ? { ...e2, notes: e.target.value } : e2))}
                      placeholder="Visible condition, wear, leaks, unusual noise, etc..."
                      style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical", minHeight: 72, lineHeight: 1.5 }}
                    />
                  ) : (
                    eq.notes ? <div style={{ fontSize: 13, color: T.text, lineHeight: 1.6 }}>{eq.notes}</div>
                             : <div style={{ fontSize: 13, color: T.textMuted }}>No condition notes.</div>
                  )}
                </div>

                {/* Detail fields — read view */}
                {!perms.editClients && (eq.purchaseDate || eq.purchasePrice || eq.serialNumber || eq.origin || linkedInv) && (
                  <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                    {[
                      eq.origin && ["Origin", eq.origin],
                      eq.purchaseDate && ["Purchase Date", eq.purchaseDate],
                      eq.purchasePrice && ["Purchase Price", `$${eq.purchasePrice}`],
                      eq.serialNumber && ["Serial Number", eq.serialNumber],
                      linkedInv && ["Linked Invoice", `${linkedInv.number || linkedInv.id} — ${linkedInv.total || ""}`],
                    ].filter(Boolean).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div style={{ fontSize: 12, color: T.textMuted }}>{k}</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: T.text, textAlign: "right" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Edit Details button */}
                {perms.editClients && (
                  <button onClick={() => openEdit(eq, i)}
                    style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 11, padding: "9px 16px", fontSize: 13, fontWeight: 700, color: T.text, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
                    <Icon name="edit" size={13} /> Edit Details
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add / Edit modal */}
      {modal && (
        <Modal title={modal.mode === "add" ? "Add Equipment" : "Edit Equipment"} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Name */}
            <div>
              <label style={lbl}>Equipment Name</label>
              <input type="text" style={field} value={modal.data.name} onChange={e => setD("name", e.target.value)} placeholder="e.g. Aquascape 3000 Pump" autoFocus />
            </div>

            {/* Origin */}
            <div>
              <label style={lbl}>Origin</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {ORIGINS.map(o => (
                  <button key={o} onClick={() => setD("origin", o)}
                    style={{ padding: "8px 12px", borderRadius: 10, border: `1.5px solid ${modal.data.origin === o ? T.primary : T.border}`, background: modal.data.origin === o ? hexA(T.primary, 0.1) : T.surface, color: modal.data.origin === o ? T.primary : T.textMuted, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {o}
                  </button>
                ))}
              </div>
            </div>

            {/* Status */}
            <div>
              <label style={lbl}>Status</label>
              <div style={{ display: "flex", gap: 8 }}>
                {STATUSES.map(s => (
                  <button key={s} onClick={() => setD("status", s)}
                    style={{ flex: 1, padding: "10px 6px", borderRadius: 11, border: `1.5px solid ${modal.data.status === s ? statusColor(s, T) : T.border}`, background: modal.data.status === s ? `${statusColor(s, T)}14` : T.surface, color: modal.data.status === s ? statusColor(s, T) : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Dates */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={lbl}>Install Date</label>
                <input type="text" inputMode="numeric" style={field} value={modal.data.installed} onChange={e => setD("installed", e.target.value)} placeholder="MM/YYYY" />
              </div>
              <div>
                <label style={lbl}>Purchase Date</label>
                <input type="text" inputMode="numeric" style={field} value={modal.data.purchaseDate || ""} onChange={e => setD("purchaseDate", e.target.value)} placeholder="MM/YYYY" />
              </div>
            </div>

            {/* Price + Serial */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={lbl}>Purchase Price</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>$</span>
                  <input type="text" inputMode="decimal" style={{ ...field, paddingLeft: 26 }} value={modal.data.purchasePrice || ""} onChange={e => setD("purchasePrice", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
                </div>
              </div>
              <div>
                <label style={lbl}>Serial Number</label>
                <input type="text" style={field} value={modal.data.serialNumber || ""} onChange={e => setD("serialNumber", e.target.value)} placeholder="SN-XXXXXX" />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label style={lbl}>Notes</label>
              <textarea style={{ ...field, minHeight: 72, resize: "vertical", lineHeight: 1.5 }} value={modal.data.notes || ""} onChange={e => setD("notes", e.target.value)} placeholder="Any notes about this equipment, history, or pre-existing condition..." />
            </div>

            {/* Linked Invoice */}
            <div>
              <label style={lbl}>Linked Invoice <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}>(optional)</span></label>
              <select style={{ ...field, appearance: "none", WebkitAppearance: "none" }} value={modal.data.linkedInvoiceId || ""} onChange={e => setD("linkedInvoiceId", e.target.value)}>
                <option value="">None</option>
                {clientInvoices.map(iv => (
                  <option key={iv.id} value={iv.id}>{iv.number || `Invoice ${iv.id}`} — {iv.date} — {iv.total || "$0.00"}</option>
                ))}
              </select>
              {clientInvoices.length === 0 && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>No invoices on file for this client yet.</div>}
            </div>

            <Btn onClick={save} block lg>{modal.mode === "add" ? "Add Equipment" : "Save Changes"}</Btn>
            {modal.mode === "edit" && (
              <button onClick={remove} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit", textAlign: "center" }}>
                Delete this equipment
              </button>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function HistoryEditModal({ entry, onSave, onClose }) {
  const { T } = useApp();
  const num = (v) => parseFloat(v) || 0;
  const b = entry.breakdown || {};
  const legacy = { pH: entry.ph, Ammonia: entry.ammonia, Nitrite: entry.nitrite, Temperature: entry.temp };
  const initReadings = entry.readings && Object.keys(entry.readings).length
    ? { ...entry.readings }
    : Object.fromEntries(Object.entries(legacy).filter(([, v]) => v && v !== "—"));

  const [notes, setNotes] = useState(entry.notes || "");
  const [officeNotes, setOfficeNotes] = useState(entry.officeNotes || "");
  const [readings, setReadings] = useState(initReadings);
  const [photos, setPhotos] = useState(entry.photos || []);
  const [busy, setBusy] = useState(false);
  const [revenue, setRevenue] = useState(String(b.revenue ?? (entry.invoice || "").replace(/[^\d.]/g, "")));
  const [labor, setLabor] = useState(String(b.labor ?? 0));
  const [treatment, setTreatment] = useState(String(b.treatment ?? 0));
  const [product, setProduct] = useState(String(b.product ?? 0));
  const [gas, setGas] = useState(String(b.gas ?? 0));
  const [insurance, setInsurance] = useState(String(b.insurance ?? 0));
  const [equipment, setEquipment] = useState(String(b.equipment ?? 0));
  const [overhead, setOverhead] = useState(String(b.overhead ?? 0));

  const total = num(labor) + num(treatment) + num(product) + num(gas) + num(insurance) + num(equipment) + num(overhead);
  const profit = num(revenue) - total;
  const margin = num(revenue) > 0 ? (profit / num(revenue)) * 100 : 0;
  const money = (n) => `$${n.toFixed(2)}`;

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    const out = [];
    for (const f of files) out.push(await compressImage(f));
    setPhotos(p => [...p, ...out]);
    setBusy(false);
  };

  const save = () => {
    onSave({
      ...entry,
      notes, officeNotes, readings, photos,
      invoice: revenue ? `$${revenue}` : "$0",
      ph: readings["pH"] || "—", ammonia: readings["Ammonia"] || "—", nitrite: readings["Nitrite"] || "—", temp: readings["Temperature"] || "—",
      breakdown: { ...b, revenue: num(revenue), labor: num(labor), treatment: num(treatment), product: num(product), gas: num(gas), insurance: num(insurance), equipment: num(equipment), overhead: num(overhead), total, profit, margin },
    });
    onClose();
  };

  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 };
  const ta = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" };
  const costLine = (label, val, setter) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
      <span style={{ fontSize: 13, color: T.text }}>{label}</span>
      <div style={{ position: "relative", width: 100 }}>
        <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
        <input type="text" inputMode="decimal" value={val} onChange={e => setter(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "7px 8px 7px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
      </div>
    </div>
  );

  return (
    <Modal title={`Edit Service — ${entry.date}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div><label style={labelStyle}>Notes to Client</label><textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={ta} /></div>
        <div><label style={labelStyle}>Notes to Office (internal)</label><textarea rows={2} value={officeNotes} onChange={e => setOfficeNotes(e.target.value)} style={ta} /></div>

        {Object.keys(readings).length > 0 && (
          <div>
            <label style={labelStyle}>Readings</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {Object.entries(readings).map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textAlign: "center", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</div>
                  <input type="text" inputMode="decimal" value={v} onChange={e => setReadings(r => ({ ...r, [k]: e.target.value }))} style={{ width: "100%", padding: "9px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label style={labelStyle}>Photos</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {photos.map((p, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={p} alt="" style={{ width: 60, height: 60, borderRadius: 10, objectFit: "cover" }} />
                <button onClick={() => setPhotos(ps => ps.filter((_, idx) => idx !== i))} style={{ position: "absolute", top: -6, right: -6, background: "#C0392B", color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, fontSize: 12, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
            ))}
            <label style={{ width: 60, height: 60, borderRadius: 10, border: `2px dashed ${T.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, color: T.textMuted, cursor: "pointer" }}>
              {busy ? <span style={{ fontSize: 18 }}>…</span> : <Icon name="plus" size={18} />}
              <span style={{ fontSize: 7, fontWeight: 700, letterSpacing: "0.02em" }}>ADD</span>
              <input type="file" accept="image/*,image/heic,image/heif" multiple onChange={addPhotos} style={{ display: "none" }} />
            </label>
          </div>
        </div>

        <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 12 }}>Financials</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Revenue</span>
            <div style={{ position: "relative", width: 110 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
              <input type="text" inputMode="decimal" value={revenue} onChange={e => setRevenue(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "8px 8px 8px 22px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${T.border}`, margin: "6px 0 10px" }} />
          {costLine("Labor", labor, setLabor)}
          {costLine("Treatments", treatment, setTreatment)}
          {costLine("Products", product, setProduct)}
          {costLine("Gas", gas, setGas)}
          {costLine("Insurance", insurance, setInsurance)}
          {costLine("Equipment", equipment, setEquipment)}
          {costLine("Overhead", overhead, setOverhead)}
          <div style={{ borderTop: `1px solid ${T.border}`, margin: "6px 0 8px" }} />
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{profit >= 0 ? "Profit" : "Loss"}</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: profit >= 0 ? T.accent : "#C0392B" }}>{money(Math.abs(profit))} <span style={{ fontSize: 12, color: T.textMuted }}>({margin.toFixed(0)}%)</span></span>
          </div>
        </div>

        <Btn onClick={save} style={{ width: "100%", padding: "12px", borderRadius: 12 }}>Save Changes</Btn>
      </div>
    </Modal>
  );
}

function ClientHistory({ client, onChange }) {
  const { T, perms } = useApp();
  const [editIdx, setEditIdx] = useState(null);
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const history = client.history || [];

  const saveEntry = (idx, updated) => {
    if (onChange) onChange(history.map((h, i) => i === idx ? updated : h));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {history.length === 0 && (
        <div style={{ textAlign: "center", padding: "36px 20px", color: T.textMuted }}>
          <div style={{ width: 52, height: 52, borderRadius: 16, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="clipboard" size={26} /></div>
          <div style={{ fontSize: 13 }}>No service history yet. Completed stops will appear here.</div>
        </div>
      )}
      {history.map((h, i) => {
        const readingPairs = h.readings && Object.keys(h.readings).length
          ? Object.entries(h.readings).filter(([, v]) => v)
          : [["pH", h.ph],["NH₃", h.ammonia],["NO₂", h.nitrite],["Temp", h.temp]].filter(([, v]) => v && v !== "—");
        const b = h.breakdown;
        return (
          <Card key={i}>
            <div style={{ padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{h.date}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>{h.type} · {h.tech}</div>
                </div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{h.invoice}</div>
                    {b && perms.seeProfit && <div style={{ fontSize: 11, fontWeight: 700, color: b.profit >= 0 ? T.accent : "#C0392B" }}>{b.profit >= 0 ? "+" : "−"}{money(Math.abs(b.profit))}</div>}
                  </div>
                  {perms.editHistory && <button onClick={() => setEditIdx(i)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", padding: 4, display:"flex", alignItems:"center" }}><Icon name="edit" size={15} /></button>}
                </div>
              </div>

              <div style={{ fontSize: 13, color: T.text, marginBottom: 12, borderLeft: `3px solid ${T.border}`, paddingLeft: 10, lineHeight: 1.5 }}>{h.notes}</div>

              {h.officeNotes && (
                <div style={{ fontSize: 12, color: T.warning, marginBottom: 12, background: `${T.warning}10`, borderRadius: 10, padding: "8px 10px" }}>
                  <strong>Office note:</strong> {h.officeNotes}
                </div>
              )}

              {readingPairs.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {readingPairs.map(([k, v]) => (
                    <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: T.text, marginTop: 2 }}>{v}</div>
                    </div>
                  ))}
                </div>
              )}

              {h.checklist && h.checklist.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: T.textMuted }}>
                  ✓ {h.checklist.filter(t => t.done).length}/{h.checklist.length} tasks done{h.checklist.some(t => !t.done) ? ` · ${h.checklist.filter(t => !t.done).map(t => t.text).join(", ")} skipped` : ""}
                </div>
              )}

              {h.treatmentsUsed && h.treatmentsUsed.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: T.textMuted, display:"flex", alignItems:"center", gap:5 }}><Icon name="info" size={12} /> {h.treatmentsUsed.map(t => `${t.name} (${t.oz}oz)`).join(", ")}</div>
              )}

              {h.photos && h.photos.length > 0 && (
                <div style={{ marginTop: 12 }}><PhotoStrip photos={h.photos} /></div>
              )}

              {b && perms.seeProfit && (
                <details style={{ marginTop: 14, background: T.surfaceAlt, borderRadius: 10, padding: "10px 12px" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: T.text, listStyle: "none" }}>
                    Profitability — {b.profit >= 0 ? "Profit" : "Loss"} {money(Math.abs(b.profit))} ({(b.margin || 0).toFixed(0)}%)
                  </summary>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                    {[["Revenue", b.revenue, false],["Labor", b.labor, true],["Treatments", b.treatment, true],["Products", b.product, true],["Gas", b.gas, true],["Insurance", b.insurance, true],["Equipment", b.equipment, true],["Overhead", b.overhead, true]].map(([k, v, neg]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: T.textMuted }}>{k}</span>
                        <span style={{ color: T.text }}>{neg ? "−" : ""}{money(v)}</span>
                      </div>
                    ))}
                    <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 6, display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 800 }}>
                      <span style={{ color: T.text }}>{b.profit >= 0 ? "Profit" : "Loss"}</span>
                      <span style={{ color: b.profit >= 0 ? T.accent : "#C0392B" }}>{money(Math.abs(b.profit))}</span>
                    </div>
                  </div>
                </details>
              )}
            </div>
          </Card>
        );
      })}

      {editIdx !== null && (
        <HistoryEditModal entry={history[editIdx]} onSave={u => saveEntry(editIdx, u)} onClose={() => setEditIdx(null)} />
      )}
    </div>
  );
}

function ClientPortal({ client, invoices, schedule, branding }) {
  const { T } = useApp();
  const [preview, setPreview] = useState(false);
  const [inviteState, setInviteState] = useState("idle"); // idle | sending | sent | error
  const [inviteMsg, setInviteMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const hasEmail = !!(client.email || "").trim();
  const appUrl = window.location.origin;
  const firstName = client.name.split(" ")[0];

  const copyLink = () => {
    try { navigator.clipboard?.writeText(appUrl); } catch (e) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sendInvite = async () => {
    if (!hasEmail || inviteState === "sending") return;
    setInviteState("sending");
    setInviteMsg("");
    try {
      // signInWithOtp with shouldCreateUser:true creates the account if it
      // doesn't exist yet AND sends the magic link — one call does both.
      const { error } = await supabase.auth.signInWithOtp({
        email: client.email.trim(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: appUrl,
          data: { name: client.name },
        },
      });
      if (error) {
        setInviteState("error");
        setInviteMsg(error.message);
      } else {
        setInviteState("sent");
      }
    } catch (e) {
      setInviteState("error");
      setInviteMsg("Something went wrong. Check your connection and try again.");
    }
  };

  const resetInvite = () => { setInviteState("idle"); setInviteMsg(""); };

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Preview button — top so it's easy to find */}
        <button onClick={() => setPreview(true)}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: T.primary, color: "#fff", border: "none", borderRadius: 14, padding: "14px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 16px ${hexA(T.primary, 0.3)}`, letterSpacing: "-0.01em" }}>
          <Icon name="eye" size={18} /> Preview Portal as {firstName}
        </button>

        {/* Invite card */}
        <Card>
          <div style={{ padding: "20px 20px" }}>
            <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, background: hexA(T.primary, 0.1), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="mail" size={22} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.text, letterSpacing: "-0.01em" }}>Client Portal Access</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Send {firstName} a login link to their portal</div>
              </div>
            </div>

            {/* No email warning */}
            {!hasEmail && (
              <div style={{ background: hexA(T.warning, 0.08), border: `1px solid ${hexA(T.warning, 0.25)}`, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: T.warning, display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 0 }}>
                <Icon name="warning" size={15} />
                <span>No email on file. Add {firstName}'s email in Edit before sending an invite.</span>
              </div>
            )}

            {/* Email on file + invite controls */}
            {hasEmail && (
              <>
                {/* Email display */}
                <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 11, padding: "10px 14px", fontSize: 13, color: T.textMuted, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <Icon name="mail" size={14} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.email}</span>
                  <button onClick={copyLink} style={{ background: "none", border: "none", color: T.primary, fontWeight: 600, fontSize: 11, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, display:"flex", alignItems:"center", gap:4 }}>
                    <Icon name="link" size={11} />{copied ? "Copied!" : "Copy link"}
                  </button>
                </div>

                {/* Idle state — send button */}
                {inviteState === "idle" && (
                  <Btn onClick={sendInvite} block style={{ gap: 8 }}>
                    <Icon name="mail" size={15} /> Send Login Invite to {firstName}
                  </Btn>
                )}

                {/* Sending */}
                {inviteState === "sending" && (
                  <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: "13px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 14, color: T.textMuted }}>
                    <div style={{ width: 16, height: 16, border: `2px solid ${T.border}`, borderTopColor: T.primary, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                    Sending invite...
                  </div>
                )}

                {/* Sent success */}
                {inviteState === "sent" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ background: hexA("#16a34a", 0.08), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ color: "#16a34a", flexShrink: 0, marginTop: 1 }}><Icon name="check" size={16} /></div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#16a34a", marginBottom: 3 }}>Invite sent to {firstName}</div>
                        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>They'll receive a login link at <b>{client.email}</b>. The link is valid for 1 hour. You can resend anytime.</div>
                      </div>
                    </div>
                    <Btn variant="ghost" onClick={resetInvite} block style={{ gap: 6 }}>
                      <Icon name="refresh" size={13} /> Resend Invite
                    </Btn>
                  </div>
                )}

                {/* Error */}
                {inviteState === "error" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ background: hexA(T.warning, 0.08), border: `1px solid ${hexA(T.warning, 0.25)}`, borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ color: T.warning, flexShrink: 0, marginTop: 1 }}><Icon name="warning" size={16} /></div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.warning, marginBottom: 3 }}>Invite failed</div>
                        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>{inviteMsg || "Something went wrong. Try again."}</div>
                      </div>
                    </div>
                    <Btn onClick={sendInvite} block style={{ gap: 8 }}>
                      <Icon name="mail" size={15} /> Try Again
                    </Btn>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        {/* How it works */}
        <Card>
          <CardHeader title="How it works" />
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              { icon: "mail",    text: "Tap Send Invite — we email them a secure login link" },
              { icon: "mobile",  text: `${firstName} taps the link and lands directly in their portal` },
              { icon: "history", text: "They see their service history, invoices, and can request service" },
              { icon: "check",   text: "They stay logged in — no password, no friction" },
            ].map((step, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon name={step.icon} size={16} />
                </div>
                <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, paddingTop: 6 }}>{step.text}</div>
              </div>
            ))}
          </div>
        </Card>

        </div>

      {preview && (
        <StaffClientPreview
          client={client}
          invoices={invoices}
          schedule={schedule}
          branding={branding}
          onClose={() => setPreview(false)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// STAFF CLIENT PREVIEW
// Renders the real client portal inside a fixed overlay
// with a staff-only banner so you can exit back instantly.
// ─────────────────────────────────────────────
function StaffClientPreview({ client, invoices, schedule, branding, onClose }) {
  const { T } = useApp();
  const fontStack = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", flexDirection: "column" }}>
      {/* Staff-only banner — always on top, not part of the real client view */}
      <div style={{ background: "#1D1D1F", color: "#fff", flexShrink: 0, zIndex: 501 }}>
        {/* Safe area spacer so banner clears the iPhone status bar */}
        <div style={{ height: "env(safe-area-inset-top)" }} />
        <div style={{
          padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: T.primary, color: "#fff", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 100, letterSpacing: "0.05em" }}>STAFF PREVIEW</span>
            <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>Viewing as {client.name}</span>
          </div>
          <button onClick={onClose} style={{
            background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff",
            borderRadius: 10, padding: "8px 16px", fontSize: 12, fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5,
            WebkitTapHighlightColor: "transparent",
          }}>← Back to my view</button>
        </div>
      </div>

      {/* Real client portal scrollable below the banner */}
      <div style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        <SPSClientPortal
          client={client}
          invoices={invoices}
          schedule={schedule}
          branding={branding}
          estimates={[]}
          T={T}
          fontStack={fontStack}
          onSignOut={onClose}
          onServiceRequest={() => {}}
          onApproveEstimate={() => {}}
          onUpgradeRequest={() => {}}
          isStaffPreview={true}
        />
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────
// ON MY WAY MODAL
// ─────────────────────────────────────────────
function OnMyWayModal({ stop, client, email, onClose, onSent }) {
  const { T, branding } = useApp();

  // ETA is set manually by the tech — auto-calc via Google Maps wired in later
  const [eta, setEta] = useState(15); // default 15 min
  const firstName = client?.name?.split(" ")[0] || "there";
  const phone = client?.phone?.replace(/\D/g, "") || "";

  const arrival = new Date(Date.now() + eta * 60000);
  const arrivalStr = arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const message = (() => {
    const tpl = (email && email.smsOnMyWay) || DEFAULT_EMAIL.smsOnMyWay;
    return tpl
      .replace(/\{first\}/g, firstName)
      .replace(/\{sender\}/g, (email && email.senderName) || (email && email.fromName) || branding.companyName)
      .replace(/\{company\}/g, branding.companyName)
      .replace(/\{eta\}/g, String(eta))
      .replace(/\{arrival\}/g, arrivalStr)
      .replace(/\{track\}/g, "");
  })();

  const handleSend = () => {
    if (!phone) return;
    const smsUrl = `sms:${phone}${/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(message)}`;
    window.open(smsUrl, "_blank");
    onSent();
    onClose();
  };

  const QUICK_MINS = [10, 15, 20, 30, 45, 60];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: T.surface, borderRadius: "22px 22px 0 0", width: "100%", maxWidth: 600, padding: "20px 20px calc(28px + env(safe-area-inset-bottom))", boxShadow: "0 -8px 40px rgba(0,0,0,0.2)" }}>

        <div style={{ width: 36, height: 4, background: T.border, borderRadius: 2, margin: "0 auto 20px" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: T.text, letterSpacing: "-0.02em" }}>On My Way</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{client?.name} · {client?.phone}</div>
          </div>
          <button onClick={onClose} style={{ background: T.surfaceAlt, border: "none", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* ETA display + stepper */}
        <div style={{ background: T.surfaceAlt, borderRadius: 18, padding: "20px", marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, marginBottom: 14, textAlign: "center" }}>Estimated Arrival</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <button onClick={() => setEta(e => Math.max(5, e - 5))}
              style={{ width: 48, height: 48, borderRadius: 14, border: `1.5px solid ${T.border}`, background: T.surface, fontSize: 24, fontWeight: 300, color: T.text, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 44, fontWeight: 800, color: T.text, lineHeight: 1, letterSpacing: "-0.03em" }}>{eta}<span style={{ fontSize: 18, fontWeight: 600, color: T.textMuted }}> min</span></div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Arriving around <strong style={{ color: T.text }}>{arrivalStr}</strong></div>
            </div>
            <button onClick={() => setEta(e => e + 5)}
              style={{ width: 48, height: 48, borderRadius: 14, border: `1.5px solid ${T.border}`, background: T.surface, fontSize: 24, fontWeight: 300, color: T.text, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            {QUICK_MINS.map(m => (
              <button key={m} onClick={() => setEta(m)}
                style={{ flex: 1, padding: "7px 2px", borderRadius: 10, border: `1.5px solid ${eta === m ? T.primary : T.border}`, background: eta === m ? hexA(T.primary, 0.1) : T.surface, color: eta === m ? T.primary : T.textMuted, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                {m}
              </button>
              ))}
          </div>
        </div>

        {/* Message preview */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Message Preview</div>
          <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", fontSize: 13, color: T.text, lineHeight: 1.6 }}>
            {message}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Stopping for gas or lunch? Adjust the time above so the client isn't left waiting.</div>
        </div>

        {/* Actions */}
        {!phone && (
          <div style={{ background: hexA(T.warning, 0.08), border: `1px solid ${hexA(T.warning, 0.25)}`, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: T.warning, marginBottom: 14, display: "flex", gap: 8 }}>
            <Icon name="warning" size={14} /> No phone number on file for this client.
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={handleSend} disabled={!phone} block style={{ flex: 1, gap: 7 }}>
            <Icon name="message" size={15} /> Send via Messages
          </Btn>
          <button onClick={onClose}
            style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 12, padding: "13px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer", color: T.text, fontFamily: "inherit" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PHOTO VIEWER (lightbox)
// ─────────────────────────────────────────────
function PhotoViewer({ photos, index, onClose }) {
  const [i, setI] = useState(index || 0);
  const prev = (e) => { e.stopPropagation(); setI(x => (x - 1 + photos.length) % photos.length); };
  const next = (e) => { e.stopPropagation(); setI(x => (x + 1) % photos.length); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "50%", width: 38, height: 38, cursor: "pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Icon name="close" size={18} /></button>
      {photos.length > 1 && <button onClick={prev} style={{ position: "absolute", left: 12, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "50%", width: 42, height: 42, cursor: "pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Icon name="back" size={20} /></button>}
      <img src={photos[i]} alt="" style={{ maxWidth: "92%", maxHeight: "82%", borderRadius: 10, objectFit: "contain" }} onClick={e => e.stopPropagation()} />
      {photos.length > 1 && <button onClick={next} style={{ position: "absolute", right: 12, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "50%", width: 42, height: 42, fontSize: 22, cursor: "pointer" }}>›</button>}
      <div style={{ position: "absolute", bottom: 20, color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{i + 1} / {photos.length}</div>
    </div>
  );
}

function PhotoStrip({ photos, size = 56 }) {
  const [viewer, setViewer] = useState(null);
  if (!photos || photos.length === 0) return null;
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {photos.map((p, i) => (
          <img key={i} src={p} alt="" onClick={() => setViewer(i)}
            style={{ width: size, height: size, borderRadius: 10, objectFit: "cover", cursor: "pointer" }} />
        ))}
      </div>
      {viewer !== null && <PhotoViewer photos={photos} index={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}

// ─────────────────────────────────────────────
// SERVICE WORKSPACE (perform & log a stop, with profitability)
// ─────────────────────────────────────────────
function CompleteStopModal({ stop, client, email, catalog, costs, team, onComplete, onClose, onViewClient, onOfficeAlert }) {
  const { T, branding, perms } = useApp();
  const todayStr = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
  const firstName = client?.name?.split(" ")[0] || "there";
  const phone = client?.phone?.replace(/\D/g, "") || "";

  // visit data
  const [minutes, setMinutes] = useState(parseInt(stop.duration) || 60);
  const [timerOn, setTimerOn] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds
  const [readings, setReadings] = useState({});
  const [tx, setTx] = useState({});       // treatmentId -> oz
  const [prods, setProds] = useState({});  // productId -> true
  const [notesClient, setNotesClient] = useState("");
  const [notesOffice, setNotesOffice] = useState("");
  const [officeFlag, setOfficeFlag] = useState(false);
  const [officeFlagMsg, setOfficeFlagMsg] = useState("");
  // Unified photos: each entry is { src, label } — label is editable per photo
  const [photos, setPhotos] = useState([]); // [{ src, label }]
  const [satisfaction,     setSatisfaction]     = useState(0);  // 1-5 stars, 0 = not rated
  const [satisfactionNote, setSatisfactionNote] = useState(""); // required when rating is set
  const MAX_PHOTOS = 10;
  const PHOTO_LABELS = ["Before", "After", "Detail", "Equipment", "Issue", "General"];
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // services on this stop (editable price per stop)
  const initServices = (stop.services || []).map(s => typeof s === "string" ? { name: s, price: "" } : { name: s.name, price: s.price || "" });
  const [svcList, setSvcList] = useState(initServices);
  const servicesTotal = svcList.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0);

  // revenue + editable cost assumptions (seeded from settings)
  const alloc = perStopCosts(costs);
  const [assigneeId, setAssigneeId] = useState(stop.assigneeId || "");
  const [revenue, setRevenue] = useState(servicesTotal > 0 ? String(servicesTotal) : "");
  const [hourlyRate, setHourlyRate] = useState(String(laborRateFor(stop.assigneeId, team, costs)));
  const [gas, setGas] = useState(alloc.gas.toFixed(2));
  const [insurance, setInsurance] = useState(alloc.insurance.toFixed(2));
  const [equipment, setEquipment] = useState(alloc.equipment.toFixed(2));
  const [overhead, setOverhead] = useState(alloc.overhead.toFixed(2));
  // when the assignee changes, refresh the labor rate to that person's rate
  const pickAssignee = (id) => { setAssigneeId(id); setHourlyRate(String(laborRateFor(id, team, costs))); };

  const setSvcPrice = (i, val) => {
    const next = svcList.map((s, idx) => idx === i ? { ...s, price: val.replace(/[^\d.]/g, "") } : s);
    setSvcList(next);
    setRevenue(String(next.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0)));
  };

  // checklist seeded from the services on this stop (each service can define default tasks)
  const [checklist, setChecklist] = useState(() => {
    const names = (stop.services || []).map(s => typeof s === "string" ? s : s.name);
    const seeded = (catalog.services || [])
      .filter(s => names.includes(s.name))
      .flatMap(s => (s.checklist || []))
      .map(t => (t || "").trim())
      .filter(Boolean);
    return [...new Set(seeded)].map((t, i) => ({ id: `c${i}`, text: t, done: false }));
  });
  const [newTask, setNewTask] = useState("");
  const toggleTask = (id) => setChecklist(cl => cl.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const addTask = () => { if (!newTask.trim()) return; setChecklist(cl => [...cl, { id: `c${Date.now()}`, text: newTask.trim(), done: false }]); setNewTask(""); };
  const removeTask = (id) => setChecklist(cl => cl.filter(t => t.id !== id));
  const tasksDone = checklist.filter(t => t.done).length;

  // timer
  useEffect(() => {
    if (!timerOn) return;
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, [timerOn]);
  const stopTimer = () => { setTimerOn(false); setMinutes(Math.max(1, Math.round(elapsed / 60))); };

  const num = (v) => parseFloat(v) || 0;
  const tests = catalog.tests || [];
  const treatments = catalog.treatments || [];
  const products = catalog.products || [];

  // cost math
  const laborCost = (num(minutes) / 60) * num(hourlyRate);
  const treatmentCost = treatments.reduce((sum, t) => sum + num(tx[t.id]) * num(t.costPerOz), 0);
  const productCost = products.reduce((sum, p) => sum + (prods[p.id] ? num(p.price) : 0), 0);
  const totalCost = laborCost + treatmentCost + productCost + num(gas) + num(insurance) + num(equipment) + num(overhead);
  const profit = num(revenue) - totalCost;
  const margin = num(revenue) > 0 ? (profit / num(revenue)) * 100 : 0;
  const money = (n) => `$${n.toFixed(2)}`;

  const addPhotos = async (e, defaultLabel = "General") => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) return;
    setBusy(true);
    const compressed = [];
    for (const f of files.slice(0, remaining)) {
      const src = await compressImage(f);
      compressed.push({ src, label: defaultLabel });
    }
    setPhotos(p => [...p, ...compressed]);
    setBusy(false);
    e.target.value = "";
  };
  const removePhoto = (i) => setPhotos(p => p.filter((_, idx) => idx !== i));
  const relabelPhoto = (i, label) => setPhotos(p => p.map((ph, idx) => idx === i ? { ...ph, label } : ph));

  const treatmentsUsed = treatments
    .filter(t => num(tx[t.id]) > 0)
    .map(t => ({ id: t.id, name: t.name, oz: num(tx[t.id]), costPerOz: num(t.costPerOz), cost: num(tx[t.id]) * num(t.costPerOz) }));
  const productsUsed = products.filter(p => prods[p.id]).map(p => p.name);

  const ctx = {
    firstName, company: branding.companyName, serviceType: stop.type,
    date: todayStr, tech: "B. Stone", notes: notesClient,
    ph: readings["pH"] || "", ammonia: readings["Ammonia"] || "", nitrite: readings["Nitrite"] || "", temp: readings["Temperature"] || "",
    photoCount: photos.length,
    photosBeforeCount: photos.filter(p => p.label === "Before").length,
    photosAfterCount:  photos.filter(p => p.label === "After").length,
  };
  const reportText = renderReport(email, ctx);

  const assignedMember = (team || []).find(e => e.id === assigneeId);
  const buildEntry = () => ({
    date: todayStr, tech: assignedMember ? assignedMember.name : "Unassigned", type: stop.type,
    assigneeId: assigneeId || "",
    notes: notesClient || "Service completed.",
    officeNotes: notesOffice,
    services: svcList,
    checklist,
    readings,
    // legacy fields for older history cards
    ph: readings["pH"] || "—", ammonia: readings["Ammonia"] || "—", nitrite: readings["Nitrite"] || "—", temp: readings["Temperature"] || "—",
    invoice: revenue ? `$${revenue}` : "$0",
    photos,  // [{ src, label }]
    satisfaction,
    satisfactionNote,
    treatmentsUsed, productsUsed,
    breakdown: {
      revenue: num(revenue), minutes: num(minutes), hourlyRate: num(hourlyRate),
      labor: laborCost, treatment: treatmentCost, product: productCost,
      gas: num(gas), insurance: num(insurance), equipment: num(equipment), overhead: num(overhead),
      total: totalCost, profit, margin,
    },
  });

  const finish = () => {
    if (satisfaction > 0 && !satisfactionNote.trim()) {
      alert("Please add a note to support your satisfaction rating before completing.");
      return;
    }
    onComplete(stop.id, buildEntry(), stop.sid);
    if (officeFlag && officeFlagMsg.trim() && onOfficeAlert) {
      onOfficeAlert({ client: client?.name || "Client", clientId: client?.id, message: officeFlagMsg.trim(), date: todayStr });
    }
    setDone(true);
  };

  const sendEmail = () => {
    const subject = email.subject.replace("{date}", todayStr);
    window.open(`mailto:${client?.email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reportText)}`, "_blank");
  };
  const sendText = () => {
    const short = `Hi ${firstName}, your ${stop.type} is complete! Full report sent to your email. Photos are in your portal. — ${branding.companyName}`;
    window.open(`sms:${phone}${/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(short)}`, "_blank");
  };

  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };
  const smallInput = { width: "100%", padding: "9px 10px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" };
  const sectionGap = { marginBottom: 20 };

  if (done) {
    return (
      <Modal title="Service Complete" onClose={onClose}>
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <div style={{ width: 60, height: 60, borderRadius: 18, background: hexA("#16a34a", 0.1), color: "#16a34a", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="check" size={28} /></div>
          <div style={{ fontWeight: 800, fontSize: 17, color: T.text, marginBottom: 6 }}>Saved to {firstName}'s history</div>
          {/* profit chip */}
          <div style={{ display: "inline-block", background: profit >= 0 ? `${T.accent}18` : "#C0392B18", color: profit >= 0 ? T.accent : "#C0392B", borderRadius: 20, padding: "6px 16px", fontSize: 14, fontWeight: 800, marginBottom: 16 }}>
            {profit >= 0 ? "Profit" : "Loss"}: {money(Math.abs(profit))} · {margin.toFixed(0)}% margin
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 18, lineHeight: 1.5 }}>Send the client their report:</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <Btn onClick={sendEmail} style={{ flex: 1, padding: "13px", borderRadius: 12, display:"flex", alignItems:"center", gap:6 }}><Icon name="mail" size={14} /> Email Report</Btn>
            <Btn onClick={sendText} variant="ghost" style={{ flex: 1, padding: "13px", borderRadius: 12, display:"flex", alignItems:"center", gap:6 }}><Icon name="message" size={14} /> Text Report</Btn>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 8, fontFamily: "inherit" }}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={client?.name || "Service"} onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: -8, marginBottom: 18 }}>
        <div style={{ fontSize: 12, color: T.textMuted }}>{stop.type} · {todayStr}</div>
        {onViewClient && client && <button onClick={() => { onViewClient(client); onClose(); }} style={{ background: "none", border: "none", color: T.primary, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>View client →</button>}
      </div>

      {/* Assigned to */}
      {(team || []).length > 0 && (
        <div style={sectionGap}>
          <label style={labelStyle}>Assigned To</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <button onClick={() => pickAssignee("")}
              style={{ padding: "8px 14px", borderRadius: 100, border: `1.5px solid ${assigneeId === "" ? T.primary : T.border}`, background: assigneeId === "" ? T.navActiveBg : T.surface, color: assigneeId === "" ? T.primary : T.textMuted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
              Unassigned
            </button>
            {team.map(e => {
              const on = assigneeId === e.id;
              return (
                <button key={e.id} onClick={() => pickAssignee(e.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px 8px 8px", borderRadius: 100, border: `1.5px solid ${on ? T.primary : T.border}`, background: on ? T.navActiveBg : T.surface, color: on ? T.primary : T.text, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", background: hexA(T.primary, 0.14), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 10 }}>{initials(e.name)}</span>
                  {e.name}
                </button>
              );
            })}
          </div>
          {perms.seeProfit && assignedMember && assignedMember.rate !== "" && assignedMember.rate != null && (
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>Labor billed at {assignedMember.name}'s rate of ${assignedMember.rate}/hr.</div>
          )}
        </div>
      )}

      {/* Services — category header with editable prices */}
      {svcList.length > 0 && (
        <div style={sectionGap}>
          <label style={labelStyle}>{stop.type} — Services</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {svcList.map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: T.surfaceAlt, borderRadius: 10, padding: "9px 12px" }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>{s.name}</span>
                <div style={{ position: "relative", width: 92 }}>
                  <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
                  <input type="text" inputMode="decimal" value={s.price} onChange={e => setSvcPrice(i, e.target.value)} placeholder="0"
                    style={{ width: "100%", padding: "7px 8px 7px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Prices feed the amount charged below. Edit any line for this stop.</div>
        </div>
      )}

      {/* Checklist */}
      <div style={sectionGap}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Checklist</label>
          {checklist.length > 0 && (
            <span style={{ fontSize: 12, fontWeight: 700, color: tasksDone === checklist.length ? T.accent : T.textMuted }}>
              {tasksDone}/{checklist.length} done
            </span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {checklist.map(t => (
            <div key={t.id} onClick={() => toggleTask(t.id)}
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", borderRadius: 12, cursor: "pointer",
                background: t.done ? hexA(T.accent, 0.1) : T.surfaceAlt,
                border: `1px solid ${t.done ? hexA(T.accent, 0.35) : "transparent"}`, transition: "all .15s" }}>
              <span style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                background: t.done ? T.accent : "transparent", border: `2px solid ${t.done ? T.accent : T.border}`, transition: "all .15s" }}>
                {t.done && <Icon name="check" size={12} />}
              </span>
              <span style={{ flex: 1, fontSize: 14, fontWeight: t.done ? 500 : 600, color: t.done ? T.textMuted : T.text, textDecoration: t.done ? "line-through" : "none", transition: "all .15s" }}>{t.text}</span>
              {t.done
                ? <span style={{ fontSize: 11, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.04em" }}>Done</span>
                : <button onClick={e => { e.stopPropagation(); removeTask(t.id); }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>}
            </div>
          ))}
          {checklist.length === 0 && <div style={{ fontSize: 12, color: T.textMuted }}>No tasks yet — add what needs to get done below.</div>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input type="text" value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === "Enter" && addTask()} placeholder="Add a task..."
            style={{ flex: 1, padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
          <Btn sm onClick={addTask} style={{ padding: "10px 16px" }}>Add</Btn>
        </div>
      </div>

      {/* Time on site */}
      <div style={sectionGap}>
        <label style={labelStyle}>Time on Site</label>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input type="text" inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value.replace(/\D/g, ""))} style={{ ...smallInput, textAlign: "left", paddingRight: 40 }} />
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>min</span>
          </div>
          {!timerOn ? (
            <button onClick={() => { setElapsed(0); setTimerOn(true); }} style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 10, padding: "9px 14px", fontSize: 13, fontWeight: 700, color: T.text, cursor: "pointer", fontFamily: "inherit" }}>▶ Start timer</button>
          ) : (
            <button onClick={stopTimer} style={{ background: T.primary, border: "none", borderRadius: 10, padding: "9px 14px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
              ⏸ {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </button>
          )}
        </div>
      </div>

      {/* Tests */}
      {tests.length > 0 && (
        <div style={sectionGap}>
          <label style={labelStyle}>Water Tests</label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {tests.map(t => (
              <div key={t}>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textAlign: "center", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t}</div>
                <input type="text" inputMode="decimal" value={readings[t] || ""} onChange={e => setReadings(r => ({ ...r, [t]: e.target.value }))} style={smallInput} placeholder="—" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Treatments */}
      {treatments.length > 0 && (
        <div style={sectionGap}>
          <label style={labelStyle}>Treatments Applied (oz)</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {treatments.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, background: T.surfaceAlt, borderRadius: 10, padding: "8px 12px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: (num(tx[t.id]) > num(t.inventoryOz)) ? T.warning : T.textMuted }}>
                    ${num(t.costPerOz).toFixed(2)}/oz · {num(t.inventoryOz)} oz on hand{num(tx[t.id]) > num(t.inventoryOz) ? " · over!" : ""}
                  </div>
                </div>
                <input type="text" inputMode="decimal" value={tx[t.id] || ""} onChange={e => setTx(x => ({ ...x, [t.id]: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="0" style={{ width: 60, padding: "8px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", textAlign: "center", boxSizing: "border-box" }} />
                <span style={{ fontSize: 12, color: T.textMuted, width: 14 }}>oz</span>
                <div style={{ width: 56, textAlign: "right", fontSize: 12, fontWeight: 700, color: num(tx[t.id]) > 0 ? T.text : T.textMuted }}>{money(num(tx[t.id]) * num(t.costPerOz))}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products */}
      {products.length > 0 && (
        <div style={sectionGap}>
          <label style={labelStyle}>Products Used</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {products.map(p => (
              <button key={p.id} onClick={() => setProds(s => ({ ...s, [p.id]: !s[p.id] }))}
                style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${prods[p.id] ? T.primary : T.border}`, background: prods[p.id] ? T.navActiveBg : T.surface, color: prods[p.id] ? T.primary : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {p.name}{p.price ? ` · $${p.price}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Photos — up to 10, each labeled */}
      <div style={sectionGap}>
        <label style={labelStyle}>
          Photos
          <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}> ({photos.length}/{MAX_PHOTOS})</span>
        </label>

        {/* Existing photos with label picker */}
        {photos.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {photos.map((ph, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", background: T.surfaceAlt, borderRadius: 12, padding: "8px 10px" }}>
                <img src={ph.src} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {PHOTO_LABELS.map(lbl => (
                      <button key={lbl} type="button" onClick={() => relabelPhoto(i, lbl)}
                        style={{ padding: "4px 10px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit",
                          background: ph.label === lbl ? T.primary : T.surface,
                          color: ph.label === lbl ? "#fff" : T.textMuted }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={() => removePhoto(i)}
                  style={{ background: "none", border: "none", color: T.textMuted, fontSize: 18, cursor: "pointer", lineHeight: 1, flexShrink: 0, padding: "0 4px" }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Add photo button */}
        {photos.length < MAX_PHOTOS && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderRadius: 12, border: `2px dashed ${T.border}`, cursor: "pointer", color: T.textMuted, fontSize: 13, fontWeight: 600 }}>
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            {busy ? "Adding…" : `Add photos (${MAX_PHOTOS - photos.length} remaining)`}
            <input type="file" accept="image/*,image/heic,image/heif" multiple onChange={e => addPhotos(e, "General")} style={{ display: "none" }} />
          </label>
        )}
      </div>

      {/* Client Satisfaction */}
      <div style={sectionGap}>
        <label style={labelStyle}>
          Client Satisfaction
          <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}> (optional)</span>
        </label>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: satisfaction > 0 ? 10 : 0 }}>
          {[1,2,3,4,5].map(star => (
            <button key={star} type="button"
              onClick={() => { setSatisfaction(satisfaction === star ? 0 : star); if (satisfaction === star) setSatisfactionNote(""); }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 4px", fontSize: 30, lineHeight: 1,
                color: star <= satisfaction ? "#F59E0B" : T.border,
                transform: star <= satisfaction ? "scale(1.1)" : "scale(1)",
                transition: "color 0.12s, transform 0.12s" }}>
              ★
            </button>
          ))}
          {satisfaction > 0 && (
            <span style={{ fontSize: 13, fontWeight: 700, color: "#F59E0B", marginLeft: 4 }}>
              {["","Poor","Fair","Good","Great","Excellent"][satisfaction]}
            </span>
          )}
        </div>
        {satisfaction > 0 && (
          <div>
            <textarea
              value={satisfactionNote}
              onChange={e => setSatisfactionNote(e.target.value)}
              placeholder={satisfaction <= 2
                ? "What went wrong? (required)"
                : satisfaction === 3
                  ? "What could have been better? (required)"
                  : "What stood out about this visit? (required)"}
              rows={2}
              style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${satisfactionNote.trim() ? T.border : "#E5484D"}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" }}
            />
            {!satisfactionNote.trim() && (
              <div style={{ fontSize: 11, color: "#E5484D", marginTop: 4, fontWeight: 600 }}>
                A note is required with every rating.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Notes to client */}
      <div style={sectionGap}>
        <label style={labelStyle}>Notes to Client <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(in their report & portal)</span></label>
        <textarea value={notesClient} onChange={e => setNotesClient(e.target.value)} placeholder="What you'd like the client to know..." rows={2}
          style={{ width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
      </div>

      {/* Notes to office */}
      <div style={sectionGap}>
        <label style={labelStyle}>Notes to Office <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(internal — all staff see this)</span></label>
        <textarea value={notesOffice} onChange={e => setNotesOffice(e.target.value)} placeholder="Internal notes — never shown to the client..." rows={2}
          style={{ width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
      </div>

      {/* Flag for office attention */}
      <div style={sectionGap}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: officeFlag ? 10 : 0 }}>
          <Checkbox checked={officeFlag} onChange={() => setOfficeFlag(f => !f)} accent={T.warning} />
          <span style={{ display:"flex", alignItems:"center", gap:6, fontSize: 13, fontWeight: 700, color: T.text }}><Icon name="warning" size={14} /> Flag for office attention</span>
        </label>
        {officeFlag && (
          <>
            <textarea value={officeFlagMsg} onChange={e => setOfficeFlagMsg(e.target.value)} placeholder="e.g. Client wants a new pump quote; needs algaecide reorder..." rows={2}
              style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${T.warning}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: `${T.warning}08`, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>This sends an alert to the office (shown on the admin dashboard). Email/SMS notification turns on with the backend.</div>
          </>
        )}
      </div>

      {/* Profitability */}
      {perms.seeProfit && (
      <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 12 }}>Job Profitability</div>

        {/* Revenue */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Amount Charged</span>
          <div style={{ position: "relative", width: 110 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
            <input type="text" inputMode="decimal" value={revenue} onChange={e => setRevenue(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" style={{ width: "100%", padding: "8px 8px 8px 22px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${T.border}`, margin: "10px 0", paddingTop: 10 }} />

        {/* computed cost lines */}
        {[["Labor", money(laborCost), `${minutes} min @ $${num(hourlyRate)}/hr`],
          ["Treatments", money(treatmentCost), null],
          ["Products", money(productCost), null]].map(([k, v, sub]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: T.text }}>{k}{sub && <span style={{ fontSize: 11, color: T.textMuted }}> · {sub}</span>}</span>
            <span style={{ fontSize: 13, color: T.textMuted }}>−{v}</span>
          </div>
        ))}

        {/* editable cost lines */}
        {[["Labor rate /hr", hourlyRate, setHourlyRate],["Gas", gas, setGas],["Insurance", insurance, setInsurance],["Equipment", equipment, setEquipment],["Overhead", overhead, setOverhead]].map(([k, val, setter]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: T.text }}>{k}</span>
            <div style={{ position: "relative", width: 90 }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
              <input type="text" inputMode="decimal" value={val} onChange={e => setter(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "6px 8px 6px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
            </div>
          </div>
        ))}

        <div style={{ borderTop: `1px solid ${T.border}`, margin: "10px 0", paddingTop: 10 }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Total Cost</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{money(totalCost)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{profit >= 0 ? "Profit" : "Loss"}</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: profit >= 0 ? T.accent : "#C0392B" }}>
            {money(Math.abs(profit))} <span style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>({margin.toFixed(0)}%)</span>
          </span>
        </div>
      </div>
      )}

      <Btn onClick={finish} style={{ width: "100%", padding: "13px", fontSize: 14, borderRadius: 12 }}>
        Finish & Save Report
      </Btn>
    </Modal>
  );
}
// ─────────────────────────────────────────────
// ADD / EDIT STOP FORM
// ─────────────────────────────────────────────
const dayLabel = (dateStr) => {
  // dateStr MM/DD/YYYY
  const [m, d, y] = dateStr.split("/").map(Number);
  if (!m || !d || !y) return dateStr;
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return date.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
};

function AddStopForm({ clients, catalog, team, seedClientIds, onSave, onClose }) {
  const { T } = useApp();
  const [clientSearch, setClientSearch] = useState("");
  const [selClients, setSelClients] = useState(
    Object.fromEntries((seedClientIds || []).map(id => [id, true]))
  );
  const [dateISO, setDateISO] = useState("");   // yyyy-mm-dd from native picker
  const [timeISO, setTimeISO] = useState("");   // HH:MM 24h from native picker
  const [stopType, setStopType] = useState(catalog.stopTypes[0] || "");
  const [duration, setDuration] = useState("60");
  const [selServices, setSelServices] = useState({}); // id -> true
  const [svcPrices, setSvcPrices] = useState({});     // id -> override price string
  const [selProducts, setSelProducts] = useState({});
  const [assigneeId, setAssigneeId] = useState("");   // "" = unassigned

  const q = clientSearch.toLowerCase();
  const filteredClients = clients.filter(c => (c.name || "").toLowerCase().includes(q));
  const selClientIds = Object.keys(selClients).filter(k => selClients[k]).map(Number);

  const toggleClient = (id) => setSelClients(s => ({ ...s, [id]: !s[id] }));
  const toggleService = (id) => {
    const turningOn = !selServices[id];
    setSelServices(s => ({ ...s, [id]: !s[id] }));
    const svc = catalog.services.find(s => s.id === id);
    if (svc && turningOn) {
      // seed editable price from catalog default
      setSvcPrices(p => ({ ...p, [id]: p[id] ?? (svc.price || "") }));
      if (svc.products && svc.products.length) {
        setSelProducts(p => { const next = { ...p }; svc.products.forEach(pid => { next[pid] = true; }); return next; });
      }
    }
  };
  const toggleProduct = (id) => setSelProducts(s => ({ ...s, [id]: !s[id] }));

  // convert native inputs to the app's display formats
  const toMMDDYYYY = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };
  const to12h = (t) => {
    if (!t) return { time: "", ampm: "AM" };
    let [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return { time: `${h}:${String(m).padStart(2, "0")}`, ampm };
  };

  const canSave = selClientIds.length > 0 && dateISO && timeISO;

  const handleSave = () => {
    const { time, ampm } = to12h(timeISO);
    const services = catalog.services.filter(s => selServices[s.id]).map(s => ({ name: s.name, price: (svcPrices[s.id] ?? s.price ?? "") }));
    const products = catalog.products.filter(p => selProducts[p.id]).map(p => ({ name: p.name, price: p.price || "" }));
    const stops = selClientIds.map((id, i) => {
      const c = clients.find(x => x.id === id);
      return {
        sid: `${Date.now()}-${i}`,
        id,
        client: c?.name || "Client",
        address: c?.address || "",
        type: stopType,
        time: `${time} ${ampm}`,
        duration: `${duration} min`,
        services, products,
        assigneeId: assigneeId || "",
      };
    });
    onSave(toMMDDYYYY(dateISO), stops);
  };

  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };
  const nativeInput = { width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };

  return (
    <Modal title="New Service Stop" onClose={onClose}>
      {/* Clients */}
      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Client(s) — {selClientIds.length} selected</label>
        <div style={{ position: "relative", marginBottom: 8 }}>
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>🔍</span>
          <input type="search" placeholder="Search clients..." value={clientSearch} onChange={e => setClientSearch(e.target.value)}
            style={{ width: "100%", padding: "9px 12px 9px 34px", border: `1px solid ${T.border}`, borderRadius: 9, fontSize: 13, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
        </div>
        <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${T.border}`, borderRadius: 10, padding: 6 }}>
          {filteredClients.map(c => (
            <div key={c.id} onClick={() => toggleClient(c.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, cursor: "pointer", background: selClients[c.id] ? T.navActiveBg : "transparent" }}>
              <Checkbox checked={!!selClients[c.id]} onChange={() => toggleClient(c.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{c.name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Date / Time — native pickers (calendar + clock), still manually typeable */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Date</label>
          <input type="date" value={dateISO} onChange={e => setDateISO(e.target.value)} style={nativeInput} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Time</label>
          <input type="time" value={timeISO} onChange={e => setTimeISO(e.target.value)} step={300} style={nativeInput} />
        </div>
      </div>

      {/* Category (header) + duration */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <div style={{ flex: 2 }}>
          <label style={labelStyle}>Category</label>
          <Select value={stopType} onChange={e => setStopType(e.target.value)} options={catalog.stopTypes} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Duration</label>
          <div style={{ position: "relative" }}>
            <input type="text" inputMode="numeric" value={duration} onChange={e => setDuration(e.target.value.replace(/\D/g, ""))} placeholder="60"
              style={{ width: "100%", padding: "10px 38px 10px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>min</span>
          </div>
        </div>
      </div>

      {/* Assign to a team member */}
      {(team || []).length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Assign To</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <button onClick={() => setAssigneeId("")}
              style={{ padding: "8px 14px", borderRadius: 100, border: `1.5px solid ${assigneeId === "" ? T.primary : T.border}`, background: assigneeId === "" ? T.navActiveBg : T.surface, color: assigneeId === "" ? T.primary : T.textMuted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
              Unassigned
            </button>
            {team.map(e => {
              const on = assigneeId === e.id;
              return (
                <button key={e.id} onClick={() => setAssigneeId(e.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px 8px 8px", borderRadius: 100, border: `1.5px solid ${on ? T.primary : T.border}`, background: on ? T.navActiveBg : T.surface, color: on ? T.primary : T.text, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                  <span style={{ width: 24, height: 24, borderRadius: "50%", background: hexA(T.primary, 0.14), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 10 }}>{initials(e.name)}</span>
                  {e.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Services — tap to add; price is editable per stop */}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Services</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: selClientIds.length || true ? 0 : 0 }}>
          {catalog.services.map(s => (
            <button key={s.id} onClick={() => toggleService(s.id)}
              style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${selServices[s.id] ? T.primary : T.border}`, background: selServices[s.id] ? T.navActiveBg : T.surface, color: selServices[s.id] ? T.primary : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              {s.name}{s.price ? ` · $${s.price}` : ""}
            </button>
          ))}
        </div>
        {/* editable prices for the chosen services */}
        {catalog.services.filter(s => selServices[s.id]).length > 0 && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {catalog.services.filter(s => selServices[s.id]).map(s => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, background: T.surfaceAlt, borderRadius: 9, padding: "7px 10px" }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>{s.name}</span>
                <span style={{ fontSize: 11, color: T.textMuted }}>price</span>
                <div style={{ position: "relative", width: 90 }}>
                  <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
                  <input type="text" inputMode="decimal" value={svcPrices[s.id] ?? s.price ?? ""} onChange={e => setSvcPrices(p => ({ ...p, [s.id]: e.target.value.replace(/[^\d.]/g, "") }))}
                    style={{ width: "100%", padding: "6px 8px 6px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11, color: T.textMuted }}>Prices default to your catalog but can be changed for this stop.</div>
          </div>
        )}
      </div>

      {/* Products */}
      <div style={{ marginBottom: 22 }}>
        <label style={labelStyle}>Products</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {catalog.products.map(p => (
            <button key={p.id} onClick={() => toggleProduct(p.id)}
              style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${selProducts[p.id] ? T.primary : T.border}`, background: selProducts[p.id] ? T.navActiveBg : T.surface, color: selProducts[p.id] ? T.primary : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
              {p.name}{p.price ? ` · $${p.price}` : ""}
            </button>
          ))}
        </div>
      </div>

      <Btn onClick={handleSave} style={{ width: "100%", padding: "13px", fontSize: 14, borderRadius: 12, opacity: canSave ? 1 : 0.5, pointerEvents: canSave ? "auto" : "none" }}>
        {selClientIds.length > 1 ? `Create ${selClientIds.length} Stops` : "Create Stop"}
      </Btn>
      {!canSave && <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center", marginTop: 8 }}>Pick at least one client, a date, and a time.</div>}
    </Modal>
  );
}

// ─────────────────────────────────────────────
// SCHEDULE
// ─────────────────────────────────────────────
function RouteRing({ done, total, size = 58, label = "stops" }) {
  const { T } = useApp();
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(done / total, 1) : 0;
  const full = total > 0 && done >= total;
  const color = full ? T.accent : T.primary;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={T.surfaceAlt} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c * (1 - pct)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y={size * 0.47} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.27} fontWeight="800" fill={color} fontFamily="inherit">{done}/{total}</text>
      <text x="50%" y={size * 0.68} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.16} fontWeight="700" fill={T.textMuted} fontFamily="inherit">{label}</text>
    </svg>
  );
}

function HeadHereModal({ stop, client, email, onClose }) {
  const { T, branding } = useApp();
  const [pref, setPref] = useState(() => { try { return localStorage.getItem("sps_map_app") || null; } catch { return null; } });
  const firstName = client && client.name ? client.name.split(" ")[0] : (stop.client || "there");
  const phone = ((client && (client.phone || client.contactPhone || "")) || "").replace(/[^\d+]/g, "");
  const addr = stop.address || "";
  const msg = (() => {
    const tpl = (email && email.smsOnMyWay) || DEFAULT_EMAIL.smsOnMyWay;
    const track = email && email.trackLink ? `Track: ${email.trackLink} ` : "";
    return (tpl || "")
      .replace(/{first}/g, firstName).replace(/{sender}/g, (email && email.senderName) || branding.companyName)
      .replace(/{company}/g, branding.companyName).replace(/{eta}/g, "a few minutes")
      .replace(/{arrival}/g, "soon").replace(/{track}/g, track);
  })();
  const smsHref = phone ? `sms:${phone}${/iPhone|iPad|iPod/.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(msg)}` : null;
  const openMap = (app) => { try { localStorage.setItem("sps_map_app", app); } catch {} setPref(app); };
  const mapApps = [{ key: "apple", label: "Apple Maps", icon: "A" }, { key: "google", label: "Google Maps", icon: "G" }, { key: "waze", label: "Waze", icon: "💜" }];
  const lbl = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10, display: "block" };
  return (
    <Modal title={`Head to ${stop.client || "Stop"}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {addr && <div style={{ fontSize: 13, color: T.textMuted, marginTop: -8, lineHeight: 1.4, display:"flex", alignItems:"center", gap:5 }}><Icon name="location" size={13} />{addr}</div>}
        <div>
          <span style={lbl}>On My Way Text</span>
          {smsHref ? <Btn href={smsHref} variant="outline" block style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="message" size={15} /> Send On My Way to {firstName}</Btn>
            : <div style={{ fontSize: 13, color: T.textMuted, background: T.surfaceAlt, borderRadius: 10, padding: "11px 14px" }}>Add a phone number to this client to send texts.</div>}
        </div>
        <div>
          <span style={lbl}>Open in Maps</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {mapApps.map(a => (
              <Btn key={a.key} href={buildMapUrl(addr, a.key)} variant={pref === a.key ? "primary" : "ghost"} block onClick={() => openMap(a.key)}>
                {a.label}{pref === a.key ? " ✓" : ""}
              </Btn>
            ))}
          </div>
          {pref && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>Preferred map app saved on this device.</div>}
        </div>
        <Btn variant="ghost" block onClick={onClose}>Done</Btn>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// ROUTE ASSIGNMENTS
// Set a client up once — frequency, day, tech, tier —
// and the schedule auto-populates stops each week.
// ─────────────────────────────────────────────

const DAYS_OF_WEEK = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const FREQ_OPTIONS = [
  { id: "weekly",    label: "Weekly",       weeks: 1 },
  { id: "biweekly",  label: "Bi-Weekly",    weeks: 2 },
  { id: "monthly",   label: "Monthly",      weeks: 4 },
  { id: "6week",     label: "Every 6 Weeks", weeks: 6 },
];

// Given assignments + existing schedule, produce the stops that SHOULD exist
// in a rolling window (today → today + 8 weeks).
// Returns array of { date, stop } for any that are missing.
function computeMissingStops(assignments, schedule, clients, catalog, windowWeeks = 8) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const windowEnd = new Date(today);
  windowEnd.setDate(windowEnd.getDate() + windowWeeks * 7);

  // Build a set of existing (clientId, date) so we don't double-add
  const existing = new Set();
  (schedule||[]).forEach(d => {
    (d.stops||[]).forEach(s => {
      if (s.id) existing.add(`${s.id}::${d.date}`);
    });
  });

  const missing = [];

  (assignments||[]).forEach(a => {
    if (!a.clientId || !a.dayOfWeek || !a.frequency || !a.startDate) return;
    if (a.paused) return;

    const client = (clients||[]).find(c => String(c.id) === String(a.clientId));
    if (!client) return;

    const freqObj = FREQ_OPTIONS.find(f => f.id === a.frequency) || FREQ_OPTIONS[0];
    const intervalDays = freqObj.weeks * 7;

    // Parse start date
    const [sy, sm, sd] = a.startDate.split("-").map(Number);
    let cursor = new Date(sy, sm - 1, sd);
    cursor.setHours(0,0,0,0);

    // Advance cursor to the right day of week
    const targetDay = DAYS_OF_WEEK.indexOf(a.dayOfWeek);
    if (targetDay === -1) return;
    while (cursor.getDay() !== targetDay) cursor.setDate(cursor.getDate() + 1);

    // weekOffset: which occurrence within the cycle to target
    // e.g. for monthly (every 4 weeks), weekOffset=1 means the 2nd occurrence each month
    // For bi-weekly, weekOffset=0 is week A, weekOffset=1 is week B
    const weekOffset = a.weekOffset ?? 0;
    const freqWeeks  = freqObj.weeks;

    // Walk through occurrences within the window
    let occurrenceCount = 0;
    const maxOccurrences = a.stopAfter ? parseInt(a.stopAfter) : 9999;
    const skipWeeks = (a.skipWeeks || "").split(",").map(s => s.trim()).filter(Boolean);

    // For offset-based scheduling: advance cursor to the correct starting occurrence
    // occurrence 0 = first hit at/after startDate, then every intervalDays
    // weekOffset shifts which occurrence within a "cycle" to use
    // We compute a global occurrence index and only emit when (index % freqWeeks) === weekOffset
    // For weekly (freqWeeks=1), weekOffset is always 0 so every occurrence fires
    let globalOccurrence = 0;

    while (cursor <= windowEnd) {
      const isTargetOccurrence = freqWeeks === 1 || (globalOccurrence % freqWeeks === weekOffset % freqWeeks);

      if (cursor >= today && isTargetOccurrence) {
        occurrenceCount++;
        if (occurrenceCount > maxOccurrences) break;

        // Format date as MM/DD/YYYY
        const mm = String(cursor.getMonth()+1).padStart(2,"0");
        const dd = String(cursor.getDate()).padStart(2,"0");
        const yy = cursor.getFullYear();
        const dateStr = `${mm}/${dd}/${yy}`;
        const isoDate = `${yy}-${mm}-${dd}`;

        // Check skip weeks
        const shouldSkip = skipWeeks.some(sw => dateStr.includes(sw) || isoDate.includes(sw));

        if (!shouldSkip && !existing.has(`${client.id}::${dateStr}`)) {
          const stopType = a.stopType || (catalog?.stopTypes?.[0]) || "Service";
          const services = (a.serviceIds || []).map(sid => {
            const svc = (catalog?.services||[]).find(s => s.id === sid);
            return svc ? (typeof svc === "string" ? svc : svc.name) : sid;
          }).filter(Boolean);

          missing.push({
            date: dateStr,
            isoDate,
            stop: {
              sid: `route-${a.id}-${isoDate}`,
              id: client.id,
              client: client.name,
              address: client.address || "",
              type: stopType,
              duration: a.duration || "60",
              time: a.time || "8:00 AM",
              assigneeId: a.techId || "",
              services: services,
              fromRoute: true,
              routeAssignmentId: a.id,
            }
          });
        }
      }
      globalOccurrence++;
      cursor.setDate(cursor.getDate() + 7); // always step 1 week at a time
    }
  });

  return missing;
}

function RouteAssignmentModal({ assignment, clients, catalog, team, T, onSave, onClose }) {
  const blank = {
    id: `ra-${Date.now()}`,
    clientId: "", techId: "", dayOfWeek: "Monday", frequency: "biweekly",
    startDate: new Date().toISOString().split("T")[0],
    stopAfter: "", skipWeeks: "", time: "08:00",
    stopType: "", serviceIds: [], duration: "60", paused: false,
  };
  const [form, setForm] = useState({ ...blank, ...(assignment || {}) });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", appearance: "none", WebkitAppearance: "none" };
  const lbl = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };

  const clientObj = (clients||[]).find(c => String(c.id) === String(form.clientId));
  const techObj   = (team||[]).find(t => t.id === form.techId);

  const toggleService = (id) => set("serviceIds",
    form.serviceIds.includes(id) ? form.serviceIds.filter(x => x !== id) : [...form.serviceIds, id]
  );

  const canSave = form.clientId && form.dayOfWeek && form.frequency && form.startDate;

  return (
    <Modal title={assignment ? "Edit Assignment" : "Add Assignment"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Client */}
        <div>
          <label style={lbl}>Client</label>
          <select style={field} value={form.clientId} onChange={e => set("clientId", e.target.value)}>
            <option value="">Select a client...</option>
            {(clients||[]).sort((a,b) => (a.name||"").localeCompare(b.name||"")).map(c => (
              <option key={c.id} value={c.id}>{c.name} — {c.plan || c.division}</option>
            ))}
          </select>
          {clientObj && (
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 5 }}>
              {clientObj.division} · {clientObj.plan} · {clientObj.planFreq} · {clientObj.address}
            </div>
          )}
        </div>

        {/* Tech */}
        <div>
          <label style={lbl}>Technician</label>
          <select style={field} value={form.techId} onChange={e => set("techId", e.target.value)}>
            <option value="">Unassigned</option>
            {(team||[]).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        {/* Day of week */}
        <div>
          <label style={lbl}>Day of Week</label>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {DAYS_OF_WEEK.map(d => (
              <button key={d} onClick={() => set("dayOfWeek", d)}
                style={{ padding: "8px 10px", borderRadius: 10, border: `1.5px solid ${form.dayOfWeek === d ? T.primary : T.border}`, background: form.dayOfWeek === d ? hexA(T.primary, 0.1) : T.surface, color: form.dayOfWeek === d ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {d.slice(0,3)}
              </button>
            ))}
          </div>
        </div>

        {/* Frequency */}
        <div>
          <label style={lbl}>Frequency</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {FREQ_OPTIONS.map(f => (
              <button key={f.id} onClick={() => set("frequency", f.id)}
                style={{ padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${form.frequency === f.id ? T.primary : T.border}`, background: form.frequency === f.id ? hexA(T.primary, 0.1) : T.surface, color: form.frequency === f.id ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Time + Duration */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={lbl}>Default Time</label>
            <input type="time" style={field} value={form.time} onChange={e => set("time", e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Duration (min)</label>
            <input type="text" inputMode="numeric" style={field} value={form.duration} onChange={e => set("duration", e.target.value.replace(/\D/g,""))} placeholder="60" />
          </div>
        </div>

        {/* Start on */}
        <div>
          <label style={lbl}>Start On</label>
          <input type="date" style={field} value={form.startDate} onChange={e => set("startDate", e.target.value)} />
        </div>

        {/* Stop type */}
        <div>
          <label style={lbl}>Stop Type <span style={{ textTransform:"none", fontWeight:400 }}>(optional)</span></label>
          <select style={field} value={form.stopType} onChange={e => set("stopType", e.target.value)}>
            <option value="">Use client service tier</option>
            {(catalog?.stopTypes||[]).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        {/* Services */}
        {(catalog?.services||[]).length > 0 && (
          <div>
            <label style={lbl}>Default Services <span style={{ textTransform:"none", fontWeight:400 }}>(optional)</span></label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {(catalog.services||[]).map(s => {
                const on = form.serviceIds.includes(s.id);
                return (
                  <button key={s.id} onClick={() => toggleService(s.id)}
                    style={{ padding: "7px 12px", borderRadius: 100, border: `1.5px solid ${on ? T.primary : T.border}`, background: on ? hexA(T.primary, 0.1) : T.surface, color: on ? T.primary : T.textMuted, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Stop after + Skip weeks */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={lbl}>Stop After <span style={{ textTransform:"none", fontWeight:400 }}>(# visits)</span></label>
            <input type="text" inputMode="numeric" style={field} value={form.stopAfter} onChange={e => set("stopAfter", e.target.value.replace(/\D/g,""))} placeholder="No limit" />
          </div>
          <div>
            <label style={lbl}>Pause</label>
            <button onClick={() => set("paused", !form.paused)}
              style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${form.paused ? T.warning : T.border}`, borderRadius: 12, background: form.paused ? hexA(T.warning, 0.08) : T.surface, color: form.paused ? T.warning : T.textMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
              {form.paused ? "Paused — tap to resume" : "Active"}
            </button>
          </div>
        </div>

        <Btn onClick={() => canSave && onSave(form)} block lg disabled={!canSave}
          style={{ opacity: canSave ? 1 : 0.4 }}>
          {assignment ? "Save Changes" : "Add Assignment"}
        </Btn>
        {assignment && (
          <button onClick={() => onSave(null)} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "center", padding: 6 }}>
            Delete Assignment
          </button>
        )}
      </div>
    </Modal>
  );
}

function RouteAssignmentsTab({ clients, catalog, team, schedule, setSchedule, assignments, setAssignments, T }) {
  const [view, setView]   = useState("matrix"); // "matrix" | "list"
  const [modal, setModal] = useState(null);
  const [populating, setPopulating] = useState(false);
  const [lastPopulated, setLastPopulated]   = useState(null);
  const [dragSrc, setDragSrc]   = useState(null);   // { assignmentId, fromWeek }
  const [dropTarget, setDropTarget] = useState(null); // { freq, week }
  const [filterFreq, setFilterFreq] = useState("all");

  // ── shared helpers ──
  const clientOf  = (id) => (clients||[]).find(c => String(c.id) === String(id));
  const techName  = (id) => { if (!id) return ""; const t = (team||[]).find(t => t.id === id); return t?.name || ""; };
  const freqLabel = (id) => FREQ_OPTIONS.find(f => f.id === id)?.label || id;

  const saveAssignment = (a) => {
    if (a === null) setAssignments(prev => prev.filter(x => x.id !== modal.id));
    else if (modal === "add") setAssignments(prev => [...(prev||[]), a]);
    else setAssignments(prev => prev.map(x => x.id === a.id ? a : x));
    setModal(null);
  };

  const populateSchedule = () => {
    setPopulating(true);
    const missing = computeMissingStops(assignments, schedule, clients, catalog, 8);
    if (missing.length === 0) { setLastPopulated("Already up to date."); setPopulating(false); return; }
    setSchedule(prev => {
      const copy = prev.map(d => ({ ...d, stops: [...d.stops] }));
      missing.forEach(({ date, isoDate, stop }) => {
        const dayName = new Date(isoDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
        const existing = copy.find(d => d.date === date);
        if (existing) { if (!existing.stops.find(s => s.sid === stop.sid)) existing.stops.push(stop); }
        else copy.push({ date, day: dayName, stops: [stop] });
      });
      copy.sort((a,b) => { const p = s => { const [m,d,y]=s.split("/").map(Number); return new Date(y,m-1,d).getTime(); }; return p(a.date)-p(b.date); });
      return copy;
    });
    setLastPopulated(`Added ${missing.length} stop${missing.length!==1?"s":""} across 8 weeks.`);
    setPopulating(false);
  };

  // ── MATRIX logic ──
  // weekOffset on an assignment = which occurrence of their day the client lands on
  // 0 = first occurrence, 1 = second, etc.
  // For weekly: all weeks (just one column "Every Week")
  // For bi-weekly: week A (0) or week B (1)
  // For monthly: 1st/2nd/3rd/4th/5th of month
  // For 6-week: 6 slots

  const FREQ_COLS = {
    weekly:   ["Every Week"],
    biweekly: ["Week A", "Week B"],
    monthly:  ["1st", "2nd", "3rd", "4th", "5th"],
    "6week":  ["Wk 1","Wk 2","Wk 3","Wk 4","Wk 5","Wk 6"],
  };

  const moveToWeek = (assignmentId, newWeek) => {
    setAssignments(prev => prev.map(a =>
      a.id === assignmentId ? { ...a, weekOffset: newWeek } : a
    ));
  };

  // Touch drag state for mobile
  const touchDragRef = useRef(null);
  const cellRefs = useRef({});

  const onTouchStartMatrix = (e, assignmentId, fromWeek) => {
    touchDragRef.current = { assignmentId, fromWeek };
    setDragSrc({ assignmentId, fromWeek });
  };

  const onTouchMoveMatrix = (e) => {
    if (!touchDragRef.current) return;
    e.preventDefault();
    const touch = e.touches[0];
    let hit = null;
    Object.entries(cellRefs.current).forEach(([key, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (touch.clientX >= r.left && touch.clientX <= r.right && touch.clientY >= r.top && touch.clientY <= r.bottom) {
        hit = key; // "freq::week"
      }
    });
    setDropTarget(hit ? { key: hit } : null);
  };

  const onTouchEndMatrix = () => {
    if (touchDragRef.current && dropTarget) {
      const [, weekStr] = dropTarget.key.split("::");
      moveToWeek(touchDragRef.current.assignmentId, parseInt(weekStr));
    }
    touchDragRef.current = null;
    setDragSrc(null);
    setDropTarget(null);
  };

  // ── MATRIX render ──
  const MatrixView = () => {
    const freqGroups = ["weekly","biweekly","monthly","6week"];
    const visibleFreqs = filterFreq === "all" ? freqGroups : [filterFreq];

    const freqAssignments = (freq) =>
      (assignments||[])
        .filter(a => a.frequency === freq && !a.paused)
        .sort((a,b) => (clientOf(a.clientId)?.name||"").localeCompare(clientOf(b.clientId)?.name||""));

    // Get all unique days used in this frequency group for column sub-label
    const dayLabel = (freq) => {
      const days = [...new Set((assignments||[]).filter(a=>a.frequency===freq).map(a=>a.dayOfWeek))];
      return days.length === 1 ? days[0] : days.length > 1 ? "Multiple days" : "";
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }} onTouchMove={onTouchMoveMatrix} onTouchEnd={onTouchEndMatrix}>
        {visibleFreqs.map(freq => {
          const rows = freqAssignments(freq);
          if (rows.length === 0) return null;
          const cols = FREQ_COLS[freq] || ["Week 1"];
          const dl   = dayLabel(freq);

          return (
            <div key={freq}>
              {/* Section header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, height: 1, background: T.border }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: T.primary, textTransform: "uppercase", letterSpacing: "0.07em" }}>{freqLabel(freq)}</span>
                  {dl && <span style={{ fontSize: 11, color: T.textMuted }}>· {dl}</span>}
                  <span style={{ fontSize: 11, color: T.textMuted }}>· {rows.length} client{rows.length!==1?"s":""}</span>
                </div>
                <div style={{ flex: 1, height: 1, background: T.border }} />
              </div>

              {/* Matrix table */}
              <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
                {/* Column headers */}
                <div style={{ display: "grid", gridTemplateColumns: `1fr ${cols.map(()=>"1fr").join(" ")}`, background: T.surfaceAlt, borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ padding: "10px 14px", fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Client</div>
                  {cols.map((col, ci) => (
                    <div key={ci} style={{ padding: "10px 6px", textAlign: "center", fontSize: 10, fontWeight: 700, color: T.primary, textTransform: "uppercase", letterSpacing: "0.05em", borderLeft: `1px solid ${T.border}` }}>
                      {col}
                    </div>
                  ))}
                </div>

                {/* Rows */}
                {rows.map((a, ri) => {
                  const c = clientOf(a.clientId);
                  const currentWeek = a.weekOffset ?? 0;
                  const isDragging = dragSrc?.assignmentId === a.id;
                  return (
                    <div key={a.id}
                      style={{ display: "grid", gridTemplateColumns: `1fr ${cols.map(()=>"1fr").join(" ")}`, borderBottom: ri < rows.length-1 ? `1px solid ${T.border}` : "none", opacity: isDragging ? 0.5 : 1 }}>
                      {/* Client name cell */}
                      <div style={{ padding: "11px 14px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1.3 }}>{c?.name || "?"}</div>
                        {a.techId && <div style={{ fontSize: 10, color: T.textMuted, marginTop: 1 }}>{techName(a.techId)}</div>}
                      </div>

                      {/* Week cells */}
                      {cols.map((col, ci) => {
                        const isHere  = currentWeek === ci;
                        const cellKey = `${freq}::${ci}`;
                        const isOver  = dropTarget?.key === cellKey;
                        return (
                          <div
                            key={ci}
                            ref={el => { cellRefs.current[cellKey] = el; }}
                            onTouchStart={isHere ? (e => onTouchStartMatrix(e, a.id, ci)) : undefined}
                            onClick={() => !isHere && moveToWeek(a.id, ci)}
                            style={{
                              borderLeft: `1px solid ${T.border}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              padding: "8px 4px", minHeight: 44,
                              background: isOver ? hexA(T.primary, 0.15)
                                        : isHere  ? hexA(T.primary, 0.08)
                                        : "transparent",
                              cursor: isHere ? "grab" : "pointer",
                              transition: "background 0.1s",
                            }}>
                            {isHere && (
                              <div style={{
                                background: T.primary, color: "#fff",
                                borderRadius: 10, padding: "5px 10px",
                                fontSize: 11, fontWeight: 800,
                                maxWidth: "100%", textAlign: "center",
                                lineHeight: 1.2,
                                boxShadow: `0 2px 8px ${hexA(T.primary, 0.35)}`,
                              }}>
                                {c?.name?.split(" ").slice(-1)[0] || "·"}
                              </div>
                            )}
                            {!isHere && isOver && (
                              <div style={{ width: 28, height: 4, borderRadius: 2, background: T.primary, opacity: 0.6 }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Paused clients note */}
              {(assignments||[]).filter(a => a.frequency===freq && a.paused).length > 0 && (
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6, fontStyle: "italic" }}>
                  {(assignments||[]).filter(a=>a.frequency===freq&&a.paused).length} client{(assignments||[]).filter(a=>a.frequency===freq&&a.paused).length!==1?"s":""} paused — hidden from matrix
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ── LIST render ──
  const ListView = () => {
    const all = (assignments||[]);
    if (!all.length) return (
      <div style={{ textAlign: "center", padding: "48px 20px" }}>
        <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}><Icon name="calendar" size={28} /></div>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 6 }}>No assignments yet</div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, maxWidth: 260, margin: "0 auto" }}>
          Tap Add to set up a client's recurring schedule. Then use Populate to auto-fill your stops.
        </div>
      </div>
    );
    const grouped = {};
    all.forEach(a => {
      const c = clientOf(a.clientId);
      const key = c?.division || "Other";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(a);
    });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Object.entries(grouped).sort().map(([div, items]) => (
          <div key={div}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, marginBottom: 8 }}>{div}</div>
            <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
              {items.sort((a,b) => (clientOf(a.clientId)?.name||"").localeCompare(clientOf(b.clientId)?.name||"")).map((a, i) => {
                const c = clientOf(a.clientId);
                const cols = FREQ_COLS[a.frequency] || ["Week 1"];
                const week = cols[a.weekOffset ?? 0] || cols[0];
                return (
                  <div key={a.id} onClick={() => setModal(a)}
                    style={{ padding: "13px 18px", borderBottom: i < items.length-1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 13, cursor: "pointer" }}>
                    <div style={{ width: 9, height: 9, borderRadius: "50%", background: a.paused ? T.textMuted : T.primary, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: a.paused ? T.textMuted : T.text, letterSpacing: "-0.01em" }}>{c?.name || "Unknown"}</div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                        {freqLabel(a.frequency)} · {a.dayOfWeek}s · {week}
                        {a.techId ? ` · ${techName(a.techId)}` : ""}
                        {a.paused ? " · PAUSED" : ""}
                      </div>
                    </div>
                    <Icon name="chevronD" size={13} style={{ transform: "rotate(-90deg)", color: T.textMuted, flexShrink: 0 }} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Route Assignments</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            {(assignments||[]).filter(a=>!a.paused).length} active · {(assignments||[]).filter(a=>a.paused).length} paused
          </div>
        </div>
        <Btn onClick={() => setModal("add")} style={{ gap: 5 }}><Icon name="plus" size={14} /> Add</Btn>
      </div>

      {/* View toggle + freq filter */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {/* List / Matrix toggle */}
        <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 10, padding: 3, gap: 2, flexShrink: 0 }}>
          {[["matrix","Grid"],["list","List"]].map(([v,l]) => (
            <button key={v} onClick={() => setView(v)}
              style={{ padding: "6px 12px", border: "none", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer", background: view===v ? T.surface : "transparent", color: view===v ? T.primary : T.textMuted, fontFamily: "inherit", boxShadow: view===v ? "0 1px 3px rgba(0,0,0,0.1)" : "none" }}>
              {l}
            </button>
          ))}
        </div>
        {/* Frequency filter (matrix only) */}
        {view === "matrix" && (
          <div style={{ flex: 1, display: "flex", gap: 5, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            {[["all","All"],...FREQ_OPTIONS.map(f=>[f.id,f.label.split(" ")[0]])].map(([id,label]) => (
              <button key={id} onClick={() => setFilterFreq(id)}
                style={{ flexShrink: 0, padding: "6px 11px", borderRadius: 100, border: "none", background: filterFreq===id ? T.primary : T.surfaceAlt, color: filterFreq===id ? "#fff" : T.textMuted, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Auto-populate card */}
      <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Auto-populate Schedule</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>Adds missing stops for the next 8 weeks. Won't duplicate.</div>
          {lastPopulated && <div style={{ fontSize: 11, color: T.primary, marginTop: 4, fontWeight: 600 }}>{lastPopulated}</div>}
        </div>
        <button onClick={populateSchedule} disabled={populating}
          style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "10px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, opacity: populating ? 0.6 : 1, flexShrink: 0, whiteSpace: "nowrap" }}>
          {populating ? <><div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /></> : <Icon name="refresh" size={14} />}
          {populating ? "Working..." : "Populate"}
        </button>
      </div>

      {/* Instruction hint for matrix */}
      {view === "matrix" && (assignments||[]).filter(a=>!a.paused).length > 0 && (
        <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center", lineHeight: 1.5 }}>
          Tap an empty cell to move a client to that week. Touch and hold the name chip to drag on mobile.
        </div>
      )}

      {/* Main view */}
      {view === "matrix" ? <MatrixView /> : <ListView />}

      {modal && (
        <RouteAssignmentModal
          assignment={modal === "add" ? null : modal}
          clients={clients} catalog={catalog} team={team} T={T}
          onSave={saveAssignment}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function Schedule({ clients, catalog, costs, schedule, setSchedule, scheduleCfg, team, onClientSelect, seedClientIds, clearSeed, email, onComplete, completedSids, onOfficeAlert, routeAssignments, setRouteAssignments }) {
  const { T, perms } = useApp();
  const cfg = { ...DEFAULT_SCHEDULE_CFG, ...(scheduleCfg || {}) };
  const compact = cfg.density === "compact";
  const [omwModal, setOmwModal] = useState(null);
  const [headHereModal, setHeadHereModal] = useState(null);
  const [completeModal, setCompleteModal] = useState(null);
  const [sentStops, setSentStops] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState({}); // { sid: true }
  const [assignFilter, setAssignFilter] = useState(""); // "" all | id | "__un" unassigned

  // order stops within a day: by time, or in stored (manual) order
  const orderStops = (stops) => cfg.sort === "time"
    ? [...stops].sort((a, b) => to24(a.time) - to24(b.time))
    : stops;
  // move a stop up/down within its day (manual ordering)
  const moveStop = (dayDate, idx, dir) => {
    setSchedule(prev => prev.map(d => {
      if (d.date !== dayDate) return d;
      const stops = [...d.stops];
      const j = idx + dir;
      if (j < 0 || j >= stops.length) return d;
      [stops[idx], stops[j]] = [stops[j], stops[idx]];
      return { ...d, stops };
    }));
  };

  // open add form automatically if clients were sent over from the Clients tab
  useEffect(() => {
    if (seedClientIds && seedClientIds.length) setShowAdd(true);
  }, [seedClientIds]);

  const handleOmwSent = (key) => setSentStops(s => ({ ...s, [key]: true }));

  const allStops = schedule.flatMap(d => d.stops.map(s => s.sid));
  const selectedSids = Object.keys(selected).filter(k => selected[k]);
  const selCount = selectedSids.length;
  const allSelected = allStops.length > 0 && allStops.every(sid => selected[sid]);

  const toggle = (sid) => setSelected(s => ({ ...s, [sid]: !s[sid] }));
  const toggleAll = () => {
    if (allSelected) setSelected({});
    else setSelected(Object.fromEntries(allStops.map(sid => [sid, true])));
  };
  const exitSelect = () => { setSelectMode(false); setSelected({}); };

  const addStops = (date, newStops) => {
    setSchedule(prev => {
      const copy = prev.map(d => ({ ...d, stops: [...d.stops] }));
      const existing = copy.find(d => d.date === date);
      if (existing) {
        existing.stops.push(...newStops);
        if (cfg.sort === "time") existing.stops.sort((a, b) => to24(a.time) - to24(b.time));
      } else {
        copy.push({ date, day: dayLabel(date), stops: newStops });
        copy.sort((a, b) => toDateNum(a.date) - toDateNum(b.date));
      }
      return copy;
    });
    setShowAdd(false);
    if (clearSeed) clearSeed();
  };

  const deleteSelected = () => {
    setSchedule(prev => prev
      .map(d => ({ ...d, stops: d.stops.filter(s => !selected[s.sid]) }))
      .filter(d => d.stops.length > 0)
    );
    exitSelect();
  };

  const closeAdd = () => { setShowAdd(false); if (clearSeed) clearSeed(); };

  // ── Route optimization (nearest-neighbor using ZIP codes as proxy) ──
  // When Google Maps API is connected, swap the distance function for real geodistance
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeMsg, setOptimizeMsg] = useState("");

  const extractZip = (address) => {
    const m = (address || "").match(/\b(\d{5})\b/);
    return m ? parseInt(m[1]) : 0;
  };

  const zipDistance = (a, b) => {
    // proxy: difference in ZIP codes as rough geographic distance
    // good enough for same-region routes; replaced by real lat/lng when Maps API is ready
    return Math.abs(extractZip(a) - extractZip(b));
  };

  const nearestNeighbor = (stops, clients) => {
    if (stops.length <= 1) return stops;
    const getAddr = (s) => {
      const c = clients.find(c => c.id === s.clientId);
      return s.address || c?.address || "";
    };
    const remaining = [...stops];
    const ordered = [remaining.shift()]; // start with first stop (approximate start location)
    while (remaining.length) {
      const last = ordered[ordered.length - 1];
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((s, i) => {
        const d = zipDistance(getAddr(last), getAddr(s));
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }
    return ordered;
  };

  const optimizeRoute = (date, techKey, currentStops) => {
    setOptimizing(true);
    const optimized = nearestNeighbor(currentStops, clients);
    setSchedule(prev => prev.map(d => {
      if (d.date !== date) return d;
      const otherStops = d.stops.filter(s => {
        if (techKey === "__all") return false;
        if (techKey === "__un") return (s.assignee || "__un") !== "__un";
        return s.assignee !== techKey;
      });
      return { ...d, stops: [...otherStops, ...optimized] };
    }));
    setOptimizeMsg("Route optimized");
    setTimeout(() => { setOptimizing(false); setOptimizeMsg(""); }, 2000);
  };

  // ── Route-dashboard state + helpers ──
  const [selectedDate, setSelectedDate] = useState(() => todayMDY());
  const [viewTech, setViewTech] = useState(null); // null = dashboard; else assignee key / "__un" / "__all"
  const LEG_MIN = 15; // assumed drive time between stops (estimate until GPS/maps is connected)
  const AVG_MPH = 28;

  const durMin = (d) => parseInt(String(d || "").replace(/[^\d]/g, "")) || 0;
  const fmtMin = (mins) => {
    let h = Math.floor(mins / 60) % 24, m = Math.round(mins % 60);
    const ap = h >= 12 ? "PM" : "AM"; let hh = h % 12; if (hh === 0) hh = 12;
    return `${hh}:${String(m).padStart(2, "0")} ${ap}`;
  };
  const fmtDur = (mins) => { const h = Math.floor(mins / 60), m = mins % 60; return h ? `${h}h ${m}m` : `${m}m`; };
  const mdy = (dt) => `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`;

  // chain arrival estimates across a day's ordered stops
  const withETAs = (ordered) => {
    let cursor = null;
    return ordered.map((s, i) => {
      const startMin = to24(s.time);
      let arr;
      if (i === 0) { arr = startMin; }
      else { arr = Math.max(cursor + LEG_MIN, startMin); }
      cursor = arr + durMin(s.duration);
      return { ...s, _arr: arr, _end: cursor };
    });
  };
  // summary metrics for a set of stops
  const routeMetrics = (stops) => {
    const ordered = orderStops(stops);
    const eta = withETAs(ordered);
    const done = stops.filter(s => completedSids && completedSids[s.sid]).length;
    const startMin = eta.length ? eta[0]._arr : 0;
    const endMin = eta.length ? eta[eta.length - 1]._end : 0;
    const driveMin = Math.max(0, eta.length - 1) * LEG_MIN;
    const milesEst = Math.round((driveMin / 60) * AVG_MPH);
    return { ordered: eta, done, total: stops.length, startMin, endMin, driveMin, milesEst };
  };
  // group a day's stops into tech routes
  const groupsForDate = (date) => {
    const dayObj = schedule.find(d => d.date === date);
    const dayStops = dayObj ? dayObj.stops : [];
    if (!dayStops.length) return [];
    if ((team || []).length === 0) return [{ key: "__all", name: "My Route", stops: dayStops }];
    const groups = [];
    (team || []).forEach(m => {
      const ss = dayStops.filter(s => s.assigneeId === m.id);
      if (ss.length) groups.push({ key: m.id, name: m.name, member: m, stops: ss });
    });
    const un = dayStops.filter(s => !s.assigneeId || !(team || []).some(m => m.id === s.assigneeId));
    if (un.length) groups.push({ key: "__un", name: "Unassigned", stops: un });
    return groups;
  };
  const stopsForKey = (date, key) => {
    const dayObj = schedule.find(d => d.date === date);
    const dayStops = dayObj ? dayObj.stops : [];
    if (key === "__all") return dayStops;
    if (key === "__un") return dayStops.filter(s => !s.assigneeId || !(team || []).some(m => m.id === s.assigneeId));
    return dayStops.filter(s => s.assigneeId === key);
  };

  // build the scrollable day strip: a few days back through ~3 weeks ahead
  const dayCells = (() => {
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const cells = [];
    for (let i = -3; i <= 24; i++) {
      const dt = new Date(base); dt.setDate(base.getDate() + i);
      const ds = mdy(dt);
      const dayObj = schedule.find(d => d.date === ds);
      cells.push({ ds, dt, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()], num: dt.getDate(), hasStops: !!(dayObj && dayObj.stops.length) });
    }
    return cells;
  })();

  const goDirections = (addr) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr || "")}`;
  const catChip = (s) => { const c = clients.find(x => x.id === s.id); return (c && c.division) || s.type; };

  // one stop card, reused by the bulk-select list and the per-tech route
  const renderStopCard = (s, dayDate, displayNum, isToday) => {
    const c = clients.find(x => x.id === s.id);
    const sent = sentStops[s.sid];
    const isSel = !!selected[s.sid];
    const isComplete = completedSids && completedSids[s.sid];
    const emp = (team || []).find(e => e.id === s.assigneeId);
    const accentLeft = isComplete ? T.accent : (isToday ? T.primary : T.textMuted);
    return (
      <div key={s.sid} style={{ background: T.surface, border: `1px solid ${isSel ? T.primary : isComplete ? hexA(T.accent, 0.3) : T.border}`, borderRadius: 20, overflow: "hidden", opacity: isComplete ? 0.88 : 1, boxShadow: isComplete ? "none" : "0 2px 12px rgba(0,0,0,0.06)", display: "flex" }}>
        {/* Number bar */}
        {!selectMode && displayNum != null && (
          <div style={{ width: 44, flexShrink: 0, background: isComplete ? hexA(T.accent, 0.12) : hexA(accentLeft, 0.1), color: isComplete ? T.accent : accentLeft, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 900 }}>{displayNum}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Main info row */}
          <div
            onClick={() => selectMode ? toggle(s.sid) : (perms.completeStops ? setCompleteModal({ stop: s, client: c }) : null)}
            style={{ padding: compact ? "11px 14px" : "14px 16px", cursor: (selectMode || perms.completeStops) ? "pointer" : "default", display: "flex", gap: 12, alignItems: "center" }}
          >
            {selectMode && <Checkbox checked={isSel} onChange={() => toggle(s.sid)} />}

            {/* Time */}
            <div style={{ textAlign: "center", minWidth: 44, flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 900, color: T.text, letterSpacing: "-0.03em", lineHeight: 1 }}>{s.time.split(" ")[0]}</div>
              <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, letterSpacing: "0.06em", marginTop: 2 }}>{s.time.split(" ")[1]}</div>
            </div>

            {/* Client + details */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: isComplete ? T.textMuted : T.text, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 5 }}>
                {isComplete && <Icon name="check" size={13} style={{ color: T.accent, flexShrink: 0 }} />}
                {s.client}
              </div>
              {cfg.showAddress && s.address && (
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.address}</div>
              )}
              {cfg.showServices && s.services && s.services.length > 0 && (
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.services.map(sv => typeof sv === "string" ? sv : sv.name).join(" · ")}
                </div>
              )}
            </div>

            {/* Right meta */}
            <div style={{ textAlign: "right", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              {s._arr != null && (
                <div style={{ fontSize: 11, fontWeight: 800, color: isComplete ? T.accent : T.primary, display: "flex", alignItems: "center", gap: 3 }}>
                  <Icon name="map" size={11} />
                  {isComplete ? fmtMin(s._arr) : `~${fmtMin(s._arr)}`}
                </div>
              )}
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.type}</div>
              {cfg.showDuration && <div style={{ fontSize: 10, color: T.textMuted }}>{s.duration} min</div>}
              {emp && (
                <span title={emp.name} style={{ width: 26, height: 26, borderRadius: "50%", background: hexA(T.primary, 0.12), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 10, flexShrink: 0 }}>
                  {initials(emp.name)}
                </span>
              )}
            </div>
          </div>

          {/* Action bar — full width, no overflow */}
          {!selectMode && (
            <div style={{ borderTop: `1px solid ${T.border}`, background: isComplete ? hexA(T.accent, 0.06) : T.surfaceAlt }}>
              {/* Status line */}
              <div style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 6 }}>
                {isComplete ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: T.accent, fontWeight: 700 }}>
                    <Icon name="check" size={12} /> Completed · Report saved
                  </div>
                ) : sent ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: T.primary, fontWeight: 700 }}>
                    <Icon name="check" size={12} /> Client notified
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: T.textMuted }}>Not yet started</div>
                )}
              </div>

              {/* Button row — equal width, never cut off */}
              <div style={{ padding: "8px 12px 10px", display: "flex", gap: 7 }}>
                <button onClick={e => { e.stopPropagation(); setHeadHereModal({ stop: s, client: c }); }}
                  style={{ flex: 1, background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "9px 6px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 0 }}>
                  <Icon name="map" size={13} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Head Here</span>
                </button>

                {!isComplete && perms.sendTexts && (
                  <button onClick={e => { e.stopPropagation(); setOmwModal({ stop: s, client: c, key: s.sid }); }}
                    style={{ flex: 1, background: "transparent", color: T.primary, border: `1.5px solid ${hexA(T.primary, 0.4)}`, borderRadius: 12, padding: "9px 6px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 0 }}>
                    <Icon name="message" size={13} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sent ? "Resend" : "On My Way"}</span>
                  </button>
                )}

                {perms.completeStops && (
                  <button onClick={e => { e.stopPropagation(); setCompleteModal({ stop: s, client: c }); }}
                    style={{ flex: 1, background: isComplete ? hexA(T.accent, 0.1) : T.accent, color: isComplete ? T.accent : "#fff", border: isComplete ? `1.5px solid ${hexA(T.accent, 0.3)}` : "none", borderRadius: 12, padding: "9px 6px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 0 }}>
                    <Icon name="check" size={13} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{isComplete ? "Re-open" : "Complete"}</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const stripDate = (ds) => { const d = parseMDY(ds); return d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ds; };
  const [schedTab, setSchedTab] = useState("schedule"); // "schedule" | "routes"

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Schedule</h2>
        {schedTab === "schedule" && (selectMode ? (
          <button onClick={exitSelect} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        ) : perms.editSchedule ? (
          <div style={{ display: "flex", gap: 8 }}>
            {allStops.length > 0 && <Btn variant="ghost" sm onClick={() => setSelectMode(true)}>Select</Btn>}
            <Btn sm onClick={() => setShowAdd(true)}>+ Add Stop</Btn>
          </div>
        ) : null)}
      </div>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 11, padding: 3, gap: 3, marginBottom: 18 }}>
        {[["schedule", "Schedule"], ["routes", "Route Assignments"]].map(([id, label]) => (
          <button key={id} onClick={() => setSchedTab(id)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", background: schedTab === id ? T.surface : "transparent", color: schedTab === id ? T.primary : T.textMuted, fontFamily: "inherit", boxShadow: schedTab === id ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
            {label}
          </button>
        ))}
      </div>

      {schedTab === "routes" && (
        <RouteAssignmentsTab
          clients={clients}
          catalog={catalog}
          team={team}
          schedule={schedule}
          setSchedule={setSchedule}
          assignments={routeAssignments}
          setAssignments={setRouteAssignments}
          T={T}
        />
      )}

      {schedTab === "schedule" && <>

      {selectMode && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, padding: "8px 14px", background: T.surfaceAlt, borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={toggleAll}>
            <Checkbox checked={allSelected} onChange={toggleAll} />
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Select all ({allStops.length})</span>
          </div>
          <span style={{ fontSize: 12, color: T.textMuted }}>{selCount} selected</span>
        </div>
      )}

      {schedule.length === 0 && (
        <div style={{ textAlign: "center", padding: "50px 20px", color: T.textMuted }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}><Icon name="calendar" size={28} /></div>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.text, marginBottom: 6 }}>No stops scheduled</div>
          <div style={{ fontSize: 13, marginBottom: 18 }}>{perms.editSchedule ? "Add your first service stop to build the route." : "No stops have been scheduled yet."}</div>
          {perms.editSchedule && <Btn onClick={() => setShowAdd(true)}>+ Add Stop</Btn>}
        </div>
      )}

      {/* Day strip */}
      {!selectMode && schedule.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 18, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch", msOverflowStyle: "none", scrollbarWidth: "none" }}>
          {dayCells.map(cell => {
            const on = cell.ds === selectedDate;
            const isToday = cell.ds === todayMDY();
            return (
              <button key={cell.ds} onClick={() => { setSelectedDate(cell.ds); setViewTech(null); }}
                style={{ flexShrink: 0, width: 54, paddingTop: 10, paddingBottom: 10, borderRadius: 16, border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "center", transition: "background 0.15s, transform 0.1s",
                  background: on ? T.primary : T.surfaceAlt,
                  color: on ? "#fff" : T.textMuted,
                  boxShadow: on ? `0 4px 14px ${hexA(T.primary, 0.35)}` : "none",
                  transform: on ? "scale(1.06)" : "scale(1)",
                }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: on ? 0.85 : 0.7 }}>{cell.weekday}</div>
                <div style={{ fontSize: 20, fontWeight: 900, marginTop: 3, letterSpacing: "-0.03em" }}>{cell.num}</div>
                <div style={{ height: 5, marginTop: 4, display: "flex", justifyContent: "center" }}>
                  {cell.hasStops
                    ? <span style={{ width: 5, height: 5, borderRadius: "50%", background: on ? "rgba(255,255,255,0.8)" : T.primary }} />
                    : <span style={{ width: 5, height: 5 }} />
                  }
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* SELECT MODE — flat selectable list across all days */}
      {selectMode && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: selCount > 0 ? 90 : 0 }}>
          {schedule.map((day, di) => (
            <div key={day.date}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: di === 0 ? T.primary : T.textMuted, marginBottom: 10 }}>{dayLabel(day.date)} · {day.date}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {orderStops(day.stops).map(s => renderStopCard(s, day.date, null, di === 0))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ROUTE DASHBOARD — per-tech summary cards for the selected day */}
      {!selectMode && viewTech === null && schedule.length > 0 && (() => {
        const groups = groupsForDate(selectedDate);
        return (
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 12 }}>{stripDate(selectedDate)}{selectedDate === todayMDY() ? " · Today" : ""}</div>
            {groups.length === 0 ? (
              <div style={{ textAlign: "center", padding: "44px 20px", color: T.textMuted }}>
                <div style={{ width: 52, height: 52, borderRadius: 16, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="calendar" size={26} /></div>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.text, marginBottom: 6 }}>No stops this day</div>
                {perms.editSchedule && <div style={{ fontSize: 13, marginBottom: 16 }}>Add a stop to start building this route.</div>}
                {perms.editSchedule && <Btn onClick={() => setShowAdd(true)}>+ Add Stop</Btn>}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {groups.map(g => {
                  const m = routeMetrics(g.stops);
                  const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
                  return (
                    <button key={g.key} onClick={() => setViewTech(g.key)}
                      style={{ display: "flex", alignItems: "center", gap: 16, background: T.surface, border: "none", borderRadius: 20, boxShadow: T.shadow, padding: "16px 18px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%" }}>
                      <RouteRing done={m.done} total={m.total} size={68} label="stops" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <div style={{ fontSize: 18, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</div>
                          <span style={{ color: T.textMuted, fontSize: 20, flexShrink: 0 }}>›</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textMuted, margin: "6px 0 5px" }}>
                          <span>{fmtMin(m.startMin)}</span><span>{fmtMin(m.endMin)}</span>
                        </div>
                        <div style={{ height: 6, background: T.surfaceAlt, borderRadius: 100, overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: m.done >= m.total ? T.accent : T.primary, borderRadius: 100 }} />
                        </div>
                        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 6 }}>{m.done}/{m.total} done · ~{m.milesEst} mi · {fmtDur(Math.max(0, m.endMin - m.startMin))} est</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* TECH ROUTE DETAIL */}
      {!selectMode && viewTech !== null && (() => {
        const stops = stopsForKey(selectedDate, viewTech);
        const m = routeMetrics(stops);
        const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
        const g = groupsForDate(selectedDate).find(x => x.key === viewTech);
        const techName = g ? g.name : "Route";
        const isToday = selectedDate === todayMDY();
        const nextStop = m.ordered.find(s => !(completedSids && completedSids[s.sid]));
        return (
          <div style={{ paddingBottom: nextStop ? 80 : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 0 12px" }}>
              <button onClick={() => setViewTech(null)} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
                <Icon name="back" size={14} /> All routes
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{stripDate(selectedDate)}{isToday ? " · Today" : ""}</span>
                {perms.editSchedule && stops.length > 1 && (
                  <button onClick={() => optimizeRoute(selectedDate, viewTech, stops)}
                    style={{ background: hexA(T.primary, 0.1), border: `1px solid ${hexA(T.primary, 0.2)}`, color: T.primary, borderRadius: 10, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
                    <Icon name="refresh" size={13} /> Optimize Route
                  </button>
                )}
              </div>
            </div>

            <div style={{ background: T.surface, borderRadius: 18, boxShadow: T.shadow, padding: "16px 18px", marginBottom: 16, display: "flex", alignItems: "center", gap: 16 }}>
              <RouteRing done={m.done} total={m.total} size={64} label="stops" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: T.text, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{techName}</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.textMuted, margin: "7px 0 5px" }}>
                  <span>{fmtMin(m.startMin)}</span><span>~{m.milesEst} mi est</span><span>{fmtMin(m.endMin)}</span>
                </div>
                <div style={{ height: 6, background: T.surfaceAlt, borderRadius: 100, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: m.done >= m.total ? T.accent : T.primary, borderRadius: 100 }} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {m.ordered.map((s, i) => renderStopCard(s, selectedDate, i + 1, isToday))}
            </div>

            {nextStop && (
              <a href={goDirections(nextStop.address)} target="_blank" rel="noreferrer" style={{ position: "fixed", bottom: "calc(74px + env(safe-area-inset-bottom))", left: 0, right: 0, zIndex: 95, maxWidth: 740, margin: "0 auto", textDecoration: "none" }}>
                <div style={{ margin: "0 16px", background: T.primary, color: "#fff", borderRadius: 14, padding: "13px 16px", textAlign: "center", boxShadow: "0 6px 24px rgba(0,0,0,0.25)" }}>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>Directions to {nextStop.client} ›</div>
                  <div style={{ fontSize: 11.5, opacity: 0.9, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nextStop.address}</div>
                </div>
              </a>
            )}
          </div>
        );
      })()}

      {/* Bulk action bar */}
      {selectMode && selCount > 0 && (
        <div style={{ position: "fixed", bottom: "calc(74px + env(safe-area-inset-bottom))", left: 0, right: 0, zIndex: 95, padding: "10px 16px", maxWidth: 740, margin: "0 auto" }}>
          <div style={{ background: T.headerBg, borderRadius: 14, padding: "10px 12px", display: "flex", gap: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.25)" }}>
            <button onClick={deleteSelected}
              style={{ flex: 1, background: "rgba(255,80,80,0.15)", color: "#ff8080", border: "none", borderRadius: 10, padding: "12px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
              <span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="trash" size={14} /> Remove {selCount} {selCount === 1 ? "Stop" : "Stops"}</span>
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <AddStopForm
          clients={clients}
          catalog={catalog}
          team={team}
          seedClientIds={seedClientIds}
          onSave={addStops}
          onClose={closeAdd}
        />
      )}

      {omwModal && (
        <OnMyWayModal stop={omwModal.stop} client={omwModal.client} email={email} onClose={() => setOmwModal(null)} onSent={() => handleOmwSent(omwModal.key)} />
      )}
      {headHereModal && <HeadHereModal stop={headHereModal.stop} client={headHereModal.client} email={email} onClose={() => setHeadHereModal(null)} />}

      {completeModal && (
        <CompleteStopModal
          stop={completeModal.stop}
          client={completeModal.client}
          email={email}
          catalog={catalog}
          costs={costs}
          team={team}
          onComplete={onComplete}
          onClose={() => setCompleteModal(null)}
          onViewClient={onClientSelect}
          onOfficeAlert={onOfficeAlert}
        />
      )}
      </>}
    </div>
  );
}

// time helpers for sorting
const to24 = (t) => {
  const [hm, ap] = t.split(" ");
  let [h, m] = hm.split(":").map(Number);
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + (m || 0);
};
const toDateNum = (d) => {
  const [m, dd, y] = d.split("/").map(Number);
  return new Date(y, m - 1, dd).getTime();
};

// ─────────────────────────────────────────────
// CSV IMPORT
// ─────────────────────────────────────────────
// Proper CSV parser: handles quoted fields with commas, escaped quotes, BOM, CRLF.
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ""); // strip byte-order mark
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* ignore */ }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const cleaned = rows.filter(r => r.some(c => c.trim() !== ""));
  if (cleaned.length === 0) return { headers: [], records: [] };
  const headers = cleaned[0].map(h => h.trim());
  const records = cleaned.slice(1).map(r =>
    Object.fromEntries(headers.map((h, idx) => [h, (r[idx] || "").trim()]))
  );
  return { headers, records };
}

// App fields + the header names we try to auto-detect for each.
const IMPORT_FIELDS = [
  { key: "name",        label: "Client Name",  candidates: ["name","client","client name","customer","customer name","full name","display name","company","company name"] },
  { key: "firstName",   label: "First Name",   candidates: ["first name","first","fname","given name"] },
  { key: "lastName",    label: "Last Name",    candidates: ["last name","last","lname","surname","family name"] },
  { key: "street",      label: "Street",       candidates: ["street","street address","address 1","address line 1","address line1","service address","property address","address","location"] },
  { key: "city",        label: "City",         candidates: ["city","town","municipality"] },
  { key: "state",       label: "State",        candidates: ["state","province","region","st"] },
  { key: "zip",         label: "ZIP",          candidates: ["zip","zip code","zipcode","postal code","postal","postcode","zip/postal"] },
  { key: "address",     label: "Full Address", candidates: ["full address","complete address","mailing address","billing address","address (full)"] },
  { key: "phone",       label: "Phone",        candidates: ["phone","phone number","mobile","cell","telephone","primary phone","phone 1","main phone"] },
  { key: "email",       label: "Email",        candidates: ["email","email address","e-mail","primary email","main email"] },
  { key: "division",    label: "Division",     candidates: ["division","department"] },
  { key: "pondType",    label: "Pond Type",    candidates: ["pond type","type","system type"] },
  { key: "pondSize",    label: "Pond Size",    candidates: ["pond size","size","volume","gallons"] },
  { key: "plan",        label: "Plan",         candidates: ["plan","service plan","membership","maintenance plan","maintenance level"] },
  { key: "planFreq",    label: "Frequency",    candidates: ["frequency","plan frequency","service frequency"] },
  { key: "nextService", label: "Next Service", candidates: ["next service","next visit","next service date"] },
  { key: "balance",     label: "Balance",      candidates: ["balance","amount due","outstanding","open balance"] },
];

// Build {fieldKey: headerName} by matching headers (case-insensitive) to candidates.
function autoMap(headers) {
  const lc = headers.map(h => ({ raw: h, norm: h.trim().toLowerCase() }));
  const mapping = {};
  for (const f of IMPORT_FIELDS) {
    const hit = lc.find(h => f.candidates.includes(h.norm));
    mapping[f.key] = hit ? hit.raw : "";
  }
  return mapping;
}

function buildClients(records, mapping) {
  return records.map((rec, i) => {
    const get = (k) => (mapping[k] ? (rec[mapping[k]] || "").trim() : "");
    let name = get("name");
    if (!name) name = [get("firstName"), get("lastName")].filter(Boolean).join(" ").trim();
    // address: combine the parts; fall back to a single full-address column and split it
    let comp = { street: get("street"), city: get("city"), state: get("state"), zip: get("zip") };
    let address;
    if (comp.street || comp.city || comp.state || comp.zip) {
      address = assembleAddress(comp);
    } else {
      address = get("address");
      comp = splitAddress(address);
    }
    return {
      id: Date.now() + i,
      division: get("division") || "Pond",
      name: name || "Unnamed Client",
      address,
      street: comp.street, city: comp.city, state: comp.state, zip: comp.zip,
      phone: get("phone"),
      email: get("email"),
      pondType: get("pondType") || "Koi Pond",
      pondSize: get("pondSize"),
      plan: get("plan") || "Essential",
      planFreq: get("planFreq") || "Monthly",
      status: "Active",
      equipment: [],
      history: [],
      nextService: get("nextService"),
      balance: get("balance") || "$0.00",
    };
  });
}

function SkimmerImport({ onImport, onGoToClients }) {
  const { T } = useApp();
  const [stage, setStage] = useState("idle"); // idle | mapping | done
  const [headers, setHeaders] = useState([]);
  const [records, setRecords] = useState([]);
  const [mapping, setMapping] = useState({});
  const [importedCount, setImportedCount] = useState(0);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { headers, records } = parseCSV(ev.target.result);
      setHeaders(headers);
      setRecords(records);
      setMapping(autoMap(headers));
      setStage("mapping");
    };
    reader.readAsText(file);
  };

  const setField = (key, header) => setMapping(m => ({ ...m, [key]: header }));

  const handleImportAll = () => {
    const clients = buildClients(records, mapping);
    onImport(clients);
    setImportedCount(clients.length);
    setStage("done");
  };

  const reset = () => { setHeaders([]); setRecords([]); setMapping({}); setImportedCount(0); setStage("idle"); };

  // live preview of the first record using current mapping
  const preview = records.length ? buildClients([records[0]], mapping)[0] : null;
  const detected = IMPORT_FIELDS.filter(f => mapping[f.key]).length;

  const selectStyle = { width: "100%", padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" };

  return (
    <div>
      <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Import Clients</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textMuted }}>Upload a CSV export from Skimmer or QuickBooks. Columns are matched automatically, and you can adjust anything before importing.</p>

      <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px", fontSize: 12, color: T.textMuted, display: "flex", gap: 8, marginBottom: 20 }}>
        <Icon name="link" size={14} />
        <span>Live two-way QuickBooks Online sync is coming in Phase 2 (needs a secure account connection). For now, CSV import works right away.</span>
      </div>

      {stage === "idle" && (
        <div>
          <div style={{ border: `2px dashed ${T.border}`, borderRadius: 14, padding: "40px 24px", textAlign: "center", marginBottom: 16, background: T.surface }}>
            <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}><Icon name="download" size={28} /></div>
            <div style={{ fontWeight: 700, fontSize: 15, color: T.text, marginBottom: 6 }}>Upload CSV Export</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 18 }}>Client name, address, phone, email, plan, and more</div>
            <label style={{ background: T.primary, color: "#fff", borderRadius: 10, padding: "10px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Choose File
              <input type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: "none" }} />
            </label>
          </div>
          <Card>
            <CardHeader title="How it works" />
            <div style={{ padding: 16 }}>
              {["Your file is parsed (commas inside addresses are handled correctly)","Columns are auto-matched to the right fields","You review and fix any mapping before importing","Clients are added to your list"].map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, color: T.text, marginBottom: 8 }}>
                  <span style={{ color: T.accent, fontWeight: 700 }}>{i + 1}.</span> {item}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {stage === "mapping" && (
        <div>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{records.length} {records.length === 1 ? "record" : "records"} found</div>
                <div style={{ fontSize: 12, color: T.textMuted }}>{detected} of {IMPORT_FIELDS.length} fields auto-matched</div>
              </div>
              {records.length > 0
                ? <Btn onClick={handleImportAll}>Import {records.length}</Btn>
                : <Btn variant="ghost" onClick={reset}>Try Again</Btn>}
            </div>
          </Card>

          {records.length > 0 && <>
            {/* Column mapping */}
            <Card style={{ marginBottom: 14 }}>
              <CardHeader title="Match Your Columns" />
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                {IMPORT_FIELDS.map(f => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 110, flexShrink: 0, fontSize: 13, fontWeight: 700, color: T.text }}>{f.label}</div>
                    <select value={mapping[f.key] || ""} onChange={e => setField(f.key, e.target.value)} style={selectStyle}>
                      <option value="">— skip —</option>
                      {headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  Tip: if your file splits names into First and Last columns, map both and the app combines them.
                </div>
              </div>
            </Card>

            {/* Live preview */}
            {preview && (
              <Card>
                <CardHeader title="Preview (first record)" />
                <div style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {[["Name", preview.name],["Address", preview.address],["Phone", preview.phone],["Email", preview.email],["Division", preview.division],["Plan", `${preview.plan} (${preview.planFreq})`]].map(([k, v]) => (
                    <div key={k}>
                      <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{k}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: v && v !== "Unnamed Client" ? T.text : T.textMuted }}>{v || "—"}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>}
        </div>
      )}

      {stage === "done" && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: hexA("#16a34a", 0.1), color: "#16a34a", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 16px" }}><Icon name="check" size={32} /></div>
          <div style={{ fontWeight: 800, fontSize: 20, color: T.text, marginBottom: 8 }}>Import Complete</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 24 }}>{importedCount} {importedCount === 1 ? "client" : "clients"} added to your list.</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Btn onClick={onGoToClients}>View Clients</Btn>
            <Btn variant="ghost" onClick={reset}>Import Another</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// EMAIL REPORT SETTINGS
// ─────────────────────────────────────────────
function EmailSettings({ email, setEmail, branding, setBranding }) {
  const { T } = useApp();
  const set = (k, v) => setEmail(e => ({ ...e, [k]: v }));
  const setB = (k, v) => setBranding(b => ({ ...b, [k]: v }));

  const sample = {
    firstName: "Robert", company: branding.companyName, serviceType: "Bi-Weekly Service",
    date: new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    tech: "B. Stone", notes: "Cleaned filter pads, added beneficial bacteria, trimmed marginals. Water clarity excellent.",
    ph: "7.4", ammonia: "0.0", nitrite: "0.0", temp: "68°F", photoCount: 3,
  };
  const previewText = renderReport(email, sample);
  const previewSubject = email.subject.replace("{date}", sample.date);
  const smsPreview = (email.smsOnMyWay || "")
    .replace(/\{first\}/g, "Robert").replace(/\{sender\}/g, email.senderName || email.fromName || branding.companyName)
    .replace(/\{company\}/g, branding.companyName).replace(/\{eta\}/g, "15").replace(/\{arrival\}/g, "3:45 PM")
    .replace(/\{track\}/g, email.trackLink ? `Track my live location here: ${email.trackLink} — ` : "");

  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 };
  const field = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const hint = { fontSize: 11, color: T.textMuted, marginTop: 6 };

  return (
    <>
      {/* Company contact — used on invoices, the portal, and tap-to-call/email */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Company Contact" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -2 }}>Your public contact details. These power the portal's Request Service and Contact Us buttons and show on invoices.</div>
          <div><label style={labelStyle}>Phone</label><input type="tel" style={field} value={branding.companyPhone || ""} onChange={e => setB("companyPhone", e.target.value)} placeholder="(610) 555-1234" inputMode="tel" /></div>
          <div><label style={labelStyle}>Contact Email</label><input type="email" style={field} value={branding.companyEmail || ""} onChange={e => setB("companyEmail", e.target.value)} placeholder="hello@yourcompany.com" /></div>
          <div><label style={labelStyle}>Website</label><input type="url" style={field} value={branding.companyWebsite || ""} onChange={e => setB("companyWebsite", e.target.value)} placeholder="yourcompany.com" /></div>
          <div><label style={labelStyle}>Business Address</label><input type="text" style={field} value={branding.companyAddress || ""} onChange={e => setB("companyAddress", e.target.value)} placeholder="123 Main St, Honey Brook, PA 19344" /></div>
        </div>
      </Card>

      {/* Email sender */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Email Sender" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div><label style={labelStyle}>From Name</label><input type="text" style={field} value={email.fromName} onChange={e => set("fromName", e.target.value)} /></div>
          <div>
            <label style={labelStyle}>From Address</label>
            <input type="email" style={field} value={email.fromAddress} onChange={e => set("fromAddress", e.target.value)} placeholder="service@yourcompany.com" />
            <div style={hint}>The address clients reply to. Auto-sending is set up with the backend; for now reports open in your own mail app.</div>
          </div>
        </div>
      </Card>

      {/* Email message */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Email Message" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div>
            <label style={labelStyle}>Subject Line</label>
            <input type="text" style={field} value={email.subject} onChange={e => set("subject", e.target.value)} />
            <div style={hint}>Use {"{date}"} to insert the service date.</div>
          </div>
          <div><label style={labelStyle}>Intro Line</label><textarea style={{ ...field, resize: "vertical" }} rows={2} value={email.intro} onChange={e => set("intro", e.target.value)} /></div>
          <div><label style={labelStyle}>Sign-off Line</label><textarea style={{ ...field, resize: "vertical" }} rows={2} value={email.signoff} onChange={e => set("signoff", e.target.value)} /></div>
          <div><label style={labelStyle}>Footer <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(small print)</span></label><input style={field} value={email.footer || ""} onChange={e => set("footer", e.target.value)} placeholder="Stone Property Solutions · Licensed & insured" /></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
            {[["showReadings", "Include water readings"], ["showPhotosNote", "Mention photos are in the portal"]].map(([key, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <Checkbox checked={!!email[key]} onChange={() => set(key, !email[key])} />
                <span style={{ fontSize: 13, color: T.text }}>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </Card>

      {/* Text messages */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Text Messages" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "10px 13px", fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>
            Tags you can use: <b style={{ color: T.text }}>{"{first}"}</b> name, <b style={{ color: T.text }}>{"{sender}"}</b> your name, <b style={{ color: T.text }}>{"{company}"}</b>, <b style={{ color: T.text }}>{"{eta}"}</b> minutes, <b style={{ color: T.text }}>{"{arrival}"}</b> time, <b style={{ color: T.text }}>{"{track}"}</b> tracking link.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>Sender Name</label><input type="text" style={field} value={email.senderName || ""} onChange={e => set("senderName", e.target.value)} placeholder="Brandon" /></div>
          </div>
          <div><label style={labelStyle}>Live Tracking Link <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(optional)</span></label><input type="url" style={field} value={email.trackLink || ""} onChange={e => set("trackLink", e.target.value)} placeholder="Leave blank until Maps API is connected" /></div>
          <div><label style={labelStyle}>Reminder Text</label><textarea style={{ ...field, resize: "vertical" }} rows={2} value={email.smsReminder || ""} onChange={e => set("smsReminder", e.target.value)} /></div>
          <div>
            <label style={labelStyle}>Text Preview</label>
            <div style={{ background: hexA(T.primary, 0.1), borderRadius: 14, padding: "12px 14px", fontSize: 13, color: T.text, lineHeight: 1.5, borderTopLeftRadius: 4 }}>{smsPreview || "Your On My Way text will appear here."}</div>
          </div>
        </div>
      </Card>

      {/* Email preview */}
      <Card>
        <CardHeader title="Email Preview" />
        <div style={{ padding: 18 }}>
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ background: T.primary, color: "#fff", padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, overflow: "hidden" }}>
                {branding.logoType === "image" && branding.logoImage ? <img src={branding.logoImage} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span>{branding.logoEmoji}</span>}
              </div>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{email.fromName}</span>
            </div>
            <div style={{ padding: "12px 16px", background: T.surfaceAlt, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, color: T.textMuted }}>From: {email.fromName} &lt;{email.fromAddress}&gt;</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginTop: 2 }}>{previewSubject}</div>
            </div>
            <div style={{ padding: 16, fontSize: 13, color: T.text, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{previewText}</div>
            {email.footer && <div style={{ padding: "0 16px 16px", fontSize: 11, color: T.textMuted, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>{email.footer}</div>}
          </div>
          <div style={hint}>Preview uses sample data. Real reports fill in the actual client, notes, and readings from each completed stop.</div>
        </div>
      </Card>

      {/* Client Portal Settings */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Client Portal" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -2 }}>Controls what clients see and how they interact with your portal.</div>
          <div>
            <label style={labelStyle}>Welcome Message</label>
            <textarea style={{ ...field, resize: "vertical" }} rows={2}
              value={email.portalWelcome || ""}
              onChange={e => set("portalWelcome", e.target.value)}
              placeholder="e.g. Thanks for being a Stone Property Solutions client!" />
            <div style={hint}>Shown on the client's Home tab. Leave blank to use the default greeting.</div>
          </div>
          <div>
            <label style={labelStyle}>Service Request Confirmation</label>
            <input type="text" style={field}
              value={email.requestConfirmMsg || ""}
              onChange={e => set("requestConfirmMsg", e.target.value)}
              placeholder="e.g. We'll be in touch within 24 hours to confirm." />
            <div style={hint}>Shown after a client submits a service request.</div>
          </div>
        </div>
      </Card>

      {/* Notifications */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Notification Templates" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -2 }}>Edit the SMS messages sent to clients. Use tags: {"{first}"} = client first name, {"{company}"} = your company, {"{eta}"} = minutes, {"{arrival}"} = clock time, {"{sender}"} = your name.</div>
          <div>
            <label style={labelStyle}>"On My Way" Text</label>
            <textarea style={{ ...field, resize: "vertical" }} rows={3} value={email.smsOnMyWay || ""} onChange={e => set("smsOnMyWay", e.target.value)} />
            {smsPreview ? (
              <div style={{ marginTop: 8, background: T.surfaceAlt, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: T.text, lineHeight: 1.5, borderTopLeftRadius: 4 }}>{smsPreview}</div>
            ) : null}
          </div>
          <div>
            <label style={labelStyle}>Invoice Sent Text <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}>(optional)</span></label>
            <textarea style={{ ...field, resize: "vertical" }} rows={2}
              value={email.smsInvoice || ""}
              onChange={e => set("smsInvoice", e.target.value)}
              placeholder={`Hi {first}, you have a new invoice from {company}. Log in to your portal to view and pay it.`} />
          </div>
          <div>
            <label style={labelStyle}>Job Complete Text <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}>(optional)</span></label>
            <textarea style={{ ...field, resize: "vertical" }} rows={2}
              value={email.smsComplete || ""}
              onChange={e => set("smsComplete", e.target.value)}
              placeholder={`Hi {first}, your {company} service is complete. Check your portal for notes and photos.`} />
          </div>
        </div>
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────
// CATALOG MANAGER (stop types, services w/ products+tests, products, tests)
// ─────────────────────────────────────────────
function CatalogManager({ catalog, setCatalog }) {
  const { T } = useApp();
  const [svcModal, setSvcModal] = useState(null);   // service editor
  const [prodModal, setProdModal] = useState(null); // product editor
  const [txModal, setTxModal] = useState(null);     // treatment editor
  const [chipModal, setChipModal] = useState(null); // { kind:"stopTypes"|"tests", mode, value, original }

  const tests = catalog.tests || [];
  const products = catalog.products || [];
  const services = catalog.services || [];
  const treatments = catalog.treatments || [];
  const num = (v) => parseFloat(v) || 0;

  // ---- chip lists (stop types, tests): add / rename / delete ----
  const openAddChip = (kind) => setChipModal({ kind, mode: "add", value: "" });
  const openEditChip = (kind, value) => setChipModal({ kind, mode: "edit", value, original: value });
  const saveChip = () => {
    const { kind, mode, value, original } = chipModal;
    const v = value.trim();
    if (!v) return;
    setCatalog(c => {
      const list = [...(c[kind] || [])];
      if (mode === "add") { if (!list.includes(v)) list.push(v); }
      else { const i = list.indexOf(original); if (i >= 0) list[i] = v; }
      const next = { ...c, [kind]: list };
      // if a test was renamed, update services referencing it
      if (kind === "tests" && mode === "edit" && v !== original) {
        next.services = (c.services || []).map(s => ({ ...s, tests: (s.tests || []).map(t => t === original ? v : t) }));
      }
      return next;
    });
    setChipModal(null);
  };
  const deleteChip = () => {
    const { kind, original } = chipModal;
    setCatalog(c => ({ ...c, [kind]: (c[kind] || []).filter(x => x !== original) }));
    setChipModal(null);
  };

  // ---- products: add / edit / delete ----
  const openAddProd = () => setProdModal({ mode: "add", data: { id: `p${Date.now()}`, name: "", price: "" } });
  const openEditProd = (p) => setProdModal({ mode: "edit", data: { ...p } });
  const saveProd = () => {
    const d = prodModal.data; if (!d.name.trim()) return;
    setCatalog(c => {
      const exists = (c.products || []).some(p => p.id === d.id);
      return { ...c, products: exists ? c.products.map(p => p.id === d.id ? d : p) : [...(c.products || []), d] };
    });
    setProdModal(null);
  };
  const deleteProd = () => { setCatalog(c => ({ ...c, products: (c.products || []).filter(p => p.id !== prodModal.data.id) })); setProdModal(null); };

  // ---- treatments: add / edit / delete + inventory ----
  const openAddTx = () => setTxModal({ mode: "add", data: { id: `t${Date.now()}`, name: "", costPerOz: "", inventoryOz: "0" }, addOz: "" });
  const openEditTx = (t) => setTxModal({ mode: "edit", data: { ...t, inventoryOz: t.inventoryOz ?? "0" }, addOz: "" });
  const saveTx = () => {
    const d = txModal.data; if (!d.name.trim()) return;
    setCatalog(c => {
      const exists = (c.treatments || []).some(t => t.id === d.id);
      return { ...c, treatments: exists ? c.treatments.map(t => t.id === d.id ? d : t) : [...(c.treatments || []), d] };
    });
    setTxModal(null);
  };
  const deleteTx = () => { setCatalog(c => ({ ...c, treatments: (c.treatments || []).filter(t => t.id !== txModal.data.id) })); setTxModal(null); };
  const adjustInv = (delta) => setTxModal(m => ({ ...m, data: { ...m.data, inventoryOz: String(Math.max(0, num(m.data.inventoryOz) + delta)) } }));
  const addInvAmount = () => setTxModal(m => ({ ...m, data: { ...m.data, inventoryOz: String(Math.max(0, num(m.data.inventoryOz) + num(m.addOz))) }, addOz: "" }));

  // ---- services: add / edit / delete ----
  const openAddSvc = () => setSvcModal({ mode: "add", data: { id: `s${Date.now()}`, name: "", price: "", products: [], tests: [] } });
  const openEditSvc = (s) => setSvcModal({ mode: "edit", data: { ...s, products: s.products || [], tests: s.tests || [] } });
  const saveSvc = () => {
    const d = svcModal.data;
    if (!d.name.trim()) return;
    setCatalog(c => {
      const exists = (c.services || []).some(s => s.id === d.id);
      const services = exists ? c.services.map(s => s.id === d.id ? d : s) : [...(c.services || []), d];
      return { ...c, services };
    });
    setSvcModal(null);
  };
  const deleteSvc = () => { setCatalog(c => ({ ...c, services: c.services.filter(s => s.id !== svcModal.data.id) })); setSvcModal(null); };
  const setSvc = (k, v) => setSvcModal(m => ({ ...m, data: { ...m.data, [k]: v } }));
  const toggleSvcProduct = (pid) => setSvcModal(m => {
    const has = m.data.products.includes(pid);
    return { ...m, data: { ...m.data, products: has ? m.data.products.filter(x => x !== pid) : [...m.data.products, pid] } };
  });
  const toggleSvcTest = (t) => setSvcModal(m => {
    const has = m.data.tests.includes(t);
    return { ...m, data: { ...m.data, tests: has ? m.data.tests.filter(x => x !== t) : [...m.data.tests, t] } };
  });

  const chipInput = { flex: 1, padding: "9px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const field = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };
  const productName = (pid) => (products.find(p => p.id === pid) || {}).name || "";

  const Chip = ({ kind, value }) => (
    <button onClick={() => openEditChip(kind, value)}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 20, background: T.surfaceAlt, fontSize: 12, fontWeight: 700, color: T.text, border: "none", cursor: "pointer", fontFamily: "inherit" }}>
      {value} <Icon name="edit" size={13} color={T.textMuted} />
    </button>
  );

  return (
    <>
      {/* Stop Types */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Stop Types" action={<Btn sm onClick={() => openAddChip("stopTypes")}>+ Add</Btn>} />
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {catalog.stopTypes.map(t => <Chip key={t} kind="stopTypes" value={t} />)}
          </div>
        </div>
      </Card>

      {/* Services */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Services" action={<Btn sm onClick={openAddSvc}>+ Add</Btn>} />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 8 }}>
          {services.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>No services yet. Tap "+ Add" to create one.</div>}
          {services.map(s => (
            <div key={s.id} onClick={() => openEditSvc(s)}
              style={{ padding: "12px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: (s.products?.length || s.tests?.length) ? 8 : 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{s.name}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {s.price && <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>${s.price}</span>}
                  <Icon name="edit" size={14} />
                </div>
              </div>
              {s.description && <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6, lineHeight: 1.4 }}>{s.description}</div>}
              {(s.products?.length > 0) && <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 3 }}>{s.products.map(productName).filter(Boolean).join(", ")}</div>}
              {(s.tests?.length > 0) && <div style={{ fontSize: 11, color: T.textMuted }}>{s.tests.join(", ")}</div>}
            </div>
          ))}
        </div>
      </Card>

      {/* Products */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Products" action={<Btn sm onClick={openAddProd}>+ Add</Btn>} />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 8 }}>
          {products.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>No products yet. Tap "+ Add" to create one.</div>}
          {products.map(p => (
            <div key={p.id} onClick={() => openEditProd(p)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{p.name}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {p.price && <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>${p.price}</span>}
                <Icon name="edit" size={14} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Treatments */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Treatments" action={<Btn sm onClick={openAddTx}>+ Add</Btn>} />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>Tracked by the ounce with your cost per oz and inventory on hand. Usage on a stop subtracts from inventory.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {treatments.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>No treatments yet. Tap "+ Add" to create one.</div>}
            {treatments.map(t => {
              const inv = num(t.inventoryOz);
              const low = inv <= 32;
              return (
                <div key={t.id} onClick={() => openEditTx(t)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: low ? T.warning : T.textMuted, fontWeight: low ? 700 : 400 }}>{inv} oz on hand{low ? " · low" : ""}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {t.costPerOz && <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>${t.costPerOz}/oz</span>}
                    <Icon name="edit" size={14} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Water Tests */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Water Tests" action={<Btn sm onClick={() => openAddChip("tests")}>+ Add</Btn>} />
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {tests.map(t => <Chip key={t} kind="tests" value={t} />)}
          </div>
        </div>
      </Card>

      {/* Chip (stop type / test) editor */}
      {chipModal && (
        <Modal title={`${chipModal.mode === "add" ? "Add" : "Edit"} ${chipModal.kind === "tests" ? "Test" : "Stop Type"}`} onClose={() => setChipModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <input style={field} value={chipModal.value} onChange={e => setChipModal(m => ({ ...m, value: e.target.value }))} placeholder={chipModal.kind === "tests" ? "e.g. Chlorine" : "e.g. Maintenance"} autoFocus />
            <Btn onClick={saveChip} style={{ width: "100%", padding: "12px", borderRadius: 12 }}>{chipModal.mode === "add" ? "Add" : "Save Changes"}</Btn>
            {chipModal.mode === "edit" && <button onClick={deleteChip} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete</button>}
          </div>
        </Modal>
      )}

      {/* Product editor */}
      {prodModal && (
        <Modal title={prodModal.mode === "add" ? "Add Product" : "Edit Product"} onClose={() => setProdModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <AutocompleteInput
                value={prodModal.data.name}
                onChange={v => setProdModal(m => ({ ...m, data: { ...m.data, name: v } }))}
                historyKey="sps_product_name_history"
                placeholder="e.g. Beneficial Bacteria"
                style={field}
                autoFocus
              />
            </div>
            <div><label style={labelStyle}>Price</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>$</span>
                <input style={{ ...field, paddingLeft: 24 }} value={prodModal.data.price} onChange={e => setProdModal(m => ({ ...m, data: { ...m.data, price: e.target.value.replace(/[^\d.]/g, "") } }))} placeholder="0" />
              </div>
            </div>
            <Btn onClick={saveProd} style={{ width: "100%", padding: "12px", borderRadius: 12 }}>{prodModal.mode === "add" ? "Add Product" : "Save Changes"}</Btn>
            {prodModal.mode === "edit" && <button onClick={deleteProd} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete this product</button>}
          </div>
        </Modal>
      )}

      {/* Treatment editor (with inventory) */}
      {txModal && (
        <Modal title={txModal.mode === "add" ? "Add Treatment" : "Edit Treatment"} onClose={() => setTxModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <AutocompleteInput
                value={txModal.data.name}
                onChange={v => setTxModal(m => ({ ...m, data: { ...m.data, name: v } }))}
                historyKey="sps_treatment_name_history"
                placeholder="e.g. Algaecide"
                style={field}
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Brand <span style={{ textTransform: "none", fontWeight: 400, color: T.textMuted }}>(optional)</span></label>
              <AutocompleteInput
                value={txModal.data.brand || ""}
                onChange={v => setTxModal(m => ({ ...m, data: { ...m.data, brand: v } }))}
                historyKey="sps_brand_history"
                placeholder="e.g. CrystalClear, API, Microbe-Lift"
                style={field}
              />
            </div>
            <div><label style={labelStyle}>Cost per Ounce</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>$</span>
                <input style={{ ...field, paddingLeft: 24 }} value={txModal.data.costPerOz} onChange={e => setTxModal(m => ({ ...m, data: { ...m.data, costPerOz: e.target.value.replace(/[^\d.]/g, "") } }))} placeholder="0.00" />
              </div>
            </div>

            {/* inventory */}
            <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: 14 }}>
              <label style={labelStyle}>Inventory on Hand</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <button onClick={() => adjustInv(-1)} style={{ width: 34, height: 34, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 18, cursor: "pointer", fontFamily: "inherit" }}>−</button>
                <div style={{ position: "relative", flex: 1 }}>
                  <input type="text" inputMode="decimal" value={txModal.data.inventoryOz} onChange={e => setTxModal(m => ({ ...m, data: { ...m.data, inventoryOz: e.target.value.replace(/[^\d.]/g, "") } }))}
                    style={{ width: "100%", padding: "10px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 16, fontWeight: 800, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
                  <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>oz</span>
                </div>
                <button onClick={() => adjustInv(1)} style={{ width: 34, height: 34, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 18, cursor: "pointer", fontFamily: "inherit" }}>+</button>
              </div>
              {/* quick add bottle sizes */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {[16, 32, 64, 128].map(sz => (
                  <button key={sz} onClick={() => adjustInv(sz)} style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${T.border}`, background: T.surface, color: T.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>+{sz}oz</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <input type="text" inputMode="decimal" value={txModal.addOz} onChange={e => setTxModal(m => ({ ...m, addOz: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="Custom amount" style={{ width: "100%", padding: "9px 12px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
                </div>
                <Btn sm onClick={addInvAmount} style={{ padding: "9px 16px" }}>Add</Btn>
              </div>
            </div>

            <Btn onClick={saveTx} style={{ width: "100%", padding: "12px", borderRadius: 12 }}>{txModal.mode === "add" ? "Add Treatment" : "Save Changes"}</Btn>
            {txModal.mode === "edit" && <button onClick={deleteTx} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete this treatment</button>}
          </div>
        </Modal>
      )}

      {/* Service editor modal */}
      {svcModal && (
        <Modal title={svcModal.mode === "add" ? "Add Service" : "Edit Service"} onClose={() => setSvcModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 2 }}>
                <label style={labelStyle}>Service Name</label>
                <AutocompleteInput
                  value={svcModal.data.name}
                  onChange={v => setSvc("name", v)}
                  historyKey="sps_service_name_history"
                  placeholder="e.g. Algae Treatment"
                  style={chipInput}
                  autoFocus
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Price</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
                  <input style={{ ...chipInput, paddingLeft: 22 }} value={svcModal.data.price} onChange={e => setSvc("price", e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" />
                </div>
              </div>
            </div>

            <div>
              <label style={labelStyle}>Description</label>
              <textarea value={svcModal.data.description || ""} onChange={e => setSvc("description", e.target.value)} rows={2}
                placeholder="What this service includes — shown to staff and on the client's report."
                style={{ ...chipInput, resize: "vertical" }} />
            </div>

            <div>
              <label style={labelStyle}>Products Needed</label>
              {products.length === 0 ? (
                <div style={{ fontSize: 12, color: T.textMuted }}>Add products first, then attach them here.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {products.map(p => {
                    const on = svcModal.data.products.includes(p.id);
                    return (
                      <button key={p.id} onClick={() => toggleSvcProduct(p.id)}
                        style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${on ? T.primary : T.border}`, background: on ? T.navActiveBg : T.surface, color: on ? T.primary : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label style={labelStyle}>Tests Required</label>
              {tests.length === 0 ? (
                <div style={{ fontSize: 12, color: T.textMuted }}>Add water tests first, then attach them here.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {tests.map(t => {
                    const on = svcModal.data.tests.includes(t);
                    return (
                      <button key={t} onClick={() => toggleSvcTest(t)}
                        style={{ padding: "7px 13px", borderRadius: 20, border: `1.5px solid ${on ? T.accent : T.border}`, background: on ? `${T.accent}14` : T.surface, color: on ? T.accent : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label style={labelStyle}>Checklist <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(one task per line)</span></label>
              <textarea value={(svcModal.data.checklist || []).join("\n")} onChange={e => setSvc("checklist", e.target.value.split("\n"))} rows={4}
                placeholder={"Skim surface & remove debris\nRinse filter pads\nCheck pump & plumbing\nTest water\nApply treatment"}
                style={{ ...chipInput, resize: "vertical" }} />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>These tasks auto-load on every stop using this service, ready to check off.</div>
            </div>

            <Btn onClick={saveSvc} style={{ width: "100%", padding: "12px", borderRadius: 12, marginTop: 2 }}>
              {svcModal.mode === "add" ? "Add Service" : "Save Changes"}
            </Btn>
            {svcModal.mode === "edit" && (
              <button onClick={deleteSvc} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete this service</button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// BUDGET MANAGER (admin: money in/out, projected vs actual)
// ─────────────────────────────────────────────
function BudgetManager({ budget, setBudget, clients, costs, invoices }) {
  const { T } = useApp();
  const money = (n) => `$${Math.round(n).toLocaleString()}`;
  const num = (v) => parseFloat(v) || 0;

  const fixedFromCosts = costs ? monthlyFixedCosts(costs) : 0;
  const incomeTotal = (budget.income || []).reduce((s, r) => s + num(r.amount), 0);
  const expenseManual = (budget.expenses || []).reduce((s, r) => s + num(r.amount), 0);
  const expenseTotal = expenseManual + fixedFromCosts;
  const projectedNet = incomeTotal - expenseTotal;

  const actuals = monthActuals(clients, new Date(), invoices || []);
  const actualOut = actuals.cost + fixedFromCosts;
  const actualNet = actuals.revenue - actualOut;

  const editRow = (kind, id, field, value) =>
    setBudget(b => ({ ...b, [kind]: b[kind].map(r => r.id === id ? { ...r, [field]: field === "amount" ? value.replace(/[^\d.]/g, "") : value } : r) }));
  const addRow = (kind) =>
    setBudget(b => ({ ...b, [kind]: [...(b[kind] || []), { id: `${kind[0]}${Date.now()}`, label: "", amount: "" }] }));
  const removeRow = (kind, id) =>
    setBudget(b => ({ ...b, [kind]: b[kind].filter(r => r.id !== id) }));

  const lineInput = { flex: 1, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const amtInput = { width: 96, padding: "9px 8px 9px 20px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" };

  const section = (kind, title, accent) => (
    <Card style={{ marginBottom: 14 }}>
      <CardHeader title={title} action={<Btn sm onClick={() => addRow(kind)}>+ Add</Btn>} />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {(budget[kind] || []).map(r => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="text" value={r.label} onChange={e => editRow(kind, r.id, "label", e.target.value)} placeholder="Label..." style={lineInput} />
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
              <input type="text" inputMode="decimal" value={r.amount} onChange={e => editRow(kind, r.id, "amount", e.target.value)} placeholder="0" style={amtInput} />
            </div>
            <button onClick={() => removeRow(kind, r.id)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
        ))}
        {kind === "expenses" && fixedFromCosts > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surfaceAlt, borderRadius: 10, padding: "9px 11px" }}>
            <span style={{ fontSize: 13, color: T.text }}>Fixed overhead <span style={{ fontSize: 11, color: T.textMuted }}>(from Costs tab)</span></span>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{money(fixedFromCosts)}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Monthly Total</span>
          <span style={{ fontSize: 14, fontWeight: 800, color: accent }}>{money(kind === "income" ? incomeTotal : expenseTotal)}</span>
        </div>
      </div>
    </Card>
  );

  return (
    <>
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14 }}>Admin only. Set your expected monthly money in and out, then compare against what's actually been completed this month.</div>

      {/* Projected net */}
      <Card style={{ marginBottom: 14 }}>
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 12 }}>Projected Monthly</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[["In", incomeTotal, T.accent],["Out", expenseTotal, T.warning],["Net", projectedNet, projectedNet >= 0 ? T.accent : "#C0392B"]].map(([k, v, col]) => (
              <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 8px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{k}</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: col, marginTop: 3 }}>{money(v)}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {section("income", "Expected Income", T.accent)}
      {section("expenses", "Expected Expenses", T.warning)}

      {/* Actuals this month */}
      <Card>
        <CardHeader title="Actual — This Month" />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>Pulled live from completed jobs ({actuals.jobs} this month), plus fixed overhead.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            {[["Revenue", actuals.revenue, T.text],["Money Out", actualOut, T.textMuted],["Net", actualNet, actualNet >= 0 ? T.accent : "#C0392B"]].map(([k, v, col]) => (
              <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 8px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: col, marginTop: 3 }}>{money(v)}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 14 }}>Money Out = job costs {money(actuals.cost)} + fixed overhead {money(fixedFromCosts)}.</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
            <span style={{ fontSize: 13, color: T.text }}>Revenue vs target</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: actuals.revenue >= incomeTotal ? T.accent : T.warning }}>
              {incomeTotal > 0 ? Math.round((actuals.revenue / incomeTotal) * 100) : 0}%
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 10, lineHeight: 1.5 }}>
            Job costs come from each completed visit (labor, treatments, products, per-stop overhead). Fixed overhead is your per-month cost lines.
          </div>
        </div>
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────
// COST SETTINGS (admin cost assumptions)
// ─────────────────────────────────────────────
function CostSettings({ costs, setCosts }) {
  const { T } = useApp();
  const n = (v) => parseFloat(v) || 0;
  const setRate = (v) => setCosts(c => ({ ...c, hourlyRate: v.replace(/[^\d.]/g, "") }));
  const setLine = (key, patch) => setCosts(c => ({ ...c, [key]: { ...costLine(c[key]), ...patch } }));

  const perStop = perStopCosts(costs);
  const monthlyFixed = monthlyFixedCosts(costs);
  const totalPerStop = perStop.gas + perStop.insurance + perStop.equipment + perStop.overhead;

  const rows = [["gas", "Gas / Fuel"], ["insurance", "Insurance"], ["equipment", "Equipment"], ["overhead", "Overhead"]];

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Labor" />
        <div style={{ padding: 18, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Labor Rate</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Per hour — billed by actual time on each job</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ position: "relative", width: 100 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
              <input type="text" inputMode="decimal" value={costs.hourlyRate} onChange={e => setRate(e.target.value)} style={{ width: "100%", padding: "9px 8px 9px 22px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
            </div>
            <span style={{ fontSize: 11, color: T.textMuted, width: 30 }}>/hr</span>
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Overhead Costs" />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 16 }}>For each cost, choose per-stop or per-month. Per-stop costs are charged to every job's profit. Per-month costs are fixed overhead in your Budget.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {rows.map(([key, label]) => {
              const l = costLine(costs[key]);
              return (
                <div key={key}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ position: "relative", width: 96 }}>
                        <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
                        <input type="text" inputMode="decimal" value={l.amount} onChange={e => setLine(key, { amount: e.target.value.replace(/[^\d.]/g, "") })} style={{ width: "100%", padding: "9px 8px 9px 20px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
                      </div>
                      <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
                        {[["stop", "/stop"], ["month", "/mo"]].map(([m, lbl]) => (
                          <button key={m} onClick={() => setLine(key, { mode: m })}
                            style={{ padding: "8px 10px", border: "none", background: l.mode === m ? T.primary : T.surface, color: l.mode === m ? "#fff" : T.textMuted, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>{lbl}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Per-stop overhead (hits each job)</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: T.text }}>${totalPerStop.toFixed(2)}</span>
            </div>
            <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Fixed monthly overhead (in Budget)</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: T.text }}>${monthlyFixed.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </Card>

      <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 14px", fontSize: 12, color: T.textMuted, display: "flex", gap: 8 }}>
        <Icon name="info" size={14} />
        <span>Switch any line between /stop and /mo and it re-tabulates automatically — per-stop in job profitability, per-month in the Budget. Per-employee labor rates flow in once tech assignment is added.</span>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// APP SETTINGS (Customize)
// ─────────────────────────────────────────────
// Apple-style toggle switch
function Toggle({ on, onChange }) {
  const { T } = useApp();
  return (
    <button onClick={() => onChange(!on)} style={{ width: 50, height: 30, borderRadius: 100, border: "none", cursor: "pointer", padding: 2, background: on ? T.accent : T.surfaceAlt, transition: "background .2s", position: "relative", flexShrink: 0 }}>
      <span style={{ display: "block", width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)", transform: on ? "translateX(20px)" : "translateX(0)", transition: "transform .2s" }} />
    </button>
  );
}

function ScheduleSettings({ cfg, setCfg }) {
  const { T } = useApp();
  const c = { ...DEFAULT_SCHEDULE_CFG, ...(cfg || {}) };
  const setK = (k, v) => setCfg({ ...c, [k]: v });
  const segOpts = (key, opts) => (
    <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 12, padding: 4, gap: 4 }}>
      {opts.map(([val, label]) => (
        <button key={val} onClick={() => setK(key, val)} style={{
          flex: 1, padding: "10px 6px", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
          fontSize: 13, fontWeight: 600,
          background: c[key] === val ? T.surface : "transparent",
          color: c[key] === val ? T.primary : T.textMuted,
          boxShadow: c[key] === val ? T.shadow : "none",
        }}>{label}</button>
      ))}
    </div>
  );
  const row = (key, label, help) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
        {help && <div style={{ fontSize: 12, color: T.textMuted }}>{help}</div>}
      </div>
      <Toggle on={!!c[key]} onChange={v => setK(key, v)} />
    </div>
  );

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Stop Order" />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>How stops are ordered within each day on the route.</div>
          {segOpts("sort", [["time", "By time"], ["manual", "Manual order"]])}
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 10 }}>
            {c.sort === "time" ? "Stops sort automatically by their scheduled time." : "Arrange stops by hand with up/down arrows on each stop, in the exact order the crew should drive them."}
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Layout" />
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 12 }}>Card spacing on the schedule.</div>
          {segOpts("density", [["comfortable", "Comfortable"], ["compact", "Compact"]])}
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Show on Each Stop" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          {row("showAddress", "Address", "Street address under the client name")}
          {row("showServices", "Services", "The list of services and prices")}
          {row("showDuration", "Duration", "Estimated time for the stop")}
        </div>
      </Card>

      <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 16px", fontSize: 12, color: T.textMuted, display: "flex", gap: 8 }}>
        <Icon name="map" size={14} />
        <span>These settings apply to everyone using the schedule on this device.</span>
      </div>
    </>
  );
}

// Reusable grouped permission toggles, operating on a perms object ({canSeeProfit, canEditClients, ...})
function PermissionGroups({ value, onChange }) {
  const { T } = useApp();
  const v = value || {};
  const setK = (k, val) => onChange({ ...v, [k]: val });
  const permRow = (key, label, help) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
        {help && <div style={{ fontSize: 12, color: T.textMuted }}>{help}</div>}
      </div>
      <Toggle on={!!v[key]} onChange={val => setK(key, val)} />
    </div>
  );
  const groupCard = (title, sub, rows) => (
    <Card style={{ marginBottom: 12 }}>
      <CardHeader title={title} />
      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
        {sub && <div style={{ fontSize: 12, color: T.textMuted, marginTop: -2 }}>{sub}</div>}
        {rows}
      </div>
    </Card>
  );
  return (
    <>
      {groupCard("Can See", "Visibility of sensitive numbers.", <>
        {permRow("canSeeProfit", "Profitability", "Per-job profit, margins, the money math")}
        {permRow("canSeeCostsBudget", "Costs & Budget", "Cost assumptions and the budget tab")}
        {permRow("canSeeBalances", "Client Balances", "What each client owes")}
      </>)}
      {groupCard("Can Change", "Editing and managing records.", <>
        {permRow("canEditClients", "Clients", "Add, edit, delete clients and their equipment")}
        {permRow("canEditSchedule", "Schedule", "Add, remove, and reorder stops")}
        {permRow("canEditHistory", "Service History", "Edit past completed visits")}
        {permRow("canEditCatalog", "Catalog", "Services, products, treatments, stop types, tests")}
        {permRow("canEditSettings", "App Settings", "Branding, appearance, email, schedule layout")}
        {permRow("canImport", "Import Data", "Bring in clients from a CSV")}
      </>)}
      {groupCard("Can Do", "Day-to-day field actions.", <>
        {permRow("canCompleteStops", "Complete Service Visits", "Open the workspace, log work, save reports")}
        {permRow("canSendTexts", "Send \"On My Way\" Texts", "Notify clients of arrival")}
        {permRow("canInvoice", "Create & Send Invoices", "Build invoices, mark them sent and paid")}
      </>)}
    </>
  );
}

function TeamManager({ team, setTeam, currentUserId }) {
  const { T } = useApp();
  const [modal, setModal] = useState(null); // { mode, data }
  const [inviteState, setInviteState] = useState({}); // { [memberId]: "idle"|"sending"|"sent"|"error" }
  const [inviteMsg, setInviteMsg] = useState({});
  const list = team || [];

  const blankMember = () => ({ id: `e${Date.now()}`, name: "", rate: "", role: "field", pin: "", email: "", perms: { ...ROLE_PRESETS.field } });
  const openAdd  = () => setModal({ mode: "add",  data: blankMember() });
  const openEdit = (e) => setModal({ mode: "edit", data: { perms: { ...(ROLE_PRESETS[e.role] || ROLE_PRESETS.field) }, ...e } });
  const setD = (patch) => setModal(m => ({ ...m, data: { ...m.data, ...patch } }));

  const save = () => {
    const d = modal.data;
    if (!d.name.trim()) return;
    setTeam(t => {
      const exists = (t || []).some(x => x.id === d.id);
      return exists ? t.map(x => x.id === d.id ? d : x) : [...(t || []), d];
    });
    setModal(null);
  };

  const del = () => {
    setTeam(t => (t || []).filter(x => x.id !== modal.data.id));
    setModal(null);
  };

  // Send a magic link invite to a staff member — creates their Supabase account automatically
  const sendStaffInvite = async (member) => {
    if (!(member.email || "").trim()) return;
    const id = member.id;
    setInviteState(s => ({ ...s, [id]: "sending" }));
    setInviteMsg(s => ({ ...s, [id]: "" }));
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: member.email.trim(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin,
          data: { name: member.name },
        },
      });
      if (error) {
        setInviteState(s => ({ ...s, [id]: "error" }));
        setInviteMsg(s => ({ ...s, [id]: error.message }));
      } else {
        setInviteState(s => ({ ...s, [id]: "sent" }));
        setInviteMsg(s => ({ ...s, [id]: `Invite sent to ${member.email}` }));
        setTimeout(() => setInviteState(s => ({ ...s, [id]: "idle" })), 6000);
      }
    } catch (e) {
      setInviteState(s => ({ ...s, [id]: "error" }));
      setInviteMsg(s => ({ ...s, [id]: "Something went wrong. Check your connection." }));
    }
  };

  const field = { width: "100%", padding: "11px 14px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };
  const ownerCount = list.filter(m => m.role === "owner").length;
  const isLastOwner = modal && modal.data.role === "owner" && ownerCount <= 1 && list.some(m => m.id === modal.data.id && m.role === "owner");

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Team & Logins" action={<Btn sm onClick={openAdd} style={{ gap: 5 }}><Icon name="plus" size={13} /> Add Member</Btn>} />
        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
            Add a staff member, set their role and permissions, then tap Send Invite — their Supabase account is created automatically and they get a login link by email. No backend required.
          </div>

          {list.length === 0 && (
            <div style={{ textAlign: "center", padding: "20px", color: T.textMuted, fontSize: 13 }}>No team members yet. Tap Add Member to get started.</div>
          )}

          {list.map(e => {
            const state = inviteState[e.id] || "idle";
            const msg   = inviteMsg[e.id] || "";
            const hasEmail = !!(e.email || "").trim();
            return (
              <div key={e.id} style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
                {/* Member row */}
                <div onClick={() => openEdit(e)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", cursor: "pointer" }}>
                  <span style={{ width: 40, height: 40, borderRadius: "50%", background: e.role === "owner" ? T.primary : hexA(T.primary, 0.14), color: e.role === "owner" ? "#fff" : T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                    {initials(e.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>
                      {e.name} {e.id === currentUserId && <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 500 }}>· you</span>}
                    </div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                      {roleLabel(e.role)}
                      {hasEmail ? ` · ${e.email}` : " · No email set"}
                      {e.rate ? ` · $${e.rate}/hr` : ""}
                    </div>
                  </div>
                  <Icon name="edit" size={14} />
                </div>

                {/* Invite row */}
                <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: T.surface }}>
                  {!hasEmail ? (
                    <div style={{ fontSize: 12, color: T.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="warning" size={13} /> Add an email above to send a login invite
                    </div>
                  ) : state === "sent" ? (
                    <div style={{ fontSize: 12, color: T.accent, display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                      <Icon name="check" size={13} /> {msg}
                    </div>
                  ) : state === "error" ? (
                    <div style={{ fontSize: 12, color: T.warning, flex: 1, lineHeight: 1.4 }}>{msg}</div>
                  ) : (
                    <div style={{ fontSize: 12, color: T.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
                      <Icon name="mail" size={13} /> {e.email}
                    </div>
                  )}
                  <button
                    onClick={() => sendStaffInvite(e)}
                    disabled={!hasEmail || state === "sending"}
                    style={{ background: hasEmail ? T.primary : T.surfaceAlt, color: hasEmail ? "#fff" : T.textMuted, border: "none", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: hasEmail ? "pointer" : "default", fontFamily: "inherit", flexShrink: 0, display: "flex", alignItems: "center", gap: 5, opacity: state === "sending" ? 0.6 : 1 }}>
                    {state === "sending"
                      ? <><div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Sending...</>
                      : state === "sent"
                        ? <><Icon name="refresh" size={12} /> Resend</>
                        : <><Icon name="mail" size={12} /> Send Invite</>
                    }
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {modal && (
        <Modal title={modal.mode === "add" ? "Add Team Member" : "Edit Team Member"} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Name */}
            <div>
              <label style={labelStyle}>Full Name</label>
              <input type="text" style={field} value={modal.data.name} onChange={e => setD({ name: e.target.value })} placeholder="e.g. David Smith" autoFocus />
            </div>

            {/* Email */}
            <div>
              <label style={labelStyle}>Login Email</label>
              <input type="email" style={field} value={modal.data.email || ""} onChange={e => setD({ email: e.target.value })} placeholder="their work email address" inputMode="email" autoCapitalize="none" />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                This is the email they use to sign in. Once saved, tap Send Invite on their card and their Supabase account is created automatically.
              </div>
            </div>

            {/* Role */}
            <div>
              <label style={labelStyle}>Role</label>
              <select value={modal.data.role || "field"} onChange={e => { const role = e.target.value; setD({ role, ...(role === "custom" && !modal.data.perms ? { perms: { ...ROLE_PRESETS.field } } : {}) }); }}
                style={{ ...field, appearance: "none", WebkitAppearance: "none" }}>
                {MEMBER_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                {modal.data.role === "owner" ? "Full control — including team and login management."
                  : "Pick a role, then fine-tune permissions below if needed."}
              </div>
            </div>

            {/* Hourly rate */}
            <div>
              <label style={labelStyle}>Hourly Labor Rate <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", fontSize: 15, color: T.textMuted }}>$</span>
                <input style={{ ...field, paddingLeft: 28 }} value={modal.data.rate} onChange={e => setD({ rate: e.target.value.replace(/[^\d.]/g, "") })} placeholder="0.00" />
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Used to calculate job profitability on assigned stops.</div>
            </div>

            {/* Permissions */}
            {modal.data.role === "owner" ? (
              <div style={{ background: hexA(T.primary, 0.08), border: `1px solid ${hexA(T.primary, 0.2)}`, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: T.text, lineHeight: 1.5 }}>
                Owners have full access to everything including team management, all reports, and settings.
              </div>
            ) : (
              <div>
                <label style={{ ...labelStyle, marginBottom: 10 }}>Permissions</label>
                <PermissionGroups
                  value={modal.data.role === "custom" ? (modal.data.perms || {}) : (ROLE_PRESETS[modal.data.role] || ROLE_PRESETS.field)}
                  onChange={p => setD({ role: "custom", perms: p })}
                />
              </div>
            )}

            <Btn onClick={save} block lg>{modal.mode === "add" ? "Save Member" : "Save Changes"}</Btn>
            {modal.mode === "edit" && !isLastOwner && (
              <button onClick={del} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit", textAlign: "center" }}>
                Remove {modal.data.name || "this member"}
              </button>
            )}
            {isLastOwner && (
              <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center" }}>Can't remove the only Owner account.</div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// INVOICING
// ─────────────────────────────────────────────
function InvoiceRow({ iv, onClick }) {
  const { T } = useApp();
  const rawEff = effectiveStatus(iv);
  // Normalize — QB returns "Paid", SPS uses "Paid", both should display same
  const eff = rawEff;
  const total = invoiceTotals(iv).total;
  // Format date — handles YYYY-MM-DD (QB) and MM/DD/YYYY (SPS)
  const displayDate = (() => {
    const s = iv.date || "";
    if (s.includes("-") && s.length === 10) {
      const [y,m,d] = s.split("-");
      const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${mo[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
    }
    return s;
  })();
  return (
    <div onClick={onClick}
      style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", transition: "box-shadow 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"}
      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
      {/* Status accent bar */}
      <div style={{ width: 3, alignSelf: "stretch", borderRadius: 3, background: invStatusColor(eff, T), flexShrink: 0, minHeight: 36 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>{iv._client?.name || iv.clientName || "Client"}</div>
        <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2, display: "flex", gap: 8 }}>
          <span>#{iv.number}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{displayDate}</span>
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{`$${total.toFixed(2)}`}</div>
        <span style={{ display: "inline-block", marginTop: 4, background: hexA(invStatusColor(eff, T), 0.12), color: invStatusColor(eff, T), padding: "2px 9px", borderRadius: 100, fontSize: 10, fontWeight: 700, letterSpacing: "0.03em" }}>{eff}</span>
      </div>
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" style={{ opacity: 0.4, flexShrink: 0 }}><path d="m9 18 6-6-6-6"/></svg>
    </div>
  );
}

function InvoiceEditor({ invoice, clients, invoices, invoicing, presetClientId, onSave, onClose, onDelete }) {
  const { T } = useApp();
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const toISO = (mdy) => { const d = parseMDY(mdy); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : ""; };
  const fromISO = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };

  const fresh = () => ({
    id: `iv${Date.now()}`,
    number: `${(invoicing && invoicing.numberPrefix) || "INV-"}${nextInvoiceNumber(invoices, invoicing)}`,
    clientId: presetClientId ?? (clients[0]?.id ?? null),
    date: todayMDY(),
    dueDate: addDaysMDY(todayMDY(), invoicing.dueDays),
    status: "Draft",
    lineItems: [{ id: `l${Date.now()}`, desc: "", qty: "1", unitPrice: "", taxable: false }],
    taxRate: invoicing.taxRate,
    notes: invoicing.terms,
    createdAt: Date.now(),
  });
  const [inv, setInv] = useState(() => invoice ? { ...invoice, lineItems: (invoice.lineItems || []).map(l => ({ ...l })) } : fresh());
  const [visitPick, setVisitPick] = useState(false);
  const set = (k, v) => setInv(s => ({ ...s, [k]: v }));
  const setLine = (id, k, v) => setInv(s => ({ ...s, lineItems: s.lineItems.map(l => l.id === id ? { ...l, [k]: v } : l) }));
  const addLine = () => setInv(s => ({ ...s, lineItems: [...s.lineItems, { id: `l${Date.now()}`, desc: "", qty: "1", unitPrice: "", taxable: false }] }));
  const removeLine = (id) => setInv(s => ({ ...s, lineItems: s.lineItems.filter(l => l.id !== id) }));

  const client = clients.find(c => c.id === inv.clientId);
  const totals = invoiceTotals(inv);
  const completedHistory = client?.history || [];

  const importVisit = (h) => {
    const items = (h.services || []).map((sv, i) => ({ id: `l${Date.now()}${i}`, desc: typeof sv === "string" ? sv : sv.name, qty: "1", unitPrice: String(typeof sv === "string" ? "" : (sv.price || "")), taxable: false }));
    if (items.length) setInv(s => ({ ...s, lineItems: items }));
    setVisitPick(false);
  };
  const save = () => { onSave({ ...inv, clientName: client?.name || "", clientAddress: client?.address || "", clientEmail: client?.email || "" }); onClose(); };

  const field = { width: "100%", padding: "11px 13px", border: `1px solid ${T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const small = { width: "100%", padding: "9px 8px", border: `1px solid ${T.border}`, borderRadius: 9, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" };
  const label = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 };

  return (
    <Modal title={invoice ? `Edit ${inv.number}` : "New Invoice"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 2 }}>
            <label style={label}>Client</label>
            <select value={inv.clientId ?? ""} onChange={e => set("clientId", Number(e.target.value))} style={{ ...field, appearance: "none", WebkitAppearance: "none" }}>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>Invoice #</label>
            <input type="text" style={field} value={inv.number} onChange={e => set("number", e.target.value)} />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}><label style={label}>Issued</label><input type="date" style={field} value={toISO(inv.date)} onChange={e => set("date", fromISO(e.target.value))} /></div>
          <div style={{ flex: 1 }}><label style={label}>Due</label><input type="date" style={field} value={toISO(inv.dueDate)} onChange={e => set("dueDate", fromISO(e.target.value))} /></div>
        </div>

        <div>
          <label style={label}>Status</label>
          <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 12, padding: 4, gap: 4 }}>
            {["Draft", "Sent", "Paid"].map(s => (
              <button key={s} onClick={() => set("status", s)} style={{ flex: 1, padding: "9px 6px", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, background: inv.status === s ? T.surface : "transparent", color: inv.status === s ? invStatusColor(s, T) : T.textMuted, boxShadow: inv.status === s ? T.shadow : "none" }}>{s}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ ...label, marginBottom: 0 }}>Line Items</label>
            {completedHistory.length > 0 && <button onClick={() => setVisitPick(v => !v)} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>＋ From a visit</button>}
          </div>
          {visitPick && (
            <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: 10, marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: T.textMuted, padding: "2px 4px" }}>Pull line items from a completed visit:</div>
              {completedHistory.slice(0, 8).map((h, i) => (
                <button key={i} onClick={() => importVisit(h)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 9, padding: "9px 11px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                  <span style={{ fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.date} · {(h.services || []).map(s => typeof s === "string" ? s : s.name).join(", ") || h.type}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: T.text, flexShrink: 0 }}>{h.invoice}</span>
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inv.lineItems.map(l => (
              <div key={l.id} style={{ background: T.surfaceAlt, borderRadius: 12, padding: 10 }}>
                <input style={{ ...field, marginBottom: 8 }} value={l.desc} onChange={e => setLine(l.id, "desc", e.target.value)} placeholder="Description" />
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ width: 50 }}>
                    <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 3 }}>Qty</div>
                    <input style={{ ...small, textAlign: "center" }} value={l.qty} onChange={e => setLine(l.id, "qty", e.target.value.replace(/[^\d.]/g, ""))} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 3 }}>Unit price</div>
                    <div style={{ position: "relative" }}>
                      <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
                      <input style={{ ...small, paddingLeft: 18, textAlign: "left" }} value={l.unitPrice} onChange={e => setLine(l.id, "unitPrice", e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" />
                    </div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 3 }}>Tax</div>
                    <div onClick={() => setLine(l.id, "taxable", !l.taxable)} title="Taxable" style={{ width: 32, height: 32, borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: l.taxable ? T.primary : T.surface, border: `1.5px solid ${l.taxable ? T.primary : T.border}`, color: "#fff", fontWeight: 800, fontSize: 13 }}>{l.taxable ? "✓" : ""}</div>
                  </div>
                  <button onClick={() => removeLine(l.id)} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 18, cursor: "pointer", padding: "4px 2px", height: 32 }}>×</button>
                </div>
              </div>
            ))}
          </div>
          <button onClick={addLine} style={{ marginTop: 8, width: "100%", padding: "10px", borderRadius: 10, border: `1.5px dashed ${T.border}`, background: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>+ Add line</button>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{ width: 120 }}>
            <label style={label}>Tax rate</label>
            <div style={{ position: "relative" }}>
              <input style={{ ...field, paddingRight: 24 }} value={inv.taxRate} onChange={e => set("taxRate", e.target.value.replace(/[^\d.]/g, ""))} />
              <span style={{ position: "absolute", right: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>%</span>
            </div>
          </div>
          <div style={{ flex: 1, background: T.surfaceAlt, borderRadius: 12, padding: "10px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted }}><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted, marginTop: 4 }}><span>Tax</span><span>{money(totals.tax)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, color: T.text, marginTop: 6, borderTop: `1px solid ${T.border}`, paddingTop: 6 }}><span>Total</span><span>{money(totals.total)}</span></div>
          </div>
        </div>

        <div>
          <label style={label}>Notes / Terms</label>
          <textarea rows={2} style={{ ...field, resize: "vertical" }} value={inv.notes} onChange={e => set("notes", e.target.value)} />
        </div>

        <Btn onClick={save} style={{ width: "100%", padding: "13px", borderRadius: 12 }}>{invoice ? "Save Invoice" : "Create Invoice"}</Btn>
        {invoice && onDelete && <button onClick={() => { onDelete(inv.id); onClose(); }} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete this invoice</button>}
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// QUICKBOOKS CONNECT
// ─────────────────────────────────────────────
function QBConnect({ onSyncData }) {
  const { T } = useApp();
  const [status, setStatus]   = useState("idle");
  const [result, setResult]   = useState(null);
  const [connected, setConnected] = useState(() => !!localStorage.getItem("qb_access_token"));

  // Check if we just returned from QB OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("qb") === "connected") {
      const accessToken  = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const realmId      = params.get("realmId");
      const expiresIn    = params.get("expires_in");
      if (accessToken && realmId) {
        localStorage.setItem("qb_access_token",  accessToken);
        localStorage.setItem("qb_refresh_token", refreshToken);
        localStorage.setItem("qb_realm_id",      realmId);
        localStorage.setItem("qb_expires_at",    String(Date.now() + Number(expiresIn) * 1000));
        setConnected(true);
      }
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("qb") === "error") {
      setStatus("error");
      setResult({ error: "QuickBooks authorization failed. Please try again." });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleConnect = () => {
    window.location.href = "/api/quickbooks/auth";
  };

  const handleDisconnect = () => {
    localStorage.removeItem("qb_access_token");
    localStorage.removeItem("qb_refresh_token");
    localStorage.removeItem("qb_realm_id");
    localStorage.removeItem("qb_expires_at");
    setConnected(false);
    setStatus("idle");
    setResult(null);
  };

  const handleSync = async () => {
    setStatus("syncing");
    setResult(null);
    const accessToken = localStorage.getItem("qb_access_token");
    const realmId     = localStorage.getItem("qb_realm_id");
    if (!accessToken || !realmId) {
      setStatus("error");
      setResult({ error: "Not connected. Please connect QuickBooks first." });
      setConnected(false);
      return;
    }
    try {
      const url = `/api/quickbooks/sync?access_token=${encodeURIComponent(accessToken)}&realm_id=${encodeURIComponent(realmId)}`;
      const res = await fetch(url);
      if (res.status === 401) {
        setStatus("error");
        setResult({ error: "Session expired. Please reconnect." });
        handleDisconnect();
        return;
      }
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // ── Save invoices into the app ──
      if (onSyncData && data.invoices) {
        onSyncData(data.invoices, data.customers);
      }

      setResult(data);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setResult({ error: err.message });
    }
  };

  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
        Connect your QuickBooks Online account to sync invoices and client records. Invoice history will appear on each client's record.
      </div>

      {!connected ? (
        <button onClick={handleConnect}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#2CA01C", color: "#fff", border: "none", borderRadius: 14, padding: "14px 20px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 16px rgba(44,160,28,0.3)" }}>
          <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
          Connect QuickBooks
        </button>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: hexA("#16a34a", 0.08), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 12, padding: "10px 14px" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#16a34a", flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#16a34a" }}>Connected to QuickBooks</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSync} disabled={status === "syncing"}
              style={{ flex: 1, background: status === "syncing" ? T.surfaceAlt : T.primary, color: status === "syncing" ? T.textMuted : "#fff", border: "none", borderRadius: 12, padding: "12px 18px", fontWeight: 700, fontSize: 14, cursor: status === "syncing" ? "default" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              {status === "syncing" ? (
                <><div style={{ width: 16, height: 16, border: `2px solid ${T.textMuted}`, borderTopColor: T.primary, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Syncing…</>
              ) : "Sync Now"}
            </button>
            <button onClick={handleDisconnect}
              style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 12, padding: "12px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {status === "done" && result && (
        <div style={{ background: hexA("#16a34a", 0.06), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 14, padding: "14px 16px" }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 6 }}>Sync complete</div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
            {result.invoices?.length || 0} invoices · {result.customers?.length || 0} customers imported from QuickBooks.
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>
            Go to a client record to see their invoice history, or the Invoices tab to see all.
          </div>
        </div>
      )}

      {status === "error" && (
        <div style={{ background: hexA("#E5484D", 0.06), border: `1px solid ${hexA("#E5484D", 0.2)}`, borderRadius: 14, padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#E5484D" }}>
            {result?.error || "Something went wrong. Try reconnecting."}
          </div>
          <button onClick={handleConnect} style={{ marginTop: 10, background: "none", border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 14px", fontSize: 12, fontWeight: 700, color: T.text, cursor: "pointer", fontFamily: "inherit" }}>
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}

function InvoiceSettings({ invoicing, setInvoicing, branding, setBranding, onSyncData }) {
  const { T } = useApp();
  const cfg = { ...DEFAULT_INVOICING, ...(invoicing || {}) };
  const set = (k, v) => setInvoicing({ ...cfg, [k]: v });
  const setB = (k, v) => setBranding(b => ({ ...b, [k]: v }));
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 };
  const field = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const accent = cfg.accent || T.primary;
  const row = (label, help, on, onChange) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <div><div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>{help && <div style={{ fontSize: 12, color: T.textMuted }}>{help}</div>}</div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Invoice Defaults" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>Number Prefix</label><input type="text" style={field} value={cfg.numberPrefix} onChange={e => set("numberPrefix", e.target.value)} placeholder="INV-" /></div>
            <div style={{ width: 110 }}><label style={labelStyle}>Next #</label><input type="text" inputMode="numeric" style={field} value={cfg.nextNumber} onChange={e => set("nextNumber", e.target.value.replace(/[^\d]/g, ""))} /></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>Default Tax Rate (%)</label><input type="text" inputMode="decimal" style={field} value={cfg.taxRate} onChange={e => set("taxRate", e.target.value.replace(/[^\d.]/g, ""))} /></div>
            <div style={{ flex: 1 }}><label style={labelStyle}>Due In (days)</label><input type="text" inputMode="numeric" style={field} value={cfg.dueDays} onChange={e => set("dueDays", e.target.value.replace(/[^\d]/g, ""))} /></div>
          </div>
          <div><label style={labelStyle}>Default Terms / Notes</label><textarea style={{ ...field, resize: "vertical" }} rows={2} value={cfg.terms} onChange={e => set("terms", e.target.value)} /></div>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="What Shows on Invoices" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          {row("Company Logo", "Show your logo in the header", cfg.showLogo !== false, v => set("showLogo", v))}
          {row("Contact Block", "Show phone, email, website, address", cfg.showContact !== false, v => set("showContact", v))}
          <div style={{ fontSize: 11.5, color: T.textMuted, borderTop: `1px solid ${T.border}`, paddingTop: 12, lineHeight: 1.5 }}>Your contact details and logo are set in the Messaging and Branding tabs and flow onto every invoice automatically.</div>
          <div><label style={labelStyle}>Invoice Footer <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(small print)</span></label><input style={field} value={cfg.footer || ""} onChange={e => set("footer", e.target.value)} placeholder="Make checks payable to Stone Property Solutions" /></div>
        </div>
      </Card>

      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Accent Color" />
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <label style={{ width: 48, height: 48, borderRadius: 12, background: accent, border: `1px solid ${T.border}`, cursor: "pointer", flexShrink: 0, position: "relative", overflow: "hidden" }}>
              <input type="color" value={/^#([0-9a-f]{6})$/i.test(accent) ? accent : "#000000"} onChange={e => set("accent", e.target.value)} style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }} />
            </label>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Invoice highlight</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>Used for the INVOICE heading and totals.</div>
            </div>
            {cfg.accent ? <button onClick={() => set("accent", "")} style={{ background: T.surfaceAlt, border: "none", borderRadius: 9, padding: "8px 12px", fontSize: 12, fontWeight: 700, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Use theme</button> : null}
          </div>
        </div>
      </Card>

      {/* ── QUICKBOOKS ── */}
      <Card style={{ marginTop: 14 }}>
        <CardHeader title="QuickBooks" />
        <QBConnect onSyncData={onSyncData} />
      </Card>
    </>
  );
}

function InvoicePreview({ invoice, client, branding, invoicing, onSave, onClose, onEdit, onDelete, canManage }) {
  const { T } = useApp();
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const totals = invoiceTotals(invoice);
  const eff = effectiveStatus(invoice);
  const anyTaxable = (invoice.lineItems || []).some(l => l.taxable);
  const setStatus = (status) => { const upd = { ...invoice, status }; if (status === "Paid") upd.paidDate = todayMDY(); onSave(upd); };
  const print = () => { try { window.print(); } catch (e) {} };
  const cfg = { ...DEFAULT_INVOICING, ...(invoicing || {}) };
  const accent = cfg.accent || T.primary;
  const contactBits = [branding.companyPhone, branding.companyEmail, branding.companyWebsite].filter(Boolean);

  return (
    <Modal title={invoice.number} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, overflow: "hidden" }}>
          <div style={{ padding: "18px 18px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
              {cfg.showLogo !== false && <div style={{ width: 42, height: 42, borderRadius: 12, background: hexA(accent, 0.12), display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
                {branding.logoType === "image" && branding.logoImage ? <img src={branding.logoImage} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 22 }}>{branding.logoEmoji}</span>}
              </div>}
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{branding.companyName}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{branding.division}</div>
                {cfg.showContact !== false && contactBits.length > 0 && <div style={{ fontSize: 10.5, color: T.textMuted, marginTop: 3, lineHeight: 1.4 }}>{contactBits.join(" · ")}</div>}
                {cfg.showContact !== false && branding.companyAddress && <div style={{ fontSize: 10.5, color: T.textMuted, lineHeight: 1.4 }}>{branding.companyAddress}</div>}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: accent, letterSpacing: "-0.02em" }}>INVOICE</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{invoice.number}</div>
              <span style={{ display: "inline-block", marginTop: 6, background: hexA(invStatusColor(eff, T), 0.14), color: invStatusColor(eff, T), padding: "3px 10px", borderRadius: 100, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{eff}</span>
            </div>
          </div>
          <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", gap: 12, borderBottom: `1px solid ${T.border}` }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 4 }}>Bill To</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{invoice.clientName || client?.name}</div>
              {(invoice.clientAddress || client?.address) && <div style={{ fontSize: 12, color: T.textMuted }}>{invoice.clientAddress || client?.address}</div>}
              {(invoice.clientEmail || client?.email) && <div style={{ fontSize: 12, color: T.textMuted }}>{invoice.clientEmail || client?.email}</div>}
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: T.textMuted }}>
              <div>Issued: <span style={{ color: T.text, fontWeight: 600 }}>{invoice.date}</span></div>
              <div style={{ marginTop: 3 }}>Due: <span style={{ color: T.text, fontWeight: 600 }}>{invoice.dueDate}</span></div>
            </div>
          </div>
          <div style={{ padding: "4px 18px" }}>
            {(invoice.lineItems || []).map(l => {
              const amt = (parseFloat(l.qty) || 0) * (parseFloat(l.unitPrice) || 0);
              return (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ flex: 1, paddingRight: 10 }}>
                    <div style={{ fontSize: 13, color: T.text }}>{l.desc || "—"}{l.taxable && <span style={{ color: T.textMuted }}> *</span>}</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>{l.qty} × {money(parseFloat(l.unitPrice) || 0)}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{money(amt)}</div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "10px 18px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted }}><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted, marginTop: 4 }}><span>Tax ({invoice.taxRate || 0}%{totals.taxableBase > 0 ? " on taxable" : ""})</span><span>{money(totals.tax)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800, color: accent, marginTop: 8, borderTop: `2px solid ${T.border}`, paddingTop: 8 }}><span>Total Due</span><span>{money(totals.total)}</span></div>
            {anyTaxable && <div style={{ fontSize: 10, color: T.textMuted, marginTop: 6 }}>* taxable item</div>}
          </div>
          {invoice.notes && <div style={{ padding: "0 18px 14px", fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>{invoice.notes}</div>}
          {cfg.footer && <div style={{ padding: "0 18px 16px", fontSize: 11, color: T.textMuted, lineHeight: 1.5, borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: invoice.notes ? 0 : 2 }}>{cfg.footer}</div>}
        </div>

        {/* QB Payment link */}
        {invoice.paymentLink && eff !== "Paid" && (
          <a href={invoice.paymentLink} target="_blank" rel="noopener noreferrer"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#2CA01C", color: "#fff", borderRadius: 14, padding: "14px 20px", fontWeight: 800, fontSize: 15, textDecoration: "none", boxShadow: "0 4px 16px rgba(44,160,28,0.3)" }}>
            <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
            Pay via QuickBooks
          </a>
        )}
        {canManage && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {eff !== "Paid" && <Btn variant="accent" onClick={() => setStatus("Paid")} style={{ flex: 1, minWidth: 120, borderRadius: 12 }}>Mark Paid</Btn>}
            {invoice.status === "Draft" && <Btn variant="ghost" onClick={() => setStatus("Sent")} style={{ flex: 1, minWidth: 120, borderRadius: 12 }}>Mark Sent</Btn>}
            {eff === "Paid" && <Btn variant="ghost" onClick={() => setStatus("Sent")} style={{ flex: 1, minWidth: 120, borderRadius: 12 }}>Reopen</Btn>}
            <Btn variant="ghost" onClick={() => onEdit(invoice)} style={{ borderRadius: 12 }}>Edit</Btn>
            <Btn variant="ghost" onClick={print} style={{ borderRadius: 12 }}>Print</Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// ESTIMATE BUILDER
// ─────────────────────────────────────────────

function EstimatesScreen({ clients, catalog, branding, email, invoicing, T, estimates: estimatesProp, setEstimates: setEstimatesProp }) {
  const [estimatesLocal, setEstimatesLocal] = useStoredState("sps_estimates", []);
  const estimates = estimatesProp !== undefined ? estimatesProp : estimatesLocal;
  const setEstimates = setEstimatesProp || setEstimatesLocal;
  const [view, setView] = useState("list"); // list | new | detail
  const [selected, setSelected] = useState(null);

  const saveEstimate = (est) => {
    setEstimates(prev => {
      const exists = (prev||[]).some(e => e.id === est.id);
      return exists ? prev.map(e => e.id === est.id ? est : e) : [est, ...(prev||[])];
    });
    setView("list");
  };

  const deleteEstimate = (id) => {
    setEstimates(prev => (prev||[]).filter(e => e.id !== id));
    setView("list");
  };

  if (view === "new" || (view === "detail" && selected)) {
    return (
      <EstimateForm
        estimate={view === "detail" ? selected : null}
        clients={clients}
        catalog={catalog}
        branding={branding}
        email={email}
        invoicing={invoicing}
        T={T}
        onSave={saveEstimate}
        onDelete={deleteEstimate}
        onBack={() => { setView("list"); setSelected(null); }}
      />
    );
  }

  const est = estimates || [];
  const open   = est.filter(e => e.status === "draft" || e.status === "sent");
  const closed = est.filter(e => e.status === "approved" || e.status === "declined");

  const statusColor = (s) => ({
    draft: T.textMuted, sent: T.primary, approved: T.accent, declined: T.warning
  }[s] || T.textMuted);

  const statusLabel = (s) => ({ draft: "Draft", sent: "Sent", approved: "Approved", declined: "Declined" }[s] || s);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Estimates</div>
        <Btn onClick={() => setView("new")} sm style={{ gap: 5 }}><Icon name="plus" size={13} /> New</Btn>
      </div>

      {est.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ width: 60, height: 60, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}><Icon name="invoice" size={28} /></div>
          <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 6 }}>No estimates yet</div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 20 }}>Build and send professional estimates to clients.</div>
          <Btn onClick={() => setView("new")} style={{ gap: 6 }}><Icon name="plus" size={14} /> Create First Estimate</Btn>
        </div>
      )}

      {open.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>Active</div>
          <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            {open.map((e, i) => (
              <button key={e.id} onClick={() => { setSelected(e); setView("detail"); }}
                style={{ width: "100%", padding: "15px 18px", background: "none", border: "none", borderBottom: i < open.length-1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{e.clientName || "No client"}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{e.title || "Estimate"} · {fmtDate(e.date)}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{e.total || "$0.00"}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: statusColor(e.status), textTransform: "uppercase", marginTop: 2 }}>{statusLabel(e.status)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {closed.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>Closed</div>
          <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden", opacity: 0.7 }}>
            {closed.map((e, i) => (
              <button key={e.id} onClick={() => { setSelected(e); setView("detail"); }}
                style={{ width: "100%", padding: "15px 18px", background: "none", border: "none", borderBottom: i < closed.length-1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{e.clientName || "No client"}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{e.title || "Estimate"} · {fmtDate(e.date)}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{e.total || "$0.00"}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: statusColor(e.status), textTransform: "uppercase", marginTop: 2 }}>{statusLabel(e.status)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EstimateForm({ estimate, clients, catalog, branding, email, invoicing, T, onSave, onDelete, onBack }) {
  const isNew = !estimate;
  const [form, setForm] = useState(() => estimate || {
    id: Date.now(),
    clientId: "",
    clientName: "",
    title: "",
    date: new Date().toISOString().split("T")[0],
    validDays: 30,
    status: "draft",
    items: [{ id: Date.now(), desc: "", qty: 1, price: "" }],
    notes: "",
    total: "$0.00",
  });
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState("");

  const set = (k, v) => setForm(f => {
    const next = { ...f, [k]: v };
    // recalculate total when items change
    if (k === "items") {
      const t = v.reduce((s, item) => s + (parseFloat(item.price||0) * (parseInt(item.qty)||1)), 0);
      next.total = `$${t.toFixed(2)}`;
    }
    return next;
  });

  const setItem = (idx, key, val) => {
    const items = form.items.map((it, i) => i === idx ? { ...it, [key]: val } : it);
    set("items", items);
  };
  const addItem = () => set("items", [...form.items, { id: Date.now(), desc: "", qty: 1, price: "" }]);
  const removeItem = (idx) => set("items", form.items.filter((_, i) => i !== idx));

  const selectClient = (id) => {
    const c = (clients||[]).find(c => String(c.id) === String(id));
    setForm(f => ({ ...f, clientId: id, clientName: c?.name || "" }));
  };

  // Build the estimate text for SMS
  const buildSmsText = () => {
    const lines = [
      `Estimate from ${branding.companyName}`,
      form.title ? `Service: ${form.title}` : "",
      "",
      ...form.items.filter(it => it.desc).map(it => `• ${it.desc}: $${(parseFloat(it.price||0)*(parseInt(it.qty)||1)).toFixed(2)}`),
      "",
      `Total: ${form.total}`,
      form.notes ? `Notes: ${form.notes}` : "",
      `Valid for ${form.validDays} days.`,
      "",
      `To approve, reply YES. Questions? Call ${branding.companyPhone || "us"}.`,
    ].filter(l => l !== null);
    return lines.join("\n");
  };

  const sendViaSms = () => {
    const client = (clients||[]).find(c => String(c.id) === String(form.clientId));
    const phone = (client?.phone||"").replace(/\D/g,"");
    if (!phone) { setSentMsg("No phone number on file for this client."); return; }
    const smsUrl = `sms:${phone}${/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(buildSmsText())}`;
    window.open(smsUrl, "_blank");
    set("status", "sent");
    setSentMsg("Opened in Messages. Mark as sent when you've sent it.");
  };

  const sendViaEmail = () => {
    const client = (clients||[]).find(c => String(c.id) === String(form.clientId));
    const em = client?.email || "";
    if (!em) { setSentMsg("No email on file for this client."); return; }
    const subject = encodeURIComponent(`Estimate from ${branding.companyName}`);
    const body = encodeURIComponent(buildSmsText());
    window.open(`mailto:${em}?subject=${subject}&body=${body}`, "_blank");
    set("status", "sent");
    setSentMsg("Opened in Mail. Save after sending.");
  };

  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box", outline: "none", color: T.text, background: T.surface };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
          <Icon name="back" size={14} /> Back
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          {!isNew && <Btn variant="danger" sm onClick={() => onDelete(form.id)}>Delete</Btn>}
          <Btn sm onClick={() => onSave(form)}>Save</Btn>
        </div>
      </div>

      {/* Client + title */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 6 }}>Client</label>
          <select value={form.clientId} onChange={e => selectClient(e.target.value)} style={field}>
            <option value="">Select a client...</option>
            {(clients||[]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 6 }}>Estimate Title</label>
          <input type="text" style={field} value={form.title} onChange={e => set("title", e.target.value)} placeholder="e.g. Spring Pond Opening, New Installation..." />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 6 }}>Date</label>
            <input type="date" style={field} value={form.date} onChange={e => set("date", e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 6 }}>Valid (days)</label>
            <input type="number" style={field} value={form.validDays} onChange={e => set("validDays", e.target.value)} min={1} />
          </div>
        </div>
      </div>

      {/* Line items */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Line Items</div>
          <button onClick={addItem} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
            <Icon name="plus" size={14} /> Add
          </button>
        </div>
        {form.items.map((item, idx) => (
          <div key={item.id} style={{ padding: "14px 18px", borderBottom: idx < form.items.length-1 ? `1px solid ${T.border}` : "none", display: "flex", flexDirection: "column", gap: 8 }}>
            <input style={field} value={item.desc} onChange={e => setItem(idx, "desc", e.target.value)} placeholder="Description of service or item..." />
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <input type="number" style={field} value={item.qty} onChange={e => setItem(idx, "qty", e.target.value)} placeholder="Qty" min={1} />
              </div>
              <div style={{ flex: 2 }}>
                <input type="number" style={{ ...field, paddingLeft: 28, backgroundImage: "none" }} value={item.price} onChange={e => setItem(idx, "price", e.target.value)} placeholder="0.00" step="0.01" />
              </div>
              {form.items.length > 1 && (
                <button onClick={() => removeItem(idx)} style={{ background: "none", border: "none", color: T.warning, cursor: "pointer", padding: "0 4px", display: "flex", alignItems: "center" }}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, textAlign: "right" }}>
              Subtotal: <strong>${(parseFloat(item.price||0) * (parseInt(item.qty)||1)).toFixed(2)}</strong>
            </div>
          </div>
        ))}
        <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", background: T.surfaceAlt }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Total</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{form.total}</div>
        </div>
      </div>

      {/* Notes */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 18px" }}>
        <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 8 }}>Notes (optional)</label>
        <textarea style={{ ...field, minHeight: 80, resize: "vertical", lineHeight: 1.5 }} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Scope of work, terms, or any extra detail..." />
      </div>

      {/* Status */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 18px" }}>
        <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 10 }}>Status</label>
        <div style={{ display: "flex", gap: 8 }}>
          {["draft","sent","approved","declined"].map(s => (
            <button key={s} onClick={() => set("status", s)} style={{ flex: 1, padding: "9px 4px", border: `1.5px solid ${form.status === s ? T.primary : T.border}`, borderRadius: 11, background: form.status === s ? hexA(T.primary, 0.1) : T.surface, color: form.status === s ? T.primary : T.textMuted, fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Send options */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 2 }}>Send to Client</div>
        <Btn onClick={sendViaSms} variant="outline" block style={{ gap: 7 }}>
          <Icon name="message" size={15} /> Send via Text Message
        </Btn>
        <Btn onClick={sendViaEmail} variant="ghost" block style={{ gap: 7 }}>
          <Icon name="mail" size={15} /> Send via Email
        </Btn>
        <Btn onClick={() => { onSave(form); generateEstimatePDF(form, branding, invoicing); }} variant="ghost" block style={{ gap: 7 }}>
          <Icon name="download" size={15} /> Download PDF
        </Btn>
        {sentMsg && <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", lineHeight: 1.5 }}>{sentMsg}</div>}
      </div>

      <Btn onClick={() => onSave(form)} block>Save Estimate</Btn>
    </div>
  );
}

// ─────────────────────────────────────────────
// TOTAL SALES SCREEN
// Full historical sales view with year/month breakdown
// ─────────────────────────────────────────────
function TotalSalesScreen({ invoices, clients, onBack, T }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [view, setView] = useState("monthly"); // monthly | clients | all

  const parseAnyDate = (s) => {
    if (!s) return null;
    if (typeof s === "string" && s.includes("/")) return parseMDY(s);
    if (typeof s === "string" && s.includes("-")) { const d = new Date(s + "T00:00:00"); return isNaN(d.getTime()) ? null : d; }
    return null;
  };

  const paid = (invoices || []).filter(iv => effectiveStatus(iv) === "Paid" || iv.status === "Paid");
  const all  = (invoices || []).filter(iv => iv.status !== "Draft");

  // Get available years from invoice data
  const years = [...new Set(all.map(iv => {
    const d = parseAnyDate(iv.date) || parseAnyDate(iv.paidDate);
    return d ? d.getFullYear() : null;
  }).filter(Boolean))].sort((a,b) => b - a);

  const money = (n) => "$" + parseFloat(n||0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyShort = (n) => n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${Math.round(n)}`;

  // All-time totals
  const totalRevenue  = paid.reduce((s,iv) => s + invoiceTotals(iv).total, 0);
  const totalInvoices = all.length;
  const totalPaid     = paid.length;
  const totalOutstanding = all.filter(iv => effectiveStatus(iv) !== "Paid" && iv.status !== "Draft").reduce((s,iv) => s + invoiceTotals(iv).total, 0);

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Monthly breakdown for selected year
  const monthlyData = MONTHS.map((label, mi) => {
    const monthPaid = paid.filter(iv => {
      const d = parseAnyDate(iv.paidDate || iv.date);
      return d && d.getMonth() === mi && d.getFullYear() === year;
    });
    const monthAll = all.filter(iv => {
      const d = parseAnyDate(iv.date);
      return d && d.getMonth() === mi && d.getFullYear() === year;
    });
    const rev = monthPaid.reduce((s,iv) => s + invoiceTotals(iv).total, 0);
    return { label, month: mi, revenue: rev, invoiced: monthAll.length, paid: monthPaid.length };
  });

  const yearTotal = monthlyData.reduce((s,m) => s + m.revenue, 0);
  const maxMonth  = Math.max(...monthlyData.map(m => m.revenue), 1);

  // Top clients by revenue (all time)
  const clientTotals = {};
  paid.forEach(iv => {
    const name = (clients.find(c => invoiceMatchesClient(iv, c)))?.name || iv.clientName || "Unknown";
    clientTotals[name] = (clientTotals[name] || 0) + invoiceTotals(iv).total;
  });
  const topClients = Object.entries(clientTotals).sort((a,b) => b[1]-a[1]).slice(0, 15);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4, fontFamily: "inherit" }}>
          ← Back
        </button>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Total Sales</h2>
      </div>

      {/* All-time summary tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[
          { label: "All-Time Revenue", value: money(totalRevenue), color: T.accent },
          { label: "Outstanding",      value: money(totalOutstanding), color: totalOutstanding > 0 ? T.warning : T.accent },
          { label: "Total Invoices",   value: totalInvoices, color: T.primary },
          { label: "Paid Invoices",    value: totalPaid, color: T.accent },
        ].map(t => (
          <div key={t.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "14px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 6 }}>{t.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: t.color, letterSpacing: "-0.02em" }}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div style={{ display: "flex", gap: 6, background: T.surfaceAlt, borderRadius: 14, padding: 4 }}>
        {[["monthly","By Month"],["clients","By Client"]].map(([val,lbl]) => (
          <button key={val} onClick={() => setView(val)}
            style={{ flex: 1, padding: "9px 8px", border: "none", borderRadius: 11, background: view === val ? T.surface : "transparent", color: view === val ? T.primary : T.textMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", boxShadow: view === val ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
            {lbl}
          </button>
        ))}
      </div>

      {/* Monthly view */}
      {view === "monthly" && (
        <div>
          {/* Year selector */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>{year} — {money(yearTotal)}</div>
            <div style={{ display: "flex", gap: 6 }}>
              {years.map(y => (
                <button key={y} onClick={() => setYear(y)}
                  style={{ padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${year === y ? T.primary : T.border}`, background: year === y ? hexA(T.primary, 0.08) : T.surface, color: year === y ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {y}
                </button>
              ))}
            </div>
          </div>

          {/* Bar chart */}
          <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 16px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120, marginBottom: 8 }}>
              {monthlyData.map((m, i) => {
                const h = maxMonth > 0 ? Math.max((m.revenue / maxMonth) * 100, m.revenue > 0 ? 4 : 0) : 0;
                const isNow = i === new Date().getMonth() && year === new Date().getFullYear();
                return (
                  <div key={m.label} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    {m.revenue > 0 && <div style={{ fontSize: 8, color: T.textMuted, fontWeight: 600 }}>{moneyShort(m.revenue)}</div>}
                    <div style={{ width: "100%", height: `${h}%`, minHeight: m.revenue > 0 ? 4 : 0, background: isNow ? T.primary : hexA(T.primary, 0.5), borderRadius: "4px 4px 0 0", transition: "height 0.3s ease" }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {monthlyData.map(m => (
                <div key={m.label} style={{ flex: 1, textAlign: "center", fontSize: 9, color: T.textMuted, fontWeight: 600 }}>{m.label}</div>
              ))}
            </div>
          </div>

          {/* Monthly rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            {monthlyData.filter(m => m.revenue > 0 || m.invoiced > 0).reverse().map(m => (
              <div key={m.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "13px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{m.label} {year}</div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{m.invoiced} invoiced · {m.paid} paid</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: T.accent }}>{money(m.revenue)}</div>
              </div>
            ))}
            {monthlyData.every(m => m.revenue === 0) && (
              <div style={{ textAlign: "center", padding: "32px 20px", color: T.textMuted, fontSize: 13 }}>No paid invoices recorded for {year}.</div>
            )}
          </div>
        </div>
      )}

      {/* By Client view */}
      {view === "clients" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {topClients.map(([name, rev], i) => (
            <div key={name} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: "13px 16px", display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: T.primary, flexShrink: 0 }}>{i+1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  {paid.filter(iv => (clients.find(c => invoiceMatchesClient(iv,c)))?.name === name || iv.clientName === name).length} invoices
                </div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, color: T.accent }}>{money(rev)}</div>
            </div>
          ))}
          {topClients.length === 0 && <div style={{ textAlign: "center", padding: "32px 20px", color: T.textMuted, fontSize: 13 }}>No paid invoices yet.</div>}
        </div>
      )}
    </div>
  );
}

function InvoicesScreen({ invoices, clients, invoicing, branding, onSave, onDelete, initialFilter = "All" }) {
  const { T, perms } = useApp();
  const moneyFmt = (n) => `$${Math.round(n).toLocaleString()}`;
  const moneyExact = (n) => `$${parseFloat(n||0).toFixed(2)}`;

  // ── Filter / sort state ──
  const [filter,     setFilter]     = useState(initialFilter);
  const [search,     setSearch]     = useState("");
  const [sortBy,     setSortBy]     = useState("number_desc"); // number_desc | number_asc | date_desc | date_asc | amount_desc | amount_asc | client_asc
  const [clientFilter, setClientFilter] = useState("all");     // "all" or client id
  const [dateRange,  setDateRange]  = useState("all");         // all | this_month | last_month | this_year | custom
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [groupBy,    setGroupBy]    = useState("none");        // none | client | status | month

  // ── Editor state ──
  const [creating,   setCreating]   = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [preview,    setPreview]    = useState(null);
  const [showSales,  setShowSales]  = useState(false);

  const now = new Date();

  // Parse date in either MM/DD/YYYY or YYYY-MM-DD (QB) format
  const parseAnyDate = (s) => {
    if (!s) return null;
    if (typeof s === "string" && s.includes("/")) return parseMDY(s);
    if (typeof s === "string" && s.includes("-")) { const d = new Date(s + "T00:00:00"); return isNaN(d.getTime()) ? null : d; }
    return null;
  };

  // Enrich with client data
  const all = (invoices || []).map(iv => ({
    ...iv,
    _client: clients.find(c => invoiceMatchesClient(iv, c)),
    _total:  invoiceTotals(iv).total,
    _status: effectiveStatus(iv),
    _date:   parseAnyDate(iv.date) || parseAnyDate(iv.paidDate) || new Date(iv.createdAt || 0),
    _num:    parseInt((String(iv.number || "0")).replace(/[^0-9]/g, "")) || 0,
  }));

  // ── Summary stats ──
  const outstanding   = all.filter(iv => iv._status !== "Paid" && iv.status !== "Draft").reduce((s, iv) => s + iv._total, 0);
  const paidThisMonth = all.filter(iv => iv._status === "Paid").filter(iv => { const d = iv._date; return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, iv) => s + iv._total, 0);
  const overdueCount  = all.filter(iv => iv._status === "Overdue").length;
  const totalAll      = all.filter(iv => iv.status !== "Draft").reduce((s, iv) => s + iv._total, 0);

  // ── Date range helper ──
  const inDateRange = (iv) => {
    if (dateRange === "all") return true;
    const d = iv._date;
    if (!d) return true;
    if (dateRange === "this_month")  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (dateRange === "last_month")  { const lm = new Date(now.getFullYear(), now.getMonth()-1, 1); return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear(); }
    if (dateRange === "this_year")   return d.getFullYear() === now.getFullYear();
    if (dateRange === "custom") {
      const from = dateFrom ? new Date(dateFrom) : null;
      const to   = dateTo   ? new Date(dateTo)   : null;
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    }
    return true;
  };

  // ── Apply all filters ──
  const q = search.toLowerCase();
  const filtered = all.filter(iv => {
    if (filter !== "All" && iv._status !== filter) return false;
    if (clientFilter !== "all" && String(iv.clientId) !== String(clientFilter) && String(iv._client?.id) !== String(clientFilter)) return false;
    if (!inDateRange(iv)) return false;
    if (q && !`${iv.number} ${iv._client?.name || iv.clientName || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  // ── Sort ──
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "number_desc")  return b._num - a._num;
    if (sortBy === "number_asc")   return a._num - b._num;
    if (sortBy === "date_desc")    return (b._date||0) - (a._date||0);
    if (sortBy === "date_asc")     return (a._date||0) - (b._date||0);
    if (sortBy === "amount_desc")  return b._total - a._total;
    if (sortBy === "amount_asc")   return a._total - b._total;
    if (sortBy === "client_asc")   return (a._client?.name||a.clientName||"").localeCompare(b._client?.name||b.clientName||"");
    return b._num - a._num;
  });

  // ── Group ──
  const grouped = (() => {
    if (groupBy === "none") return [{ label: null, items: sorted }];
    const groups = {};
    sorted.forEach(iv => {
      let key = "Other";
      if (groupBy === "client")  key = iv._client?.name || iv.clientName || "Unknown Client";
      if (groupBy === "status")  key = iv._status || iv.status || "Unknown";
      if (groupBy === "month") {
        const d = iv._date;
        key = d ? d.toLocaleString("default", { month: "long", year: "numeric" }) : "Unknown";
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(iv);
    });
    return Object.entries(groups).map(([label, items]) => ({ label, items }));
  })();

  const livePreview = preview ? ((invoices||[]).find(x => x.id === preview.id) || preview) : null;
  const activeFilterCount = [filter !== "All", clientFilter !== "all", dateRange !== "all", groupBy !== "none"].filter(Boolean).length;

  if (showSales) return <TotalSalesScreen invoices={invoices} clients={clients} onBack={() => setShowSales(false)} T={T} />;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.03em" }}>Invoices</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowFilters(f => !f)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 12, border: `1.5px solid ${activeFilterCount > 0 ? T.primary : T.border}`, background: activeFilterCount > 0 ? hexA(T.primary, 0.08) : T.surface, color: activeFilterCount > 0 ? T.primary : T.textMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M3 6h18M7 12h10M11 18h2"/></svg>
            Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          {perms.canInvoice && <Btn sm onClick={() => setCreating(true)}>+ New</Btn>}
        </div>
      </div>

      {/* Summary tiles — tap to see Total Sales */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div onClick={() => setShowSales(true)} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "14px 16px", cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.08)"}
          onMouseLeave={e => e.currentTarget.style.boxShadow="none"}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 6, display:"flex", justifyContent:"space-between" }}>
            Outstanding
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" style={{opacity:0.5}}><path d="m9 18 6-6-6-6"/></svg>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: outstanding > 0 ? T.warning : T.accent, letterSpacing: "-0.02em" }}>{moneyFmt(outstanding)}</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>{all.filter(iv => iv._status !== "Paid" && iv.status !== "Draft").length} invoices · tap for sales</div>
        </div>
        <div onClick={() => setShowSales(true)} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "14px 16px", cursor: "pointer" }}
          onMouseEnter={e => e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,0.08)"}
          onMouseLeave={e => e.currentTarget.style.boxShadow="none"}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 6, display:"flex", justifyContent:"space-between" }}>
            Paid This Month
            <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" style={{opacity:0.5}}><path d="m9 18 6-6-6-6"/></svg>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: T.accent, letterSpacing: "-0.02em" }}>{moneyFmt(paidThisMonth)}</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>{overdueCount > 0 ? <span style={{ color: T.warning, fontWeight: 700 }}>{overdueCount} overdue</span> : "No overdue"}</div>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: T.textMuted, pointerEvents: "none" }}>
          <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input type="search" placeholder="Search by number or client…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: "11px 14px 11px 38px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
      </div>

      {/* Status filter pills */}
      <div style={{ display: "flex", gap: 7, marginBottom: showFilters ? 12 : 16, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
        {["All", ...INVOICE_STATUSES].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 100, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, background: filter === s ? T.primary : T.surfaceAlt, color: filter === s ? "#fff" : T.textMuted }}>{s}</button>
        ))}
      </div>

      {/* Expanded filter panel */}
      {showFilters && (
        <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "16px 16px", marginBottom: 16, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Sort */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Sort By</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[
                ["number_desc", "Invoice # ↓"],
                ["number_asc",  "Invoice # ↑"],
                ["date_desc",   "Newest First"],
                ["date_asc",    "Oldest First"],
                ["amount_desc", "Highest Amount"],
                ["amount_asc",  "Lowest Amount"],
                ["client_asc",  "Client A–Z"],
              ].map(([val, lbl]) => (
                <button key={val} onClick={() => setSortBy(val)}
                  style={{ padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${sortBy === val ? T.primary : T.border}`, background: sortBy === val ? hexA(T.primary, 0.08) : T.surface, color: sortBy === val ? T.primary : T.textMuted, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* Client filter */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Client</div>
            <select value={clientFilter} onChange={e => setClientFilter(e.target.value)}
              style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }}>
              <option value="all">All Clients</option>
              {[...clients].sort((a,b) => (a.name||"").localeCompare(b.name||"")).map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Date Range</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: dateRange === "custom" ? 10 : 0 }}>
              {[["all","All Time"],["this_month","This Month"],["last_month","Last Month"],["this_year","This Year"],["custom","Custom"]].map(([val,lbl]) => (
                <button key={val} onClick={() => setDateRange(val)}
                  style={{ padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${dateRange === val ? T.primary : T.border}`, background: dateRange === val ? hexA(T.primary, 0.08) : T.surface, color: dateRange === val ? T.primary : T.textMuted, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {lbl}
                </button>
              ))}
            </div>
            {dateRange === "custom" && (
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>From</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                    style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>To</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                    style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
                </div>
              </div>
            )}
          </div>

          {/* Group by */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Group By</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[["none","None"],["client","Client"],["status","Status"],["month","Month"]].map(([val,lbl]) => (
                <button key={val} onClick={() => setGroupBy(val)}
                  style={{ padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${groupBy === val ? T.primary : T.border}`, background: groupBy === val ? hexA(T.primary, 0.08) : T.surface, color: groupBy === val ? T.primary : T.textMuted, fontWeight: 600, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* Reset */}
          {activeFilterCount > 0 && (
            <button onClick={() => { setFilter("All"); setClientFilter("all"); setDateRange("all"); setGroupBy("none"); setSortBy("date_desc"); setDateFrom(""); setDateTo(""); }}
              style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0, alignSelf: "flex-start" }}>
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Results summary */}
      {sorted.length > 0 && (
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
          <span>{sorted.length} invoice{sorted.length !== 1 ? "s" : ""}</span>
          <span style={{ fontWeight: 700, color: T.text }}>{moneyExact(sorted.reduce((s,iv) => s + iv._total, 0))} total</span>
        </div>
      )}

      {/* Invoice list */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: T.textMuted }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}><Icon name="invoice" size={28} /></div>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.text, marginBottom: 6 }}>No invoices{filter !== "All" ? ` marked ${filter}` : ""}</div>
          {perms.canInvoice && filter === "All" && <><div style={{ fontSize: 13, marginBottom: 18 }}>Create one, or generate it from a completed visit.</div><Btn onClick={() => setCreating(true)}>+ New Invoice</Btn></>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: groupBy !== "none" ? 20 : 8 }}>
          {grouped.map(({ label, items }) => (
            <div key={label || "all"}>
              {label && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>{label}</div>
                  <div style={{ fontSize: 12, color: T.textMuted }}>{moneyExact(items.reduce((s,iv) => s + iv._total, 0))}</div>
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {items.map(iv => <InvoiceRow key={iv.id} iv={iv} onClick={() => setPreview(iv)} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && <InvoiceEditor clients={clients} invoices={invoices} invoicing={invoicing} onSave={onSave} onClose={() => setCreating(false)} />}
      {editing  && <InvoiceEditor invoice={editing} clients={clients} invoices={invoices} invoicing={invoicing} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {livePreview && <InvoicePreview invoice={livePreview} client={clients.find(c => invoiceMatchesClient(livePreview, c))} branding={branding} invoicing={invoicing} canManage={perms.canInvoice} onSave={onSave} onEdit={(iv) => { setPreview(null); setEditing(iv); }} onDelete={onDelete} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ClientInvoices({ client, invoices, invoicing, branding, onSave, onDelete }) {
  const { T, perms } = useApp();
  const list = sortInvoices(clientInvoicesOf(invoices, client.id, client)).map(iv => ({ ...iv, _client: client }));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const owed = clientOutstanding(client, invoices);
  const livePreview = preview ? ((invoices || []).find(x => x.id === preview.id) || preview) : null;

  const paid   = list.filter(iv => ["Paid","paid"].includes(effectiveStatus(iv)));
  const unpaid = list.filter(iv => !["Paid","paid"].includes(effectiveStatus(iv)) && iv.status !== "Draft");

  return (
    <Card>
      <CardHeader title={`Invoices (${list.length})`} action={perms.canInvoice ? <Btn sm onClick={() => setCreating(true)}>+ New</Btn> : null} />
      {list.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, borderBottom: `1px solid ${T.border}`, background: T.border }}>
          <div style={{ background: T.surfaceAlt, padding: "12px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 4 }}>Outstanding</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: owed > 0 ? T.warning : T.accent }}>${owed.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{unpaid.length} unpaid</div>
          </div>
          <div style={{ background: T.surfaceAlt, padding: "12px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 4 }}>Collected</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.accent }}>${paid.reduce((s,iv) => s + invoiceTotals(iv).total, 0).toFixed(2)}</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{paid.length} paid</div>
          </div>
        </div>
      )}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {list.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, padding: "6px 0" }}>No invoices yet for this client.</div>}
        {list.map(iv => <InvoiceRow key={iv.id} iv={iv} onClick={() => setPreview(iv)} />)}
      </div>
      {creating && <InvoiceEditor clients={[client]} presetClientId={client.id} invoices={invoices} invoicing={invoicing} onSave={onSave} onClose={() => setCreating(false)} />}
      {editing && <InvoiceEditor invoice={editing} clients={[client]} invoices={invoices} invoicing={invoicing} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {livePreview && <InvoicePreview invoice={livePreview} client={client} branding={branding} invoicing={invoicing} canManage={perms.canInvoice} onSave={onSave} onEdit={(iv) => { setPreview(null); setEditing(iv); }} onDelete={onDelete} onClose={() => setPreview(null)} />}
    </Card>
  );
}

// ─────────────────────────────────────────────
// SERVICE TIERS MANAGER
// Edit tier names, pricing, descriptions, and what's included.
// Bulk-update client pricing by tier.
// ─────────────────────────────────────────────
function ServiceTiersManager({ tiers, setTiers, clients, setClients, T }) {
  // Read from stored tiers so names/divisions are always in sync
  const DIVISIONS_LIST  = getDivisions(tiers);
  const TIER_KEYS       = getTierNames(tiers, DIVISIONS_LIST[0]);
  const [activeDivision, setActiveDivision] = useState(DIVISIONS_LIST[0] || "Pond");
  const [selected, setSelected] = useState(TIER_KEYS[1] || TIER_KEYS[0] || "Signature");
  // Renaming state
  const [renamingDiv,  setRenamingDiv]  = useState(false); // editing division name
  const [renamingTier, setRenamingTier] = useState(false); // editing tier names
  const [divNameDraft, setDivNameDraft] = useState("");
  const [tierNameDrafts, setTierNameDrafts] = useState([]);
  // Add division state
  const [addingDiv, setAddingDiv] = useState(false);
  const [newDivName, setNewDivName] = useState("");
  const [newDivLabel, setNewDivLabel] = useState("");
  const [editingInclude, setEditingInclude] = useState(null);
  const [newInclude, setNewInclude] = useState("");
  const [bulkPrices, setBulkPrices] = useState({});
  const [bulkPlans, setBulkPlans] = useState({});
  const [bulkSaved, setBulkSaved] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [tierSaved, setTierSaved] = useState(false);
  const [unsaved, setUnsaved] = useState(false);

  // Local draft — edits stay here until you hit Save
  const divTierData = (tiers || DEFAULT_TIERS)[activeDivision] || DEFAULT_TIERS[activeDivision] || DEFAULT_TIERS["Pond"];
  const liveTier = divTierData[selected] || DEFAULT_TIERS["Pond"]["Signature"];
  const [draft, setDraft] = useState(() => ({ ...liveTier }));

  // Switch tiers: load fresh draft
  const switchTier = (key) => {
    setSelected(key);
    const dt = (tiers || DEFAULT_TIERS)[activeDivision] || DEFAULT_TIERS[activeDivision] || DEFAULT_TIERS["Pond"];
    setDraft({ ...(dt[key] || DEFAULT_TIERS["Pond"][key] || {}) });
    setBulkPrices({}); setBulkPlans({}); setBulkSaved(false); setConfirmBulk(false);
    setUnsaved(false); setTierSaved(false); setEditingInclude(null); setNewInclude("");
  };

  const switchDivision = (div) => {
    setActiveDivision(div);
    const dt = (tiers || DEFAULT_TIERS)[div] || DEFAULT_TIERS[div] || DEFAULT_TIERS["Pond"];
    setDraft({ ...(dt[selected] || DEFAULT_TIERS["Pond"][selected] || {}) });
    setBulkPrices({}); setBulkPlans({}); setBulkSaved(false); setConfirmBulk(false);
    setUnsaved(false); setTierSaved(false); setEditingInclude(null); setNewInclude("");
  };

  // Keep draft in sync when tiers first load from Supabase
  useEffect(() => {
    const dt = (tiers || DEFAULT_TIERS)[activeDivision] || DEFAULT_TIERS[activeDivision] || DEFAULT_TIERS["Pond"];
    setDraft({ ...(dt[selected] || DEFAULT_TIERS["Pond"][selected] || {}) });
  }, [selected, activeDivision]);

  const tier = draft;
  const setDraftField = (k, v) => { setDraft(d => ({ ...d, [k]: v })); setUnsaved(true); };
  const setInclude = (i, v) => setDraftField("includes", draft.includes.map((item, j) => j === i ? v : item));
  const removeInclude = (i) => setDraftField("includes", draft.includes.filter((_, j) => j !== i));
  const addInclude = () => {
    if (!newInclude.trim()) return;
    setDraftField("includes", [...(draft.includes || []), newInclude.trim()]);
    setNewInclude("");
  };
  const moveInclude = (i, dir) => {
    const arr = [...draft.includes];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setDraftField("includes", arr);
  };

  // Save a renamed division
  const saveDivisionRename = (oldName, newName, newLabel) => {
    if (!newName.trim() || newName === oldName) return;
    setTiers(prev => {
      const base = { ...(prev || DEFAULT_TIERS) };
      // Copy division data under new name
      base[newName] = base[oldName] || makeDivisionTiers(newName);
      delete base[oldName];
      // Update meta
      const meta = { ...(base._meta || DEFAULT_TIERS._meta) };
      meta.divisions = meta.divisions.map(d => d === oldName ? newName : d);
      if (newLabel) {
        meta.divisionLabels = { ...(meta.divisionLabels || {}), [newName]: { singular: newLabel, plural: newLabel + "s", portalLabel: "My " + newLabel } };
        delete (meta.divisionLabels || {})[oldName];
      }
      base._meta = meta;
      return base;
    });
    // Update any clients using old division name
    setClients(cs => cs.map(c => c.division === oldName ? { ...c, division: newName } : c));
    setActiveDivision(newName);
    setRenamingDiv(false);
  };

  // Save renamed tier names for active division
  const saveTierRenames = (newNames) => {
    if (!newNames || newNames.length === 0) return;
    setTiers(prev => {
      const base = { ...(prev || DEFAULT_TIERS) };
      const oldNames = getTierNames(base, activeDivision);
      const divData  = { ...(base[activeDivision] || {}) };
      // Rename each tier key
      const newDivData = { _tierNames: newNames };
      newNames.forEach((name, i) => {
        const old = oldNames[i];
        if (old && divData[old]) newDivData[name] = { ...divData[old] };
        else newDivData[name] = makeDivisionTiers(activeDivision)[old] || {};
      });
      base[activeDivision] = newDivData;
      return base;
    });
    // Update any clients using old tier names for this division
    const oldNames = getTierNames(tiers, activeDivision);
    setClients(cs => cs.map(c => {
      if (c.division !== activeDivision) return c;
      const oldPlan = c.plan;
      const idx = oldNames.indexOf(oldPlan);
      if (idx >= 0 && newNames[idx] && newNames[idx] !== oldPlan) {
        return { ...c, plan: newNames[idx], plans: { ...(c.plans || {}), [activeDivision]: newNames[idx] } };
      }
      return c;
    }));
    setRenamingTier(false);
    setSelected(newNames[1] || newNames[0]);
  };

  // Add a brand new division
  const addDivision = (name, label) => {
    if (!name.trim()) return;
    setTiers(prev => {
      const base = { ...(prev || DEFAULT_TIERS) };
      base[name] = makeDivisionTiers(name);
      const meta = { ...(base._meta || DEFAULT_TIERS._meta) };
      meta.divisions = [...(meta.divisions || []), name];
      meta.divisionLabels = { ...(meta.divisionLabels || {}), [name]: { singular: label || name, plural: (label || name) + "s", portalLabel: "My " + (label || name) } };
      base._meta = meta;
      return base;
    });
    setActiveDivision(name);
    setAddingDiv(false);
    setNewDivName(""); setNewDivLabel("");
  };

  // Remove a division (with guard — can't remove last one)
  const removeDivision = (name) => {
    const divs = getDivisions(tiers);
    if (divs.length <= 1) return;
    setTiers(prev => {
      const base = { ...(prev || DEFAULT_TIERS) };
      delete base[name];
      const meta = { ...(base._meta || DEFAULT_TIERS._meta) };
      meta.divisions = meta.divisions.filter(d => d !== name);
      base._meta = meta;
      return base;
    });
    setActiveDivision(getDivisions(tiers).filter(d => d !== name)[0]);
  };

  const saveTierDraft = () => {
    setTiers(prev => {
      const base = prev || DEFAULT_TIERS;
      const divData = base[activeDivision] || DEFAULT_TIERS[activeDivision] || {};
      return { ...base, [activeDivision]: { ...divData, [selected]: { ...draft } } };
    });
    setUnsaved(false);
    setTierSaved(true);
    setTimeout(() => setTierSaved(false), 2500);
  };

  // Clients on this tier (or no tier when __none__ is selected)
  const tierClients = (clients || []).filter(c => {
    const clientPlan = (c.plans && c.plans[activeDivision]) || (c.division === activeDivision ? c.plan : null);
    if (selected === "__none__") return !clientPlan;
    return clientPlan === selected;
  });

  // Bulk apply prices + plan changes
  const applyBulkPrices = () => {
    if (Object.keys(bulkPrices).length === 0 && Object.keys(bulkPlans).length === 0) return;
    setClients(prev => prev.map(c => {
      const newRate    = bulkPrices[String(c.id)];
      const newPlanRaw = bulkPlans[String(c.id)];   // "" = None, undefined = no change
      if (newRate === undefined && newPlanRaw === undefined) return c;
      const newPlan = newPlanRaw === "" ? null : newPlanRaw;
      const updatedPlans = newPlanRaw !== undefined
        ? { ...(c.plans || {}), [activeDivision]: newPlan || "" }
        : c.plans;
      const isPrimary = c.division === activeDivision;
      return {
        ...c,
        ...(newRate !== undefined ? { monthlyRate: newRate } : {}),
        ...(newPlanRaw !== undefined && isPrimary ? {
          plan:     newPlan || "",
          planFreq: newPlan ? (TIER_FREQ[newPlan] || c.planFreq) : "",
        } : {}),
        ...(newPlanRaw !== undefined ? { plans: updatedPlans } : {}),
      };
    }));
    setBulkPrices({});
    setBulkPlans({});
    setBulkSaved(true);
    setConfirmBulk(false);
    setTimeout(() => setBulkSaved(false), 3000);
  };

  const field = { width: "100%", padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const lbl   = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>Customize plans for each division. Each division has its own Essential, Signature, and Premium tiers.</div>
      </div>

      {/* Division switcher + manage */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, background: T.surfaceAlt, borderRadius: 14, padding: 4 }}>
          {DIVISIONS_LIST.map(div => (
            <button key={div} onClick={() => switchDivision(div)}
              style={{ flex: 1, padding: "9px 6px", border: "none", borderRadius: 11, background: activeDivision === div ? T.surface : "transparent", color: activeDivision === div ? T.primary : T.textMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", boxShadow: activeDivision === div ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
              {div}
            </button>
          ))}
          {/* Add division button */}
          <button onClick={() => { setAddingDiv(true); setRenamingDiv(false); setRenamingTier(false); }}
            style={{ width: 34, height: 34, border: "none", borderRadius: 11, background: "transparent", color: T.primary, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "inherit" }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>

        {/* Division management row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => { setRenamingDiv(true); setDivNameDraft(activeDivision); setRenamingTier(false); setAddingDiv(false); }}
            style={{ fontSize: 11, fontWeight: 700, color: T.primary, background: "none", border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" }}>
            Rename Division
          </button>
          <button onClick={() => { setRenamingTier(true); setTierNameDrafts([...getTierNames(tiers, activeDivision)]); setRenamingDiv(false); setAddingDiv(false); }}
            style={{ fontSize: 11, fontWeight: 700, color: T.primary, background: "none", border: `1px solid ${T.border}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" }}>
            Rename Tiers
          </button>
          {DIVISIONS_LIST.length > 1 && (
            <button onClick={() => { if (window.confirm(`Remove ${activeDivision} division? This cannot be undone.`)) removeDivision(activeDivision); }}
              style={{ fontSize: 11, fontWeight: 700, color: "#E5484D", background: "none", border: `1px solid ${hexA("#E5484D", 0.3)}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>
              Remove
            </button>
          )}
        </div>

        {/* Rename division panel */}
        {renamingDiv && (
          <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Rename "{activeDivision}" Division</div>
            <input value={divNameDraft} onChange={e => setDivNameDraft(e.target.value)}
              placeholder="Division name (e.g. Irrigation)"
              style={{ padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => saveDivisionRename(activeDivision, divNameDraft.trim(), divNameDraft.trim())}
                style={{ flex: 1, background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "10px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Save</button>
              <button onClick={() => setRenamingDiv(false)}
                style={{ background: T.surface, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Rename tiers panel */}
        {renamingTier && (
          <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Rename Tiers — {activeDivision}</div>
            <div style={{ fontSize: 12, color: T.textMuted }}>Changes update all client records and the portal automatically.</div>
            {tierNameDrafts.map((name, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: T.textMuted, width: 16, fontWeight: 700 }}>{i + 1}</span>
                <input value={name} onChange={e => { const n = [...tierNameDrafts]; n[i] = e.target.value; setTierNameDrafts(n); }}
                  style={{ flex: 1, padding: "9px 13px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => saveTierRenames(tierNameDrafts.map(n => n.trim()).filter(Boolean))}
                style={{ flex: 1, background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "10px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Save Names</button>
              <button onClick={() => setRenamingTier(false)}
                style={{ background: T.surface, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Add division panel */}
        {addingDiv && (
          <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Add New Division</div>
            <input value={newDivName} onChange={e => setNewDivName(e.target.value)}
              placeholder="Division name (e.g. Irrigation)"
              style={{ padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
            <input value={newDivLabel} onChange={e => setNewDivLabel(e.target.value)}
              placeholder="Portal label (e.g. Irrigation System)"
              style={{ padding: "10px 13px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }} />
            <div style={{ fontSize: 11, color: T.textMuted }}>The new division will get default Essential / Signature / Premium tiers that you can customize.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => addDivision(newDivName.trim(), newDivLabel.trim())}
                disabled={!newDivName.trim()}
                style={{ flex: 1, background: newDivName.trim() ? T.primary : T.surfaceAlt, color: newDivName.trim() ? "#fff" : T.textMuted, border: "none", borderRadius: 10, padding: "10px", fontWeight: 700, fontSize: 13, cursor: newDivName.trim() ? "pointer" : "default", fontFamily: "inherit" }}>Add Division</button>
              <button onClick={() => { setAddingDiv(false); setNewDivName(""); setNewDivLabel(""); }}
                style={{ background: T.surface, color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Tier selector */}
      <div style={{ display: "flex", gap: 8 }}>
        {TIER_KEYS.map(key => {
          const dt2 = (tiers || DEFAULT_TIERS)[activeDivision] || DEFAULT_TIERS[activeDivision] || DEFAULT_TIERS["Pond"];
          const t = dt2[key] || {};
          const count = (clients || []).filter(c => c.plan === key).length;
          const active = selected === key;
          return (
            <button key={key} onClick={() => switchTier(key)}
              style={{ flex: 1, padding: "12px 8px", border: `2px solid ${active ? (t.color || T.primary) : T.border}`, borderRadius: 16, background: active ? hexA(t.color || T.primary, 0.08) : T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "center", transition: "all 0.15s" }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: t.color || T.primary, margin: "0 auto 6px" }} />
              <div style={{ fontSize: 13, fontWeight: 800, color: active ? (t.color || T.primary) : T.text }}>{key}</div>
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{count} client{count !== 1 ? "s" : ""}</div>
            </button>
          );
        })}
        {/* None tab */}
        {(() => {
          const noneCount = (clients || []).filter(c => {
            const p = (c.plans && c.plans[activeDivision]) || (c.division === activeDivision ? c.plan : null);
            return !p;
          }).length;
          const active = selected === "__none__";
          return (
            <button onClick={() => setSelected("__none__")}
              style={{ flex: 1, padding: "12px 8px", border: `2px solid ${active ? T.textMuted : T.border}`, borderRadius: 16, background: active ? hexA(T.textMuted, 0.06) : T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "center", transition: "all 0.15s" }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: T.border, margin: "0 auto 6px" }} />
              <div style={{ fontSize: 13, fontWeight: 800, color: active ? T.text : T.textMuted }}>None</div>
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{noneCount} client{noneCount !== 1 ? "s" : ""}</div>
            </button>
          );
        })()}
      </div>

      {/* None tab — just shows the client list below, no tier editor */}
      {selected === "__none__" && (
        <Card>
          <CardHeader title="No Tier" />
          <div style={{ padding: "14px 18px" }}>
            <p style={{ margin: 0, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              Clients listed here are not assigned to any service tier. Use the bulk pricing section below to assign them to a tier, or set their rate to $0 to keep them here.
            </p>
          </div>
        </Card>
      )}

      {/* Tier details editor — hidden when None tab is active */}
      {selected !== "__none__" && <Card>
        <CardHeader title={`${selected} Tier Settings`}
          action={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {unsaved && <span style={{ fontSize: 12, color: T.textMuted }}>Unsaved changes</span>}
              {tierSaved && !unsaved && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "#16a34a", display: "flex", alignItems: "center", gap: 5 }}>
                  <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="#16a34a" strokeWidth={2.5} strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                  Saved
                </span>
              )}
              <button onClick={saveTierDraft}
                style={{ background: unsaved ? T.primary : T.surfaceAlt, color: unsaved ? "#fff" : T.textMuted, border: "none", borderRadius: 10, padding: "7px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s", boxShadow: unsaved ? `0 2px 8px ${hexA(T.primary, 0.3)}` : "none" }}>
                Save {selected}
              </button>
            </div>
          }
        />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={lbl}>Tagline</label>
              <input type="text" style={field} value={tier.tagline || ""} onChange={e => setDraftField("tagline", e.target.value)} placeholder="e.g. Our most popular plan" />
            </div>
            <div>
              <label style={lbl}>Display Price</label>
              <input type="text" style={field} value={tier.price || ""} onChange={e => setDraftField("price", e.target.value)} placeholder="e.g. $150/mo or Contact us" />
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Shown to clients in their portal.</div>
            </div>
          </div>

          <div>
            <label style={lbl}>Tier Color</label>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative", width: 44, height: 44, borderRadius: 12, overflow: "hidden", border: `1.5px solid ${T.border}`, background: tier.color || "#6B7280", flexShrink: 0 }}>
                <input type="color" value={tier.color || "#6B7280"} onChange={e => setDraftField("color", e.target.value)} style={{ position: "absolute", inset: -4, width: 56, height: 56, border: "none", cursor: "pointer" }} />
              </div>
              <div style={{ fontSize: 13, color: T.textMuted }}>Used on the hero card and tier badge in the client portal.</div>
            </div>
          </div>

          <div>
            <label style={lbl}>Upgrades To</label>
            <div style={{ display: "flex", gap: 8 }}>
              {["Signature", "Premium", "none"].map(opt => (
                <button key={opt} onClick={() => setDraftField("upgradeTo", opt === "none" ? null : opt)}
                  style={{ flex: 1, padding: "9px", border: `1.5px solid ${(tier.upgradeTo === opt || (opt === "none" && !tier.upgradeTo)) ? T.primary : T.border}`, borderRadius: 10, background: (tier.upgradeTo === opt || (opt === "none" && !tier.upgradeTo)) ? hexA(T.primary, 0.08) : T.surface, color: (tier.upgradeTo === opt || (opt === "none" && !tier.upgradeTo)) ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  {opt === "none" ? "None (top tier)" : opt}
                </button>
              ))}
            </div>
          </div>

          {/* What's included */}
          <div>
            <label style={lbl}>What's Included</label>
            <div style={{ background: T.surfaceAlt, borderRadius: 14, overflow: "hidden" }}>
              {(tier.includes || []).map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: i < tier.includes.length - 1 ? `1px solid ${T.border}` : "none" }}>
                  {/* Up/down */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
                    <button onClick={() => moveInclude(i, -1)} disabled={i === 0}
                      style={{ background: "none", border: "none", color: i === 0 ? T.border : T.textMuted, cursor: i === 0 ? "default" : "pointer", padding: 2, fontSize: 12, lineHeight: 1 }}>▲</button>
                    <button onClick={() => moveInclude(i, 1)} disabled={i === tier.includes.length - 1}
                      style={{ background: "none", border: "none", color: i === tier.includes.length - 1 ? T.border : T.textMuted, cursor: i === tier.includes.length - 1 ? "default" : "pointer", padding: 2, fontSize: 12, lineHeight: 1 }}>▼</button>
                  </div>
                  {editingInclude === i ? (
                    <input type="text" autoFocus value={item}
                      onChange={e => setInclude(i, e.target.value)}
                      onBlur={() => setEditingInclude(null)}
                      onKeyDown={e => e.key === "Enter" && setEditingInclude(null)}
                      style={{ ...field, flex: 1, padding: "6px 10px" }} />
                  ) : (
                    <div onClick={() => setEditingInclude(i)} style={{ flex: 1, fontSize: 13, color: T.text, cursor: "text" }}>{item}</div>
                  )}
                  <button onClick={() => removeInclude(i)}
                    style={{ background: hexA("#E5484D", 0.1), border: "none", borderRadius: 8, color: "#E5484D", width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
              {/* Add new */}
              <div style={{ display: "flex", gap: 8, padding: "10px 14px" }}>
                <input type="text" value={newInclude} onChange={e => setNewInclude(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addInclude()}
                  placeholder="Add a benefit..." style={{ ...field, flex: 1, padding: "8px 12px", fontSize: 13 }} />
                <button onClick={addInclude} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Add</button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Tap any line to edit. Arrows to reorder. Enter to confirm.</div>
          </div>

          {/* Bottom save button */}
          <button onClick={saveTierDraft}
            style={{ width: "100%", background: unsaved ? T.primary : T.surfaceAlt, color: unsaved ? "#fff" : T.textMuted, border: "none", borderRadius: 14, padding: "14px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s", boxShadow: unsaved ? `0 4px 14px ${hexA(T.primary, 0.3)}` : "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {tierSaved && !unsaved
              ? <><svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg> {selected} Saved</>
              : `Save ${selected} Tier`
            }
          </button>
        </div>
      </Card>}

      {/* ── BULK CLIENT PRICING ── */}
      <Card>
        <CardHeader title={selected === "__none__" ? "Untiered Clients" : `${selected} Clients — Bulk Pricing`} />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {tierClients.length === 0 ? (
            <div style={{ fontSize: 13, color: T.textMuted, textAlign: "center", padding: "16px 0" }}>No clients on the {selected} plan yet.</div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
                Edit monthly rates for all {selected} clients in one place. Leave unchanged to keep existing pricing. Tap <strong style={{ color: T.text }}>Apply Changes</strong> to save.
              </div>

              {/* Quick set all */}
              <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 13, color: T.textMuted, flex: 1 }}>Set all to:</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.textMuted, fontSize: 14 }}>$</span>
                    <input type="text" inputMode="decimal"
                      id="bulk-all-input"
                      style={{ ...field, width: 100, paddingLeft: 24 }}
                      placeholder="0.00"
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          const v = e.target.value;
                          const newPrices = {};
                          tierClients.forEach(c => { newPrices[String(c.id)] = v; });
                          setBulkPrices(prev => ({ ...prev, ...newPrices }));
                          e.target.value = "";
                        }
                      }} />
                  </div>
                  <button onClick={() => {
                    const el = document.getElementById("bulk-all-input");
                    const v = el?.value;
                    if (!v) return;
                    const newPrices = {};
                    tierClients.forEach(c => { newPrices[String(c.id)] = v; });
                    setBulkPrices(prev => ({ ...prev, ...newPrices }));
                    if (el) el.value = "";
                  }} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    Set All
                  </button>
                </div>
              </div>

              {/* Per-client rows */}
              <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
                {tierClients.sort((a,b) => (a.name||"").localeCompare(b.name||"")).map((c, i) => {
                  const currentRate = bulkPrices[String(c.id)] !== undefined ? bulkPrices[String(c.id)] : (c.monthlyRate || "");
                  const priceChanged = bulkPrices[String(c.id)] !== undefined;
                  const planChanged  = !!bulkPlans[String(c.id)];
                  const activePlan   = bulkPlans[String(c.id)] !== undefined ? (bulkPlans[String(c.id)] || "") : (c.plan || "");
                  const anyChange    = priceChanged || planChanged;
                  return (
                    <div key={c.id} style={{ padding: "12px 16px", borderBottom: i < tierClients.length - 1 ? `1px solid ${T.border}` : "none", background: anyChange ? hexA(T.primary, 0.03) : "transparent" }}>
                      {/* Name + current frequency */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{c.name}</div>
                          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>
                            {planChanged
                              ? <><span style={{ textDecoration: "line-through", opacity: 0.5 }}>{c.plan}</span> → <span style={{ color: T.primary, fontWeight: 700 }}>{activePlan}</span> · {TIER_FREQ[activePlan]}</>
                              : <>{c.plan} · {TIER_FREQ[c.plan] || c.planFreq || "—"}</>
                            }
                          </div>
                        </div>
                        {anyChange && (
                          <button onClick={() => {
                            setBulkPrices(prev => { const n = { ...prev }; delete n[String(c.id)]; return n; });
                            setBulkPlans(prev => { const n = { ...prev }; delete n[String(c.id)]; return n; });
                          }} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit", flexShrink: 0, marginLeft: 8 }}>Undo</button>
                        )}
                      </div>
                      {/* Plan pills + price input on same row */}
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {/* Plan selector — pill buttons */}
                        <div style={{ display: "flex", gap: 5, flex: 1 }}>
                          {["Essential", "Signature", "Premium", "None"].map(pill => {
                            const planVal  = pill === "None" ? "" : pill;
                            const isActive = activePlan === planVal;
                            const isNone   = pill === "None";
                            const changed  = planChanged && planVal !== (c.plan || "");
                            const activeCol = isNone ? T.textMuted : (changed ? T.primary : T.border);
                            return (
                             <button key={pill} onClick={() => {
                               const orig = c.plan || "";
                               if (planVal === orig) {
                                 setBulkPlans(prev => { const n = { ...prev }; delete n[String(c.id)]; return n; });
                                 if (planVal === "") setBulkPrices(prev => { const n = { ...prev }; delete n[String(c.id)]; return n; });
                               } else {
                                 setBulkPlans(prev => ({ ...prev, [String(c.id)]: planVal }));
                                 if (planVal === "") setBulkPrices(prev => ({ ...prev, [String(c.id)]: "0" }));
                               }
                             }}
                               style={{ flex: 1, padding: "6px 4px", borderRadius: 10,
                                  border: `1.5px solid ${isActive ? activeCol : T.border}`,
                                  background: isActive ? (isNone ? hexA(T.textMuted, 0.08) : (changed ? hexA(T.primary, 0.1) : T.surfaceAlt)) : T.surface,
                                  color: isActive ? (isNone ? T.textMuted : (changed ? T.primary : T.text)) : T.textMuted,
                                  fontWeight: isActive ? 800 : 500, fontSize: 11, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>
                               {pill}
                             </button>
                            );
                          })}
                        </div>
                        {/* Price input */}
                        <div style={{ position: "relative", width: 100, flexShrink: 0 }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.textMuted, fontSize: 14 }}>$</span>
                          <input type="text" inputMode="decimal"
                            value={currentRate}
                            onChange={e => setBulkPrices(prev => ({ ...prev, [String(c.id)]: e.target.value.replace(/[^0-9.]/g, "") }))}
                            placeholder={c.monthlyRate || "rate"}
                            style={{ ...field, paddingLeft: 24, border: priceChanged ? `1.5px solid ${T.primary}` : `1.5px solid ${T.border}` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Apply button */}
              {(Object.keys(bulkPrices).length > 0 || Object.keys(bulkPlans).length > 0) && !confirmBulk && (
                <button onClick={() => setConfirmBulk(true)}
                  style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 14, padding: "14px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 16px ${hexA(T.primary, 0.3)}` }}>
                  Apply {Object.keys(bulkPrices).length + Object.keys(bulkPlans).length} Change{(Object.keys(bulkPrices).length + Object.keys(bulkPlans).length) !== 1 ? "s" : ""}
                </button>
              )}
              {confirmBulk && (
                <div style={{ background: hexA(T.primary, 0.06), border: `1px solid ${hexA(T.primary, 0.2)}`, borderRadius: 14, padding: "14px 16px" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 10 }}>
                    Update {Object.keys(bulkPrices).length} client{Object.keys(bulkPrices).length !== 1 ? "s" : ""}?
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
                    Updates monthly rates and plan assignments on each client record. Plan changes also update their service frequency. Doesn't generate invoices automatically.
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={applyBulkPrices}
                      style={{ flex: 1, background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                      Confirm
                    </button>
                    <button onClick={() => setConfirmBulk(false)}
                      style={{ background: T.surfaceAlt, color: T.text, border: "none", borderRadius: 12, padding: "12px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {bulkSaved && (
                <div style={{ background: hexA("#16a34a", 0.1), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 12, padding: "12px 16px", fontSize: 13, fontWeight: 700, color: "#16a34a", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="check" size={16} /> Prices updated for all {selected} clients.
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function AppSettings({ branding, setBranding, catalog, setCatalog, email, setEmail, costs, setCosts, budget, setBudget, clients, setClients, invoices, scheduleCfg, setScheduleCfg, team, setTeam, invoicing, setInvoicing, currentUserId, onResetData, serviceTiers, setServiceTiers, onSyncData }) {
  const { T, perms } = useApp();
  const fileRef = useRef();
  const [tab, setTab] = useState("branding");
  const [localBranding, setLocalBranding] = useState({ ...branding });
  const [confirmReset, setConfirmReset] = useState(false);
  const [palette, setPalette, lpal] = useStoredState("sps_palette", DEFAULT_PALETTE);
  const [editingPalette, setEditingPalette] = useState(false);
  const [newPaletteHex, setNewPaletteHex] = useState("#000000");
  const [newPaletteName, setNewPaletteName] = useState("");
  const set = (k, v) => setLocalBranding(b => ({ ...b, [k]: v }));

  const sysDark = useSystemDark();
  const localMode = localBranding.appearance === "system" ? (sysDark ? "dark" : "light") : (localBranding.appearance || "light");
  const palOf = (theme) => theme[localMode] || theme.light;

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      set("logoImage", ev.target.result);
      set("logoType", "image");
    };
    reader.readAsDataURL(file);
  };

  const handleSave = () => setBranding(localBranding);

  const tabs = [];
  if (perms.editSettings) tabs.push(["branding", "Branding"]);
  if (perms.editCatalog || perms.editSettings || perms.isAdmin) tabs.push(["services", "Services"]);
  if (perms.seeCostsBudget || perms.editSettings || perms.canInvoice) tabs.push(["business", "Business"]);
  if (perms.isAdmin) tabs.push(["team", "Team"]);
  // if the current tab isn't available (e.g. switched to employee view), fall back to the first one
  const activeTab = tabs.some(([id]) => id === tab) ? tab : (tabs[0] ? tabs[0][0] : null);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.03em" }}>Customize</h2>
        {activeTab === "branding" && <Btn onClick={handleSave}>Apply</Btn>}
      </div>

      {tabs.length === 0 ? (
        <Card>
          <div style={{ padding: 28, textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: 16, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}><Icon name="lock" size={26} /></div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>Nothing to customize</div>
            <div style={{ fontSize: 13, color: T.textMuted }}>Your access doesn't include any settings. Ask your admin if you need changes.</div>
          </div>
        </Card>
      ) : (<>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flexShrink: 0, padding: "9px 16px", border: "none", borderRadius: 100,
            fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: activeTab === id ? T.primary : T.surfaceAlt,
            color: activeTab === id ? "#fff" : T.textMuted,
            fontFamily: "inherit", letterSpacing: "-0.01em",
          }}>{label}</button>
        ))}
      </div>

      {activeTab === "services" && (
        <div key="services-tab">
          {perms.editCatalog && (
            <Collapsible title="Service Catalog" subtitle="Stop types, services, products, treatments, and water tests.">
              <CatalogManager catalog={catalog} setCatalog={setCatalog} />
            </Collapsible>
          )}
          {perms.isAdmin && (
            <Collapsible title="Service Tiers" subtitle="Plan benefits, pricing, and upgrade paths shown in the client portal.">
              <ServiceTiersManager tiers={serviceTiers || DEFAULT_TIERS} setTiers={setServiceTiers} clients={clients} setClients={setClients} T={T} />
            </Collapsible>
          )}
          <Collapsible title="Schedule Settings" subtitle="Sort order, stop density, and what appears on each stop card.">
            <ScheduleSettings cfg={scheduleCfg} setCfg={setScheduleCfg} />
          </Collapsible>
        </div>
      )}
      {activeTab === "business" && (
        <div key="business-tab">
          {(perms.editSettings || perms.canInvoice) && (
            <Collapsible title="Invoicing" subtitle="Invoice numbering, tax rate, payment terms, and QuickBooks link.">
              <InvoiceSettings invoicing={invoicing} setInvoicing={setInvoicing} branding={branding} setBranding={setBranding} onSyncData={onSyncData} />
            </Collapsible>
          )}
          {perms.editSettings && (
            <Collapsible title="Messaging & Notifications" subtitle="On My Way texts, email templates, and client notification messages.">
              <EmailSettings email={email} setEmail={setEmail} branding={branding} setBranding={setBranding} />
            </Collapsible>
          )}
          {perms.seeCostsBudget && (
            <Collapsible title="Costs & Labor" subtitle="Hourly rate, overhead, gas, and per-stop cost assumptions.">
              <CostSettings costs={costs} setCosts={setCosts} />
            </Collapsible>
          )}
          {perms.seeCostsBudget && (
            <Collapsible title="Budget & Targets" subtitle="Monthly revenue goals and profitability tracking.">
              <BudgetManager budget={budget} setBudget={setBudget} clients={clients} costs={costs} invoices={invoices || []} />
            </Collapsible>
          )}
        </div>
      )}
      {activeTab === "team" && perms.isAdmin && <TeamManager team={team} setTeam={setTeam} currentUserId={currentUserId} />}
      {activeTab === "branding" && <>

      {/* ── LOGO & IDENTITY ── */}
      <Collapsible title="Logo & Identity" subtitle="Name, logo, emoji, and app appearance." defaultOpen={true}>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Live preview */}
          <div style={{ display: "flex", gap: 14, alignItems: "center", background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: T.surface, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {localBranding.logoType === "image" && localBranding.logoImage
                ? <img src={localBranding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 26 }}>{localBranding.logoEmoji}</span>}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, color: T.text, letterSpacing: "-0.01em" }}>{localBranding.companyName || "Company Name"}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{localBranding.splashTagline || localBranding.division || "Division"}</div>
            </div>
          </div>

          <FieldRow label="Company Name">
            <Input value={localBranding.companyName} onChange={e => set("companyName", e.target.value)} placeholder="Stone Property Solutions" />
          </FieldRow>
          <FieldRow label="Division / Tagline">
            <Input value={localBranding.division} onChange={e => set("division", e.target.value)} placeholder="Pond · Pool · Seasonal" />
          </FieldRow>
          <FieldRow label="Staff Default Landing Page">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                ["dashboard", "Home / Dashboard"],
                ["schedule",  "Schedule"],
                ["clients",   "Clients"],
                ["invoices",  "Invoices"],
                ["inventory", "Inventory"],
                ["reports",   "Reports"],
              ].map(([v, l]) => {
                const active = (localBranding.staffDefaultPage || "dashboard") === v;
                return (
                  <button key={v} onClick={() => set("staffDefaultPage", v)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", border: `1.5px solid ${active ? T.primary : T.border}`, borderRadius: 12, background: active ? hexA(T.primary, 0.06) : T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%", boxSizing: "border-box" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: active ? T.primary : T.border, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? T.primary : T.text }}>{l}</span>
                    {active && <Icon name="check" size={14} style={{ marginLeft: "auto", color: T.primary }} />}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 5 }}>The page staff land on after the splash screen.</div>
          </FieldRow>
          {/* ── LOADING SCREEN CUSTOMIZER ── */}
          <div style={{ background: T.surfaceAlt, borderRadius: 16, overflow: "hidden", border: `1px solid ${T.border}` }}>
            <div style={{ padding: "12px 16px 10px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>Loading Screen</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Live preview below</div>
            </div>

            {/* LIVE PREVIEW */}
            {(() => {
              const bg1 = localBranding.splashBgColor || T.primary;
              const bg2 = localBranding.splashBgColor2 || mix(bg1, "#000", 0.3);
              const style = localBranding.splashBgStyle || "gradient";
              const textColor = localBranding.splashTextColor === "dark" ? "rgba(0,0,0,0.85)" : "#fff";
              const tagline = (localBranding.splashTagline || "").trim() || (localBranding.division || "").trim() || "Field Operations";
              const logoSrc = localBranding.splashLogoOverride || (localBranding.logoType === "image" ? localBranding.logoImage : null);
              return (
                <div style={{ margin: "14px 16px", borderRadius: 16, overflow: "hidden", height: 180, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
                  background: style === "gradient" ? `linear-gradient(160deg, ${bg1} 0%, ${bg2} 100%)`
                    : style === "solid" ? bg1
                    : style === "image" && localBranding.splashBgImage ? `url(${localBranding.splashBgImage}) center/cover` : `linear-gradient(160deg, ${bg1} 0%, ${bg2} 100%)`,
                }}>
                  {style === "image" && localBranding.splashBgImage && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)" }} />}
                  <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                    {logoSrc ? <img src={logoSrc} style={{ width: 44, height: 44, borderRadius: 12, objectFit: "cover" }} alt="logo" />
                      : <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{localBranding.logoEmoji || "💧"}</div>}
                    <div style={{ fontSize: 14, fontWeight: 900, color: textColor, letterSpacing: "-0.02em" }}>{localBranding.companyName || "Company Name"}</div>
                    <div style={{ fontSize: 10, color: textColor, opacity: 0.7 }}>{tagline}</div>
                    {(localBranding.splashShowGreeting !== "false") && (
                      <div style={{ marginTop: 8, background: "rgba(255,255,255,0.15)", borderRadius: 100, padding: "5px 14px", backdropFilter: "blur(8px)" }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: textColor }}>
                          {(localBranding.splashGreetingPrefix && localBranding.splashGreetingPrefix.trim()) ? localBranding.splashGreetingPrefix.trim() : "Good morning"}, Brandon.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {/* Tagline */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Tagline</label>
                <Input value={localBranding.splashTagline || ""} onChange={e => set("splashTagline", e.target.value)} placeholder={localBranding.division || "e.g. The SPS Way"} />
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>If blank, uses Division / Tagline above.</div>
              </div>

              {/* Background style */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Background Style</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[["gradient","Gradient"],["solid","Solid"],["image","Image"]].map(([v,l]) => (
                    <button key={v} onClick={() => set("splashBgStyle", v)}
                      style={{ flex: 1, padding: "8px 6px", border: `1.5px solid ${(localBranding.splashBgStyle||"gradient")===v ? T.primary : T.border}`, borderRadius: 10, background: (localBranding.splashBgStyle||"gradient")===v ? hexA(T.primary,0.08) : T.surface, color: (localBranding.splashBgStyle||"gradient")===v ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              {/* Colors */}
              {(localBranding.splashBgStyle || "gradient") !== "image" && (
                <div style={{ display: "grid", gridTemplateColumns: (localBranding.splashBgStyle||"gradient") === "gradient" ? "1fr 1fr" : "1fr", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>
                      {(localBranding.splashBgStyle||"gradient") === "gradient" ? "Color 1" : "Background Color"}
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, cursor: "pointer" }}>
                      <span style={{ width: 28, height: 28, borderRadius: 8, background: localBranding.splashBgColor || T.primary, display: "block", flexShrink: 0, border: `1px solid ${T.border}`, position: "relative", overflow: "hidden" }}>
                        <input type="color" value={localBranding.splashBgColor || T.primary} onChange={e => set("splashBgColor", e.target.value)} style={{ position: "absolute", inset: -4, width: 40, height: 40, border: "none", cursor: "pointer" }} />
                      </span>
                      <span style={{ fontSize: 12, color: T.text, fontFamily: "monospace" }}>{(localBranding.splashBgColor || T.primary).toUpperCase()}</span>
                      {localBranding.splashBgColor && <button onClick={() => set("splashBgColor", "")} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 10, cursor: "pointer", marginLeft: "auto", fontFamily: "inherit" }}>Reset</button>}
                    </label>
                  </div>
                  {(localBranding.splashBgStyle||"gradient") === "gradient" && (
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Color 2</label>
                      <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, cursor: "pointer" }}>
                        <span style={{ width: 28, height: 28, borderRadius: 8, background: localBranding.splashBgColor2 || mix(localBranding.splashBgColor || T.primary, "#000", 0.3), display: "block", flexShrink: 0, border: `1px solid ${T.border}`, position: "relative", overflow: "hidden" }}>
                          <input type="color" value={localBranding.splashBgColor2 || mix(localBranding.splashBgColor || T.primary, "#000", 0.3)} onChange={e => set("splashBgColor2", e.target.value)} style={{ position: "absolute", inset: -4, width: 40, height: 40, border: "none", cursor: "pointer" }} />
                        </span>
                        <span style={{ fontSize: 12, color: T.text, fontFamily: "monospace" }}>{(localBranding.splashBgColor2 || mix(localBranding.splashBgColor || T.primary, "#000", 0.3)).toUpperCase()}</span>
                        {localBranding.splashBgColor2 && <button onClick={() => set("splashBgColor2", "")} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 10, cursor: "pointer", marginLeft: "auto", fontFamily: "inherit" }}>Reset</button>}
                      </label>
                    </div>
                  )}
                </div>
              )}

              {/* Background image upload */}
              {(localBranding.splashBgStyle||"gradient") === "image" && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Background Image</label>
                  {localBranding.splashBgImage ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <img src={localBranding.splashBgImage} style={{ width: 56, height: 40, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }} alt="bg" />
                      <div style={{ flex: 1, fontSize: 12, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Background set</div>
                      <button onClick={() => set("splashBgImage", "")} style={{ background: "none", border: "none", color: "#E5484D", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Remove</button>
                    </div>
                  ) : (
                    <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", border: `1.5px dashed ${T.border}`, borderRadius: 10, cursor: "pointer" }}>
                      <Icon name="plus" size={15} /><span style={{ fontSize: 13, color: T.textMuted }}>Upload background image</span>
                      <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => set("splashBgImage", ev.target.result); r.readAsDataURL(f); e.target.value = ""; }} />
                    </label>
                  )}
                </div>
              )}

              {/* Splash logo override */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Splash Logo <span style={{ textTransform: "none", fontWeight: 400 }}>(optional — defaults to main logo)</span></label>
                {localBranding.splashLogoOverride ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <img src={localBranding.splashLogoOverride} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 10, border: `1px solid ${T.border}` }} alt="splash logo" />
                    <button onClick={() => set("splashLogoOverride", "")} style={{ background: "none", border: "none", color: "#E5484D", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Remove override</button>
                  </div>
                ) : (
                  <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", border: `1.5px dashed ${T.border}`, borderRadius: 10, cursor: "pointer" }}>
                    <Icon name="plus" size={15} /><span style={{ fontSize: 13, color: T.textMuted }}>Upload a different logo for splash</span>
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => set("splashLogoOverride", ev.target.result); r.readAsDataURL(f); e.target.value = ""; }} />
                  </label>
                )}
              </div>

              {/* Text color + greeting toggle */}
              {/* Greeting prefix */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Greeting Text</label>
                <Input
                  value={localBranding.splashGreetingPrefix || ""}
                  onChange={e => set("splashGreetingPrefix", e.target.value)}
                  placeholder="Good morning / Good afternoon / Good evening"
                />
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Replaces the time-based greeting. Leave blank to keep "Good morning/afternoon/evening".</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Text Color</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["light","Light"],["dark","Dark"]].map(([v,l]) => (
                      <button key={v} onClick={() => set("splashTextColor", v)}
                        style={{ flex: 1, padding: "8px", border: `1.5px solid ${(localBranding.splashTextColor||"light")===v ? T.primary : T.border}`, borderRadius: 10, background: (localBranding.splashTextColor||"light")===v ? hexA(T.primary,0.08) : T.surface, color: (localBranding.splashTextColor||"light")===v ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 }}>Greeting</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["true","On"],["false","Off"]].map(([v,l]) => (
                      <button key={v} onClick={() => set("splashShowGreeting", v)}
                        style={{ flex: 1, padding: "8px", border: `1.5px solid ${(localBranding.splashShowGreeting||"true")===v ? T.primary : T.border}`, borderRadius: 10, background: (localBranding.splashShowGreeting||"true")===v ? hexA(T.primary,0.08) : T.surface, color: (localBranding.splashShowGreeting||"true")===v ? T.primary : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Logo type */}
          <FieldRow label="Logo">
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {["image", "emoji"].map(opt => (
                <button key={opt} onClick={() => set("logoType", opt)}
                  style={{ flex: 1, padding: "9px 12px", border: `1.5px solid ${localBranding.logoType === opt ? T.primary : T.border}`, borderRadius: 10, background: localBranding.logoType === opt ? hexA(T.primary, 0.08) : T.surface, color: localBranding.logoType === opt ? T.primary : T.text, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                  {opt === "image" ? "Upload Image" : "Use Emoji"}
                </button>
              ))}
            </div>

            {localBranding.logoType === "image" && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ background: T.primary, color: "#fff", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="download" size={14} /> Upload Logo
                  <input type="file" accept="image/*" ref={fileRef} onChange={handleLogoUpload} style={{ display: "none" }} />
                </label>
                {localBranding.logoImage && localBranding.logoImage !== "/icon-192.png" && (
                  <button onClick={() => { set("logoImage", "/icon-192.png"); }} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    Reset to default
                  </button>
                )}
              </div>
            )}

            {localBranding.logoType === "emoji" && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {["💧","🌿","🏡","🐟","🌊","⚙️","🔧","🍃","🪴","🌱","🌻","🦆"].map(e => (
                  <button key={e} onClick={() => set("logoEmoji", e)}
                    style={{ width: 44, height: 44, borderRadius: 10, border: `2px solid ${localBranding.logoEmoji === e ? T.primary : T.border}`, background: localBranding.logoEmoji === e ? hexA(T.primary, 0.08) : T.surface, fontSize: 22, cursor: "pointer" }}>
                    {e}
                  </button>
                ))}
              </div>
            )}
          </FieldRow>

          {/* App icon hint */}
          <div style={{ background: hexA(T.primary, 0.06), border: `1px solid ${hexA(T.primary, 0.15)}`, borderRadius: 12, padding: "12px 14px", fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
            <span style={{ fontWeight: 700, color: T.text }}>App icon: </span>
            The logo above appears in the header. For the home screen icon (after installing to your iPhone), replace <code style={{ background: T.surfaceAlt, padding: "1px 5px", borderRadius: 4 }}>icon-180.png</code> and <code style={{ background: T.surfaceAlt, padding: "1px 5px", borderRadius: 4 }}>icon-512.png</code> in your GitHub repo with your logo at those sizes.
          </div>
        </div>
      </Collapsible>

      {/* ── CONTACT INFO ── */}
      <Collapsible title="Contact Info" subtitle="Phone, email, address, and company website.">
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -4 }}>These appear on invoices, estimates, and the client portal.</div>
          <FieldRow label="Phone">
            <Input value={localBranding.companyPhone || ""} onChange={e => set("companyPhone", e.target.value)} placeholder="(610) 555-1234" />
          </FieldRow>
          <FieldRow label="Email">
            <Input value={localBranding.companyEmail || ""} onChange={e => set("companyEmail", e.target.value)} placeholder="hello@stonepropertysolutions.com" />
          </FieldRow>
          <FieldRow label="Website">
            <Input value={localBranding.companyWebsite || ""} onChange={e => set("companyWebsite", e.target.value)} placeholder="stonepropertysolutions.com" />
          </FieldRow>
          <FieldRow label="Address">
            <Input value={localBranding.companyAddress || ""} onChange={e => set("companyAddress", e.target.value)} placeholder="123 Main St, Honey Brook, PA 19344" />
          </FieldRow>
        </div>
      </Collapsible>

      {/* ── APPEARANCE ── */}
      <Collapsible title="Appearance" subtitle="Light mode, dark mode, and font settings.">
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Mode</div>
            <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 12, padding: 4, gap: 4 }}>
              {[["light", "Light"], ["dark", "Dark"], ["system", "Auto"]].map(([m, label]) => (
                <button key={m} onClick={() => set("appearance", m)} style={{
                  flex: 1, padding: "10px 6px", border: "none", borderRadius: 9, cursor: "pointer", fontFamily: "inherit",
                  fontSize: 13, fontWeight: 600,
                  background: (localBranding.appearance || "system") === m ? T.surface : "transparent",
                  color: (localBranding.appearance || "system") === m ? T.primary : T.textMuted,
                  boxShadow: (localBranding.appearance || "system") === m ? T.shadow : "none",
                }}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8 }}>
              {(localBranding.appearance || "system") === "system" ? "Follows your device's light or dark setting." : `Always ${localBranding.appearance} mode.`}
            </div>
          </div>
        </div>
      </Collapsible>

      {/* ── THEME ── */}
      <Collapsible title="Color Theme" subtitle="Choose a preset theme or build a custom one.">
        <div style={{ padding: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {Object.entries(THEMES).map(([key, theme]) => {
              const pal = palOf(theme);
              const active = localBranding.themeKey === key;
              return (
                <button key={key} onClick={() => set("themeKey", key)}
                  style={{ padding: "14px 14px", border: `2px solid ${active ? pal.primary : T.border}`, borderRadius: 14, background: pal.surface, cursor: "pointer", textAlign: "left", fontFamily: "inherit", position: "relative", overflow: "hidden" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: pal.primary }} />
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: pal.bg, border: `1px solid ${pal.border}` }} />
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: pal.accent }} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: pal.text }}>{theme.name}</div>
                  {active && (
                    <div style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: "50%", background: pal.primary, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                      <Icon name="check" size={12} />
                    </div>
                  )}
                </button>
              );
            })}
            {/* Custom */}
            {(() => {
              const cu = buildCustomTheme(localBranding.custom, localMode);
              const active = localBranding.themeKey === "custom";
              return (
                <button onClick={() => set("themeKey", "custom")}
                  style={{ padding: "14px 14px", border: `2px solid ${active ? cu.primary : T.border}`, borderRadius: 14, background: cu.surface, cursor: "pointer", textAlign: "left", fontFamily: "inherit", position: "relative", overflow: "hidden" }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: cu.primary }} />
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: cu.bg, border: `1px solid ${cu.border}` }} />
                    <div style={{ width: 20, height: 20, borderRadius: 6, background: cu.accent }} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: cu.text }}>Custom</div>
                  {active && (
                    <div style={{ position: "absolute", top: 8, right: 8, width: 20, height: 20, borderRadius: "50%", background: cu.primary, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                      <Icon name="check" size={12} />
                    </div>
                  )}
                </button>
              );
            })()}
          </div>
        </div>
      </Collapsible>

      {/* ── SAVED COLOR PALETTE ── */}
      <Collapsible title="Brand Palette" subtitle="Your saved brand colors for quick access.">
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button onClick={() => setEditingPalette(e => !e)}
            style={{ background: editingPalette ? T.primary : T.surfaceAlt, color: editingPalette ? "#fff" : T.textMuted, border: "none", borderRadius: 10, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {editingPalette ? "Done" : "Edit"}
          </button>
        </div>
        <div style={{ padding: "14px 18px" }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
            Your saved colors. Tap any chip in the color editor below to apply instantly. These are pre-loaded with SPS brand colors.
          </div>

          {/* Palette grid */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: editingPalette ? 16 : 0 }}>
            {(palette || DEFAULT_PALETTE).map((p, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                <div style={{ position: "relative" }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: p.hex, border: `1px solid ${T.border}`, boxShadow: "0 1px 4px rgba(0,0,0,0.12)" }} />
                  {editingPalette && (
                    <button onClick={() => setPalette(prev => (prev||DEFAULT_PALETTE).filter((_, j) => j !== i))}
                      style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#E5484D", border: `2px solid ${T.surface}`, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontSize: 10 }}>
                      ×
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 10, color: T.textMuted, textAlign: "center", maxWidth: 44, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{p.name}</div>
              </div>
            ))}

            {/* Add new color */}
            {editingPalette && (palette || DEFAULT_PALETTE).length < 16 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, background: T.surfaceAlt, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ position: "relative", width: 36, height: 36, borderRadius: 9, overflow: "hidden", border: `1px solid ${T.border}`, background: newPaletteHex, flexShrink: 0 }}>
                    <input type="color" value={newPaletteHex} onChange={e => setNewPaletteHex(e.target.value)}
                      style={{ position: "absolute", inset: -4, width: 48, height: 48, border: "none", padding: 0, cursor: "pointer" }} />
                  </div>
                  <input
                    type="text"
                    value={newPaletteName}
                    onChange={e => setNewPaletteName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && newPaletteName.trim()) {
                        setPalette(prev => [...(prev || DEFAULT_PALETTE), { name: newPaletteName.trim(), hex: newPaletteHex }]);
                        setNewPaletteName(""); setNewPaletteHex("#000000");
                      }
                    }}
                    placeholder="Color name"
                    style={{ flex: 1, padding: "6px 10px", border: `1.5px solid ${T.border}`, borderRadius: 9, fontSize: 12, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" }}
                  />
                  <button
                    onClick={() => {
                      if (!newPaletteName.trim()) return;
                      setPalette(prev => [...(prev || DEFAULT_PALETTE), { name: newPaletteName.trim(), hex: newPaletteHex }]);
                      setNewPaletteName(""); setNewPaletteHex("#000000");
                    }}
                    style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 9, padding: "7px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

          {editingPalette && (
            <button
              onClick={() => setPalette(DEFAULT_PALETTE)}
              style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
              Reset to SPS defaults
            </button>
          )}
        </div>
      </Collapsible>

      {/* ── CUSTOM THEME EDITOR ── */}
      {localBranding.themeKey === "custom" && (() => {
        const cust = { ...DEFAULT_CUSTOM, ...(localBranding.custom || {}) };
        const setCustom = (k, v) => setLocalBranding(b => ({ ...b, custom: { ...DEFAULT_CUSTOM, ...(b.custom || {}), [k]: v } }));
        const preview = buildCustomTheme(cust, localMode);
        const savedPalette = palette || DEFAULT_PALETTE;

        // Color row: shows palette chips + a native color picker fallback
        const ColorRow = ({ colorKey, label, hint }) => {
          const [showHex, setShowHex] = useState(false);
          const currentVal = cust[colorKey] || "#000000";
          return (
            <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "13px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
                  {hint && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{hint}</div>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "monospace" }}>{currentVal.toUpperCase()}</span>
                  <div style={{ position: "relative", width: 32, height: 32, borderRadius: 10, overflow: "hidden", border: `2px solid ${T.border}`, background: currentVal, flexShrink: 0 }}>
                    <input type="color" value={currentVal} onChange={e => setCustom(colorKey, e.target.value)}
                      style={{ position: "absolute", inset: -4, width: 44, height: 44, border: "none", padding: 0, cursor: "pointer", background: "none" }} />
                  </div>
                </div>
              </div>
              {/* Saved palette chips */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {savedPalette.map((p, pi) => (
                  <button key={pi} onClick={() => setCustom(colorKey, p.hex)}
                    title={`${p.name} ${p.hex}`}
                    style={{
                      width: 30, height: 30, borderRadius: 10, background: p.hex, border: `2.5px solid ${currentVal === p.hex ? T.text : "transparent"}`,
                      cursor: "pointer", flexShrink: 0, boxShadow: currentVal === p.hex ? `0 0 0 1px ${T.border}` : "0 1px 3px rgba(0,0,0,0.15)",
                      transition: "transform 0.1s",
                    }}
                  />
                ))}
                {/* Custom hex input */}
                <button onClick={() => setShowHex(v => !v)}
                  style={{ width: 30, height: 30, borderRadius: 10, background: T.surface, border: `1.5px dashed ${T.border}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted, fontSize: 16, fontWeight: 300 }}>
                  +
                </button>
              </div>
              {showHex && (
                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    placeholder="#AF011A"
                    defaultValue={currentVal}
                    onBlur={e => {
                      const v = e.target.value.trim();
                      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setCustom(colorKey, v);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        const v = e.target.value.trim();
                        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { setCustom(colorKey, v); setShowHex(false); }
                      }
                    }}
                    style={{ flex: 1, padding: "8px 12px", border: `1.5px solid ${T.border}`, borderRadius: 10, fontSize: 13, fontFamily: "monospace", color: T.text, background: T.surface, outline: "none" }}
                  />
                  <div style={{ width: 30, height: 30, borderRadius: 10, background: currentVal, border: `1px solid ${T.border}`, flexShrink: 0 }} />
                </div>
              )}
            </div>
          );
        };

        return (
          <div style={{ background: T.surfaceAlt, borderRadius: 16, border: `1px solid ${T.border}`, marginTop: 14 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, fontSize: 14, fontWeight: 800, color: T.text }}>Custom Theme Editor</div>
            <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Font */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Font</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {Object.entries(FONTS).map(([key, f]) => (
                    <button key={key} onClick={() => setCustom("fontFamily", key)}
                      style={{ padding: "8px 14px", borderRadius: 100, border: `1.5px solid ${cust.fontFamily === key ? T.primary : T.border}`, background: cust.fontFamily === key ? hexA(T.primary, 0.08) : T.surface, color: cust.fontFamily === key ? T.primary : T.text, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: f.stack }}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Colors */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Colors</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <ColorRow colorKey="primary" label="Brand Color"   hint="Buttons, active states, highlights" />
                  <ColorRow colorKey="accent"  label="Accent Color"  hint="Success, money, positive states" />
                  <ColorRow colorKey="bg"      label="Background"    hint="Page background" />
                  <ColorRow colorKey="surface" label="Surface"       hint="Cards, modals, input fields" />
                  <ColorRow colorKey="text"    label="Text"          hint="Primary text color" />
                </div>
              </div>

              {/* Live preview */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Live Preview</div>
                <div style={{ background: preview.bg, borderRadius: 16, padding: 16, border: `1px solid ${preview.border}`, fontFamily: FONTS[cust.fontFamily]?.stack }}>
                  <div style={{ background: preview.surface, borderRadius: 14, padding: 16, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", marginBottom: 10, border: `1px solid ${preview.border}` }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: preview.text, letterSpacing: "-0.02em", marginBottom: 4 }}>Sample Client Card</div>
                    <div style={{ fontSize: 13, color: preview.textMuted, marginBottom: 12 }}>This is how your app will look.</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ background: preview.primary, color: "#fff", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700 }}>Primary Button</span>
                      <span style={{ background: preview.surfaceAlt, color: preview.text, borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600, border: `1px solid ${preview.border}` }}>Secondary</span>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 14, fontWeight: 700, color: preview.accent }}>$245.00 collected</div>
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>Tap <strong>Apply</strong> at the top right to use this theme across the whole app.</div>
            </div>
          </div>
        );
      })()}

      {/* ── CLIENT PORTAL BRANDING ── */}
      <Collapsible title="Client Portal" subtitle="Portal name, nav labels, default landing page, and accent color.">
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: -4, lineHeight: 1.5 }}>Controls what clients see when they open their portal. Changes apply when you save.</div>

          {/* Live portal hero preview */}
          <div style={{ background: `linear-gradient(145deg, ${localBranding.accentColor || T.primary}, ${mix(localBranding.accentColor || T.primary, "#000", 0.28)})`, borderRadius: 18, padding: "20px 18px", color: "#fff", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", right: -20, top: -20, width: 100, height: 100, borderRadius: "50%", background: "rgba(255,255,255,0.08)", pointerEvents: "none" }} />
            <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.65, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Portal Preview</div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{localBranding.portalAppName || localBranding.companyName || "Stone Property Solutions"}</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 5 }}>{localBranding.portalTagline || "Your trusted property care partner"}</div>
          </div>

          <FieldRow label="Portal App Name">
            <Input value={localBranding.portalAppName || ""} onChange={e => set("portalAppName", e.target.value)} placeholder={localBranding.companyName || "Stone Property Solutions"} />
          </FieldRow>
          <FieldRow label="Welcome Tagline">
            <Input value={localBranding.portalTagline || ""} onChange={e => set("portalTagline", e.target.value)} placeholder="Your trusted property care partner" />
          </FieldRow>
          <FieldRow label="Welcome Message">
            <Input value={localBranding.portalWelcome || ""} onChange={e => set("portalWelcome", e.target.value)} placeholder="e.g. Thanks for being a Stone Property Solutions client!" />
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Shown below the greeting on the client's Home tab.</div>
          </FieldRow>

          {/* Portal accent color with palette chips */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Portal Hero Color</div>
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
              <div>
                <div style={{ fontSize: 14, color: T.text, fontWeight: 600 }}>Hero card gradient</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>Shown on Home and My Service screens</div>
              </div>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "monospace" }}>{(localBranding.accentColor || T.primary).toUpperCase()}</span>
                <span style={{ position: "relative", width: 32, height: 32, borderRadius: 10, overflow: "hidden", border: `1px solid ${T.border}`, background: localBranding.accentColor || T.primary, flexShrink: 0 }}>
                  <input type="color" value={localBranding.accentColor || T.primary} onChange={e => set("accentColor", e.target.value)} style={{ position: "absolute", inset: -4, width: 44, height: 44, border: "none", padding: 0, cursor: "pointer", background: "none" }} />
                </span>
              </span>
            </label>
            <div style={{ display: "flex", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
              {(palette || DEFAULT_PALETTE).map((p, i) => (
                <button key={i} onClick={() => set("accentColor", p.hex)} title={`${p.name} ${p.hex}`}
                  style={{ width: 28, height: 28, borderRadius: 7, background: p.hex, border: `2.5px solid ${(localBranding.accentColor || T.primary) === p.hex ? T.text : "transparent"}`, cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.15)", flexShrink: 0 }} />
              ))}
              <button onClick={() => set("accentColor", "")} style={{ width: 28, height: 28, borderRadius: 7, background: T.surface, border: `1.5px solid ${T.border}`, cursor: "pointer", fontSize: 10, color: T.textMuted, fontFamily: "inherit" }}>Reset</button>
            </div>
          </div>

          {/* Default landing page for clients */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Client Default Landing Page</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10, lineHeight: 1.5 }}>Which screen clients see first every time they open their portal.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { id: "cp_home",     label: "Home",         sub: "Dashboard overview (default)" },
                { id: "cp_property", label: "My Property", sub: "Pond, pool or property details" },
                { id: "cp_invoices", label: "Invoices",     sub: "Balance and payment history" },
              ].map(opt => {
                const active = (localBranding.portalDefaultPage || "cp_home") === opt.id;
                return (
                  <button key={opt.id} onClick={() => set("portalDefaultPage", opt.id)}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", border: `1.5px solid ${active ? T.primary : T.border}`, borderRadius: 12, background: active ? hexA(T.primary, 0.06) : T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%", boxSizing: "border-box" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: active ? T.primary : T.border, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: active ? T.primary : T.text }}>{opt.label}</div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{opt.sub}</div>
                    </div>
                    {active && <Icon name="check" size={14} style={{ color: T.primary, flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Nav label toggle */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>Nav Bar Labels</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[["true","Icons + Labels"],["false","Icons Only"]].map(([v,l]) => {
                const active = (localBranding.portalNavLabels ?? "true") === v;
                return (
                  <button key={v} onClick={() => set("portalNavLabels", v)}
                    style={{ flex:1, padding:"10px 8px", border:`1.5px solid ${active ? T.primary : T.border}`, borderRadius:12, background: active ? hexA(T.primary,0.07) : T.surface, color: active ? T.primary : T.textMuted, fontWeight:700, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
                    {l}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize:11, color:T.textMuted, marginTop:5 }}>Icons Only is cleaner on small screens.</div>
          </div>



          <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: "12px 14px", fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
            <strong style={{ color: T.text }}>Plan tier details</strong> — what's listed under each plan (Essential, Signature, Premium) and upgrade copy — edit in the <strong style={{ color: T.text }}>Service Tiers</strong> tab above.
          </div>
        </div>
      </Collapsible>

      {/* ── RESET ── */}
      <Collapsible title="Reset All Data" subtitle="Restore all app data to factory defaults.">
        <div style={{ padding: 18 }}>
          {!confirmReset ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>Clear all saved data and restore demo defaults. This cannot be undone.</div>
              <button onClick={() => setConfirmReset(true)} style={{ flexShrink: 0, background: "transparent", color: "#C0392B", border: `1.5px solid #C0392B`, borderRadius: 10, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Reset</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, color: T.text, marginBottom: 12, fontWeight: 600 }}>This erases everything. Are you sure?</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => { onResetData(); setConfirmReset(false); }} style={{ background: "#C0392B", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Yes, Reset Everything</button>
                <button onClick={() => setConfirmReset(false)} style={{ background: T.surfaceAlt, color: T.text, border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </Collapsible>
      </>}
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────
// NAV
// ─────────────────────────────────────────────
// Crisp line icons — render identically on every platform, inherit currentColor
function Icon({ name, size = 22, filled = false }) {
  const sw = filled ? 0 : 1.8;
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: filled ? "currentColor" : "none", stroke: filled ? "none" : "currentColor", strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    // Nav
    home:     <><path d="M4 10.5 12 4l8 6.5" /><path d="M5.5 9.5V19a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1V9.5" /></>,
    clients:  <><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6" /></>,
    calendar: <><rect x="4" y="5" width="16" height="16" rx="2.5" /><path d="M4 9.5h16M9 3v4M15 3v4" /></>,
    sliders:  <><path d="M5 8h9M19 8h0M5 16h0M10 16h9" /><circle cx="16.5" cy="8" r="2.2" /><circle cx="7.5" cy="16" r="2.2" /></>,
    // Actions
    edit:     <><path d="M11 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M17.5 2.5a2.12 2.12 0 0 1 3 3L12 14l-4 1 1-4Z" /></>,
    trash:    <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></>,
    check:    <path d="M20 6 9 17l-5-5" />,
    plus:     <path d="M12 5v14M5 12h14" />,
    close:    <path d="M18 6 6 18M6 6l12 12" />,
    back:     <path d="M19 12H5M12 19l-7-7 7-7" />,
    forward:  <path d="M5 12h14M12 5l7 7-7 7" />,
    // Content
    download: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 20h14" /></>,
    invoice:  <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3.5" /></>,
    phone:    <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" />,
    mail:     <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="m2 8 10 7 10-7" /></>,
    location: <><path d="M12 2C8.7 2 6 4.7 6 8c0 5 6 14 6 14s6-9 6-14c0-3.3-2.7-6-6-6z" /><circle cx="12" cy="8" r="2" /></>,
    map:      <><path d="m3 7 6-3 6 3 6-3v13l-6 3-6-3-6 3V7z" /><path d="M9 4v13M15 7v13" /></>,
    warning:  <><path d="m10.3 3.4-7.9 13.3A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-3.3L13.7 3.4a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
    info:     <><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M12 12v4" /></>,
    lock:     <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
    eye:      <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
    history:  <><path d="M12 8v4l3 3" /><path d="M3.05 11a9 9 0 1 0 .5-3M3 4v4h4" /></>,
    link:     <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    message:  <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
    request:  <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>,
    refresh:  <><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.5 9A9 9 0 0 1 20.5 9M20.5 15A9 9 0 0 1 3.5 15" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    tag:      <><path d="M20.6 11.3 12.7 3.4A2 2 0 0 0 11.3 3H5a2 2 0 0 0-2 2v6.3a2 2 0 0 0 .6 1.4l7.9 7.9a2 2 0 0 0 2.8 0l6.3-6.3a2 2 0 0 0 0-2.7z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
    dollar:   <path d="M12 2v20M17 5H9.5a3.5 3.5 0 1 0 0 7h5a3.5 3.5 0 1 1 0 7H6" />,
    clipboard:<><rect x="9" y="2" width="6" height="4" rx="1" /><path d="M8 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-2" /><path d="M9 12h6M9 16h4" /></>,
    mobile:   <><rect x="7" y="2" width="10" height="20" rx="3" /><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" /></>,
    chevronR: <path d="m9 18 6-6-6-6" />,
    chevronD: <path d="m6 9 6 6 6-6" />,
  };
  return <svg {...common}>{paths[name] || null}</svg>;
}

// ─────────────────────────────────────────────
// MESSAGING SYSTEM
// Two-way chat between staff and clients.
// Backed by the sps_messages table in Supabase.
// ─────────────────────────────────────────────

// Shared hook — loads messages for a given clientId, with real-time polling
function useMessages(clientId) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!clientId) return;
    const { data, error } = await supabase
      .from("sps_messages")
      .select("*")
      .eq("client_id", String(clientId))
      .order("created_at", { ascending: true });
    if (!error && data) setMessages(data);
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, 8000); // poll every 8s
    return () => clearInterval(interval);
  }, [clientId]);

  const send = async (body, sender, senderName) => {
    if (!body.trim() || !clientId) return;
    const { data, error } = await supabase.from("sps_messages").insert({
      client_id: String(clientId),
      sender,
      sender_name: senderName || "",
      body: body.trim(),
    }).select().single();
    if (!error && data) setMessages(prev => [...prev, data]);
    return !error;
  };

  const markRead = async (msgIds) => {
    if (!msgIds.length) return;
    await supabase.from("sps_messages").update({ read_at: new Date().toISOString() }).in("id", msgIds);
  };

  return { messages, loading, send, markRead, reload: load };
}

function fmtMsgTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ── STAFF: Full messages inbox ──
function MessagesScreen({ clients, currentUser, T }) {
  const [selectedClientId, setSelectedClientId] = useState(null);
  const selectedClient = (clients || []).find(c => String(c.id) === String(selectedClientId)) || null;

  // Get unread counts per client — loaded once then refreshed
  const [unreadMap, setUnreadMap] = useState({});
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("sps_messages")
        .select("client_id, read_at, sender")
        .eq("sender", "client")
        .is("read_at", null);
      if (data) {
        const map = {};
        data.forEach(m => { map[m.client_id] = (map[m.client_id] || 0) + 1; });
        setUnreadMap(map);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (selectedClient) {
    return (
      <StaffChat
        client={selectedClient}
        currentUser={currentUser}
        T={T}
        onBack={() => setSelectedClientId(null)}
      />
    );
  }

  const clientsWithMessages = (clients || []).filter(c => unreadMap[String(c.id)] > 0);
  const otherClients = (clients || []).filter(c => !unreadMap[String(c.id)]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Messages</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 3 }}>Client conversations</div>
      </div>

      {clientsWithMessages.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>Unread</div>
          <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            {clientsWithMessages.map((c, i) => (
              <button key={c.id} onClick={() => setSelectedClientId(c.id)}
                style={{ width: "100%", padding: "14px 18px", background: "none", border: "none", borderBottom: i < clientsWithMessages.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <div style={{ width: 42, height: 42, borderRadius: 13, background: hexA(T.primary, 0.1), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flexShrink: 0 }}>
                  {(c.name || "?")[0].toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Tap to view conversation</div>
                </div>
                <div style={{ background: T.primary, color: "#fff", borderRadius: 100, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                  {unreadMap[String(c.id)]}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        {clientsWithMessages.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>All Clients</div>}
        <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {otherClients.length === 0 && clientsWithMessages.length === 0 && (
            <div style={{ padding: "40px 20px", textAlign: "center", color: T.textMuted, fontSize: 14 }}>No clients yet. Add clients to start messaging.</div>
          )}
          {otherClients.map((c, i) => (
            <button key={c.id} onClick={() => setSelectedClientId(c.id)}
              style={{ width: "100%", padding: "14px 18px", background: "none", border: "none", borderBottom: i < otherClients.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
              <div style={{ width: 42, height: 42, borderRadius: 13, background: T.surfaceAlt, color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flexShrink: 0 }}>
                {(c.name || "?")[0].toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{c.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{c.division || "Pond"} · {c.status || "Active"}</div>
              </div>
              <Icon name="chevronR" size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Shared chat thread UI (used by both staff and client) ──
function ChatThread({ clientId, sender, senderName, T, accentSide = "right" }) {
  const { messages, loading, send, markRead } = useMessages(clientId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Mark incoming messages as read
  useEffect(() => {
    const unread = messages.filter(m => m.sender !== sender && !m.read_at).map(m => m.id);
    if (unread.length) markRead(unread);
  }, [messages]);

  const handleSend = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    await send(draft, sender, senderName);
    setDraft("");
    setSending(false);
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted, fontSize: 14 }}>
        <div style={{ width: 18, height: 18, border: `2px solid ${T.border}`, borderTopColor: T.primary, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 0", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: T.textMuted, fontSize: 13 }}>No messages yet. Start the conversation below.</div>
        )}
        {messages.map((m, i) => {
          const isMine = m.sender === sender;
          const showTime = i === 0 || (new Date(m.created_at) - new Date(messages[i-1].created_at)) > 300000;
          return (
            <div key={m.id}>
              {showTime && (
                <div style={{ textAlign: "center", fontSize: 11, color: T.textMuted, padding: "6px 0", marginBottom: 2 }}>{fmtMsgTime(m.created_at)}</div>
              )}
              <div style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start", paddingLeft: isMine ? 48 : 0, paddingRight: isMine ? 0 : 48 }}>
                <div style={{
                  background: isMine ? T.primary : T.surfaceAlt,
                  color: isMine ? "#fff" : T.text,
                  borderRadius: isMine ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                  padding: "10px 14px",
                  fontSize: 14,
                  lineHeight: 1.5,
                  maxWidth: "100%",
                  wordBreak: "break-word",
                  boxShadow: isMine ? `0 2px 8px ${hexA(T.primary, 0.25)}` : "none",
                }}>
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ borderTop: `1px solid ${T.border}`, padding: "12px 0 0", display: "flex", gap: 10, alignItems: "flex-end" }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Type a message..."
          rows={1}
          style={{ flex: 1, padding: "11px 14px", border: `1.5px solid ${T.border}`, borderRadius: 14, fontSize: 14, fontFamily: "inherit", resize: "none", outline: "none", color: T.text, background: T.surface, lineHeight: 1.5, maxHeight: 120, overflowY: "auto" }}
        />
        <button onClick={handleSend} disabled={!draft.trim() || sending}
          style={{ width: 42, height: 42, borderRadius: 13, background: draft.trim() ? T.primary : T.surfaceAlt, border: "none", color: draft.trim() ? "#fff" : T.textMuted, cursor: draft.trim() ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}>
          <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
  );
}

// ── Staff chat view (single client thread) ──
function StaffChat({ client, currentUser, T, onBack }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${T.border}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: T.primary, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4, fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>
          <Icon name="back" size={16} /> Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{client.name}</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>{client.division || "Pond"} client</div>
        </div>
      </div>
      <ChatThread
        clientId={client.id}
        sender="staff"
        senderName={currentUser?.name || "SPS"}
        T={T}
      />
    </div>
  );
}

// ── Client messages tab ──
function CPMessages({ client, branding, onSubmit, T }) {
  const [view, setView] = useState("messages"); // "messages" | "request"

  if (view === "request") {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <button onClick={() => setView("messages")}
          style={{ background:"none", border:"none", color:T.primary, fontWeight:700, fontSize:13, cursor:"pointer", padding:"0 0 4px", display:"flex", alignItems:"center", gap:4, fontFamily:"inherit", alignSelf:"flex-start" }}>
          ← Messages
        </button>
        <CPRequest client={client} branding={branding} onSubmit={(data) => { if (onSubmit) onSubmit(data); setView("messages"); }} T={T} />
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14, height:"calc(100vh - 200px)" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:4 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>Messages</div>
          <div style={{ fontSize:14, color:T.textMuted, marginTop:3 }}>Chat with {branding?.companyName || "us"}</div>
        </div>
        <button onClick={() => setView("request")}
          style={{ display:"flex", alignItems:"center", gap:7, background:T.primary, color:"#fff", border:"none", borderRadius:12, padding:"9px 16px", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit", flexShrink:0, boxShadow:`0 3px 12px ${hexA(T.primary,0.3)}` }}>
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          Request Service
        </button>
      </div>
      <ChatThread
        clientId={client.id}
        sender="client"
        senderName={client.name}
        T={T}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// REPORTS DASHBOARD
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// SERVICE STOPS REPORT
// Per-client breakdown of completed stops for any period.
// Printable — generates a clean PDF for billing review.
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// INVENTORY SCREEN
// Full treatment/chemical inventory tracker.
// Shows stock levels, usage history, restock alerts,
// and lets you adjust inventory manually.
// ─────────────────────────────────────────────

function InventoryScreen({ catalog, setCatalog, clients, T }) {
  const LOW_THRESHOLD = 32; // oz — configurable
  const treatments = catalog.treatments || [];
  const [adjustModal, setAdjustModal] = useState(null); // { treatment, mode: "restock"|"adjust" }
  const [adjustAmt, setAdjustAmt] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [historyModal, setHistoryModal] = useState(null); // treatment id

  // Build usage history from all client history entries
  const usageHistory = {};
  (clients || []).forEach(c => {
    (c.history || []).forEach(h => {
      (h.treatmentsUsed || []).forEach(u => {
        if (!usageHistory[u.id]) usageHistory[u.id] = [];
        usageHistory[u.id].push({ date: h.date, oz: u.oz, client: c.name, cost: u.cost });
      });
    });
  });

  // Total usage per treatment (all time)
  const totalUsed = (id) => (usageHistory[id] || []).reduce((s, e) => s + (e.oz || 0), 0);
  const lastUsed  = (id) => {
    const h = (usageHistory[id] || []).slice().sort((a,b) => {
      const p = s => { const [m,d,y]=(s||"").split("/").map(Number); return new Date(y,m-1,d); };
      return p(b.date) - p(a.date);
    });
    return h[0]?.date || null;
  };

  const statusOf = (oz) => {
    if (oz <= 0) return { label: "Out of Stock", color: "#E5484D", bg: hexA("#E5484D", 0.1) };
    if (oz < LOW_THRESHOLD) return { label: "Low Stock", color: "#F59E0B", bg: hexA("#F59E0B", 0.1) };
    return { label: "In Stock", color: "#16a34a", bg: hexA("#16a34a", 0.1) };
  };

  const applyAdjust = () => {
    const t = adjustModal.treatment;
    const amt = parseFloat(adjustAmt) || 0;
    if (amt === 0) { setAdjustModal(null); return; }
    const current = parseFloat(t.inventoryOz) || 0;
    const newAmt = adjustModal.mode === "restock"
      ? current + amt
      : Math.max(0, current + amt); // adjust can be negative
    setCatalog(cat => ({
      ...cat,
      treatments: (cat.treatments || []).map(tr =>
        tr.id === t.id ? { ...tr, inventoryOz: String(newAmt) } : tr
      )
    }));
    setAdjustModal(null);
    setAdjustAmt("");
    setAdjustNote("");
  };

  const field = { width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const lbl   = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 7 };

  const low = treatments.filter(t => parseFloat(t.inventoryOz) < LOW_THRESHOLD);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Inventory</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
          {treatments.length} treatment{treatments.length !== 1 ? "s" : ""} tracked · {low.length > 0 ? `${low.length} need restocking` : "All stocked"}
        </div>
      </div>

      {/* Low stock alerts */}
      {low.length > 0 && (
        <div style={{ background: hexA("#F59E0B", 0.08), border: `1px solid ${hexA("#F59E0B", 0.25)}`, borderRadius: 16, padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#92400E", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="warning" size={15} /> {low.length} item{low.length !== 1 ? "s" : ""} running low
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {low.map(t => {
              const oz = parseFloat(t.inventoryOz) || 0;
              return (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>{t.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: oz <= 0 ? "#E5484D" : "#F59E0B", fontWeight: 700 }}>
                      {oz <= 0 ? "OUT" : `${oz}oz left`}
                    </span>
                    <button onClick={() => { setAdjustModal({ treatment: t, mode: "restock" }); setAdjustAmt(""); }}
                      style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      Restock
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Treatment cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {treatments.map(t => {
          const oz = parseFloat(t.inventoryOz) || 0;
          const status = statusOf(oz);
          const used = totalUsed(t.id);
          const last = lastUsed(t.id);
          const maxOz = Math.max(oz + used, 512); // scale bar
          const pct = Math.min(100, (oz / maxOz) * 100);
          const barColor = oz <= 0 ? "#E5484D" : oz < LOW_THRESHOLD ? "#F59E0B" : T.primary;

          return (
            <div key={t.id} style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, padding: "16px 18px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{t.name}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>
                    ${parseFloat(t.costPerOz || 0).toFixed(2)}/oz
                    {last && <span> · Last used {last}</span>}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 100, background: status.bg, color: status.color, flexShrink: 0, marginLeft: 10 }}>
                  {status.label}
                </span>
              </div>

              {/* Stock bar */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{oz.toFixed(0)}<span style={{ fontSize: 13, fontWeight: 500, color: T.textMuted, marginLeft: 4 }}>oz</span></span>
                  <span style={{ fontSize: 12, color: T.textMuted }}>{used.toFixed(0)}oz used all time</span>
                </div>
                <div style={{ height: 6, background: T.surfaceAlt, borderRadius: 100, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 100, transition: "width 0.4s ease" }} />
                </div>
                {oz < LOW_THRESHOLD && oz > 0 && (
                  <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 5 }}>Below {LOW_THRESHOLD}oz threshold</div>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { setAdjustModal({ treatment: t, mode: "restock" }); setAdjustAmt(""); }}
                  style={{ flex: 1, background: hexA(T.primary, 0.08), color: T.primary, border: "none", borderRadius: 11, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  + Restock
                </button>
                <button onClick={() => { setAdjustModal({ treatment: t, mode: "adjust" }); setAdjustAmt(""); }}
                  style={{ flex: 1, background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 11, padding: "9px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  Adjust
                </button>
                {(usageHistory[t.id] || []).length > 0 && (
                  <button onClick={() => setHistoryModal(t.id)}
                    style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 11, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                    History
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Adjust/Restock modal */}
      {adjustModal && (
        <Modal title={adjustModal.mode === "restock" ? `Restock — ${adjustModal.treatment.name}` : `Adjust — ${adjustModal.treatment.name}`} onClose={() => setAdjustModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px" }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>Current stock</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginTop: 2 }}>
                {parseFloat(adjustModal.treatment.inventoryOz || 0).toFixed(0)}<span style={{ fontSize: 14, color: T.textMuted }}> oz</span>
              </div>
            </div>
            <div>
              <label style={lbl}>{adjustModal.mode === "restock" ? "Add (oz)" : "Adjustment (oz, use – for removal)"}</label>
              <input type="text" inputMode="decimal" style={field} value={adjustAmt}
                onChange={e => setAdjustAmt(e.target.value.replace(/[^0-9.\-]/g, ""))}
                placeholder={adjustModal.mode === "restock" ? "e.g. 128" : "e.g. -16"}
                autoFocus />
              {adjustAmt && (
                <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>
                  New total: <strong style={{ color: T.text }}>
                    {Math.max(0, (parseFloat(adjustModal.treatment.inventoryOz) || 0) + (parseFloat(adjustAmt) || 0)).toFixed(0)}oz
                  </strong>
                </div>
              )}
            </div>
            <div>
              <label style={lbl}>Note <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span></label>
              <input type="text" style={field} value={adjustNote} onChange={e => setAdjustNote(e.target.value)} placeholder="e.g. Received shipment, Spilled, Manual count" />
            </div>
            <Btn onClick={applyAdjust} block lg disabled={!adjustAmt}>
              {adjustModal.mode === "restock" ? "Add to Inventory" : "Apply Adjustment"}
            </Btn>
          </div>
        </Modal>
      )}

      {/* Usage history modal */}
      {historyModal && (() => {
        const t = treatments.find(x => x.id === historyModal);
        const hist = (usageHistory[historyModal] || []).slice().sort((a,b) => {
          const p = s => { const [m,d,y]=(s||"").split("/").map(Number); return new Date(y,m-1,d); };
          return p(b.date) - p(a.date);
        });
        return (
          <Modal title={`Usage — ${t?.name}`} onClose={() => setHistoryModal(null)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
                {hist.length} use{hist.length !== 1 ? "s" : ""} · {hist.reduce((s,e) => s + (e.oz||0), 0).toFixed(0)}oz total consumed
              </div>
              {hist.map((h, i) => (
                <div key={i} style={{ padding: "11px 0", borderBottom: i < hist.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{h.client}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{h.date}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{(h.oz || 0).toFixed(1)}oz</div>
                    {h.cost > 0 && <div style={{ fontSize: 11, color: T.textMuted }}>${(h.cost || 0).toFixed(2)}</div>}
                  </div>
                </div>
              ))}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ─────────────────────────────────────────────
// WATER QUALITY TRENDS
// Charts water readings over time per client.
// Shows pH, Ammonia, Nitrite, Nitrate, Temp, etc.
// Highlights out-of-range values.
// ─────────────────────────────────────────────

// Healthy ranges for common pond water parameters
const WATER_RANGES = {
  "pH":          { min: 6.8, max: 8.2,  unit: "",    ideal: "6.8–8.2",  label: "pH" },
  "Ammonia":     { min: 0,   max: 0.25, unit: "ppm", ideal: "0–0.25",   label: "NH₃" },
  "Nitrite":     { min: 0,   max: 0.5,  unit: "ppm", ideal: "0–0.5",    label: "NO₂" },
  "Nitrate":     { min: 0,   max: 40,   unit: "ppm", ideal: "0–40",     label: "NO₃" },
  "Temperature": { min: 40,  max: 85,   unit: "°F",  ideal: "40–85",    label: "Temp" },
  "Alkalinity":  { min: 80,  max: 180,  unit: "ppm", ideal: "80–180",   label: "Alk" },
  "Phosphate":   { min: 0,   max: 0.5,  unit: "ppm", ideal: "0–0.5",    label: "PO₄" },
  "NH₃":         { min: 0,   max: 0.25, unit: "ppm", ideal: "0–0.25",   label: "NH₃" },
  "NO₂":         { min: 0,   max: 0.5,  unit: "ppm", ideal: "0–0.5",    label: "NO₂" },
  "Temp":        { min: 40,  max: 85,   unit: "°F",  ideal: "40–85",    label: "Temp" },
};

function WaterQualityTrends({ clients, T }) {
  const [selectedClient, setSelectedClient] = useState("");
  const [selectedParam, setSelectedParam] = useState("pH");

  // Get clients that have water readings
  const clientsWithReadings = (clients || []).filter(c =>
    (c.history || []).some(h => {
      const r = h.readings || {};
      return Object.keys(r).length > 0 || h.ph || h.ammonia || h.nitrite || h.temp;
    })
  );

  const client = clientsWithReadings.find(c => String(c.id) === selectedClient);

  // Extract all readings for a client, sorted oldest→newest
  const getReadings = (c, param) => {
    if (!c) return [];
    const points = [];
    (c.history || []).forEach(h => {
      let val = null;
      if (h.readings && h.readings[param] !== undefined) {
        val = parseFloat(h.readings[param]);
      } else {
        // Legacy flat fields
        const legacyMap = { "pH": h.ph, "Ammonia": h.ammonia, "NH₃": h.ammonia, "Nitrite": h.nitrite, "NO₂": h.nitrite, "Temperature": h.temp, "Temp": h.temp };
        if (legacyMap[param] !== undefined) val = parseFloat(legacyMap[param]);
      }
      if (val !== null && !isNaN(val) && h.date) {
        const [mm, dd, yy] = (h.date || "").split("/").map(Number);
        points.push({ date: h.date, val, ts: new Date(yy, mm - 1, dd).getTime() });
      }
    });
    return points.sort((a, b) => a.ts - b.ts);
  };

  // Find all params this client has readings for
  const availableParams = client ? (() => {
    const params = new Set();
    (client.history || []).forEach(h => {
      if (h.readings) Object.keys(h.readings).forEach(k => { if (parseFloat(h.readings[k]) > 0 || h.readings[k]) params.add(k); });
      if (h.ph) params.add("pH");
      if (h.ammonia) params.add("Ammonia");
      if (h.nitrite) params.add("Nitrite");
      if (h.temp) params.add("Temperature");
    });
    return [...params].filter(p => getReadings(client, p).length > 0);
  })() : [];

  const points = client ? getReadings(client, selectedParam) : [];
  const range = WATER_RANGES[selectedParam];

  // Spark line chart — pure SVG, no library needed
  const ChartSVG = ({ points, range, T }) => {
    if (points.length < 2) return (
      <div style={{ textAlign: "center", padding: "32px 0", color: T.textMuted, fontSize: 13 }}>
        Not enough data points to chart. Need at least 2 readings.
      </div>
    );

    const W = 320, H = 140, PAD = { t: 12, r: 12, b: 28, l: 40 };
    const vals = points.map(p => p.val);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);

    // Expand range to include healthy band if close
    const domMin = range ? Math.min(rawMin, range.min * 0.9) : rawMin * 0.9;
    const domMax = range ? Math.max(rawMax, range.max * 1.1) : rawMax * 1.1;
    const span = domMax - domMin || 1;

    const xOf = (i) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
    const yOf = (v) => PAD.t + (1 - (v - domMin) / span) * (H - PAD.t - PAD.b);

    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p.val).toFixed(1)}`).join(" ");
    const fillD = pathD + ` L${xOf(points.length-1).toFixed(1)},${(H-PAD.b).toFixed(1)} L${xOf(0).toFixed(1)},${(H-PAD.b).toFixed(1)} Z`;

    // Healthy band
    const bandY1 = range ? yOf(range.max) : null;
    const bandY2 = range ? yOf(range.min) : null;

    // Y axis labels
    const yLabels = [domMin, (domMin+domMax)/2, domMax].map(v => ({
      v: v.toFixed(v < 10 ? 2 : 0),
      y: yOf(v),
    }));

    // X axis labels (show up to 6 dates)
    const step = Math.max(1, Math.floor(points.length / 5));
    const xLabels = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p, _, arr) => {
      const i = points.indexOf(p);
      const [m, d] = p.date.split("/");
      return { label: `${m}/${d}`, x: xOf(i) };
    });

    const lineColor = T.primary;
    const outOfRange = (v) => range && (v < range.min || v > range.max);

    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible", display: "block" }}>
        {/* Healthy band */}
        {range && bandY1 !== null && bandY2 !== null && (
          <rect x={PAD.l} y={Math.min(bandY1, bandY2)} width={W - PAD.l - PAD.r} height={Math.abs(bandY2 - bandY1)}
            fill={hexA("#16a34a", 0.08)} rx={2} />
        )}

        {/* Grid lines */}
        {yLabels.map((l, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={l.y} x2={W - PAD.r} y2={l.y} stroke={T.border} strokeWidth={1} strokeDasharray="3,3" />
            <text x={PAD.l - 5} y={l.y + 4} textAnchor="end" fontSize={9} fill={T.textMuted}>{l.v}</text>
          </g>
        ))}

        {/* X axis labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 4} textAnchor="middle" fontSize={9} fill={T.textMuted}>{l.label}</text>
        ))}

        {/* Fill area */}
        <path d={fillD} fill={hexA(lineColor, 0.08)} />

        {/* Line */}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {/* Data points */}
        {points.map((p, i) => {
          const bad = outOfRange(p.val);
          return (
            <g key={i}>
              <circle cx={xOf(i)} cy={yOf(p.val)} r={bad ? 5 : 4}
                fill={bad ? "#E5484D" : lineColor}
                stroke={T.surface} strokeWidth={2}
              />
              {bad && <circle cx={xOf(i)} cy={yOf(p.val)} r={8} fill="none" stroke={hexA("#E5484D", 0.3)} strokeWidth={1.5} />}
            </g>
          );
        })}

        {/* Healthy range label */}
        {range && bandY1 !== null && (
          <text x={W - PAD.r} y={bandY1 - 3} textAnchor="end" fontSize={8} fill={hexA("#16a34a", 0.7)} fontWeight="600">
            Ideal range
          </text>
        )}
      </svg>
    );
  };

  // Latest reading card for each param
  const StatChip = ({ param, client }) => {
    const pts = getReadings(client, param);
    if (pts.length === 0) return null;
    const latest = pts[pts.length - 1];
    const r = WATER_RANGES[param];
    const bad = r && (latest.val < r.min || latest.val > r.max);
    const prev = pts.length > 1 ? pts[pts.length - 2].val : null;
    const trend = prev !== null ? (latest.val > prev ? "↑" : latest.val < prev ? "↓" : "→") : null;
    const active = selectedParam === param;
    return (
      <button onClick={() => setSelectedParam(param)}
        style={{ background: active ? hexA(T.primary, 0.1) : T.surface, border: `1.5px solid ${active ? T.primary : T.border}`, borderRadius: 14, padding: "12px 14px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", flexShrink: 0, minWidth: 90 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: active ? T.primary : T.textMuted, marginBottom: 4 }}>{r?.label || param}</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: bad ? "#E5484D" : active ? T.primary : T.text, letterSpacing: "-0.02em" }}>
          {latest.val % 1 === 0 ? latest.val : latest.val.toFixed(2)}
          <span style={{ fontSize: 11, fontWeight: 500, color: T.textMuted }}>{r?.unit}</span>
        </div>
        {trend && <div style={{ fontSize: 11, color: bad ? "#E5484D" : T.textMuted, marginTop: 2 }}>{trend} {pts.length} reads</div>}
        {r && <div style={{ fontSize: 9, color: T.textMuted, marginTop: 2 }}>Ideal: {r.ideal}{r.unit}</div>}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Water Quality</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Trending readings per client over time</div>
      </div>

      {/* Client picker */}
      <select value={selectedClient} onChange={e => { setSelectedClient(e.target.value); setSelectedParam("pH"); }}
        style={{ width: "100%", padding: "12px 14px", border: `1.5px solid ${T.border}`, borderRadius: 14, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", appearance: "none", WebkitAppearance: "none" }}>
        <option value="">Select a client...</option>
        {clientsWithReadings.sort((a,b) => (a.name||"").localeCompare(b.name||"")).map(c => (
          <option key={c.id} value={String(c.id)}>{c.name}</option>
        ))}
      </select>

      {clientsWithReadings.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" /><path d="M12 8v4l3 3" />
            </svg>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 6 }}>No readings yet</div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, maxWidth: 260, margin: "0 auto" }}>
            Water quality readings appear here once you log them on completed service stops.
          </div>
        </div>
      )}

      {client && availableParams.length === 0 && (
        <div style={{ textAlign: "center", padding: "32px 20px", color: T.textMuted, fontSize: 13 }}>
          No water readings logged for {client.name} yet.
        </div>
      )}

      {client && availableParams.length > 0 && (
        <>
          {/* Parameter chips — scrollable row */}
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
            {availableParams.map(p => <StatChip key={p} param={p} client={client} />)}
          </div>

          {/* Chart card */}
          <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, padding: "18px 18px 14px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{WATER_RANGES[selectedParam]?.label || selectedParam}</div>
              {range && <div style={{ fontSize: 11, color: T.textMuted }}>Healthy: {range.ideal}{range.unit}</div>}
            </div>
            <ChartSVG points={points} range={range} T={T} />
            {/* Out of range callout */}
            {range && points.some(p => p.val < range.min || p.val > range.max) && (
              <div style={{ marginTop: 10, background: hexA("#E5484D", 0.07), borderRadius: 10, padding: "9px 12px", fontSize: 12, color: "#E5484D", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="warning" size={13} />
                {points.filter(p => p.val < range.min || p.val > range.max).length} reading{points.filter(p => p.val < range.min || p.val > range.max).length !== 1 ? "s" : ""} outside healthy range
              </div>
            )}
          </div>

          {/* Reading history table */}
          <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            <div style={{ padding: "13px 18px", borderBottom: `1px solid ${T.border}`, fontSize: 13, fontWeight: 700, color: T.text }}>
              All {WATER_RANGES[selectedParam]?.label || selectedParam} Readings
            </div>
            {points.slice().reverse().map((p, i) => {
              const bad = range && (p.val < range.min || p.val > range.max);
              return (
                <div key={i} style={{ padding: "11px 18px", borderBottom: i < points.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13, color: T.textMuted }}>{p.date}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {bad && <span style={{ fontSize: 10, fontWeight: 700, color: "#E5484D", background: hexA("#E5484D", 0.1), padding: "2px 8px", borderRadius: 100 }}>OUT OF RANGE</span>}
                    <span style={{ fontSize: 15, fontWeight: 800, color: bad ? "#E5484D" : T.text, letterSpacing: "-0.01em" }}>
                      {p.val % 1 === 0 ? p.val : p.val.toFixed(2)}{range?.unit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function ServiceStopsReport({ clients, invoices, T }) {
  const now = new Date();

  // Period options
  const [mode, setMode] = useState("month");      // month | custom
  const [month, setMonth] = useState(now.getMonth());
  const [year,  setYear]  = useState(now.getFullYear());
  const [customStart, setCustomStart] = useState("");
  const [customEnd,   setCustomEnd]   = useState("");
  const [generating, setGenerating]   = useState(false);
  const [filterClient, setFilterClient] = useState("all");

  const MONTHS = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];

  // Build date range
  const range = (() => {
    if (mode === "custom" && customStart && customEnd) {
      return { start: new Date(customStart + "T00:00:00"), end: new Date(customEnd + "T23:59:59"), label: `${customStart} – ${customEnd}` };
    }
    const s = new Date(year, month, 1);
    const e = new Date(year, month + 1, 0, 23, 59, 59);
    return { start: s, end: e, label: `${MONTHS[month]} ${year}` };
  })();

  const inRange = (dateStr) => {
    if (!dateStr) return false;
    const [mm, dd, yy] = dateStr.split("/").map(Number);
    if (!mm || !dd || !yy) return false;
    const d = new Date(yy, mm - 1, dd);
    return d >= range.start && d <= range.end;
  };

  // Collect all completed stops (from client history) in range
  const allStops = [];
  (clients || []).forEach(c => {
    (c.history || []).forEach(h => {
      if (!inRange(h.date)) return;
      if (filterClient !== "all" && String(c.id) !== filterClient) return;
      allStops.push({ client: c, visit: h });
    });
  });

  // Group by client
  const byClient = {};
  allStops.forEach(({ client: c, visit: h }) => {
    if (!byClient[c.id]) byClient[c.id] = { client: c, visits: [] };
    byClient[c.id].visits.push(h);
  });

  // Sort each client's visits by date ascending
  Object.values(byClient).forEach(row => {
    row.visits.sort((a, b) => {
      const parse = (s) => { const [m,d,y] = (s||"").split("/").map(Number); return new Date(y,m-1,d); };
      return parse(a.date) - parse(b.date);
    });
  });

  const clientRows = Object.values(byClient).sort((a, b) =>
    (a.client.name || "").localeCompare(b.client.name || "")
  );

  const totalStops = allStops.length;
  const uniqueClients = clientRows.length;

  // PDF generation
  const generatePDF = async () => {
    setGenerating(true);
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "letter" });
      const W = doc.internal.pageSize.getWidth();
      const MARGIN = 40;
      let y = 40;
      const LINE_H = 16;
      const newPage = () => { doc.addPage(); y = 40; };
      const checkPage = (needed = 20) => { if (y + needed > 750) newPage(); };

      // Header
      doc.setFillColor("#AF011A");
      doc.rect(0, 0, W, 60, "F");
      doc.setTextColor("#ffffff");
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Stone Property Solutions", MARGIN, 30);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text("Service Stops Report", MARGIN, 46);
      doc.text(`${range.label}  ·  ${totalStops} stop${totalStops !== 1 ? "s" : ""}  ·  ${uniqueClients} client${uniqueClients !== 1 ? "s" : ""}`, W - MARGIN, 46, { align: "right" });
      y = 80;

      if (clientRows.length === 0) {
        doc.setTextColor("#6B7280");
        doc.setFontSize(12);
        doc.text("No service stops found for this period.", MARGIN, y);
      }

      clientRows.forEach(({ client: c, visits }) => {
        checkPage(40 + visits.length * 18);

        // Client header bar
        doc.setFillColor("#F5F5F7");
        doc.rect(MARGIN, y, W - MARGIN * 2, 22, "F");
        doc.setTextColor("#1D1D1F");
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.text(c.name || "Unknown", MARGIN + 8, y + 15);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor("#6B7280");
        const meta = [c.division, c.plan, c.address].filter(Boolean).join("  ·  ");
        doc.text(meta, W - MARGIN - 8, y + 15, { align: "right" });
        y += 26;

        // Column headers
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.setTextColor("#9CA3AF");
        doc.text("DATE",       MARGIN + 8,         y);
        doc.text("TYPE",       MARGIN + 80,         y);
        doc.text("TECHNICIAN", MARGIN + 240,        y);
        doc.text("SERVICES",   MARGIN + 340,        y);
        doc.text("INVOICE",    W - MARGIN - 8,      y, { align: "right" });
        y += 4;
        doc.setDrawColor("#E5E7EB");
        doc.line(MARGIN, y, W - MARGIN, y);
        y += 10;

        // Visit rows
        visits.forEach((h, vi) => {
          checkPage(18);
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          doc.setTextColor("#1D1D1F");

          const services = (h.services || []).map(s => typeof s === "string" ? s : s.name).join(", ") || "—";
          const servicesShort = services.length > 40 ? services.slice(0, 38) + "…" : services;

          doc.text(h.date || "—",                   MARGIN + 8,  y);
          doc.text((h.type || "Service Visit").slice(0, 22), MARGIN + 80,  y);
          doc.text((h.tech || "—").slice(0, 18),    MARGIN + 240, y);
          doc.text(servicesShort,                    MARGIN + 340, y);
          doc.setTextColor(h.invoice && h.invoice !== "$0" ? "#AF011A" : "#9CA3AF");
          doc.text(h.invoice || "—",                W - MARGIN - 8, y, { align: "right" });

          if (vi < visits.length - 1) {
            doc.setDrawColor("#F3F4F6");
            doc.line(MARGIN + 8, y + 4, W - MARGIN - 8, y + 4);
          }
          y += LINE_H;
          doc.setTextColor("#1D1D1F");
        });

        // Client total
        y += 4;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor("#6B7280");
        doc.text(`${visits.length} stop${visits.length !== 1 ? "s" : ""}`, MARGIN + 8, y);
        const clientInvs = (invoices || []).filter(iv => iv.clientId === c.id && inRange(iv.date || iv.createdAt));
        if (clientInvs.length) {
          const total = clientInvs.reduce((s, iv) => s + (parseFloat((iv.total||"0").replace(/[^0-9.-]/g,""))||0), 0);
          doc.setTextColor("#AF011A");
          doc.text(`$${total.toFixed(2)} invoiced`, W - MARGIN - 8, y, { align: "right" });
        }
        y += 20;
      });

      // Footer on last page
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor("#9CA3AF");
        doc.text(`Stone Property Solutions  ·  ${range.label}  ·  Page ${i} of ${pageCount}`, W / 2, 760, { align: "center" });
      }

      doc.save(`sps-service-report-${range.label.replace(/\s+/g, "-").toLowerCase()}.pdf`);
    } catch (e) {
      console.error("PDF error:", e);
    }
    setGenerating(false);
  };

  const YEARS = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);
  const field = { padding: "9px 12px", border: `1.5px solid ${T.border}`, borderRadius: 11, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Service Stops Report</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>Every completed stop per client — use this to audit billing at end of month.</div>
      </div>

      {/* Controls */}
      <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Period mode */}
        <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 11, padding: 3, gap: 3 }}>
          {[["month", "By Month"], ["custom", "Custom Range"]].map(([v, l]) => (
            <button key={v} onClick={() => setMode(v)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: "pointer", background: mode === v ? T.surface : "transparent", color: mode === v ? T.primary : T.textMuted, fontFamily: "inherit", boxShadow: mode === v ? "0 1px 4px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
              {l}
            </button>
          ))}
        </div>

        {/* Month/year picker */}
        {mode === "month" && (
          <div style={{ display: "flex", gap: 10 }}>
            <select value={month} onChange={e => setMonth(Number(e.target.value))} style={{ ...field, flex: 2 }}>
              {MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={{ ...field, flex: 1 }}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}

        {/* Custom range */}
        {mode === "custom" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ ...field, flex: 1 }} />
            <span style={{ color: T.textMuted, fontSize: 13 }}>to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ ...field, flex: 1 }} />
          </div>
        )}

        {/* Client filter */}
        <select value={filterClient} onChange={e => setFilterClient(e.target.value)} style={field}>
          <option value="all">All Clients ({uniqueClients} with stops)</option>
          {(clients || []).sort((a,b) => (a.name||"").localeCompare(b.name||"")).map(c => (
            <option key={c.id} value={String(c.id)}>{c.name}</option>
          ))}
        </select>

        {/* Generate PDF */}
        <button onClick={generatePDF} disabled={generating || (mode === "custom" && (!customStart || !customEnd))}
          style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 13, padding: "14px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: (generating || (mode === "custom" && (!customStart || !customEnd))) ? 0.5 : 1, boxShadow: `0 4px 16px ${hexA(T.primary, 0.3)}` }}>
          {generating
            ? <><div style={{ width: 16, height: 16, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> Generating PDF...</>
            : <><Icon name="download" size={16} /> Download PDF Report</>
          }
        </button>
      </div>

      {/* Summary strip */}
      <div style={{ display: "flex", gap: 10 }}>
        {[
          { label: "Period", value: range.label },
          { label: "Total Stops", value: totalStops },
          { label: "Clients", value: uniqueClients },
        ].map(s => (
          <div key={s.label} style={{ flex: 1, background: T.surface, borderRadius: 14, border: `1px solid ${T.border}`, padding: "14px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Per-client breakdown */}
      {clientRows.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: T.textMuted }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}><Icon name="calendar" size={28} /></div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 6 }}>No stops found</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>No completed service stops for {range.label}. Stops are logged when you mark them complete in the Schedule tab.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {clientRows.map(({ client: c, visits }) => {
            const clientInvs = (invoices || []).filter(iv => iv.clientId === c.id && inRange(iv.date || iv.createdAt));
            const invoiced = clientInvs.reduce((s, iv) => s + (parseFloat((iv.total||"0").replace(/[^0-9.-]/g,""))||0), 0);
            return (
              <div key={c.id} style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden" }}>
                {/* Client header */}
                <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{c.division} · {c.plan} · {visits.length} stop{visits.length !== 1 ? "s" : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {invoiced > 0 ? (
                      <div style={{ fontSize: 15, fontWeight: 800, color: T.primary }}>${invoiced.toFixed(2)}</div>
                    ) : (
                      <div style={{ fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>Not yet invoiced</div>
                    )}
                    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{invoiced > 0 ? "invoiced this period" : ""}</div>
                  </div>
                </div>

                {/* Visit rows */}
                {visits.map((h, i) => {
                  const services = (h.services || []).map(s => typeof s === "string" ? s : s.name).join(", ");
                  return (
                    <div key={i} style={{ padding: "12px 18px", borderBottom: i < visits.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", alignItems: "flex-start", gap: 14 }}>
                      {/* Date pill */}
                      <div style={{ background: hexA(T.primary, 0.08), borderRadius: 9, padding: "5px 10px", flexShrink: 0, textAlign: "center" }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: T.primary, letterSpacing: "-0.01em" }}>
                          {(() => { const [m,d] = (h.date||"").split("/"); return `${m}/${d}`; })()}
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{h.type || "Service Visit"}</div>
                        {h.tech && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{h.tech}</div>}
                        {services && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3, lineHeight: 1.4 }}>{services}</div>}
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        {h.invoice && h.invoice !== "$0"
                          ? <div style={{ fontSize: 13, fontWeight: 700, color: T.primary }}>{h.invoice}</div>
                          : <div style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>—</div>
                        }
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReportsScreen({ clients, invoices, schedule, costs, T }) {
  const [period, setPeriod] = useState("month"); // month | quarter | year | all

  const now = new Date();
  const periodStart = (() => {
    const d = new Date(now);
    if (period === "month")   { d.setDate(1); d.setHours(0,0,0,0); return d; }
    if (period === "quarter") { d.setMonth(Math.floor(d.getMonth()/3)*3,1); d.setHours(0,0,0,0); return d; }
    if (period === "year")    { d.setMonth(0,1); d.setHours(0,0,0,0); return d; }
    return new Date(0);
  })();

  const inPeriod = (ts) => ts && new Date(ts) >= periodStart;

  // ── Revenue ──
  // Parse any date format — QB uses YYYY-MM-DD, SPS uses MM/DD/YYYY
  const parseDate = (s) => {
    if (!s) return null;
    if (typeof s === "number") return new Date(s);
    if (typeof s === "string" && s.includes("/")) {
      const [m, d, y] = s.split("/").map(Number);
      return (m && d && y) ? new Date(y, m-1, d) : null;
    }
    if (typeof s === "string" && s.includes("-")) {
      const d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  };

  const isPaid = (iv) => {
    const s = (iv.status || "").toLowerCase();
    return s === "paid";
  };

  const ivTotal = (iv) => invoiceTotals(iv).total;

  const ivDate = (iv) => parseDate(iv.paidDate || iv.date) || new Date(iv.createdAt || 0);

  const inPeriodIv = (iv) => ivDate(iv) >= periodStart;

  const allInvoices   = invoices || [];
  const periodPaid    = allInvoices.filter(iv => isPaid(iv) && inPeriodIv(iv));
  const openInvoices  = allInvoices.filter(iv => !isPaid(iv) && iv.status !== "Draft" && iv.status !== "draft");

  const sumTotal = (arr) => arr.reduce((s, iv) => s + ivTotal(iv), 0);
  const revenue   = sumTotal(periodPaid);
  const pipeline  = sumTotal(openInvoices);
  const allRevenue = sumTotal(allInvoices.filter(isPaid));

  // ── Jobs ──
  const allHistory = (clients||[]).flatMap(c => (c.history||[]).map(h => ({ ...h, clientId: c.id, division: c.division })));
  const periodJobs = allHistory.filter(h => {
    const d = parseDate(h.date);
    return d && d >= periodStart;
  });
  const jobsByDivision = { Pond: 0, Pool: 0, Seasonal: 0 };
  periodJobs.forEach(h => { jobsByDivision[h.division] = (jobsByDivision[h.division]||0) + 1; });

  // ── Clients ──
  const activeClients = (clients||[]).filter(c => c.status === "Active");
  const byDivision = { Pond: 0, Pool: 0, Seasonal: 0 };
  activeClients.forEach(c => { byDivision[c.division] = (byDivision[c.division]||0) + 1; });

  // ── Satisfaction ──
  const allHistoryWithRatings = allHistory.filter(h => h.satisfaction > 0);
  const periodRatings  = periodJobs.filter(h => h.satisfaction > 0);
  const avgSatisfaction = periodRatings.length
    ? (periodRatings.reduce((s, h) => s + h.satisfaction, 0) / periodRatings.length).toFixed(1)
    : null;
  const allTimeAvgSat = allHistoryWithRatings.length
    ? (allHistoryWithRatings.reduce((s, h) => s + h.satisfaction, 0) / allHistoryWithRatings.length).toFixed(1)
    : null;

  // ── Referrals ──
  const referralBreakdown = {};
  activeClients.forEach(c => {
    const src = c.referralSource || "Unknown";
    referralBreakdown[src] = (referralBreakdown[src] || 0) + 1;
  });
  const topReferralSources = Object.entries(referralBreakdown)
    .filter(([k]) => k !== "Unknown" && k !== "")
    .sort((a, b) => b[1] - a[1]);

  // ── Schedule ──
  const periodStops = (schedule||[])
    .filter(d => inPeriod(d.date))
    .flatMap(d => d.stops||[]);

  // ── Monthly revenue trend (last 6 months) ──
  const monthlyRevenue = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - (5 - i));
    const label = d.toLocaleDateString("en-US", { month: "short" });
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    const total = sumTotal(allInvoices.filter(iv => {
      const dt = ivDate(iv);
      return isPaid(iv) && dt >= start && dt <= end;
    }));
    return { label, total };
  });
  const maxBar = Math.max(...monthlyRevenue.map(m => m.total), 1);

  const money = (n) => { const v = parseFloat(n) || 0; return v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(0)}`; };
  const pct = (n, total) => total ? Math.round((n/total)*100) : 0;

  const PERIODS = [
    { id: "month",   label: "This Month" },
    { id: "quarter", label: "Quarter" },
    { id: "year",    label: "This Year" },
    { id: "all",     label: "All Time" },
  ];

  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );

  const [reportTab, setReportTab] = useState("overview");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ paddingTop: 4, marginBottom: 14 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Reports</div>
      </div>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 12, padding: 4, marginBottom: 16, gap: 3 }}>
        {[["overview", "Overview"], ["stops", "Service Stops"], ["water", "Water Quality"]].map(([id, label]) => (
          <button key={id} onClick={() => setReportTab(id)} style={{ flex: 1, padding: "9px 4px", border: "none", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", background: reportTab === id ? T.surface : "transparent", color: reportTab === id ? T.primary : T.textMuted, boxShadow: reportTab === id ? "0 1px 4px rgba(0,0,0,0.1)" : "none", fontFamily: "inherit", transition: "all 0.15s" }}>
            {label}
          </button>
        ))}
      </div>

      {reportTab === "stops" && (
        <ServiceStopsReport clients={clients} invoices={invoices} T={T} />
      )}
      {reportTab === "water" && (
        <WaterQualityTrends clients={clients} T={T} />
      )}

      {reportTab === "overview" && <>

      {/* Period selector */}
      <div style={{ display: "flex", background: T.surfaceAlt, borderRadius: 12, padding: 4, marginBottom: 20, gap: 3 }}>
        {PERIODS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{ flex: 1, padding: "8px 4px", border: "none", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", background: period === p.id ? T.surface : "transparent", color: period === p.id ? T.primary : T.textMuted, boxShadow: period === p.id ? "0 1px 4px rgba(0,0,0,0.1)" : "none", fontFamily: "inherit", transition: "all 0.15s" }}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Revenue */}
      <Section title="Revenue">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          {[
            { label: "Collected", value: money(revenue), sub: `${periodPaid.length} invoices`, color: T.accent },
            { label: "Outstanding", value: money(pipeline), sub: `${openInvoices.length} open`, color: T.warning },
          ].map(s => (
            <div key={s.label} style={{ background: T.surface, borderRadius: 16, padding: "16px 16px", border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: s.color, letterSpacing: "-0.03em" }}>{s.value}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Monthly bar chart */}
        <div style={{ background: T.surface, borderRadius: 16, padding: "18px 16px", border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 14 }}>6-Month Revenue Trend</div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 80 }}>
            {monthlyRevenue.map((m, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600 }}>{m.total > 0 ? money(m.total) : ""}</div>
                <div style={{ width: "100%", background: i === monthlyRevenue.length-1 ? T.primary : hexA(T.primary, 0.3), borderRadius: "4px 4px 0 0", height: `${Math.max(4, (m.total/maxBar)*60)}px`, transition: "height 0.3s" }} />
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600 }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Jobs & Activity */}
      <Section title="Jobs & Activity">
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {[
            { label: "Service Visits", value: periodJobs.length, sub: `${periodStops.length} scheduled stops` },
            { label: "Avg Visits / Client", value: activeClients.length ? (periodJobs.length / activeClients.length).toFixed(1) : "0", sub: "active clients" },
            { label: "Pond Jobs", value: jobsByDivision.Pond, sub: `${pct(jobsByDivision.Pond, periodJobs.length)}% of total` },
            { label: "Pool Jobs", value: jobsByDivision.Pool, sub: `${pct(jobsByDivision.Pool, periodJobs.length)}% of total` },
            { label: "Seasonal Jobs", value: jobsByDivision.Seasonal, sub: `${pct(jobsByDivision.Seasonal, periodJobs.length)}% of total` },
          ].map((row, i, arr) => (
            <div key={row.label} style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length-1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>{row.label}</div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{row.value}</div>
                <div style={{ fontSize: 11, color: T.textMuted }}>{row.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Satisfaction */}
      {allHistoryWithRatings.length > 0 && (
        <Section title="Client Satisfaction">
          <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            <div style={{ padding: "20px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: 13, color: T.textMuted }}>Avg Rating — {PERIODS.find(p => p.id === period)?.label}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{periodRatings.length} rated visits</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 28, fontWeight: 900, color: "#F59E0B" }}>{avgSatisfaction || "—"}</div>
                {avgSatisfaction && <div style={{ fontSize: 12, color: "#F59E0B" }}>{"★".repeat(Math.round(parseFloat(avgSatisfaction)))}</div>}
              </div>
            </div>
            {[1,2,3,4,5].reverse().map(star => {
              const count = allHistoryWithRatings.filter(h => h.satisfaction === star).length;
              const pctStar = allHistoryWithRatings.length ? Math.round((count / allHistoryWithRatings.length) * 100) : 0;
              return (
                <div key={star} style={{ padding: "10px 18px", display: "flex", alignItems: "center", gap: 12, borderBottom: star > 1 ? `1px solid ${T.border}` : "none" }}>
                  <span style={{ fontSize: 13, color: "#F59E0B", width: 70, flexShrink: 0 }}>{"★".repeat(star)}{"☆".repeat(5-star)}</span>
                  <div style={{ flex: 1, height: 8, background: T.surfaceAlt, borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ width: `${pctStar}%`, height: "100%", background: "#F59E0B", borderRadius: 4, transition: "width 0.5s ease" }} />
                  </div>
                  <span style={{ fontSize: 12, color: T.textMuted, width: 30, textAlign: "right", flexShrink: 0 }}>{count}</span>
                </div>
              );
            })}
            <div style={{ padding: "10px 18px", fontSize: 12, color: T.textMuted }}>
              All-time average: <strong style={{ color: T.text }}>{allTimeAvgSat || "—"}</strong> from {allHistoryWithRatings.length} visits
            </div>
          </div>
        </Section>
      )}

      {/* Referrals */}
      {topReferralSources.length > 0 && (
        <Section title="Referral Sources">
          <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            {topReferralSources.map(([src, count], i) => (
              <div key={src} style={{ padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < topReferralSources.length - 1 ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>{src}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 80, height: 6, background: T.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${pct(count, activeClients.length)}%`, height: "100%", background: T.primary, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: T.text, width: 24, textAlign: "right" }}>{count}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Client base */}
      <Section title="Client Base">
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {[
            { label: "Total Active Clients", value: activeClients.length },
            { label: "Pond Clients", value: byDivision.Pond, sub: `${pct(byDivision.Pond, activeClients.length)}%` },
            { label: "Pool Clients", value: byDivision.Pool, sub: `${pct(byDivision.Pool, activeClients.length)}%` },
            { label: "Seasonal Clients", value: byDivision.Seasonal, sub: `${pct(byDivision.Seasonal, activeClients.length)}%` },
            { label: "All-Time Revenue / Client", value: activeClients.length ? money(activeClients.length ? allRevenue / activeClients.length : 0) : "$0", sub: "average" },
          ].map((row, i, arr) => (
            <div key={row.label} style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length-1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>{row.label}</div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{row.value}</div>
                {row.sub && <div style={{ fontSize: 11, color: T.textMuted }}>{row.sub}</div>}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Invoice health */}
      <Section title="Invoice Health">
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {[
            { label: "Invoices Sent", value: allInvoices.length },
            { label: "Paid", value: allInvoices.filter(iv => iv.status === "paid").length, color: T.accent },
            { label: "Outstanding", value: openInvoices.length, color: T.warning },
            { label: "Collection Rate", value: `${pct(allInvoices.filter(iv=>iv.status==="paid").length, allInvoices.length)}%`, color: T.accent },
            { label: "Total Outstanding", value: money(pipeline), color: pipeline > 0 ? T.warning : T.accent },
          ].map((row, i, arr) => (
            <div key={row.label} style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: i < arr.length-1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>{row.label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: row.color || T.text }}>{row.value}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Top clients by visits */}
      <Section title="Most Active Clients">
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {(clients||[])
            .map(c => ({ c, visits: (c.history||[]).length }))
            .sort((a,b) => b.visits - a.visits)
            .slice(0, 5)
            .map(({ c, visits }, i, arr) => (
              <div key={c.id} style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, borderBottom: i < arr.length-1 ? `1px solid ${T.border}` : "none" }}>
                <div style={{ width: 36, height: 36, borderRadius: 11, background: hexA(T.primary, 0.1), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, flexShrink: 0 }}>
                  {(c.name||"?")[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: T.textMuted }}>{c.division}{c.plan ? ` · ${c.plan}` : ""}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{visits} <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 500 }}>visits</span></div>
              </div>
            ))}
          {(clients||[]).length === 0 && (
            <div style={{ padding: "24px", textAlign: "center", color: T.textMuted, fontSize: 13 }}>No client data yet.</div>
          )}
        </div>
      </Section>
      </>}
    </div>
  );
}

// All available pages — the user picks up to 5 for their dock
const ALL_NAV = [
  { id: "dashboard",  label: "Home",      icon: "home" },
  { id: "clients",    label: "Clients",   icon: "clients" },
  { id: "schedule",   label: "Schedule",  icon: "calendar" },
  { id: "messages",   label: "Messages",  icon: "message" },
  { id: "invoices",   label: "Invoices",  icon: "invoice",   perm: "canInvoice" },
  { id: "estimates",  label: "Estimates", icon: "clipboard", perm: "canInvoice" },
  { id: "inventory",  label: "Inventory", icon: "info",      ownerOnly: true },
  { id: "reports",    label: "Reports",   icon: "dollar",    ownerOnly: true },
  { id: "settings",   label: "Customize", icon: "sliders" },
];

const DEFAULT_DOCK = ["dashboard", "clients", "schedule", "messages", "settings"];

// ─────────────────────────────────────────────
// OVERFLOW MENU + DOCK EDITOR
// Top-right menu showing all pages not in the dock,
// plus account info and the ability to edit the dock.
// ─────────────────────────────────────────────

function OverflowMenu({ page, perms, navUnread, dockIds, setDockIds, onNav, onSignOut, currentUser, T, branding, onClose }) {
  const availableNav = ALL_NAV.filter(n => {
    if (n.ownerOnly && !perms.isAdmin) return false;
    if (n.perm && !perms[n.perm]) return false;
    return true;
  });

  const overflow = availableNav.filter(n => !dockIds.includes(n.id));

  // ── Drag state ──
  const dragIdx = useRef(null);    // index being dragged in dockIds
  const dragOver = useRef(null);   // index currently hovered
  const [dragging, setDragging] = useState(null); // id of item being dragged
  const itemRefs = useRef({});

  const toggleDock = (id) => {
    setDockIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 5) return prev;
      return [...prev, id];
    });
  };

  // ── Touch drag handlers ──
  const onTouchStart = (e, id) => {
    dragIdx.current = dockIds.indexOf(id);
    dragOver.current = dragIdx.current;
    setDragging(id);
  };

  const onTouchMove = (e) => {
    if (dragIdx.current === null) return;
    e.preventDefault();
    const touch = e.touches[0];
    // Find which row the finger is over by checking bounding rects
    let overIdx = dragOver.current;
    Object.entries(itemRefs.current).forEach(([id, el]) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        const idx = dockIds.indexOf(id);
        if (idx !== -1) overIdx = idx;
      }
    });
    if (overIdx !== dragOver.current) {
      dragOver.current = overIdx;
      // Reorder in real time
      setDockIds(prev => {
        const arr = [...prev];
        const from = dragIdx.current;
        const to = overIdx;
        if (from === to || from === null) return prev;
        const item = arr.splice(from, 1)[0];
        arr.splice(to, 0, item);
        dragIdx.current = to; // update so next move is relative to new position
        return arr;
      });
    }
  };

  const onTouchEnd = () => {
    dragIdx.current = null;
    dragOver.current = null;
    setDragging(null);
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }} />

      {/* Sheet */}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 201, width: "min(320px, 88vw)", background: T.surface, boxShadow: "-8px 0 40px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)" }}>

        {/* Header */}
        <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: T.primary, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13 }}>
              {initials(currentUser.name)}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{currentUser.name}</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>{roleLabel(currentUser.role)}</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: T.surfaceAlt, border: "none", borderRadius: "50%", width: 30, height: 30, cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: dragging ? "hidden" : "auto", padding: "16px 0" }}>

          {/* Overflow pages — not in dock */}
          {overflow.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, padding: "0 20px 8px" }}>More</div>
              {overflow.map(n => {
                const active = page === n.id;
                return (
                  <button key={n.id} onClick={() => { onNav(n.id); onClose(); }}
                    style={{ width: "100%", padding: "12px 20px", background: active ? hexA(T.primary, 0.08) : "none", border: "none", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 11, background: active ? hexA(T.primary, 0.15) : T.surfaceAlt, color: active ? T.primary : T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative" }}>
                      <Icon name={n.icon} size={18} />
                      {n.id === "messages" && navUnread > 0 && (
                        <span style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, borderRadius: "50%", background: T.primary, border: `2px solid ${T.surface}` }} />
                      )}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: active ? 700 : 500, color: active ? T.primary : T.text }}>{n.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Divider */}
          <div style={{ height: 1, background: T.border, margin: "8px 0" }} />

          {/* Dock editor — drag to reorder */}
          <div style={{ padding: "12px 20px 0" }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, marginBottom: 4 }}>Bottom Bar ({dockIds.length}/5)</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Drag to reorder. Tap Remove to free up a slot.</div>
            </div>

            {/* Dock items — draggable */}
            <div onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
              {dockIds.map((id) => {
                const n = ALL_NAV.find(x => x.id === id);
                if (!n) return null;
                const isDragging = dragging === id;
                return (
                  <div
                    key={id}
                    ref={el => { itemRefs.current[id] = el; }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "10px 0", borderBottom: `1px solid ${T.border}`,
                      background: isDragging ? hexA(T.primary, 0.06) : "transparent",
                      borderRadius: isDragging ? 12 : 0,
                      transition: "background 0.15s",
                      transform: isDragging ? "scale(1.01)" : "scale(1)",
                      opacity: isDragging ? 0.85 : 1,
                    }}
                  >
                    {/* Drag handle */}
                    <div
                      onTouchStart={e => onTouchStart(e, id)}
                      style={{ padding: "4px 6px", color: T.textMuted, cursor: "grab", touchAction: "none", display: "flex", flexDirection: "column", gap: 3, flexShrink: 0 }}>
                      {[0,1,2].map(i => (
                        <div key={i} style={{ display: "flex", gap: 3 }}>
                          {[0,1].map(j => (
                            <div key={j} style={{ width: 3, height: 3, borderRadius: "50%", background: T.textMuted, opacity: 0.5 }} />
                          ))}
                        </div>
                      ))}
                    </div>

                    <div style={{ width: 32, height: 32, borderRadius: 9, background: hexA(T.primary, 0.1), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon name={n.icon} size={16} />
                    </div>
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>{n.label}</div>
                    <button onClick={() => toggleDock(id)}
                      style={{ background: hexA("#E5484D", 0.1), color: "#E5484D", border: "none", borderRadius: 10, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Available to add */}
            {availableNav.filter(n => !dockIds.includes(n.id)).length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, marginBottom: 10 }}>Add to Bottom Bar</div>
                {availableNav.filter(n => !dockIds.includes(n.id)).map(n => (
                  <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: T.surfaceAlt, color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon name={n.icon} size={16} />
                    </div>
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>{n.label}</div>
                    <button onClick={() => toggleDock(n.id)}
                      disabled={dockIds.length >= 5}
                      style={{ background: dockIds.length >= 5 ? T.surfaceAlt : hexA(T.primary, 0.1), color: dockIds.length >= 5 ? T.textMuted : T.primary, border: "none", borderRadius: 10, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: dockIds.length >= 5 ? "default" : "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                      {dockIds.length >= 5 ? "Full" : "Add"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 14, lineHeight: 1.5, paddingBottom: 8 }}>
              Drag the <span style={{ fontWeight: 700 }}>⠿</span> handle to reorder. Max 5 items in the bottom bar.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${T.border}`, paddingBottom: "calc(14px + env(safe-area-inset-bottom))", display: "flex", gap: 10 }}>
          <button onClick={() => window.location.reload()}
            style={{ background: T.surfaceAlt, border: "none", borderRadius: 12, padding: "10px 16px", fontSize: 13, fontWeight: 600, color: T.textMuted, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="refresh" size={15} /> Sync
          </button>
          <button onClick={onSignOut}
            style={{ flex: 1, background: hexA("#E5484D", 0.08), border: "none", borderRadius: 12, padding: "10px", fontSize: 13, fontWeight: 700, color: "#E5484D", cursor: "pointer", fontFamily: "inherit" }}>
            Sign Out
          </button>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// CLIENT PORTAL
// Full client-facing experience. Rendered when the
// logged-in email matches a client record (not a staff member).
// ─────────────────────────────────────────────

const CLIENT_NAV = [
  { id: "cp_home",      label: "Home",       icon: "home" },
  { id: "cp_property",  label: "My Property", icon: "pond" },  // combined pond + service
  { id: "cp_messages",  label: "Messages",   icon: "message" },
  { id: "cp_invoices",  label: "Invoices",   icon: "invoice" },
];

// Tier → frequency mapping (single source of truth)
const TIER_FREQ = {
  "Essential":  "Monthly",
  "Signature":  "Bi-Weekly",
  "Premium":    "Weekly",
};

// Per-division tier defaults — each division has its own plan set
const makeDivisionTiers = (div) => ({
  "Essential": {
    color: "#6B7280", price: "", upgradeTo: "Signature",
    tagline: div === "Pond" ? "Reliable pond care" : div === "Pool" ? "Basic pool service" : "Core seasonal service",
    includes: div === "Pond"
      ? ["Monthly service visits","Basic water quality checks","Filter maintenance","Seasonal adjustments"]
      : div === "Pool"
      ? ["Monthly pool service","Chemical balancing","Filter check","Skimmer cleaning"]
      : ["One seasonal service","Debris removal","Basic cleanup"],
  },
  "Signature": {
    color: "#B81D24", price: "", upgradeTo: "Premium",
    tagline: div === "Pond" ? "Our most popular plan" : div === "Pool" ? "Complete pool care" : "Full seasonal package",
    includes: div === "Pond"
      ? ["Bi-weekly service visits","Full water chemistry testing","Filter + skimmer cleaning","Algae & debris treatment","Priority scheduling","Photo documentation each visit"]
      : div === "Pool"
      ? ["Bi-weekly service","Full chemical testing","Equipment inspection","Algae prevention","Priority scheduling"]
      : ["Multiple seasonal visits","Full property cleanup","Gutter cleaning","Priority scheduling"],
  },
  "Premium": {
    color: "#AF011A", price: "", upgradeTo: null,
    tagline: div === "Pond" ? "White-glove pond care" : div === "Pool" ? "Premium pool service" : "White-glove property care",
    includes: div === "Pond"
      ? ["Weekly service visits","Comprehensive water testing","Equipment health monitoring","Same-day emergency response","Seasonal startup & closing","Annual equipment inspection","Dedicated technician"]
      : div === "Pool"
      ? ["Weekly service","Comprehensive water testing","Equipment monitoring","Same-day emergency response","Opening & closing service","Dedicated technician"]
      : ["Unlimited seasonal visits","Full property maintenance","Snow removal included","Same-day emergency response","Dedicated crew"],
  },
});

const DEFAULT_TIERS = {
  _meta: {
    // Ordered list of active divisions — edit to add/remove/rename
    divisions: ["Pond", "Pool", "Seasonal"],
    // Global tier names (apply across all divisions unless overridden)
    tierNames: ["Essential", "Signature", "Premium"],
    // Per-division display labels (for portal + app UI)
    divisionLabels: {
      Pond:     { singular: "Pond",     plural: "Ponds",      portalLabel: "My Pond" },
      Pool:     { singular: "Pool",     plural: "Pools",      portalLabel: "My Pool" },
      Seasonal: { singular: "Property", plural: "Properties", portalLabel: "My Property" },
    },
  },
  Pond:     makeDivisionTiers("Pond"),
  Pool:     makeDivisionTiers("Pool"),
  Seasonal: makeDivisionTiers("Seasonal"),
};

// CP_TIERS is loaded from stored state in App — this is just the reference
// Individual components read from the `tiers` context via useApp()
let CP_TIERS = DEFAULT_TIERS;
// Helper: get tiers for a specific division
const divTiers = (tiers, div) => (tiers || DEFAULT_TIERS)[div] || (tiers || DEFAULT_TIERS)["Pond"] || DEFAULT_TIERS["Pond"];

// Helper: get active divisions list from stored tiers
const getDivisions = (tiers) => ((tiers || DEFAULT_TIERS)._meta?.divisions) || DEFAULT_TIERS._meta.divisions;

// Helper: get tier names for a division
const getTierNames = (tiers, div) => {
  const t = (tiers || DEFAULT_TIERS);
  // Per-division tier names take precedence, fall back to global tier names
  const divData = t[div] || {};
  const globalNames = t._meta?.tierNames || DEFAULT_TIERS._meta.tierNames;
  return divData._tierNames || globalNames;
};

function clientNextVisit(schedule, clientId) {
  const today = new Date(); today.setHours(0,0,0,0);
  let best = null;
  (schedule || []).forEach(day => {
    (day.stops || []).forEach(stop => {
      if (stop.clientId !== clientId) return;
      const d = new Date(day.date);
      if (isNaN(d)) return;
      if (d >= today && (!best || d < best.date)) best = { date: d, label: day.date, stop };
    });
  });
  return best;
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ── CLIENT NAV ICON ──
function CIcon({ name, size = 22 }) {
  // Stroke-based icons (cleaner on dark nav)
  const icons = {
    home: (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9.5z"/>
        <path d="M9 21V12h6v9"/>
      </svg>
    ),
    service: (
      // Shield check — representing a service plan/agreement
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6l-8-4z"/>
        <polyline points="9 12 11 14 15 10"/>
      </svg>
    ),
    pond: (
      // Water drop / waves — representing a pond or pool
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2C6.5 2 2 8 2 12c0 5.5 4.5 10 10 10s10-4.5 10-10c0-4-4.5-10-10-10z"/>
        <path d="M7 15c1-1 2-1.5 3-1.5s2 .5 4 .5 3-.5 3-1.5"/>
      </svg>
    ),
    invoice: (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <path d="M9 7h6M9 11h6M9 15h4"/>
      </svg>
    ),
    plus: (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    ),
    history: (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <polyline points="12 7 12 12 15 15"/>
      </svg>
    ),
    message: (
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    ),
  };
  return icons[name] || icons.home;
}

// ── CP HOME ──
function CPHome({ client, schedule, invoices, branding, onNav, T }) {
  const next = clientNextVisit(schedule, client.id);
  const myInvoices = sortInvoices((invoices || []).filter(iv => invoiceMatchesClient(iv, client)));
  const outstanding = myInvoices.filter(iv => !["Paid","paid"].includes(effectiveStatus(iv)) && iv.status !== "Draft");
  const totalOwed = outstanding.reduce((s, iv) => s + invoiceTotals(iv).total, 0);
  const recentHistory = (client.history || []).slice(0, 3);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (client.name || "").split(" ")[0] || "there";
  const tier = client.plan ? (CP_TIERS[client.plan] || CP_TIERS["Signature"]) : null;
  const tierColor = tier?.color || T.surfaceAlt;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* Greeting */}
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: T.text, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
          {greeting},<br /><span style={{ color: T.primary }}>{firstName}.</span>
        </div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 8 }}>
          {branding.portalTagline || `Welcome to your ${branding.companyName} portal`}
        </div>
      </div>

      {/* Hero: Next Visit + Tier combined card */}
      <div style={{ background: tier ? `linear-gradient(145deg, ${tierColor} 0%, ${mix(tierColor, "#000", 0.3)} 100%)` : `linear-gradient(145deg, ${T.surfaceAlt} 0%, ${T.border} 100%)`, borderRadius: 26, padding: "24px 22px", color: tier ? "#fff" : T.text, boxShadow: tier ? `0 12px 40px ${hexA(tierColor, 0.4)}` : "none", position: "relative", overflow: "hidden", border: tier ? "none" : `1px solid ${T.border}` }}>
        {/* Decorative circles */}
        <div style={{ position: "absolute", right: -30, top: -30, width: 160, height: 160, borderRadius: "50%", background: "rgba(255,255,255,0.06)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", right: 30, bottom: -50, width: 120, height: 120, borderRadius: "50%", background: "rgba(255,255,255,0.04)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: -20, bottom: -20, width: 80, height: 80, borderRadius: "50%", background: "rgba(255,255,255,0.03)", pointerEvents: "none" }} />

        {/* Tier badge */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
          <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 100, padding: "5px 14px", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>{client.plan ? `${client.plan} Plan` : "No Service Tier"}</span>
          </div>
          <button onClick={() => onNav("cp_service")}
            style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 100, padding: "5px 14px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}>
            Details →
          </button>
        </div>

        {/* Next visit */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.65, marginBottom: 6 }}>Next Service Visit</div>
        {next ? (
          <>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{fmtDate(next.label)}</div>
            <div style={{ fontSize: 14, opacity: 0.8, marginTop: 6, fontWeight: 500 }}>{next.stop.type || "Service Visit"}</div>
          </>
        ) : (
          <div style={{ fontSize: 18, fontWeight: 700, opacity: 0.75 }}>No upcoming visits scheduled</div>
        )}
      </div>

      {/* Balance due — urgent card */}
      {totalOwed > 0 && (
        <button onClick={() => onNav("cp_invoices")}
          style={{ background: T.surface, border: `1.5px solid ${hexA("#E5484D", 0.3)}`, borderRadius: 20, padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, cursor: "pointer", fontFamily: "inherit", width: "100%", boxSizing: "border-box", boxShadow: `0 4px 20px ${hexA("#E5484D", 0.1)}`, textAlign: "left" }}>
          <div style={{ width: 44, height: 44, borderRadius: 14, background: hexA("#E5484D", 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#E5484D" strokeWidth={2} strokeLinecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#E5484D", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 3 }}>Balance Due</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>${totalOwed.toFixed(2)}</div>
          </div>
          <div style={{ fontSize: 13, color: "#E5484D", fontWeight: 700 }}>Pay →</div>
        </button>
      )}

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          { label: "Visits", value: (client.history||[]).length, page: "cp_pond" },
          { label: "Invoices", value: myInvoices.length, page: "cp_invoices" },
          { label: "Equipment", value: (client.equipment||[]).length, page: null },
        ].map(s => (
          <button key={s.label} onClick={() => s.page && onNav(s.page)}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "16px 10px", textAlign: "center", cursor: s.page ? "pointer" : "default", fontFamily: "inherit" }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{s.value}</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, fontWeight: 600 }}>{s.label}</div>
          </button>
        ))}
      </div>

      {/* Recent visits */}
      {recentHistory.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Recent Visits</div>
            <button onClick={() => onNav("cp_pond")} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>See all</button>
          </div>
          <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, overflow: "hidden" }}>
            {recentHistory.map((h, i) => {
              const readings = h.readings && Object.keys(h.readings).length ? h.readings : null;
              return (
                <div key={i} style={{ padding: "15px 18px", borderBottom: i < recentHistory.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", gap: 14, alignItems: "center" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 13, background: hexA(T.primary, 0.08), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" width={20} height={20} fill={T.primary}><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{h.type || "Service Visit"}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{fmtDate(h.date)}{h.tech ? ` · ${h.tech}` : ""}</div>
                  </div>
                  {readings && (
                    <div style={{ fontSize: 11, color: T.primary, fontWeight: 700, background: hexA(T.primary, 0.08), borderRadius: 8, padding: "3px 8px" }}>
                      pH {Object.values(readings)[0]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Quick actions grid */}
      <div>
        <div style={{ fontSize: 16, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 12 }}>Quick Actions</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "My Service Plan", sub: client.plan ? `${client.plan} — tap to manage` : "No tier assigned", icon: "clients", page: "cp_service", accent: !!client.plan },
            { label: "Messages", sub: "Chat with our team", icon: "message", page: "cp_messages", accent: false },
            { label: "My Property", sub: `${pondLabel(client)} · ${(client.history||[]).length} visits`, icon: "history", page: "cp_property", accent: false },
            { label: "My Invoices", sub: outstanding.length ? `${outstanding.length} outstanding` : "All paid up", icon: "invoice", page: "cp_invoices", accent: false },
          ].map(q => (
            <button key={q.page} onClick={() => onNav(q.page)}
              style={{ background: q.accent ? hexA(T.primary, 0.06) : T.surface, border: `1.5px solid ${q.accent ? hexA(T.primary, 0.2) : T.border}`, borderRadius: 20, padding: "18px 16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
              <div style={{ width: 40, height: 40, borderRadius: 13, background: q.accent ? T.primary : hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12, color: q.accent ? "#fff" : T.primary }}>
                <CIcon name={q.icon} size={20} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em", lineHeight: 1.2 }}>{q.label}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, lineHeight: 1.4 }}>{q.sub}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── CP UPGRADE REQUEST ──
// Multi-step upgrade interest flow shown to the client.
// Step 1: Compare tiers. Step 2: Write a message. Step 3: Confirmation.
function CPUpgradeRequest({ client, currentPlan, currentTier, upgradePlan, upgradeTier, upgradeOptions = [], tiers, branding, onSubmit, T }) {
  const [step, setStep] = useState("browse");   // browse | message | done
  const [selectedPlan, setSelectedPlan] = useState(upgradePlan);
  const [message, setMessage] = useState("");
  const allTiers = tiers || CP_TIERS;

  // upgradeOptions passed in from CPService (all tiers strictly above current)

  const chosen = allTiers[selectedPlan] || upgradeTier;
  const newItems = (chosen?.includes || []).filter(item => !(currentTier?.includes || []).includes(item));

  const handleSubmit = () => {
    if (!selectedPlan) return;
    onSubmit({
      clientId: client.id,
      clientName: client.name,
      currentPlan,
      requestedPlan: selectedPlan,
      message: message.trim(),
      submittedAt: Date.now(),
    });
    setStep("done");
  };

  if (step === "done") {
    return (
      <div style={{ background: T.surface, borderRadius: 22, border: `1px solid ${T.border}`, padding: "32px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: hexA("#16a34a", 0.1), display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg viewBox="0 0 24 24" width={32} height={32} fill="#16a34a"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 8 }}>Upgrade Request Sent</div>
          <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.6, maxWidth: 260 }}>
            We'll review your request and reach out within 1–2 business days to confirm your upgrade to <strong>{selectedPlan}</strong>.
          </div>
        </div>
        <button onClick={() => setStep("browse")} style={{ marginTop: 4, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 24px", fontWeight: 700, fontSize: 13, color: T.text, cursor: "pointer", fontFamily: "inherit" }}>
          Back to My Service
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, height: 1, background: T.border }} />
        <span style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.07em" }}>Available Upgrades</span>
        <div style={{ flex: 1, height: 1, background: T.border }} />
      </div>

      {step === "browse" && (
        <>
          {/* Plan selector — if multiple upgrade paths */}
          {upgradeOptions.length > 1 && (
            <div style={{ display: "flex", gap: 8 }}>
              {upgradeOptions.map(key => {
                const t = allTiers[key] || {};
                return (
                  <button key={key} onClick={() => setSelectedPlan(key)}
                    style={{ flex: 1, padding: "10px 8px", border: `2px solid ${selectedPlan === key ? (t.color || T.primary) : T.border}`, borderRadius: 14, background: selectedPlan === key ? hexA(t.color || T.primary, 0.08) : T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: selectedPlan === key ? (t.color || T.primary) : T.text }}>{key}</div>
                    {t.price && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{t.price}</div>}
                  </button>
                );
              })}
            </div>
          )}

          {/* Comparison card */}
          <div style={{ background: T.surface, borderRadius: 22, border: `1.5px solid ${hexA(chosen?.color || T.primary, 0.3)}`, overflow: "hidden", boxShadow: `0 6px 24px ${hexA(chosen?.color || T.primary, 0.1)}` }}>
            {/* Header gradient */}
            <div style={{ background: `linear-gradient(135deg, ${chosen?.color || T.primary}, ${mix(chosen?.color || T.primary, "#000", 0.22)})`, padding: "22px 20px", color: "#fff" }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.65, marginBottom: 6 }}>Upgrade to</div>
              <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: "-0.03em", lineHeight: 1 }}>{selectedPlan}</div>
              <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>{chosen?.tagline}</div>
              {chosen?.price && (
                <div style={{ marginTop: 12, display: "inline-flex", background: "rgba(255,255,255,0.2)", borderRadius: 100, padding: "5px 16px", fontSize: 13, fontWeight: 700 }}>
                  {chosen.price}
                </div>
              )}
            </div>

            <div style={{ padding: "16px 20px" }}>
              {/* New benefits */}
              {newItems.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                    What you gain
                  </div>
                  {newItems.map((item, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "8px 0", borderBottom: i < newItems.length - 1 ? `1px solid ${T.border}` : "none" }}>
                      <div style={{ width: 20, height: 20, borderRadius: "50%", background: hexA(chosen?.color || T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                        <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke={chosen?.color || T.primary} strokeWidth={2.5} strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                      </div>
                      <span style={{ fontSize: 14, color: T.text, fontWeight: 500, lineHeight: 1.4 }}>{item}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Everything you keep */}
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Plus everything in {currentPlan}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(currentTier?.includes || []).map((item, i) => (
                  <span key={i} style={{ fontSize: 12, background: T.surfaceAlt, color: T.textMuted, borderRadius: 100, padding: "4px 12px", fontWeight: 500 }}>{item}</span>
                ))}
              </div>
            </div>

            <div style={{ padding: "0 20px 20px" }}>
              <button onClick={() => setStep("message")}
                style={{ width: "100%", background: chosen?.color || T.primary, color: "#fff", border: "none", borderRadius: 14, padding: "15px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 16px ${hexA(chosen?.color || T.primary, 0.35)}`, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                Request Upgrade to {selectedPlan}
              </button>
              <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>
                This is just a request — no changes are made until our team confirms and you sign an updated agreement.
              </div>
            </div>
          </div>
        </>
      )}

      {step === "message" && (
        <div style={{ background: T.surface, borderRadius: 22, border: `1px solid ${T.border}`, padding: "22px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 4 }}>One more step</div>
            <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              Tell us a bit about why you're interested in upgrading to <strong style={{ color: T.text }}>{selectedPlan}</strong>. Our team will reach out within 1–2 business days.
            </div>
          </div>

          <div style={{ background: hexA(chosen?.color || T.primary, 0.06), borderRadius: 14, padding: "12px 16px" }}>
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 2 }}>Upgrading from → to</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{currentPlan} → {selectedPlan}</div>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 8 }}>
              Your Message <span style={{ textTransform: "none", fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="e.g. We added a koi pond and would love more frequent service. Interested in the weekly plan."
              style={{ width: "100%", padding: "13px 15px", border: `1.5px solid ${T.border}`, borderRadius: 13, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical", minHeight: 110, lineHeight: 1.6 }}
            />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={handleSubmit}
              style={{ flex: 1, background: chosen?.color || T.primary, color: "#fff", border: "none", borderRadius: 14, padding: "15px", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 16px ${hexA(chosen?.color || T.primary, 0.3)}` }}>
              Send Request
            </button>
            <button onClick={() => setStep("browse")}
              style={{ background: T.surfaceAlt, color: T.textMuted, border: "none", borderRadius: 14, padding: "15px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── CP PROPERTY — combines pond/property details + service plan ──
function CPProperty({ client, branding, onNav, onUpgradeRequest, T }) {
  const { tiers } = useApp();
  const [section, setSection] = useState("property"); // "property" | "plan"
  const plan = client.plan || "";
  const clientDiv = client.division || "Pond";
  const allTiers = tiers || CP_TIERS;
  const divTierSet = (allTiers[clientDiv] || allTiers["Pond"] || DEFAULT_TIERS["Pond"]);
  const tier = plan ? (divTierSet[plan] || divTierSet["Essential"] || {}) : null;
  const tierColor = tier?.color || T.primary;
  const TIER_ORDER = ["Essential", "Signature", "Premium"];
  const currentIdx = TIER_ORDER.indexOf(plan);
  const upgradeOptions = plan ? TIER_ORDER.slice(currentIdx + 1).filter(p => divTierSet[p]) : [];
  const upgradePlan = upgradeOptions[0] || null;
  const upgradeTier = upgradePlan ? divTierSet[upgradePlan] : null;
  const pondLbl = pondLabel(client);
  const m = dMeta(client.division);

  // Service plan card — tappable to switch to plan section
  const PlanCard = () => (
    <div onClick={() => setSection("plan")}
      style={{ background: tier ? `linear-gradient(145deg, ${tierColor} 0%, ${mix(tierColor,"#000",0.28)} 100%)` : T.surfaceAlt, borderRadius: 20, padding: "18px 20px", color: tier ? "#fff" : T.text, cursor: "pointer", boxShadow: tier ? `0 8px 28px ${hexA(tierColor,0.35)}` : "none", position: "relative", overflow: "hidden", border: tier ? "none" : `1px solid ${T.border}` }}>
      <div style={{ position:"absolute", right:-30, top:-30, width:140, height:140, borderRadius:"50%", background:"rgba(255,255,255,0.06)" }} />
      <div style={{ position:"relative" }}>
        <div style={{ fontSize:10, fontWeight:800, textTransform:"uppercase", letterSpacing:"0.1em", opacity:0.7, marginBottom:4 }}>Service Plan</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
          <div>
            <div style={{ fontSize:22, fontWeight:900, letterSpacing:"-0.02em" }}>{plan || "No tier"}</div>
            <div style={{ fontSize:12, opacity: tier ? 0.8 : 1, marginTop:3, color: tier ? "inherit" : T.textMuted }}>{plan ? (TIER_FREQ[plan] || client.planFreq || "—") + " service" : "Contact us to set up a plan"}</div>
          </div>
          <div style={{ textAlign:"right" }}>
            {client.monthlyRate && <div style={{ fontSize:20, fontWeight:900 }}>${parseFloat(client.monthlyRate).toLocaleString()}<span style={{ fontSize:11, opacity:0.7 }}>/mo</span></div>}
            <div style={{ fontSize:11, opacity:0.7, marginTop:2, display:"flex", alignItems:"center", gap:4 }}>
              {upgradeOptions.length > 0 ? "Tap to view & upgrade →" : "Top tier ✓"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (section === "plan") {
    return (
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <button onClick={() => setSection("property")}
          style={{ background:"none", border:"none", color:T.primary, fontWeight:700, fontSize:13, cursor:"pointer", padding:"0 0 4px", display:"flex", alignItems:"center", gap:4, fontFamily:"inherit", alignSelf:"flex-start" }}>
          ← {pondLbl}
        </button>
        {/* Reuse CPService content inline */}
        <CPService client={client} branding={branding} onNav={onNav} onUpgradeRequest={onUpgradeRequest} T={T} />
      </div>
    );
  }

  // Property section — pond/pool/property details + plan card
  const history   = client.history   || [];
  const equipment = client.equipment || [];
  const sitePhotos = client.sitePhotos || [];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
      {/* Page title */}
      <div>
        <div style={{ fontSize:26, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>{pondLabel(client, true)}</div>
        <div style={{ fontSize:14, color:T.textMuted, marginTop:3 }}>{client.pondType || m.typeOptions[0]}</div>
      </div>

      {/* Service plan card — tappable */}
      <PlanCard />

      {/* Stats row */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
        {[
          { label:"Visits",    value: history.length },
          { label:"Equipment", value: equipment.length },
          { label:"Photos",    value: sitePhotos.length },
        ].map(s => (
          <div key={s.label} style={{ background:T.surface, border:`1px solid ${T.border}`, borderRadius:16, padding:"14px 10px", textAlign:"center" }}>
            <div style={{ fontSize:24, fontWeight:800, color:T.text, letterSpacing:"-0.02em" }}>{s.value}</div>
            <div style={{ fontSize:10, color:T.textMuted, marginTop:4, fontWeight:600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* All active service sections */}
      {clientServices(client, tiers).map((svc, si) => {
        const sm = dMeta(svc.div);
        return (
          <div key={si} style={{ background:T.surface, borderRadius:18, border:`1px solid ${T.border}`, padding:"16px 18px" }}>
            <div style={{ fontSize:13, fontWeight:800, color:T.text, marginBottom:12 }}>{svc.div} Details</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {[[sm.typeLabel, svc.type],[sm.sizeLabel, svc.size]].filter(([,v])=>v).map(([k,v]) => (
                <div key={k}>
                  <div style={{ fontSize:10, color:T.textMuted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:3 }}>{k}</div>
                  <div style={{ fontSize:14, fontWeight:600, color:T.text }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Site photos */}
      {sitePhotos.length > 0 && (
        <div style={{ background:T.surface, borderRadius:18, border:`1px solid ${T.border}`, padding:"16px 18px" }}>
          <div style={{ fontSize:13, fontWeight:800, color:T.text, marginBottom:12 }}>Photos</div>
          <div style={{ display:"flex", gap:8, overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
            {sitePhotos.map((p,i) => {
              const src = typeof p === "string" ? p : p.src;
              return <img key={i} src={src} alt="" style={{ width:90, height:90, borderRadius:12, objectFit:"cover", flexShrink:0 }} />;
            })}
          </div>
        </div>
      )}

      {/* Recent service */}
      {history.length > 0 && (
        <div style={{ background:T.surface, borderRadius:18, border:`1px solid ${T.border}`, overflow:"hidden" }}>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${T.border}`, fontSize:13, fontWeight:800, color:T.text }}>Recent Visits</div>
          {history.slice(0,3).map((h,i) => (
            <div key={i} style={{ padding:"12px 18px", borderBottom: i<2 && i<history.length-1 ? `1px solid ${T.border}` : "none", display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:T.text, display:"flex", alignItems:"center", gap:8 }}>
                  {h.type || "Service Visit"}
                  {h.satisfaction > 0 && (
                    <span style={{ fontSize:11, color:"#F59E0B", letterSpacing:"0.02em" }}>{"★".repeat(h.satisfaction)}</span>
                  )}
                </div>
                <div style={{ fontSize:11, color:T.textMuted, marginTop:2 }}>{h.date}{h.tech ? ` · ${h.tech}` : ""}</div>
                {h.notes && <div style={{ fontSize:12, color:T.textMuted, marginTop:4, lineHeight:1.4 }}>{h.notes}</div>}
                {/* Before/After thumbnails */}
                {(h.photos||[]).length > 0 && (
                  <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
                    {(h.photos||[]).slice(0,4).map((ph, i) => {
                      const src   = typeof ph === "string" ? ph : ph.src;
                      const label = typeof ph === "string" ? "" : ph.label;
                      const labelColor = label === "Before" ? "#F59E0B" : label === "After" ? "#16a34a" : "rgba(0,0,0,0.5)";
                      return (
                        <div key={i} style={{ position:"relative" }}>
                          <img src={src} alt="" style={{ width:52, height:52, borderRadius:8, objectFit:"cover", border:`2px solid ${labelColor}` }} />
                          {label && <div style={{ position:"absolute", bottom:2, left:2, fontSize:8, fontWeight:800, color:"#fff", background:labelColor, borderRadius:3, padding:"1px 4px" }}>{label.slice(0,2).toUpperCase()}</div>}
                        </div>
                      );
                    })}
                    {(h.photos||[]).length > 4 && (
                      <div style={{ width:52, height:52, borderRadius:8, background:"rgba(0,0,0,0.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:T.textMuted }}>
                        +{(h.photos||[]).length - 4}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {h.invoice && <div style={{ fontSize:12, fontWeight:700, color:T.textMuted, flexShrink:0 }}>{h.invoice}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Equipment */}
      {equipment.length > 0 && (
        <div style={{ background:T.surface, borderRadius:18, border:`1px solid ${T.border}`, overflow:"hidden" }}>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${T.border}`, fontSize:13, fontWeight:800, color:T.text }}>Equipment</div>
          {equipment.map((eq,i) => (
            <div key={i} style={{ padding:"12px 18px", borderBottom: i<equipment.length-1 ? `1px solid ${T.border}` : "none", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:T.text }}>{eq.name}</div>
                {eq.installed && <div style={{ fontSize:11, color:T.textMuted, marginTop:1 }}>Installed {eq.installed}</div>}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background: eq.status==="Good" ? "#16a34a" : eq.status==="Monitor" ? "#F59E0B" : T.primary }} />
                <span style={{ fontSize:11, color:T.textMuted, fontWeight:600 }}>{eq.status || "Good"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CP SERVICE (My Service Plan) ──
function CPService({ client, branding, onNav, onUpgradeRequest, T }) {
  const { tiers } = useApp();
  const plan = client.plan || "Signature";
  const clientDiv = client.division || "Pond";
  const allTiers = tiers || CP_TIERS;
  const divTierSet = (allTiers[clientDiv] || allTiers["Pond"] || DEFAULT_TIERS["Pond"]);
  const tier = divTierSet[plan] || divTierSet["Essential"] || {};
  const tierColor = tier?.color || T.primary;
  // All tiers strictly above current — no downgrades
  const TIER_ORDER = ["Essential", "Signature", "Premium"];
  const currentIdx = TIER_ORDER.indexOf(plan);
  const upgradeOptions = TIER_ORDER.slice(currentIdx + 1).filter(p => divTierSet[p]);
  const upgradePlan = upgradeOptions[0] || null;
  const upgradeTier = upgradePlan ? divTierSet[upgradePlan] : null;

  const CheckRow = ({ text, highlighted }) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ width: 22, height: 22, borderRadius: "50%", background: highlighted ? tierColor : hexA(tierColor, 0.12), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke={highlighted ? "#fff" : tierColor} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <span style={{ fontSize: 14, color: T.text, fontWeight: 500, lineHeight: 1.4 }}>{text}</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Page title */}
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>My Service Plan</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 4 }}>Your current plan with {branding.companyName}</div>
      </div>

      {/* Current plan hero — with optional image or logo */}
      <div style={{ background: `linear-gradient(145deg, ${tierColor} 0%, ${mix(tierColor, "#000", 0.28)} 100%)`, borderRadius: 26, padding: "28px 24px", color: "#fff", boxShadow: `0 12px 40px ${hexA(tierColor, 0.4)}`, position: "relative", overflow: "hidden", minHeight: 140 }}>
        {/* Background image (pond photo or branding) */}
        {(branding.portalHeroImage || client.sitePhotos?.[0]?.src || (typeof client.sitePhotos?.[0] === "string" ? client.sitePhotos[0] : null)) && (
          <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${branding.portalHeroImage || (typeof client.sitePhotos[0] === "string" ? client.sitePhotos[0] : client.sitePhotos[0]?.src)})`, backgroundSize: "cover", backgroundPosition: "center", opacity: 0.22 }} />
        )}
        <div style={{ position: "absolute", right: -30, top: -30, width: 180, height: 180, borderRadius: "50%", background: "rgba(255,255,255,0.06)" }} />
        <div style={{ position: "absolute", left: -20, bottom: -30, width: 130, height: 130, borderRadius: "50%", background: "rgba(255,255,255,0.04)" }} />

        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.7, marginBottom: 8 }}>Current Plan</div>
              <div style={{ fontSize: 36, fontWeight: 900, letterSpacing: "-0.03em", lineHeight: 1 }}>{plan}</div>
              <div style={{ fontSize: 14, opacity: 0.8, marginTop: 8, fontWeight: 500 }}>{tier?.tagline}</div>
            </div>
            {/* Logo or branded icon */}
            {(branding.logoImage || branding.logoEmoji) && (
              <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, backdropFilter: "blur(8px)" }}>
                {branding.logoType === "image" && branding.logoImage
                  ? <img src={branding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: 24 }}>{branding.logoEmoji}</span>}
              </div>
            )}
          </div>
          {/* Price + frequency pills */}
          <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(client.monthlyRate || tier?.price) && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.2)", borderRadius: 100, padding: "7px 16px", backdropFilter: "blur(8px)" }}>
                <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                <span style={{ fontSize: 13, fontWeight: 800 }}>{client.monthlyRate ? `$${parseFloat(client.monthlyRate).toLocaleString()}/mo` : tier?.price}</span>
              </div>
            )}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", borderRadius: 100, padding: "7px 16px", backdropFilter: "blur(8px)" }}>
              <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{TIER_FREQ[plan] || client.planFreq || "—"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* What's included */}
      <div style={{ background: T.surface, borderRadius: 22, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: hexA(tierColor, 0.1), display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={tierColor} strokeWidth={2} strokeLinecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <span style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>What's Included</span>
        </div>
        <div style={{ padding: "4px 20px 14px" }}>
          {(tier?.includes || []).map((item, i) => (
            <CheckRow key={i} text={item} highlighted={i === 0} />
          ))}
        </div>
      </div>

      {/* Next service */}
      {client.nextService && (
        <div style={{ background: hexA(T.primary, 0.06), borderRadius: 18, border: `1px solid ${hexA(T.primary, 0.15)}`, padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 13, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: T.primary }}>
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>Next Service Date</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{client.nextService}</div>
          </div>
        </div>
      )}

      {/* Upgrade section */}
      {upgradeOptions.length > 0 && (
        <CPUpgradeRequest
          client={client}
          currentPlan={plan}
          currentTier={tier}
          upgradePlan={upgradePlan}
          upgradeTier={upgradeTier}
          upgradeOptions={upgradeOptions}
          tiers={divTierSet}
          branding={branding}
          onSubmit={onUpgradeRequest}
          T={T}
        />
      )}

      {/* Already on top tier */}
      {upgradeOptions.length === 0 && (
        <div style={{ background: hexA("#16a34a", 0.06), border: `1px solid ${hexA("#16a34a", 0.2)}`, borderRadius: 18, padding: "18px 20px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 13, background: hexA("#16a34a", 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="#16a34a" strokeWidth={2} strokeLinecap="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>You're on our top tier</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>The Premium plan includes our highest level of service. Thank you for trusting us with your property.</div>
          </div>
        </div>
      )}

      {/* Contact for questions */}
      <button onClick={() => onNav("cp_request")}
        style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: "inherit", width: "100%", boxSizing: "border-box" }}>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Have a question about your plan?</div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>Send us a message and we'll get back to you.</div>
        </div>
        <div style={{ color: T.primary, fontWeight: 700, fontSize: 13, flexShrink: 0, marginLeft: 10 }}>Contact →</div>
      </button>
    </div>
  );
}

// ── CP HISTORY ──
function CPPond({ client, T }) {
  const [section, setSection] = useState("overview"); // overview | service | equipment | fish | purchases
  const history  = client.history  || [];
  const equipment = client.equipment || [];
  const sitePhotos = client.sitePhotos || [];
  const siteVideos = client.siteVideos || [];
  const fishHistory = client.fishHistory || [];
  const purchaseHistory = client.purchaseHistory || [];
  const [expanded, setExpanded] = useState({});

  const SECTIONS = [
    { id: "overview",  label: "Overview" },
    { id: "service",   label: "Service" },
    { id: "equipment", label: "Equipment" },
    { id: "fish",      label: "Fish" },
    { id: "purchases", label: "Purchases" },
  ];

  const getReadings = (h) => {
    if (h.readings && Object.keys(h.readings).length) return h.readings;
    const legacy = {};
    if (h.ph) legacy["pH"] = h.ph;
    if (h.ammonia) legacy["NH₃"] = h.ammonia;
    if (h.nitrite) legacy["NO₂"] = h.nitrite;
    if (h.temp) legacy["Temp"] = h.temp;
    return legacy;
  };

  const statusColor = (s) => s === "Good" ? "#16a34a" : s === "Monitor" ? "#d97706" : "#dc2626";
  const statusBg    = (s) => s === "Good" ? hexA("#16a34a", 0.1) : s === "Monitor" ? hexA("#d97706", 0.1) : hexA("#dc2626", 0.1);

  const EmptyState = ({ icon, title, sub }) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "56px 20px", gap: 12, textAlign: "center" }}>
      <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), display: "flex", alignItems: "center", justifyContent: "center", color: T.primary }}>{icon}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{title}</div>
      <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, maxWidth: 240 }}>{sub}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Page header */}
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>{pondLabel(client, true)}</div>
        {client.pondSize && <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>{client.pondSize}{client.pondType ? ` · ${client.pondType}` : ""}</div>}
        {client.pondGallons && <div style={{ fontSize: 13, color: T.primary, fontWeight: 700, marginTop: 2 }}>{parseInt(client.pondGallons).toLocaleString()} gallons</div>}
      </div>

      {/* Section pill scroll */}
      <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch" }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            style={{ flexShrink: 0, padding: "8px 18px", borderRadius: 100, border: "none", fontFamily: "inherit", fontWeight: 700, fontSize: 13, cursor: "pointer", background: section === s.id ? T.primary : T.surfaceAlt, color: section === s.id ? "#fff" : T.textMuted, transition: "all 0.15s" }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {section === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Pond stats */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { label: "Service Visits", value: history.length },
              { label: "Equipment", value: equipment.length },
              { label: "Fish Logged", value: fishHistory.length },
            ].map(s => (
              <div key={s.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: "14px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{s.value}</div>
                <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4, fontWeight: 600, lineHeight: 1.3 }}>{s.label}</div>
              </div>
            ))}

          </div>

          {/* Plan + price card */}
          {(client.monthlyRate || client.plan) && (
            <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "15px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 3 }}>Service Plan</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{client.plan || "—"}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{TIER_FREQ[client.plan] || client.planFreq || "—"} service</div>
              </div>
              {client.monthlyRate && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 3 }}>Monthly</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: T.primary, letterSpacing: "-0.02em" }}>${parseFloat(client.monthlyRate).toLocaleString()}</div>
                </div>
              )}
            </div>
          )}

          {/* Pond details card */}
          {(client.pondGallons || client.pondType || client.pondSize || client.division) && (
            <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, padding: "18px 20px" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.text, marginBottom: 12 }}>Pond Details</div>
              {[
                client.division && ["Type", client.division],
                client.pondType && ["Style", client.pondType],
                client.pondSize && ["Size", client.pondSize],
                client.pondGallons && ["Volume", `${parseInt(client.pondGallons).toLocaleString()} gallons`],
                client.address && ["Location", client.address],
              ].filter(Boolean).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 13, color: T.textMuted }}>{k}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* Site photos */}
          {sitePhotos.length > 0 && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 10 }}>Pond Photos</div>
              <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
                {sitePhotos.map((p, i) => {
                  const src = typeof p === "string" ? p : p.src;
                  const cap = typeof p === "object" ? p.caption : "";
                  return (
                    <div key={i} style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                      <img src={src} alt={cap || ""} style={{ width: 130, height: 100, borderRadius: 14, objectFit: "cover", display: "block", border: `1px solid ${T.border}` }} />
                      {cap && <div style={{ fontSize: 10, color: T.textMuted, textAlign: "center", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{cap}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Site videos */}
          {siteVideos.length > 0 && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 10 }}>Pond Videos</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {siteVideos.map((v, i) => (
                  <div key={i} style={{ background: T.surface, borderRadius: 16, overflow: "hidden", border: `1px solid ${T.border}` }}>
                    <video src={v.src} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: 220, display: "block", background: "#000", objectFit: "contain", borderRadius: "16px 16px 0 0" }} />
                    {v.caption && <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600, color: T.text }}>{v.caption}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!sitePhotos.length && !siteVideos.length && (
            <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "20px", textAlign: "center", fontSize: 13, color: T.textMuted }}>
              No pond photos or videos yet — your technician will add these during service visits.
            </div>
          )}
        </div>
      )}

      {/* ── SERVICE HISTORY ── */}
      {section === "service" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13, color: T.textMuted }}>{history.length} visit{history.length !== 1 ? "s" : ""} on record</div>
          {!history.length && <EmptyState icon={<CIcon name="history" size={28} />} title="No service history yet" sub="Your service records will appear here after each visit." />}
          {history.map((h, i) => {
            const readings = getReadings(h);
            const hasReadings = Object.keys(readings).length > 0;
            const isOpen = expanded[`s${i}`];
            const hasDetails = h.notes || hasReadings || h.services?.length || h.products?.length || h.photos?.length;
            return (
              <div key={i} style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.04)" }}>
                <div onClick={() => hasDetails && setExpanded(e => ({ ...e, [`s${i}`]: !e[`s${i}`] }))}
                  style={{ padding: "15px 18px", display: "flex", gap: 13, alignItems: "center", cursor: hasDetails ? "pointer" : "default" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 13, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: T.primary }}>
                    <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{h.type || "Service Visit"}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{fmtDate(h.date)}{h.tech ? ` · ${h.tech}` : ""}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {h.invoice && h.invoice !== "$0" && <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{h.invoice}</div>}
                    {hasDetails && <div style={{ color: T.textMuted, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}><svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg></div>}
                  </div>
                </div>
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${T.border}` }}>
                    {h.notes && <div style={{ padding: "13px 18px", fontSize: 13, color: T.textMuted, lineHeight: 1.6, borderBottom: (hasReadings || h.services?.length) ? `1px solid ${T.border}` : "none" }}>{h.notes}</div>}
                    {hasReadings && (
                      <div style={{ padding: "13px 18px", borderBottom: h.services?.length ? `1px solid ${T.border}` : "none" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>Water Quality</div>
                        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(Object.keys(readings).length, 4)}, 1fr)`, gap: 8 }}>
                          {Object.entries(readings).map(([k, v]) => (
                            <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "9px 6px", textAlign: "center" }}>
                              <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</div>
                              <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginTop: 2 }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {(h.services?.length > 0 || h.products?.length > 0) && (
                      <div style={{ padding: "11px 18px", display: "flex", flexWrap: "wrap", gap: 6, borderBottom: h.photos?.length ? `1px solid ${T.border}` : "none" }}>
                        {(h.services || []).map((s, j) => <span key={j} style={{ fontSize: 11, fontWeight: 600, background: hexA(T.primary, 0.1), color: T.primary, borderRadius: 100, padding: "4px 11px" }}>{typeof s === "string" ? s : s.name}</span>)}
                        {(h.products || []).map((p, j) => <span key={j} style={{ fontSize: 11, fontWeight: 600, background: T.surfaceAlt, color: T.textMuted, borderRadius: 100, padding: "4px 11px" }}>{typeof p === "string" ? p : p.name}</span>)}
                      </div>
                    )}
                    {h.photos?.length > 0 && <div style={{ padding: "11px 18px 14px" }}><PhotoStrip photos={h.photos} size={68} /></div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── EQUIPMENT ── */}
      {section === "equipment" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!equipment.length && <EmptyState icon={<CIcon name="history" size={28} />} title="No equipment logged" sub="Your technician will document your equipment during service visits." />}
          {equipment.some(e => e.status !== "Good") && (
            <div style={{ background: hexA("#d97706", 0.08), border: `1px solid ${hexA("#d97706", 0.2)}`, borderRadius: 16, padding: "13px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
              <div style={{ color: "#d97706", flexShrink: 0 }}><svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
              <div style={{ fontSize: 12, color: T.textMuted }}>
                <strong style={{ color: "#d97706" }}>Attention needed: </strong>
                {equipment.filter(e => e.status !== "Good").map(e => e.name).join(", ")}
              </div>
            </div>
          )}
          {equipment.map((eq, i) => {
            const isOpen = expanded[`eq${i}`];
            const hasDetail = eq.notes || (eq.photos || []).length > 0 || eq.serialNumber || eq.purchasePrice;
            return (
              <div key={i} style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,0.04)" }}>
                <div onClick={() => hasDetail && setExpanded(e => ({ ...e, [`eq${i}`]: !e[`eq${i}`] }))}
                  style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 13, cursor: hasDetail ? "pointer" : "default" }}>
                  <div style={{ width: 40, height: 40, borderRadius: 13, background: statusBg(eq.status), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" width={20} height={20} fill={statusColor(eq.status)}><circle cx="12" cy="12" r="9" fill={statusBg(eq.status)} /><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill={statusColor(eq.status)} /></svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{eq.name}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                      {eq.installed ? `Installed ${eq.installed}` : "Install date unknown"}
                      {eq.serialNumber && <span> · S/N {eq.serialNumber}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 100, background: statusBg(eq.status), color: statusColor(eq.status), flexShrink: 0 }}>{eq.status || "Good"}</span>
                </div>
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${T.border}` }}>
                    {eq.notes && <div style={{ padding: "13px 18px", fontSize: 13, color: T.textMuted, lineHeight: 1.6, borderBottom: `1px solid ${T.border}` }}>{eq.notes}</div>}
                    {(eq.purchasePrice || eq.purchaseDate || eq.origin) && (
                      <div style={{ padding: "12px 18px", borderBottom: (eq.photos||[]).length ? `1px solid ${T.border}` : "none" }}>
                        {[eq.origin && ["Origin", eq.origin], eq.purchaseDate && ["Purchase Date", eq.purchaseDate], eq.purchasePrice && ["Purchase Price", `$${eq.purchasePrice}`]].filter(Boolean).map(([k,v]) => (
                          <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12 }}>
                            <span style={{ color: T.textMuted }}>{k}</span>
                            <span style={{ color: T.text, fontWeight: 600 }}>{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(eq.photos||[]).length > 0 && <div style={{ padding: "11px 18px 14px" }}><PhotoStrip photos={eq.photos} size={68} /></div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── FISH ── */}
      {section === "fish" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!fishHistory.length
            ? <EmptyState icon={<svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>} title="No fish logged" sub="Your technician can document fish species, counts, and health during service visits." />
            : fishHistory.map((f, i) => (
              <div key={i} style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, padding: "14px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{f.species || "Unknown species"}</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{f.date}{f.count ? ` · ${f.count} fish` : ""}</div>
                  </div>
                  {f.health && <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 100, background: f.health === "Good" ? hexA("#16a34a", 0.1) : hexA("#d97706", 0.1), color: f.health === "Good" ? "#16a34a" : "#d97706" }}>{f.health}</span>}
                </div>
                {f.notes && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>{f.notes}</div>}
              </div>
            ))
          }
        </div>
      )}

      {/* ── PURCHASES ── */}
      {section === "purchases" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!purchaseHistory.length
            ? <EmptyState icon={<svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>} title="No purchase history" sub="Products and equipment purchased through Stone Property Solutions will appear here." />
            : purchaseHistory.map((p, i) => (
              <div key={i} style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{p.item}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{p.date}{p.category ? ` · ${p.category}` : ""}</div>
                </div>
                {p.price && <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>${p.price}</div>}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

// Keep CPHistory as an alias for backward compat
function CPHistory({ client, T }) { return <CPPond client={client} T={T} />; }

// ── CP INVOICES ──
function CPInvoices({ client, invoices, branding, T }) {
  const myInvoices = sortInvoices((invoices || []).filter(iv => invoiceMatchesClient(iv, client)));
  const [open, setOpen] = useState(null);

  // Normalize status — handles both "Paid" and "paid", "Overdue"/"overdue" etc.
  const normStatus = (iv) => {
    const s = effectiveStatus(iv) || iv.status || "";
    const sl = s.toLowerCase();
    if (sl === "paid") return "paid";
    if (sl === "overdue") return "overdue";
    if (sl === "draft") return "draft";
    return "due";
  };
  const statusColor = (s) => s === "paid" ? "#16a34a" : s === "overdue" ? "#E5484D" : "#d97706";
  const statusBg    = (s) => s === "paid" ? hexA("#16a34a",0.1) : s === "overdue" ? hexA("#E5484D",0.1) : hexA("#d97706",0.1);
  const statusLabel = (s) => s === "paid" ? "Paid" : s === "overdue" ? "Overdue" : "Due";

  // Format date — handles YYYY-MM-DD and MM/DD/YYYY
  const fmtDate = (s) => {
    if (!s) return "";
    if (s.includes("-") && s.length === 10) {
      const [y, m, d] = s.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${months[parseInt(m)-1]} ${parseInt(d)}, ${y}`;
    }
    return s;
  };

  if (!myInvoices.length) return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ fontSize:26, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>Invoices</div>
      <div style={{ textAlign:"center", padding:"56px 20px" }}>
        <div style={{ width:56, height:56, borderRadius:18, background:hexA(T.primary,0.08), display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px", color:T.primary }}>
          <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>
        </div>
        <div style={{ fontSize:16, fontWeight:700, color:T.text, marginBottom:6 }}>No invoices yet</div>
        <div style={{ fontSize:13, color:T.textMuted }}>Invoices from {branding.companyName} will appear here.</div>
      </div>
    </div>
  );

  const outstanding = myInvoices.filter(iv => normStatus(iv) !== "paid" && normStatus(iv) !== "draft");
  const total = outstanding.reduce((s,iv) => s + invoiceTotals(iv).total, 0);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ fontSize:26, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>Invoices</div>

      {outstanding.length > 0 && (
        <div style={{ background:`linear-gradient(135deg, #E5484D, #c0392b)`, borderRadius:20, padding:"20px 22px", color:"#fff", boxShadow:"0 8px 24px rgba(229,72,77,0.35)" }}>
          <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", opacity:0.7, marginBottom:6 }}>Balance Due</div>
          <div style={{ fontSize:34, fontWeight:900, letterSpacing:"-0.03em" }}>${total.toFixed(2)}</div>
          <div style={{ fontSize:13, opacity:0.8, marginTop:4 }}>{outstanding.length} outstanding invoice{outstanding.length!==1?"s":""}</div>
        </div>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {myInvoices.map((iv) => {
          const isOpen = open === iv.id;
          const amt    = invoiceTotals(iv).total;
          const st     = normStatus(iv);
          const isPaidSt = st === "paid";
          return (
            <div key={iv.id} style={{ background:T.surface, borderRadius:18, border:`1px solid ${isPaidSt ? T.border : hexA(statusColor(st), 0.3)}`, overflow:"hidden", transition:"box-shadow 0.15s" }}>
              <div onClick={() => setOpen(isOpen ? null : iv.id)}
                style={{ padding:"16px 18px", display:"flex", alignItems:"center", gap:14, cursor:"pointer" }}>
                {/* Left accent */}
                <div style={{ width:3, alignSelf:"stretch", borderRadius:3, background:statusColor(st), flexShrink:0, minHeight:40 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:T.text, letterSpacing:"-0.01em" }}>Invoice #{iv.number || iv.id}</div>
                  <div style={{ fontSize:12, color:T.textMuted, marginTop:2 }}>{fmtDate(iv.date || iv.issueDate || "")}</div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={{ fontSize:16, fontWeight:800, color: isPaidSt ? T.textMuted : T.text, letterSpacing:"-0.02em", textDecoration: isPaidSt ? "none" : "none" }}>${amt.toFixed(2)}</div>
                  <div style={{ fontSize:10, fontWeight:700, padding:"3px 10px", borderRadius:100, background:statusBg(st), color:statusColor(st), marginTop:4, display:"inline-block" }}>{statusLabel(st)}</div>
                </div>
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={T.textMuted} strokeWidth={2} strokeLinecap="round" style={{ transform:isOpen?"rotate(180deg)":"rotate(0)", transition:"transform 0.2s", opacity:0.5, flexShrink:0 }}><path d="M6 9l6 6 6-6"/></svg>
              </div>
              {isOpen && (
                <div style={{ borderTop:`1px solid ${T.border}`, padding:"14px 18px", display:"flex", flexDirection:"column", gap:10 }}>
                  {(iv.lineItems||iv.items||[]).length > 0 && (
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {(iv.lineItems||iv.items||[]).map((li,j) => (
                        <div key={j} style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10, fontSize:13 }}>
                          <span style={{ color:T.text, flex:1 }}>{li.description||li.name||li.service}</span>
                          <span style={{ color:T.text, fontWeight:700, flexShrink:0 }}>${parseFloat(li.amount||li.price||0).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {iv.dueDate && !isPaidSt && (
                    <div style={{ fontSize:12, color: new Date(iv.dueDate) < new Date() ? T.warning : T.textMuted }}>
                      Due {fmtDate(iv.dueDate)}
                    </div>
                  )}
                  {iv.notes && <div style={{ fontSize:12, color:T.textMuted, fontStyle:"italic" }}>{iv.notes}</div>}
                  {iv.paymentLink && !isPaidSt && (
                    <a href={iv.paymentLink} target="_blank" rel="noopener noreferrer"
                      style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8, background:"#2CA01C", color:"#fff", borderRadius:12, padding:"12px 18px", fontWeight:800, fontSize:14, textDecoration:"none", boxShadow:"0 4px 14px rgba(44,160,28,0.3)" }}>
                      Pay Now via QuickBooks
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── CP ESTIMATES ──
function CPEstimates({ client, estimates, branding, onApprove, T }) {
  const mine = (estimates||[]).filter(e => String(e.clientId)===String(client.id));
  if (!mine.length) return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ fontSize:26, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>Estimates</div>
      <div style={{ textAlign:"center", padding:"56px 20px" }}>
        <div style={{ fontSize:15, fontWeight:700, color:T.text, marginBottom:6 }}>No estimates yet</div>
        <div style={{ fontSize:13, color:T.textMuted }}>Estimates from {branding.companyName} will appear here.</div>
      </div>
    </div>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ fontSize:26, fontWeight:800, color:T.text, letterSpacing:"-0.03em" }}>Estimates</div>
      {mine.map((e,i) => (
        <div key={e.id} style={{ background:T.surface, borderRadius:18, border:`1px solid ${T.border}`, padding:"16px 18px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:T.text }}>Estimate #{e.number||e.id}</div>
            <div style={{ fontSize:12, color:T.textMuted, marginTop:2 }}>{e.date||""} · ${parseFloat((e.total||"0").replace(/[^0-9.-]/g,"")).toFixed(2)}</div>
          </div>
          {e.status !== "approved" && (
            <button onClick={() => onApprove(e.id)} style={{ background:T.primary, color:"#fff", border:"none", borderRadius:12, padding:"9px 16px", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>Approve</button>
          )}
          {e.status === "approved" && <span style={{ fontSize:12, fontWeight:700, color:"#16a34a" }}>Approved</span>}
        </div>
      ))}
    </div>
  );
}

// ── CP REQUEST ──
function CPRequest({ client, branding, onSubmit, T }) {
  const [form, setForm] = useState({ type: "", dates: "", notes: "" });
  const [sent, setSent] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const serviceTypes = ["General Service Visit", "Water Quality Issue", "Equipment Problem", "Spring Opening", "Fall Closing", "Estimate / Quote", "Other"];

  const handleSend = () => {
    if (!form.type) return;
    onSubmit({ ...form, clientId: client.id, clientName: client.name, submittedAt: Date.now() });
    setSent(true);
  };

  if (sent) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 16, textAlign: "center" }}>
        <div style={{ width: 72, height: 72, borderRadius: 22, background: hexA("#16a34a", 0.1), display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg viewBox="0 0 24 24" width={36} height={36} fill="#16a34a"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", marginBottom: 8 }}>Request Sent</div>
          <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.6, maxWidth: 260 }}>We'll be in touch shortly to confirm your appointment.</div>
        </div>
        <button onClick={() => setSent(false)} style={{ marginTop: 8, background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 14, padding: "12px 28px", fontWeight: 700, fontSize: 14, color: T.text, cursor: "pointer", fontFamily: "inherit" }}>Send Another</button>
      </div>
    );
  }

  const field = { width: "100%", padding: "13px 15px", border: `1.5px solid ${T.border}`, borderRadius: 13, fontSize: 15, fontFamily: "inherit", boxSizing: "border-box", outline: "none", color: T.text, background: T.surface, transition: "border-color 0.15s" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Request Service</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 4 }}>Tell us what you need and we'll be in touch.</div>
      </div>
      <div style={{ background: T.surface, borderRadius: 22, border: `1px solid ${T.border}`, padding: "22px 20px", display: "flex", flexDirection: "column", gap: 18, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 8 }}>Service Type</label>
          <select value={form.type} onChange={e => set("type", e.target.value)} style={field}>
            <option value="">Select a type...</option>
            {serviceTypes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 8 }}>Preferred Dates</label>
          <input type="text" style={field} value={form.dates} onChange={e => set("dates", e.target.value)} placeholder="e.g. Anytime next week, Mon/Wed mornings" />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, display: "block", marginBottom: 8 }}>Notes</label>
          <textarea style={{ ...field, minHeight: 100, resize: "vertical", lineHeight: 1.6 }} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Describe what you're seeing or any specific concerns..." />
        </div>
        <button onClick={handleSend} disabled={!form.type} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 14, padding: "15px", fontWeight: 800, fontSize: 15, cursor: form.type ? "pointer" : "not-allowed", opacity: form.type ? 1 : 0.45, fontFamily: "inherit", letterSpacing: "-0.01em", boxShadow: form.type ? `0 4px 16px ${hexA(T.primary, 0.3)}` : "none", transition: "all 0.2s" }}>Send Request</button>
      </div>
      {(branding.companyPhone || branding.companyEmail) && (
        <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 2 }}>Need immediate help?</div>
            <div style={{ fontSize: 13, color: T.text, fontWeight: 600 }}>{branding.companyPhone || branding.companyEmail}</div>
          </div>
          <a href={branding.companyPhone ? `tel:${branding.companyPhone}` : `mailto:${branding.companyEmail}`} style={{ background: hexA(T.primary, 0.1), color: T.primary, borderRadius: 12, padding: "9px 16px", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>Call</a>
        </div>
      )}
    </div>
  );
}

// ── SPS CLIENT PORTAL SHELL ──
function CPSettings({ client, branding, prefs, setPrefs, T, onSignOut, isStaffPreview }) {
  const set = (k, v) => setPrefs(p => ({ ...p, [k]: v }));
  const pondLbl = pondLabel(client);

  const OptionRow = ({ label, value, options, onChange }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${T.border}` }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {options.map(([val, lbl]) => (
          <button key={val} onClick={() => onChange(val)}
            style={{ padding: "6px 14px", borderRadius: 100, border: `1.5px solid ${value === val ? T.primary : T.border}`, background: value === val ? hexA(T.primary, 0.1) : T.surface, color: value === val ? T.primary : T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em", marginBottom: 20 }}>Settings</div>

      {/* Appearance */}
      <div style={{ background: T.surface, borderRadius: 20, border: `1px solid ${T.border}`, padding: "4px 18px", marginBottom: 16 }}>
        <OptionRow label="Appearance" value={prefs.appearance || "system"}
          options={[["light","Light"],["dark","Dark"],["system","Auto"]]}
          onChange={v => set("appearance", v)} />
        <OptionRow label="Default Screen" value={prefs.defaultPage || branding.portalDefaultPage || "cp_home"}
          options={[["cp_home","Home"],["cp_property","My Property"],["cp_invoices","Invoices"]]}
          onChange={v => set("defaultPage", v)} />
        <OptionRow label="Text Size" value={prefs.textSize || "normal"}
          options={[["small","S"],["normal","M"],["large","L"]]}
          onChange={v => set("textSize", v)} />
        <div style={{ padding: "14px 0", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Reduce Motion</span>
          <button onClick={() => set("reduceMotion", !(prefs.reduceMotion))}
            style={{ width: 48, height: 28, borderRadius: 100, background: prefs.reduceMotion ? T.primary : T.surfaceAlt, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
            <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: prefs.reduceMotion ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }} />
          </button>
        </div>
        <div style={{ padding: "14px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Account</span>
            <span style={{ fontSize: 12, color: T.textMuted }}>{client.email}</span>
          </div>
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{client.name} · {client.plan} Plan</div>
        </div>
      </div>

      {!isStaffPreview && (
        <button onClick={onSignOut}
          style={{ width: "100%", padding: "14px", background: hexA("#E5484D", 0.08), color: "#E5484D", border: `1px solid ${hexA("#E5484D", 0.2)}`, borderRadius: 16, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
          Sign Out
        </button>
      )}

      <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: T.textMuted }}>
        {branding.companyName} · Client Portal
      </div>
    </div>
  );
}

function SPSClientPortal({ client, schedule, invoices, estimates, branding, T: globalT, fontStack, onSignOut, onServiceRequest, onApproveEstimate, onUpgradeRequest, isStaffPreview = false }) {
  // Client prefs stored in localStorage — personal per-device settings
  const prefsKey = `sps_client_prefs_${client.id}`;
  const [prefs, setPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(prefsKey) || "{}"); } catch { return {}; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persist prefs to localStorage whenever they change
  useEffect(() => {
    try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch {}
  }, [prefs, prefsKey]);

  // Apply appearance preference — override global T if client has set a preference
  const sysDark = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
  const appearancePref = prefs.appearance || branding.appearance || "system";
  const effectiveMode = appearancePref === "system" ? (sysDark ? "dark" : "light") : appearancePref;
  const themeKey = branding.themeKey || "sps";
  const T = THEMES[themeKey] ? (effectiveMode === "dark" ? THEMES[themeKey].dark : THEMES[themeKey].light) : globalT;

  // Text size scaling
  const textScale = prefs.textSize === "large" ? 1.1 : prefs.textSize === "small" ? 0.9 : 1;

  const [page, setPage] = useState(prefs.defaultPage || branding.portalDefaultPage || "cp_home");

  return (
    <div style={{ fontFamily: fontStack, background: T.bg, minHeight: "100vh", display: "flex", flexDirection: "column", color: T.text, WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale", letterSpacing: "-0.01em" }}>
      <style>{`
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        input, select, textarea { -webkit-appearance: none; appearance: none; font-size: 16px !important; }
        input:focus, select:focus, textarea:focus { border-color: ${T.primary} !important; outline: none; box-shadow: 0 0 0 3px ${hexA(T.primary, 0.15)}; }
        button { transition: transform 0.08s ease, opacity 0.15s ease; }
        button:active { transform: scale(0.97); }
      `}</style>

      {/* Header */}
      <header style={{
        background: hexA(T.surface, 0.88),
        backdropFilter: "saturate(200%) blur(28px)",
        WebkitBackdropFilter: "saturate(200%) blur(28px)",
        borderBottom: `1px solid ${T.border}`,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        {!isStaffPreview && <div style={{ height: "env(safe-area-inset-top)" }} />}
        <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 16, paddingRight: 16 }}>
          {/* Logo + name */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: T.primary, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, boxShadow: `0 2px 8px ${hexA(T.primary, 0.35)}` }}>
              {branding.logoType === "image" && branding.logoImage
                ? <img src={branding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 17 }}>{branding.logoEmoji || "💧"}</span>}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{branding.portalAppName || branding.companyName}</div>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, letterSpacing: "0.02em" }}>Client Portal</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {/* Refresh */}
            <button onClick={() => window.location.reload()}
              style={{ width: 34, height: 34, borderRadius: 10, background: T.surfaceAlt, border: "none", color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
            {/* Settings gear — always visible */}
            <button onClick={() => setSettingsOpen(s => !s)}
              style={{ width: 34, height: 34, borderRadius: 10, background: settingsOpen ? hexA(T.primary, 0.12) : T.surfaceAlt, border: "none", color: settingsOpen ? T.primary : T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="settings" size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, padding: "24px 18px", maxWidth: 600, margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: "calc(96px + env(safe-area-inset-bottom))", fontSize: `${textScale}em` }}>
        {settingsOpen && (
          <CPSettings client={client} branding={branding} prefs={prefs} setPrefs={setPrefs} T={T} onSignOut={onSignOut} isStaffPreview={isStaffPreview} />
        )}
        {!settingsOpen && page === "cp_home"     && <CPHome client={client} schedule={schedule} invoices={invoices} branding={branding} onNav={setPage} T={T} />}
        {!settingsOpen && page === "cp_property" && <CPProperty client={client} branding={branding} onNav={setPage} onUpgradeRequest={onUpgradeRequest || (() => {})} T={T} />}
        {!settingsOpen && (page === "cp_pond" || page === "cp_service" || page === "cp_history") && <CPProperty client={client} branding={branding} onNav={setPage} onUpgradeRequest={onUpgradeRequest || (() => {})} T={T} />}
        {!settingsOpen && page === "cp_invoices" && <CPInvoices client={client} invoices={invoices} branding={branding} T={T} />}
        {!settingsOpen && page === "cp_messages" && <CPMessages client={client} branding={branding} onSubmit={onServiceRequest} T={T} />}
        {!settingsOpen && page === "cp_estimates" && <CPEstimates client={client} estimates={estimates} branding={branding} onApprove={onApproveEstimate || (() => {})} T={T} />}
      </main>

      {/* Bottom nav — 4 clean tabs */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: hexA(T.surface, 0.88),
        backdropFilter: "saturate(180%) blur(20px)",
        WebkitBackdropFilter: "saturate(180%) blur(20px)",
        borderTop: `1px solid ${T.border}`,
        display: "flex", zIndex: 90,
        minHeight: 60, paddingTop: 4,
        paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
      }}>
        {CLIENT_NAV.map(n => {
          const active = (page === n.id || (n.id === "cp_property" && (page === "cp_pond" || page === "cp_service"))) && !settingsOpen;
          const label  = n.label; // nav always says "My Property"; inside the tab pondLabel() is used
          return (
            <button key={n.id} onClick={() => { setPage(n.id); setSettingsOpen(false); }}
              style={{ flex: 1, border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: active ? T.primary : T.textMuted, fontFamily: "inherit", position: "relative", WebkitTapHighlightColor: "transparent" }}>
              <span style={{ width: 46, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 100, background: active ? hexA(T.primary, 0.12) : "transparent", transition: "background .15s" }}>
                <CIcon name={n.icon} size={22} />
              </span>
              <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500, letterSpacing: "-0.01em" }}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ─────────────────────────────────────────────
// APP SHELL
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// LOGIN / ACCOUNT PICKER
// Prototype of per-employee sign-in. Real passwords + cross-device sync come with the backend.
// ─────────────────────────────────────────────
function LoginScreen({ team, branding, T, fontStack, onSignIn }) {
  const [pinFor, setPinFor] = useState(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const members = team || [];

  const pick = (m) => { if (m.pin) { setPinFor(m); setPin(""); setErr(false); } else onSignIn(m.id); };
  const submitPin = () => { if (pin === pinFor.pin) onSignIn(pinFor.id); else { setErr(true); setPin(""); } };

  const wrap = { position: "fixed", inset: 0, zIndex: 500, background: T.bg, color: T.text, fontFamily: fontStack, WebkitFontSmoothing: "antialiased", overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", padding: "0 20px", letterSpacing: "-0.01em" };

  return (
    <div style={wrap}>
      <style>{`@keyframes shakeX { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }`}</style>
      <div style={{ width: "100%", maxWidth: 380, margin: "auto 0", paddingTop: 48, paddingBottom: 48 }}>
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ width: 64, height: 64, borderRadius: 18, background: hexA(T.primary, 0.12), display: "inline-flex", alignItems: "center", justifyContent: "center", overflow: "hidden", marginBottom: 14 }}>
            {branding.logoType === "image" && branding.logoImage
              ? <img src={branding.logoImage} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ fontSize: 34 }}>{branding.logoEmoji}</span>}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.03em" }}>{branding.companyName}</div>
          <div style={{ fontSize: 13, color: T.textMuted, marginTop: 3 }}>{pinFor ? `Enter ${pinFor.name.split(" ")[0]}'s PIN` : "Choose your account to sign in"}</div>
        </div>

        {!pinFor ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {members.length === 0 && <div style={{ textAlign: "center", color: T.textMuted, fontSize: 13 }}>No accounts exist yet.</div>}
            {members.map(m => (
              <button key={m.id} onClick={() => pick(m)} style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 16px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, cursor: "pointer", fontFamily: "inherit", textAlign: "left", boxShadow: T.shadow }}>
                <span style={{ width: 44, height: 44, borderRadius: "50%", background: m.role === "owner" ? T.primary : hexA(T.primary, 0.14), color: m.role === "owner" ? "#fff" : T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flexShrink: 0 }}>{initials(m.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>{m.name}</div>
                  <div style={{ fontSize: 12.5, color: T.textMuted }}>{roleLabel(m.role)}{m.pin ? " · PIN" : ""}</div>
                </div>
                <span style={{ color: T.textMuted, fontSize: 18 }}>›</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: err ? "shakeX 0.3s" : "none" }}>
            <input
              type="password" inputMode="numeric" autoFocus value={pin}
              onChange={e => { setErr(false); setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); }}
              onKeyDown={e => { if (e.key === "Enter") submitPin(); }}
              placeholder="••••"
              style={{ width: "100%", padding: "16px", textAlign: "center", letterSpacing: "0.4em", fontSize: 22, border: `1.5px solid ${err ? "#C0392B" : T.border}`, borderRadius: 14, background: T.surface, color: T.text, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
            />
            {err && <div style={{ textAlign: "center", color: "#C0392B", fontSize: 12.5, fontWeight: 600, marginTop: -6 }}>Incorrect PIN. Try again.</div>}
            <button onClick={submitPin} style={{ width: "100%", padding: "14px", borderRadius: 13, border: "none", background: T.primary, color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>Sign In</button>
            <button onClick={() => { setPinFor(null); setPin(""); setErr(false); }} style={{ background: "none", border: "none", color: T.textMuted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>← Choose a different account</button>
          </div>
        )}

        <div style={{ marginTop: 26, textAlign: "center", fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
          Prototype sign-in on this device. Secure passwords and cross-device accounts arrive with the cloud backend.
        </div>
      </div>
    </div>
  );
}

export default function App({ authEmail = "", onSignOut }) {
  const [selectedClient, setSelectedClient] = useState(null);
  const [adding, setAdding] = useState(false);
  const [scheduleSeed, setScheduleSeed] = useState(null);

  // Persistent data — survives reloads and app updates
  const [clients, setClients, lc] = useStoredState("sps_clients", DEMO_CLIENTS);
  const [branding, setBranding, lb] = useStoredState("sps_branding", DEFAULT_BRANDING);
  const [page, setPage] = useState(DEFAULT_BRANDING.staffDefaultPage || "dashboard");
  const [invoiceFilter, setInvoiceFilter] = useState("All"); // deep-link from dashboard tiles
  const [schedule, setSchedule, ls] = useStoredState("sps_schedule", DEFAULT_SCHEDULE);
  const [catalog, setCatalog, lcat] = useStoredState("sps_catalog", DEFAULT_CATALOG);
  const [email, setEmail, lem] = useStoredState("sps_email", DEFAULT_EMAIL);
  const [costs, setCosts, lco] = useStoredState("sps_costs", DEFAULT_COSTS);
  const [home, setHome, lh] = useStoredState("sps_home", DEFAULT_HOME);
  const [budget, setBudget, lbud] = useStoredState("sps_budget", DEFAULT_BUDGET);
  const [officeAlerts, setOfficeAlerts, loa] = useStoredState("sps_officeAlerts", []);
  const [scheduleCfg, setScheduleCfg, lscfg] = useStoredState("sps_schedule_cfg", DEFAULT_SCHEDULE_CFG);
  const [roles, setRoles, lrol] = useStoredState("sps_roles", DEFAULT_ROLES);
  const [team, setTeam, ltm] = useStoredState("sps_team", DEFAULT_TEAM);
  const [session, setSession, lsesh] = useStoredState("sps_session", { userId: DEFAULT_OWNER_ID });
  const [invoices, setInvoices, linv] = useStoredState("sps_invoices", DEMO_INVOICES);
  const [invoicing, setInvoicing, linvc] = useStoredState("sps_invoicing", DEFAULT_INVOICING);
  const [completedSids, setCompletedSids, lcomp] = useStoredState("sps_completed", {});
  const hydrated = lc && lb && ls && lcat && lem && lco && lh && lbud && loa && lscfg && lrol && ltm && lsesh && linv && linvc && lcomp;

  // Backfill newer catalog/cost fields for anyone with older saved data
  useEffect(() => {
    if (!lcat) return;
    setCatalog(c => {
      const next = { ...c };
      let changed = false;
      if (!next.tests || !next.tests.length) { next.tests = DEFAULT_CATALOG.tests; changed = true; }
      if (!next.treatments || !next.treatments.length) { next.treatments = DEFAULT_CATALOG.treatments; changed = true; }
      if (!next.services) { next.services = DEFAULT_CATALOG.services; changed = true; }
      return changed ? next : c;
    });
  }, [lcat]);
  useEffect(() => {
    if (!lco) return;
    setCosts(c => {
      const next = { hourlyRate: c.hourlyRate || DEFAULT_COSTS.hourlyRate };
      let changed = c.jobsPerMonth !== undefined || c.gasMonthly !== undefined;
      COST_LINES.forEach(k => {
        const cur = c[k];
        if (typeof cur === "object" && cur !== null && "mode" in cur) { next[k] = cur; }
        else if (typeof cur === "string") { next[k] = { amount: cur, mode: "stop" }; changed = true; }
        else { next[k] = DEFAULT_COSTS[k]; changed = true; }
      });
      return changed ? next : c;
    });
  }, [lco]);

  useEffect(() => {
    if (!ltm) return;
    setTeam(list => {
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) return list;
      let changed = false;
      let next = arr.map(m => {
        const nm = { ...m };
        if (nm.role === undefined) { nm.role = "field"; changed = true; }
        if (nm.pin === undefined) { nm.pin = ""; changed = true; }
        return nm;
      });
      if (!next.some(m => m.role === "owner")) { next = next.map((m, i) => i === 0 ? { ...m, role: "owner" } : m); changed = true; }
      return changed ? next : list;
    });
  }, [ltm]);

  // cache the current logo so the sign-in screen can show it (matches the in-app logo)
  useEffect(() => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("sps_brand_logo", JSON.stringify({
          type: branding.logoType, emoji: branding.logoEmoji, image: branding.logoImage, name: branding.companyName,
        }));
      }
    } catch (e) {}
  }, [branding]);

  const systemDark = useSystemDark();
  const mode = branding.appearance === "system" ? (systemDark ? "dark" : "light") : (branding.appearance || "light");
  const themeDef = THEMES[branding.themeKey];
  const T = branding.themeKey === "custom"
    ? buildCustomTheme(branding.custom, mode)
    : (themeDef ? (themeDef[mode] || themeDef.light) : THEMES.sps.light);
  const fontStack = (branding.themeKey === "custom" && FONTS[branding.custom?.fontFamily]) ? FONTS[branding.custom.fontFamily].stack : DEFAULT_FONT_STACK;

  // who is signed in, and the permissions that flow from their role
  const emailKey = (authEmail || "").trim().toLowerCase();
  const anyEmail = (team || []).some(m => (m.email || "").trim());
  const currentUser = (team || []).find(m => (m.email || "").trim().toLowerCase() === emailKey) || null;
  // client portal: if no staff match, check if email belongs to a client record
  const clientUser = !currentUser && emailKey ? (clients || []).find(c => (c.email || "").trim().toLowerCase() === emailKey) || null : null;
  // older saved team data may predate roles — guarantee an owner so admin powers always resolve
  const teamHasOwner = (team || []).some(m => m.role === "owner");
  const effRole = (m) => m ? (m.role || ((!teamHasOwner && team[0] && team[0].id === m.id) ? "owner" : "field")) : null;
  const perms = memberPerms(currentUser ? { ...currentUser, role: effRole(currentUser) } : null);
  useEffect(() => {
    let hiddenAt = null;
    const onVis = () => { if (document.hidden) { hiddenAt = Date.now(); } else if (hiddenAt && Date.now() - hiddenAt > 30000) { window.location.reload(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const [dbError, setDbError] = useState(null);
  useEffect(() => {
    const onStatus = (e) => {
      if (e.detail.type === "error") setDbError(e.detail.msg);
      else setDbError(null);
    };
    document.addEventListener("sps-db-status", onStatus);
    return () => document.removeEventListener("sps-db-status", onStatus);
  }, []);

  // Track unread message count for nav badge
  const [navUnread, setNavUnread] = useState(0);

  // Customizable dock — which pages appear in the bottom bar (max 5)
  const [navDock, setNavDock, lndock] = useStoredState("sps_nav_dock", DEFAULT_DOCK);
  const [estimatesRaw, setEstimatesRaw, lest] = useStoredState("sps_estimates", []);
  const [serviceTiers, setServiceTiers] = useStoredState("sps_service_tiers", DEFAULT_TIERS);
  // Keep the module-level reference in sync so client portal uses live tiers
  CP_TIERS = serviceTiers || DEFAULT_TIERS;  // now a { Pond, Pool, Seasonal } object
  const [routeAssignments, setRouteAssignments, lra] = useStoredState("sps_route_assignments", []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncState, setSyncState] = useState("idle");
  const syncTimer = useRef(null);
  const [showSplash, setShowSplash] = useState(true);
  const splashShown = useRef(false);

  // Trigger a visible sync pulse whenever any stored state saves
  const triggerSync = () => {
    setSyncState("syncing");
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => setSyncState("saved"), 800);
    setTimeout(() => setSyncState("idle"), 2400);
  };

  const manualSync = () => {
    triggerSync();
    setTimeout(() => window.location.reload(), 300);
  };

  // Register global sync hook so useStoredState can notify us
  useEffect(() => {
    window.__onSpsSync = triggerSync;
    return () => { window.__onSpsSync = null; };
  }, []);

  // Branded splash — always shows for 2.2s after hydration
  useEffect(() => {
    if (!hydrated) return;
    if (splashShown.current) return;
    splashShown.current = true;
    setShowSplash(true);
    const t = setTimeout(() => setShowSplash(false), 3000);
    return () => clearTimeout(t);
  }, [hydrated]);

  // Ensure dock only contains pages the user has permission to see
  const dockIds = (navDock || DEFAULT_DOCK).filter(id => {
    const n = ALL_NAV.find(x => x.id === id);
    if (!n) return false;
    if (n.ownerOnly && !perms.isAdmin) return false;
    if (n.perm && !perms[n.perm]) return false;
    return true;
  });
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from("sps_messages").select("id").eq("sender", "client").is("read_at", null);
      setNavUnread(data ? data.length : 0);
    };
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleSignOut = () => { setPage("dashboard"); setSelectedClient(null); setAdding(false); if (onSignOut) onSignOut(); };
  // first real sign-in (no emails assigned yet) claims the owner account automatically
  useEffect(() => {
    if (!ltm || !emailKey || currentUser || anyEmail) return;
    setTeam(list => {
      const arr = Array.isArray(list) ? list.slice() : [];
      let idx = arr.findIndex(m => m.role === "owner"); if (idx < 0) idx = 0;
      if (arr[idx]) arr[idx] = { ...arr[idx], email: authEmail };
      return arr;
    });
  }, [ltm, emailKey, currentUser, anyEmail]);

  const handleClientSelect = (c) => { setSelectedClient(c); setAdding(false); setPage("clients"); window.scrollTo({ top: 0, behavior: "instant" }); };
  // QuickBooks sync handler — merges QB invoices into app state and matches customers to clients
  const handleQBSync = (qbInvoices, qbCustomers) => {
    // Build client lookup maps from current clients snapshot
    const currentClients = clients || [];

    // Build map: qbCustomerId -> spsClientId, using name + email matching
    const qbIdToClientId = {};
    const nameToClientId = {};

    // Index SPS clients by name and email for fast lookup
    currentClients.forEach(c => {
      if (c.name)  nameToClientId[c.name.toLowerCase().trim()]  = c.id;
      if (c.email) nameToClientId[c.email.toLowerCase().trim()] = c.id;
    });

    // Match QB customers to SPS clients
    const updatedClients = currentClients.map(c => ({ ...c }));
    (qbCustomers || []).forEach(qc => {
      const nameKey  = (qc.name  || "").toLowerCase().trim();
      const emailKey = (qc.email || "").toLowerCase().trim();
      const matchId  = nameToClientId[nameKey] || nameToClientId[emailKey];
      if (matchId) {
        qbIdToClientId[qc.qbId] = matchId;
        // Tag the matching client with their QB ID
        const idx = updatedClients.findIndex(c => c.id === matchId);
        if (idx >= 0) updatedClients[idx] = { ...updatedClients[idx], qbId: qc.qbId };
      }
    });

    // Update clients with QB IDs
    setClients(updatedClients);

    // Map QB invoices to SPS format with clientId resolved
    const newInvoices = qbInvoices.map(qi => {
      // Try qbCustomerId match first, then clientName match
      const clientId = qbIdToClientId[qi.qbCustomerId]
        || nameToClientId[(qi.clientName || "").toLowerCase().trim()]
        || null;

      return {
        id:         `qb_${qi.qbId}`,
        qbId:       qi.qbId,
        number:     qi.number,
        clientId,
        clientName: qi.clientName,
        date:       qi.date,
        dueDate:    qi.dueDate,
        status:     qi.status,
        items:      (qi.lines || []).map(l => ({
          description: l.description,
          qty:         l.qty,
          rate:        l.rate,
          amount:      l.amount,
        })),
        total:      String(qi.total),
        balance:    qi.balance,
        source:     "quickbooks",
        createdAt:  Date.now(),
      };
    });

    // Merge — keep manual invoices, replace all QB ones
    setInvoices(prev => {
      const manual = (prev || []).filter(iv => iv.source !== "quickbooks");
      return [...manual, ...newInvoices];
    });

    // Log match stats
    const matched = newInvoices.filter(iv => iv.clientId).length;
    console.log(`QB Sync: ${newInvoices.length} invoices, ${matched} matched to clients`);
  };

  // Push a new invoice to QuickBooks and get back payment link
  const pushInvoiceToQB = async (invoice, client) => {
    const accessToken = localStorage.getItem("qb_access_token");
    const realmId     = localStorage.getItem("qb_realm_id");
    if (!accessToken || !realmId) return null;
    try {
      const res = await fetch("/api/quickbooks/create-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: accessToken,
          realm_id:     realmId,
          invoice: {
            ...invoice,
            qbCustomerId: client?.qbId || null,
            clientName:   client?.name  || invoice.clientName,
            clientEmail:  client?.email || invoice.clientEmail,
            clientPhone:  client?.phone || "",
          },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data; // { qbId, paymentLink }
    } catch (err) {
      console.error("QB push invoice error:", err);
      return null;
    }
  };

  const handleNav = (id, opts = {}) => {
    setPage(id);
    setSelectedClient(null);
    setAdding(false);
    setInvoiceFilter(opts.invoiceFilter || "All");
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const handleSaveNewClient = (form) => {
    const newClient = {
      ...form,
      id: Date.now(),
      status: form.status || "Active",
      balance: form.balance || "$0.00",
      equipment: form.equipment || [],
      history: form.history || [],
    };
    setClients(cs => [...cs, newClient]);
    setAdding(false);
  };

  const handleImportClients = (imported) => setClients(cs => [...cs, ...imported]);

  // update a single client (edits, equipment) and keep the open detail in sync
  const handleUpdateClient = (updated) => {
    setClients(cs => cs.map(c => c.id === updated.id ? updated : c));
    setSelectedClient(sc => sc && sc.id === updated.id ? updated : sc);
  };

  // batch client operations
  const handleBatchUpdate = (ids, changes) =>
    setClients(cs => cs.map(c => ids.includes(c.id) ? { ...c, ...changes } : c));
  const handleBatchDelete = (ids) =>
    setClients(cs => cs.filter(c => !ids.includes(c.id)));
  const handleBatchSchedule = (ids) => {
    setScheduleSeed(ids);
    setSelectedClient(null);
    setPage("schedule");
  };

  const handleResetData = async () => {
    await store.remove("sps_clients");
    await store.remove("sps_branding");
    await store.remove("sps_schedule");
    await store.remove("sps_catalog");
    await store.remove("sps_email");
    await store.remove("sps_costs");
    await store.remove("sps_home");
    await store.remove("sps_budget");
    await store.remove("sps_officeAlerts");
    await store.remove("sps_schedule_cfg");
    await store.remove("sps_roles");
    await store.remove("sps_team");
    await store.remove("sps_session");
    await store.remove("sps_invoices");
    await store.remove("sps_invoicing");
    await store.remove("sps_completed");
    setClients(DEMO_CLIENTS);
    setBranding(DEFAULT_BRANDING);
    setSchedule(DEFAULT_SCHEDULE);
    setCatalog(DEFAULT_CATALOG);
    setEmail(DEFAULT_EMAIL);
    setCosts(DEFAULT_COSTS);
    setHome(DEFAULT_HOME);
    setBudget(DEFAULT_BUDGET);
    setOfficeAlerts([]);
    setScheduleCfg(DEFAULT_SCHEDULE_CFG);
    setRoles(DEFAULT_ROLES);
    setTeam(DEFAULT_TEAM);
    setSession({ userId: DEFAULT_OWNER_ID });
    setInvoices(DEMO_INVOICES);
    setInvoicing(DEFAULT_INVOICING);
    setCompletedSids({});
  };

  const handleOfficeAlert = (a) => setOfficeAlerts(list => [{ id: Date.now(), resolved: false, ...a }, ...list]);
  const handleResolveAlert = (id) => setOfficeAlerts(list => list.filter(a => a.id !== id));
  // client service requests land as office alerts so staff see them on the dashboard
  const handleServiceRequest = (req) => handleOfficeAlert({ title: `Service Request: ${req.clientName}`, body: `${req.type}${req.dates ? " · " + req.dates : ""}${req.notes ? " — " + req.notes : ""}`, type: "request", clientId: req.clientId });

  const handleConfirmUpgrade = (updatedAlert, updatedClient) => {
    // Save progress state back to the alert (persists steps across modal opens)
    setOfficeAlerts(list => list.map(a => a.id === updatedAlert.id ? { ...a, ...updatedAlert } : a));
    // Final step — apply plan change and save signed doc to client record
    if (updatedAlert.fullyComplete && updatedClient) {
      setClients(prev => prev.map(c => {
        if (String(c.id) !== String(updatedAlert.clientId)) return c;
        const existingDocs = c.documents || [];
        const signedDoc = updatedAlert.signedDoc;
        const newDocs = signedDoc && !existingDocs.find(d => d.name === signedDoc.name)
          ? [...existingDocs, {
              id: `doc-${Date.now()}`,
              ...signedDoc,
              label: `${updatedAlert.requestedPlan} Service Agreement`,
              category: "Upgrade Agreement",
              note: updatedAlert.contractNote || "Signed via Dropbox Sign",
              uploadedAt: Date.now(),
            }]
          : existingDocs;
        return { ...c, plan: updatedAlert.requestedPlan, documents: newDocs };
      }));
    }
  };

  const handleUpgradeRequest = (req) => handleOfficeAlert({
    title: `Upgrade Request: ${req.clientName}`,
    body: req.message || "No additional message.",
    type: "upgrade_request",
    clientId: req.clientId,
    clientName: req.clientName,
    currentPlan: req.currentPlan,
    requestedPlan: req.requestedPlan,
    submittedAt: req.submittedAt,
    upgradeStep: 0,
    date: new Date().toLocaleDateString("en-US"),
  });

  const handleSaveInvoice = async (inv) => {
    // Push new invoices to QuickBooks if connected
    const isNew = !(invoices || []).some(iv => iv.id === inv.id);
    const accessToken = localStorage.getItem("qb_access_token");
    let finalInv = { ...inv };

    if (isNew && accessToken && inv.source !== "quickbooks") {
      const client = (clients || []).find(c => c.id === inv.clientId);
      const qbResult = await pushInvoiceToQB(inv, client);
      if (qbResult?.qbId) {
        finalInv = { ...finalInv, qbId: qbResult.qbId, paymentLink: qbResult.paymentLink, source: "sps+qb" };
      }
    }

    setInvoices(list => {
      const exists = (list || []).some(iv => iv.id === finalInv.id);
      return exists ? list.map(iv => iv.id === finalInv.id ? finalInv : iv) : [finalInv, ...(list || [])];
    });
  };
  const handleDeleteInvoice = (id) => setInvoices(list => (list || []).filter(iv => iv.id !== id));

  // mark a stop complete: prepend the visit to the client's history (with photos)
  const handleCompleteStop = (clientId, entry, sid) => {
    setClients(cs => cs.map(c => {
      if (c.id !== clientId) return c;
      const history = [entry, ...(c.history || [])];
      const balance = entry.invoice && entry.invoice !== "$0"
        ? entry.invoice : c.balance;
      return { ...c, history, balance };
    }));
    // subtract used treatment ounces from inventory
    if (entry.treatmentsUsed && entry.treatmentsUsed.length) {
      setCatalog(cat => ({
        ...cat,
        treatments: (cat.treatments || []).map(t => {
          const used = entry.treatmentsUsed.find(u => u.id === t.id);
          if (!used) return t;
          const remaining = Math.max(0, (parseFloat(t.inventoryOz) || 0) - (used.oz || 0));
          return { ...t, inventoryOz: String(remaining) };
        }),
      }));
    }
    if (sid) setCompletedSids(m => ({ ...m, [sid]: true }));
  };

  // Branded splash — shows while loading OR for minimum 2.2s after hydration
  const splashTagline = (branding.splashTagline && branding.splashTagline.trim())
    ? branding.splashTagline.trim()
    : (branding.division && branding.division.trim())
    ? branding.division.trim()
    : "Field Operations";

  const splashUser = currentUser || clientUser;
  const splashFirstName = splashUser ? ((splashUser.name || splashUser.email || "").split(" ")[0] || "").split("@")[0] : "";
  const splashHour = new Date().getHours();
  const splashGreeting = splashHour < 12 ? "Good morning" : splashHour < 17 ? "Good afternoon" : "Good evening";

  if (!hydrated || showSplash) {
    const splashBg1    = (branding.splashBgColor && branding.splashBgColor.trim()) ? branding.splashBgColor : T.primary;
    const splashBg2    = (branding.splashBgColor2 && branding.splashBgColor2.trim()) ? branding.splashBgColor2 : mix(splashBg1, "#000", 0.32);
    const splashStyle  = branding.splashBgStyle || "gradient";
    const splashBgCss  = splashStyle === "solid" ? splashBg1
      : splashStyle === "image" && branding.splashBgImage ? `url(${branding.splashBgImage}) center/cover no-repeat`
      : `linear-gradient(150deg, ${splashBg1} 0%, ${splashBg2} 100%)`;
    const splashFgColor = branding.splashTextColor === "dark" ? "rgba(0,0,0,0.85)" : "#fff";
    const splashLogoSrc = branding.splashLogoOverride || (branding.logoType === "image" ? branding.logoImage : null);
    const showGreeting  = branding.splashShowGreeting !== "false";
    const greetPrefix   = (branding.splashGreetingPrefix || "").trim();

    return (
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif',
        background: splashBgCss,
        position: "fixed", inset: 0,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        color: splashFgColor, WebkitFontSmoothing: "antialiased", overflow: "hidden",
        zIndex: 9999,
      }}>
        <style>{`
          @keyframes sIn  { from { opacity:0; transform:translateY(20px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }
          @keyframes sOut { from { opacity:1; } to { opacity:0; } }
          @keyframes spin { to { transform:rotate(360deg); } }
          .si0 { animation: sIn 0.5s cubic-bezier(.22,1,.36,1) 0.05s both; }
          .si1 { animation: sIn 0.5s cubic-bezier(.22,1,.36,1) 0.18s both; }
          .si2 { animation: sIn 0.5s cubic-bezier(.22,1,.36,1) 0.28s both; }
          .si3 { animation: sIn 0.5s cubic-bezier(.22,1,.36,1) 0.42s both; }
          .s-out { animation: sOut 0.6s ease 2.3s both; }
        `}</style>

        {splashStyle === "image" && branding.splashBgImage && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.38)", pointerEvents:"none" }} />
        )}
        {splashStyle !== "image" && (
          <>
            <div style={{ position:"absolute", right:-100, top:-100, width:340, height:340, borderRadius:"50%", background:"rgba(255,255,255,0.06)", pointerEvents:"none" }} />
            <div style={{ position:"absolute", left:-70, bottom:-70, width:220, height:220, borderRadius:"50%", background:"rgba(255,255,255,0.04)", pointerEvents:"none" }} />
          </>
        )}

        <div className="s-out" style={{ position:"relative", display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", padding:"0 36px", gap: 0 }}>
          {/* Logo */}
          <div className="si0" style={{ marginBottom: 24 }}>
            {splashLogoSrc ? (
              <img src={splashLogoSrc} alt="" style={{ width:92, height:92, borderRadius:26, objectFit:"cover", boxShadow:"0 16px 48px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)" }} />
            ) : (
              <div style={{ width:92, height:92, borderRadius:26, background:"rgba(255,255,255,0.18)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:44, boxShadow:"0 16px 48px rgba(0,0,0,0.25)" }}>
                {branding.logoEmoji || "💧"}
              </div>
            )}
          </div>

          {/* Company name */}
          <div className="si1" style={{ fontSize:26, fontWeight:900, letterSpacing:"-0.04em", color:splashFgColor, lineHeight:1, marginBottom:8 }}>
            {branding.companyName}
          </div>

          {/* Tagline */}
          <div className="si2" style={{ fontSize:14, fontWeight:500, letterSpacing:"0.04em", textTransform:"uppercase", opacity:0.6, color:splashFgColor, marginBottom: splashFirstName && showGreeting ? 28 : 0 }}>
            {splashTagline}
          </div>

          {/* Greeting pill */}
          {splashFirstName && showGreeting && (
            <div className="si3" style={{ background:"rgba(255,255,255,0.14)", borderRadius:100, padding:"11px 28px", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", border:"1px solid rgba(255,255,255,0.18)" }}>
              <span style={{ fontSize:20, fontWeight:800, color:splashFgColor, letterSpacing:"-0.02em" }}>
                {greetPrefix || splashGreeting}, {splashFirstName}.
              </span>
            </div>
          )}

          {/* Loading spinner */}
          {!hydrated && (
            <div className="splash-dot" style={{ marginTop: 48, width: 22, height: 22, border: `2.5px solid rgba(255,255,255,0.3)`, borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.9s linear infinite" }} />
          )}
        </div>
      </div>
    );
  }

  // Client portal — email matched a client record, not a staff member
  if (!currentUser && clientUser) {
    return (
      <SPSClientPortal
        client={clientUser}
        estimates={estimatesRaw}
        onApproveEstimate={(id, status) => setEstimatesRaw(prev => (prev||[]).map(e => String(e.id) === String(id) ? { ...e, status } : e))}
        schedule={schedule}
        invoices={invoices}
        branding={branding}
        T={T}
        fontStack={fontStack}
        onSignOut={handleSignOut}
        onServiceRequest={handleServiceRequest}
        onUpgradeRequest={handleUpgradeRequest}
      />
    );
  }

  // Not signed in → show the account picker
  if (!currentUser) {
    if (!anyEmail) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: fontStack, background: T.bg, color: T.textMuted, fontSize: 14 }}>Setting up your account…</div>;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: fontStack, background: T.bg, color: T.text }}>
        <div style={{ textAlign: "center", maxWidth: 340 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}><Icon name="lock" size={32} /></div>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>No access yet</div>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 20, lineHeight: 1.5 }}>This app isn't set up for <b>{authEmail}</b>. Ask the owner to add this email under Team &amp; Logins.</div>
          <button onClick={onSignOut} style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 12, padding: "12px 20px", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <AppCtx.Provider value={{ T, branding, perms, tiers: serviceTiers || DEFAULT_TIERS }}>
      <div style={{
        fontFamily: fontStack,
        background: T.bg, minHeight: "100vh", display: "flex", flexDirection: "column", color: T.text,
        WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale", letterSpacing: "-0.01em",
        // CSS vars used by the global polish layer below
        ["--ring"]: hexA(T.primary, 0.22), ["--ringBorder"]: T.primary,
      }}>
        <style>{`
          *, *::before, *::after { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
          body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
          input, select, textarea {
            transition: border-color .15s ease, box-shadow .15s ease;
            -webkit-appearance: none;
            appearance: none;
            border-radius: 12px;
            font-size: 16px !important;
            line-height: 1.4;
          }
          input:focus, select:focus, textarea:focus {
            border-color: var(--ringBorder) !important;
            box-shadow: 0 0 0 3.5px var(--ring);
            outline: none;
          }
          button { -webkit-tap-highlight-color: transparent; }
          button, a { transition: transform .1s cubic-bezier(.34,1.56,.64,1), opacity .15s ease, background .15s ease; }
          button:active:not(:disabled) { transform: scale(0.95); opacity: 0.85; }
          @media (hover: hover) { button:hover:not(:disabled) { filter: brightness(1.05); } }
          ::selection { background: var(--ring); }
          ::-webkit-scrollbar { width: 5px; height: 5px; }
          ::-webkit-scrollbar-thumb { background: ${hexA(T.textMuted, 0.2)}; border-radius: 100px; }
          ::-webkit-scrollbar-track { background: transparent; }
          select { background-image: none; cursor: pointer; }
          textarea { line-height: 1.6; }
          img { -webkit-user-drag: none; }
        `}</style>

        {/* Header — light frosted, matches theme surface */}
        <header style={{ background: hexA(T.surface, 0.9), backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", color: T.text, position: "sticky", top: 0, zIndex: 100, borderBottom: `1px solid ${T.border}` }}>
          {/* Safe area spacer — grows to exactly the status bar height on any iPhone, zero on Android */}
          <div style={{ height: "env(safe-area-inset-top)", background: "transparent" }} />
          <div style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 18, paddingRight: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ width: 36, height: 36, borderRadius: 11, background: hexA(T.primary, 0.12), display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {branding.logoType === "image" && branding.logoImage
                ? <img src={branding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 19 }}>{branding.logoEmoji}</span>}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2, color: T.text }}>{branding.companyName}</div>
              <div style={{ fontSize: 11, color: T.textMuted, letterSpacing: "0.01em" }}>{branding.division}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Sync button */}
            <button onClick={manualSync} title="Sync"
              style={{ background: T.surfaceAlt, border: "none", color: syncState === "saved" ? "#16a34a" : T.textMuted, cursor: "pointer", width: 36, height: 36, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", transition: "color 0.3s" }}>
              <Icon name="refresh" size={16} style={{ animation: syncState === "syncing" ? "spin 0.7s linear infinite" : "none" }} />
            </button>
            {/* Menu button */}
            <button onClick={() => setMenuOpen(true)}
              style={{ background: menuOpen ? hexA(T.primary, 0.12) : T.surfaceAlt, border: "none", color: menuOpen ? T.primary : T.textMuted, cursor: "pointer", width: 36, height: 36, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
              <Icon name="sliders" size={18} />
              {navUnread > 0 && !dockIds.includes("messages") && (
                <span style={{ position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: "50%", background: T.primary, border: `1.5px solid ${T.surface}` }} />
              )}
            </button>
          </div>
          </div>
        </header>



        {/* Sync indicator strip — minimal, non-intrusive */}
        {syncState !== "idle" && (
          <div style={{ height: 2, background: syncState === "syncing" ? T.primary : "#16a34a", transition: "background 0.3s", animation: syncState === "syncing" ? "syncPulse 0.8s ease-in-out" : "none" }} />
        )}

        {dbError && (
          <div style={{ background: hexA("#F59E0B", 0.1), borderBottom: `1px solid ${hexA("#F59E0B", 0.3)}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, color: T.text }}>
            <span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="warning" size={15} />{dbError}</span>
            <button onClick={() => window.location.reload()} style={{ background: "#F59E0B", color: "#fff", border: "none", borderRadius: 10, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, display:"flex", alignItems:"center", gap:5 }}>Retry</button>
          </div>
        )}
        <main style={{ flex: 1, padding: "22px 16px", maxWidth: 740, margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: "calc(96px + env(safe-area-inset-bottom))" }}>
          {page === "dashboard" && <Dashboard clients={clients} invoices={invoices} schedule={schedule} home={home} setHome={setHome} officeAlerts={officeAlerts} onResolveAlert={handleResolveAlert} onNav={handleNav} catalog={catalog} onConfirmUpgrade={handleConfirmUpgrade} />}
          {page === "clients" && adding && <ClientEditForm client={BLANK_CLIENT} title="Add Client" onSave={handleSaveNewClient} onCancel={() => setAdding(false)} />}
          {page === "clients" && !adding && !selectedClient && <ClientList clients={clients} onSelect={handleClientSelect} onAdd={() => setAdding(true)} onImport={() => handleNav("import")} onBatchUpdate={handleBatchUpdate} onBatchDelete={handleBatchDelete} onBatchSchedule={handleBatchSchedule} />}
          {page === "clients" && !adding && selectedClient && <ClientDetail client={selectedClient} invoices={invoices} invoicing={invoicing} branding={branding} schedule={schedule} onBack={() => setSelectedClient(null)} onUpdate={handleUpdateClient} onSaveInvoice={handleSaveInvoice} onDeleteInvoice={handleDeleteInvoice} />}
          {page === "schedule" && <Schedule clients={clients} catalog={catalog} costs={costs} schedule={schedule} setSchedule={setSchedule} scheduleCfg={scheduleCfg} team={team} onClientSelect={handleClientSelect} seedClientIds={scheduleSeed} clearSeed={() => setScheduleSeed(null)} email={email} onComplete={handleCompleteStop} completedSids={completedSids} onOfficeAlert={handleOfficeAlert} routeAssignments={routeAssignments} setRouteAssignments={setRouteAssignments} />}
          {page === "messages"  && <MessagesScreen clients={clients} currentUser={currentUser} T={T} />}
          {page === "inventory"  && perms.isAdmin && <InventoryScreen catalog={catalog} setCatalog={setCatalog} clients={clients} T={T} />}
          {page === "reports"   && perms.isAdmin && <ReportsScreen clients={clients} invoices={invoices} schedule={schedule} costs={costs} T={T} />}
          {page === "estimates" && perms.canInvoice && <EstimatesScreen clients={clients} catalog={catalog} branding={branding} email={email} invoicing={invoicing} T={T} estimates={estimatesRaw} setEstimates={setEstimatesRaw} />}
          {page === "invoices"  && perms.canInvoice && <InvoicesScreen invoices={invoices} clients={clients} invoicing={invoicing} branding={branding} onSave={handleSaveInvoice} onDelete={handleDeleteInvoice} initialFilter={invoiceFilter} />}
          {page === "import"   && perms.canImport && <SkimmerImport onImport={handleImportClients} onGoToClients={() => handleNav("clients")} />}
          {page === "settings" && <AppSettings branding={branding} setBranding={setBranding} catalog={catalog} setCatalog={setCatalog} email={email} setEmail={setEmail} costs={costs} setCosts={setCosts} budget={budget} setBudget={setBudget} clients={clients} setClients={setClients} invoices={invoices} scheduleCfg={scheduleCfg} setScheduleCfg={setScheduleCfg} team={team} setTeam={setTeam} invoicing={invoicing} setInvoicing={setInvoicing} currentUserId={currentUser.id} onResetData={handleResetData} serviceTiers={serviceTiers} setServiceTiers={setServiceTiers} onSyncData={handleQBSync} />}
        </main>

        {/* Bottom Nav — shows only the user's chosen dock items */}
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: hexA(T.surface, 0.88), backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", borderTop: `1px solid ${T.border}`, display: "flex", zIndex: 90, minHeight: 60, paddingTop: 4, paddingBottom: "calc(8px + env(safe-area-inset-bottom))" }}>
          {dockIds.map(id => {
            const n = ALL_NAV.find(x => x.id === id);
            if (!n) return null;
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => handleNav(n.id)}
                style={{ flex: 1, border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: active ? T.primary : T.textMuted, fontFamily: "inherit", position: "relative" }}>
                <span style={{ width: 46, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 100, background: active ? hexA(T.primary, 0.12) : "transparent", transition: "background .15s", position: "relative" }}>
                  <Icon name={n.icon} size={22} />
                  {n.id === "messages" && navUnread > 0 && (
                    <span style={{ position: "absolute", top: 2, right: 4, width: 8, height: 8, borderRadius: "50%", background: T.primary, border: `2px solid ${T.bg}` }} />
                  )}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500, letterSpacing: "-0.01em" }}>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Overflow menu — slides in from top right */}
        {menuOpen && (
          <OverflowMenu
            page={page}
            perms={perms}
            navUnread={navUnread}
            dockIds={dockIds}
            setDockIds={setNavDock}
            onNav={handleNav}
            onSignOut={handleSignOut}
            currentUser={currentUser}
            T={T}
            branding={branding}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </AppCtx.Provider>
  );
}
