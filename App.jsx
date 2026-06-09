import { useState, useRef, useEffect, useContext, createContext } from "react";
import { store, supabase } from "./supabaseClient";

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
  }, [key, value, loaded]);
  return [value, setValue, loaded];
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
  equipment: [], history: [],
  nextService: "", balance: "$0.00",
};

const DIVISIONS = ["Pond", "Pool", "Seasonal"];
const PLANS = ["Essential", "Signature", "Premium"];

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
    lines.push(`We took ${ctx.photoCount} photo${ctx.photoCount === 1 ? "" : "s"} during today's visit — you can view them anytime in your client portal.`);
    lines.push("");
  }
  lines.push(email.signoff);
  lines.push("");
  lines.push(`— The ${ctx.company} Team`);
  return lines.join("\n");
}

// Resize + compress an image file to a small data URL so storage stays light
function compressImage(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL("image/jpeg", quality)); }
        catch (err) { resolve(e.target.result); }
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
const planMeta = (plan, T) => ({
  Premium:   { bg: T.primary,     text: "#fff" },
  Signature: { bg: T.headerBg,    text: "#fff" },
  Essential: { bg: T.surfaceAlt,  text: T.text  },
}[plan] || { bg: T.border, text: T.textMuted });

const statusColor = (s, T) => ({
  Good:          T.accent,
  Monitor:       T.warning,
  "Replace Soon": T.primary,
}[s] || T.textMuted);

// Sum revenue/cost/profit from completed jobs in a given month (default: current)
function monthActuals(clients, when = new Date()) {
  const m = when.getMonth(), y = when.getFullYear();
  let revenue = 0, cost = 0, jobs = 0;
  (clients || []).forEach(c => (c.history || []).forEach(h => {
    if (!h.breakdown) return;
    const [mm, dd, yy] = (h.date || "").split("/").map(Number);
    if (mm - 1 === m && yy === y) {
      revenue += h.breakdown.revenue || 0;
      cost += h.breakdown.total || 0;
      jobs += 1;
    }
  }));
  return { revenue, cost, profit: revenue - cost, jobs };
}

// derive outstanding balances + equipment flags into alert items
function deriveAlerts(clients, invoices) {
  const alerts = [];
  (clients || []).forEach(c => {
    (c.equipment || []).forEach(e => {
      if (e.status && e.status !== "Good") alerts.push({ icon: "warning", title: `${c.name} — ${e.name}`, sub: `Marked "${e.status}"` });
    });
    const owed = clientOutstanding(c, invoices);
    if (owed > 0) alerts.push({ icon: "dollar", title: `${c.name} — $${owed.toFixed(2)} outstanding`, sub: "Open balance" });
  });
  return alerts.slice(0, 6);
}

// ── Invoicing ──
const INVOICE_STATUSES = ["Draft", "Sent", "Paid", "Overdue"];
const invStatusColor = (s, T) => ({ Draft: T.textMuted, Sent: T.primary, Paid: T.accent, Overdue: T.warning }[s] || T.textMuted);

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
const clientInvoicesOf = (invoices, clientId) => (invoices || []).filter(iv => iv.clientId === clientId);
// what a client owes: from their unpaid invoices if any exist, else the stored balance
const clientOutstanding = (client, invoices) => {
  const list = clientInvoicesOf(invoices, client.id);
  if (list.length) return list.filter(iv => effectiveStatus(iv) !== "Paid" && iv.status !== "Draft").reduce((s, iv) => s + invoiceTotals(iv).total, 0);
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

function StatCard({ label, value, sub, accent }) {
  const { T } = useApp();
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: 20,
      padding: "18px 18px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: T.textMuted, textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, color: accent && accent !== T.surface ? accent : T.text, lineHeight: 1, letterSpacing: "-0.03em" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 6 }}>{sub}</div>}
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
function Dashboard({ clients, invoices, schedule, home, setHome, officeAlerts, onResolveAlert, onNav }) {
  const { T, perms } = useApp();
  const [editing, setEditing] = useState(false);

  const today = (schedule && schedule[0]) || { stops: [] };
  const ma = monthActuals(clients);
  const derived = deriveAlerts(clients, invoices).filter(a => perms.seeBalances || !/outstanding/i.test(a.title || ""));
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
        { label: "Active Clients", value: clients.length, sub: "All divisions", accent: T.primary },
        { label: "Stops Today", value: today.stops.length, sub: today.stops.length === 1 ? "1 stop" : "scheduled", accent: T.headerBg },
      ];
      if (perms.seeBalances) tiles.push({ label: "Outstanding", value: money(outstandingTotal), sub: `${outstandingClients.length} ${outstandingClients.length === 1 ? "client" : "clients"}`, accent: T.warning });
      if (perms.seeProfit) tiles.push({ label: "Profit (mo)", value: money(ma.profit), sub: `${ma.jobs} jobs`, accent: T.accent });
      else tiles.push({ label: "Jobs (mo)", value: ma.jobs, sub: "completed", accent: T.accent });
      return (
        <div key="stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {tiles.map(t => <StatCard key={t.label} label={t.label} value={t.value} sub={t.sub} accent={t.accent} />)}
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
              <div style={{ fontSize: 9, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.time.split(" ")[1]}</div>
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
        {flags.map((a) => (
          <div key={a.id} style={{ padding: "14px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 12, alignItems: "flex-start", background: `${T.warning}08` }}>
            <Icon name="warning" size={18} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{a.client} — needs office attention</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{a.message}</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{a.date}</div>
            </div>
            <button onClick={() => onResolveAlert && onResolveAlert(a.id)} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: T.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Resolve</button>
          </div>
        ))}
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
  const { T, perms } = useApp();
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Clients</h2>
        {selectMode ? (
          <button onClick={exitSelect} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        ) : perms.editClients ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" sm onClick={() => setSelectMode(true)}>Select</Btn>
            <Btn sm onClick={onAdd}>+ Add</Btn>
          </div>
        ) : null}
      </div>

      <div style={{ position: "relative", marginBottom: 14 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.textMuted, display:"flex" }}><Icon name="clients" size={16} /></span>
        <input type="search" placeholder="Search clients or address..."
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ width: "100%", padding: "10px 14px 10px 36px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
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
          const pm = planMeta(c.plan, T);
          const isSel = !!selected[c.id];
          return (
            <div key={c.id}
              onClick={() => selectMode ? toggle(c.id) : onSelect(c)}
              style={{ background: T.surface, border: `1px solid ${isSel ? T.primary : T.border}`, borderRadius: 14, padding: "16px 18px", cursor: "pointer", display: "flex", gap: 14, alignItems: "center", transition: "box-shadow 0.15s, border-color 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
            >
              {selectMode && <Checkbox checked={isSel} onChange={() => toggle(c.id)} />}
              <div style={{ width: 46, height: 46, borderRadius: 12, background: T.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{dMeta(c.division).icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: T.text }}>{c.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.address}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{c.division || "Pond"} · {c.pondType} · {c.pondSize}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", flexShrink: 0 }}>
                <Badge label={c.plan} bg={pm.bg} color={pm.color || pm.text} sm />
                <div style={{ fontSize: 11, color: T.textMuted }}>Next: {c.nextService || "—"}</div>
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
            {DIVISIONS.map(d => (
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
              const pm = planMeta(p, T);
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
  const { T } = useApp();
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
              </>}
              {si === 1 && <>
                <FieldRow label="Division"><Select value={form.division || "Pond"} onChange={e => set("division", e.target.value)} options={DIVISIONS} /></FieldRow>
                <FieldRow label={dMeta(form.division).typeLabel}><Select value={form.pondType} onChange={e => set("pondType", e.target.value)} options={dMeta(form.division).typeOptions} /></FieldRow>
                <FieldRow label={dMeta(form.division).sizeLabel}><Input value={form.pondSize} onChange={e => set("pondSize", e.target.value)} placeholder="e.g. 3,200 gal" /></FieldRow>
              </>}
              {si === 2 && <>
                <FieldRow label="Plan"><Select value={form.plan} onChange={e => set("plan", e.target.value)} options={["Essential","Signature","Premium"]} /></FieldRow>
                <FieldRow label="Frequency"><Select value={form.planFreq} onChange={e => set("planFreq", e.target.value)} options={["Monthly","Bi-Weekly","Weekly"]} /></FieldRow>
                <FieldRow label="Next Service"><Input value={form.nextService} onChange={e => set("nextService", e.target.value)} placeholder="MM/DD/YYYY" /></FieldRow>
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
function ClientDetail({ client: init, invoices, invoicing, branding, schedule, onBack, onUpdate, onSaveInvoice, onDeleteInvoice }) {
  const { T, perms } = useApp();
  const [client, setClient] = useState(init);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const pm = planMeta(client.plan, T);
  const tabs = ["overview", "equipment", "history", ...(perms.canInvoice ? ["invoices"] : []), "portal"];
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
      <button onClick={onBack} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", padding: "0 0 16px", display: "flex", alignItems: "center", gap: 4 }}>← Back to Clients</button>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ padding: "18px 18px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <h2 style={{ margin: "0 0 3px", fontSize: 20, fontWeight: 800, color: T.text, letterSpacing: "-0.01em" }}>{client.name}</h2>
              <div style={{ fontSize: 12, color: T.textMuted }}>{client.address}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge label={client.plan} bg={pm.bg} color={pm.color || pm.text} />
              {perms.editClients && <Btn variant="ghost" sm onClick={() => setEditing(true)} style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="edit" size={13} /> Edit</Btn>}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 12, color: T.textMuted }}>
            <span style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="phone" size={13} />{client.phone}</span>
            <span style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="mail" size={13} />{client.email}</span>
            <span style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="calendar" size={13} />{client.nextService}</span>
            {perms.seeBalances && <span style={{ color: owed <= 0 ? T.accent : T.warning, fontWeight: 600, display:"flex", alignItems:"center", gap:4 }}><Icon name="dollar" size={13} />${owed.toFixed(2)}</span>}
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
      {tab === "equipment" && <ClientEquipment client={client} onChange={eq => update({ equipment: eq })} />}
      {tab === "history" && <ClientHistory client={client} onChange={hist => update({ history: hist })} />}
      {tab === "invoices" && perms.canInvoice && <ClientInvoices client={client} invoices={invoices} invoicing={invoicing} branding={branding} onSave={onSaveInvoice} onDelete={onDeleteInvoice} />}
      {tab === "portal" && <ClientPortal client={client} invoices={invoices} schedule={schedule} branding={branding} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// CLIENT PHOTO PICKER
// Shared inline photo capture/upload used on overview + equipment
// ─────────────────────────────────────────────
function PhotoPicker({ photos = [], onChange, label = "Photos", maxPhotos = 10 }) {
  const { T } = useApp();
  const inputRef = useRef(null);
  const [viewer, setViewer] = useState(null);

  const addPhotos = (files) => {
    const readers = Array.from(files).slice(0, maxPhotos - photos.length).map(file =>
      new Promise(res => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.readAsDataURL(file);
      })
    );
    Promise.all(readers).then(results => onChange([...photos, ...results]));
  };

  const remove = (idx) => onChange(photos.filter((_, i) => i !== idx));

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
        {photos.map((p, i) => (
          <div key={i} style={{ position: "relative" }}>
            <img src={p} alt="" onClick={() => setViewer(i)}
              style={{ width: 80, height: 80, borderRadius: 12, objectFit: "cover", cursor: "pointer", border: `1px solid ${T.border}` }} />
            <button onClick={() => remove(i)}
              style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: "50%", background: "#E5484D", border: "2px solid #fff", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
              <Icon name="close" size={10} />
            </button>
          </div>
        ))}
        {photos.length < maxPhotos && (
          <button onClick={() => inputRef.current?.click()}
            style={{ width: 80, height: 80, borderRadius: 12, border: `2px dashed ${T.border}`, background: T.surfaceAlt, color: T.textMuted, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Icon name="plus" size={20} />
            <span style={{ fontSize: 10, fontWeight: 700 }}>Add</span>
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple capture="environment"
        style={{ display: "none" }}
        onChange={e => { addPhotos(e.target.files); e.target.value = ""; }} />
      {viewer !== null && <PhotoViewer photos={photos} index={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function ClientOverview({ client, onUpdate }) {
  const { T, perms } = useApp();
  const h = client.history[0];
  const m = dMeta(client.division);
  const sitePhotos = client.sitePhotos || [];

  const updateSitePhotos = (photos) => {
    if (onUpdate) onUpdate({ ...client, sitePhotos: photos });
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
              {sitePhotos.length > 0 && (
                <div style={{ marginBottom: perms.editClients ? 16 : 0 }}>
                  <PhotoStrip photos={sitePhotos} size={100} />
                </div>
              )}
              {perms.editClients && (
                <PhotoPicker
                  photos={sitePhotos}
                  onChange={updateSitePhotos}
                  label={sitePhotos.length === 0 ? `Add photos of the ${m.siteLabel.toLowerCase()} to document its current state` : "Add more photos"}
                  maxPhotos={20}
                />
              )}
            </>
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
                  <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</div>
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

function ClientEquipment({ client, onChange }) {
  const { T, perms } = useApp();
  const [modal, setModal] = useState(null);
  const [expanded, setExpanded] = useState({});
  const equipment = client.equipment || [];
  const STATUSES = ["Good", "Monitor", "Replace Soon"];

  const blankEq = () => ({ name: "", installed: "", status: "Good", notes: "", photos: [] });
  const openAdd  = () => setModal({ mode: "add",  data: blankEq() });
  const openEdit = (eq, i) => { if (perms.editClients) setModal({ mode: "edit", index: i, data: { photos: [], notes: "", ...eq } }); };

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
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };

  const toggleExpand = (i) => setExpanded(e => ({ ...e, [i]: !e[i] }));

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
        return (
          <div key={i} style={{ borderBottom: i < equipment.length - 1 ? `1px solid ${T.border}` : "none" }}>
            {/* Header row — tap to expand */}
            <div onClick={() => toggleExpand(i)}
              style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{eq.name}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                  Installed {eq.installed || "—"}
                  {photos.length > 0 && <span style={{ marginLeft: 8, color: T.primary }}>· {photos.length} photo{photos.length > 1 ? "s" : ""}</span>}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(eq.status, T), flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{eq.status}</span>
                </div>
                <div style={{ color: T.textMuted, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                  <Icon name="chevronD" size={16} />
                </div>
              </div>
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div style={{ padding: "0 18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Photos */}
                {perms.editClients ? (
                  <PhotoPicker
                    photos={photos}
                    onChange={newPhotos => {
                      const next = equipment.map((e2, j) => j === i ? { ...e2, photos: newPhotos } : e2);
                      onChange(next);
                    }}
                    label="Equipment Photos"
                    maxPhotos={10}
                  />
                ) : (
                  photos.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Photos</div>
                      <PhotoStrip photos={photos} size={80} />
                    </div>
                  )
                )}

                {/* Condition notes */}
                {perms.editClients ? (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Condition Notes</div>
                    <textarea
                      value={eq.notes || ""}
                      onChange={e => {
                        const next = equipment.map((e2, j) => j === i ? { ...e2, notes: e.target.value } : e2);
                        onChange(next);
                      }}
                      placeholder="Describe visible condition, wear, leaks, noise, etc..."
                      style={{ width: "100%", padding: "11px 13px", border: `1.5px solid ${T.border}`, borderRadius: 12, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical", minHeight: 72, lineHeight: 1.5 }}
                    />
                  </div>
                ) : (
                  eq.notes && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 6 }}>Condition Notes</div>
                      <div style={{ fontSize: 13, color: T.text, lineHeight: 1.6 }}>{eq.notes}</div>
                    </div>
                  )
                )}

                {/* Edit button */}
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

      {modal && (
        <Modal title={modal.mode === "add" ? "Add Equipment" : "Edit Equipment"} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <input type="text" style={field} value={modal.data.name} onChange={e => setD("name", e.target.value)} placeholder="e.g. Aquascape 3000 Pump" autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Date Installed</label>
              <input type="text" inputMode="numeric" style={field} value={modal.data.installed} onChange={e => setD("installed", e.target.value)} placeholder="MM/YYYY" />
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <div style={{ display: "flex", gap: 8 }}>
                {STATUSES.map(s => (
                  <button key={s} onClick={() => setD("status", s)}
                    style={{ flex: 1, padding: "10px 6px", borderRadius: 11, border: `1.5px solid ${modal.data.status === s ? statusColor(s, T) : T.border}`, background: modal.data.status === s ? `${statusColor(s, T)}14` : T.surface, color: modal.data.status === s ? statusColor(s, T) : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {s}
                  </button>
                ))}
              </div>
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
  const ta = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" };
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
                  <input value={v} onChange={e => setReadings(r => ({ ...r, [k]: e.target.value }))} style={{ width: "100%", padding: "9px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
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
            <label style={{ width: 60, height: 60, borderRadius: 10, border: `2px dashed ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: T.textMuted, cursor: "pointer" }}>
              {busy ? "…" : "+"}
              <input type="file" accept="image/*" multiple onChange={addPhotos} style={{ display: "none" }} />
            </label>
          </div>
        </div>

        <div style={{ background: T.surfaceAlt, borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, marginBottom: 12 }}>Financials</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Revenue</span>
            <div style={{ position: "relative", width: 110 }}>
              <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: T.textMuted }}>$</span>
              <input value={revenue} onChange={e => setRevenue(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "8px 8px 8px 22px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
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
                <div style={{ fontSize: 12, color: T.warning, marginBottom: 12, background: `${T.warning}10`, borderRadius: 8, padding: "8px 10px" }}>
                  <strong>Office note:</strong> {h.officeNotes}
                </div>
              )}

              {readingPairs.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                  {readingPairs.map(([k, v]) => (
                    <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</div>
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

        {/* Preview button */}
        <Btn variant="ghost" onClick={() => setPreview(true)} block style={{ gap: 8 }}>
          <Icon name="eye" size={15} /> Preview as {firstName}
        </Btn>

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
          T={T}
          fontStack={fontStack}
          onSignOut={onClose}
          onServiceRequest={() => {}}
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
            style={{ width: size, height: size, borderRadius: 8, objectFit: "cover", cursor: "pointer" }} />
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
  const [photos, setPhotos] = useState([]);
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

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    const compressed = [];
    for (const f of files) compressed.push(await compressImage(f));
    setPhotos(p => [...p, ...compressed]);
    setBusy(false);
  };
  const removePhoto = (i) => setPhotos(p => p.filter((_, idx) => idx !== i));

  const treatmentsUsed = treatments
    .filter(t => num(tx[t.id]) > 0)
    .map(t => ({ id: t.id, name: t.name, oz: num(tx[t.id]), costPerOz: num(t.costPerOz), cost: num(tx[t.id]) * num(t.costPerOz) }));
  const productsUsed = products.filter(p => prods[p.id]).map(p => p.name);

  const ctx = {
    firstName, company: branding.companyName, serviceType: stop.type,
    date: todayStr, tech: "B. Stone", notes: notesClient,
    ph: readings["pH"] || "", ammonia: readings["Ammonia"] || "", nitrite: readings["Nitrite"] || "", temp: readings["Temperature"] || "",
    photoCount: photos.length,
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
    photos,
    treatmentsUsed, productsUsed,
    breakdown: {
      revenue: num(revenue), minutes: num(minutes), hourlyRate: num(hourlyRate),
      labor: laborCost, treatment: treatmentCost, product: productCost,
      gas: num(gas), insurance: num(insurance), equipment: num(equipment), overhead: num(overhead),
      total: totalCost, profit, margin,
    },
  });

  const finish = () => {
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
  const smallInput = { width: "100%", padding: "9px 10px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" };
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
                  <input value={s.price} onChange={e => setSvcPrice(i, e.target.value)} placeholder="0"
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
            <input value={minutes} onChange={e => setMinutes(e.target.value.replace(/\D/g, ""))} style={{ ...smallInput, textAlign: "left", paddingRight: 40 }} />
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>min</span>
          </div>
          {!timerOn ? (
            <button onClick={() => { setElapsed(0); setTimerOn(true); }} style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, color: T.text, cursor: "pointer", fontFamily: "inherit" }}>▶ Start timer</button>
          ) : (
            <button onClick={stopTimer} style={{ background: T.primary, border: "none", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 700, color: "#fff", cursor: "pointer", fontFamily: "inherit" }}>
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
                <input value={readings[t] || ""} onChange={e => setReadings(r => ({ ...r, [t]: e.target.value }))} style={smallInput} placeholder="—" />
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
                <input value={tx[t.id] || ""} onChange={e => setTx(x => ({ ...x, [t.id]: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="0" style={{ width: 60, padding: "8px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", textAlign: "center", boxSizing: "border-box" }} />
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

      {/* Photos */}
      <div style={sectionGap}>
        <label style={labelStyle}>Photos</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative" }}>
              <img src={p} alt="" style={{ width: 64, height: 64, borderRadius: 10, objectFit: "cover" }} />
              <button onClick={() => removePhoto(i)} style={{ position: "absolute", top: -6, right: -6, background: "#C0392B", color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, fontSize: 12, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>
          ))}
          <label style={{ width: 64, height: 64, borderRadius: 10, border: `2px dashed ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, color: T.textMuted, cursor: "pointer" }}>
            {busy ? "…" : "+"}
            <input type="file" accept="image/*" multiple capture="environment" onChange={addPhotos} style={{ display: "none" }} />
          </label>
        </div>
      </div>

      {/* Notes to client */}
      <div style={sectionGap}>
        <label style={labelStyle}>Notes to Client <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(in their report & portal)</span></label>
        <textarea value={notesClient} onChange={e => setNotesClient(e.target.value)} placeholder="What you'd like the client to know..." rows={2}
          style={{ width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
      </div>

      {/* Notes to office */}
      <div style={sectionGap}>
        <label style={labelStyle}>Notes to Office <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(internal — all staff see this)</span></label>
        <textarea value={notesOffice} onChange={e => setNotesOffice(e.target.value)} placeholder="Internal notes — never shown to the client..." rows={2}
          style={{ width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
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
              style={{ width: "100%", padding: "10px 13px", border: `1.5px solid ${T.warning}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: `${T.warning}08`, outline: "none", boxSizing: "border-box", resize: "vertical" }} />
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
            <input value={revenue} onChange={e => setRevenue(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" style={{ width: "100%", padding: "8px 8px 8px 22px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
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
  const nativeInput = { width: "100%", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };

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
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: selClients[c.id] ? T.navActiveBg : "transparent" }}>
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
            <input value={duration} onChange={e => setDuration(e.target.value.replace(/\D/g, ""))} placeholder="60"
              style={{ width: "100%", padding: "10px 38px 10px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
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
                  <input value={svcPrices[s.id] ?? s.price ?? ""} onChange={e => setSvcPrices(p => ({ ...p, [s.id]: e.target.value.replace(/[^\d.]/g, "") }))}
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

function Schedule({ clients, catalog, costs, schedule, setSchedule, scheduleCfg, team, onClientSelect, seedClientIds, clearSeed, email, onComplete, completedSids, onOfficeAlert }) {
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
      <div key={s.sid} style={{ background: T.surface, border: `1px solid ${isSel ? T.primary : T.border}`, borderRadius: 16, overflow: "hidden", opacity: isComplete ? 0.92 : 1, boxShadow: T.shadow, display: "flex" }}>
        {!selectMode && displayNum != null && (
          <div style={{ width: 42, flexShrink: 0, background: isComplete ? T.accent : hexA(accentLeft, 0.12), color: isComplete ? "#fff" : accentLeft, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800 }}>{displayNum}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            onClick={() => selectMode ? toggle(s.sid) : (perms.completeStops ? setCompleteModal({ stop: s, client: c }) : null)}
            style={{ padding: compact ? "10px 13px" : "13px 16px", cursor: (selectMode || perms.completeStops) ? "pointer" : "default", display: "flex", gap: compact ? 10 : 12, alignItems: "center" }}
          >
            {selectMode && <Checkbox checked={isSel} onChange={() => toggle(s.sid)} />}
            <div style={{ textAlign: "center", minWidth: 50, flexShrink: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{s.time.split(" ")[0]}</div>
              <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700 }}>{s.time.split(" ")[1]}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: T.text, display: "flex", alignItems: "center", gap: 6 }}>
                {isComplete && <span style={{ color: T.accent, marginRight: 4, display:"inline-flex", verticalAlign:"middle" }}><Icon name="check" size={13} /></span>}{s.client}
              </div>
              {cfg.showAddress && <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.address}</div>}
              {cfg.showServices && s.services && s.services.length > 0 ? (
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.services.map(sv => typeof sv === "string" ? sv : `${sv.name}${sv.price ? ` $${sv.price}` : ""}`).join(" · ")}
                </div>
              ) : null}
            </div>
            <div style={{ textAlign: "right", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
              <div>
                {s._arr != null && <div style={{ fontSize: 12.5, fontWeight: 800, color: isComplete ? T.accent : T.text, display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}><span style={{ fontSize: 11, opacity: 0.7 }}>🚚</span>{isComplete ? fmtMin(s._arr) : `est ${fmtMin(s._arr)}`}</div>}
                <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: s._arr != null ? 3 : 0 }}>{s.type}</div>
                {cfg.showDuration && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{s.duration}</div>}
              </div>
              {emp && <span title={emp.name} style={{ width: 30, height: 30, borderRadius: "50%", background: hexA(T.primary, 0.14), color: T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, flexShrink: 0 }}>{initials(emp.name)}</span>}
            </div>
          </div>
          {!selectMode && (
            <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: isComplete ? `${T.accent}12` : T.surfaceAlt }}>
              {isComplete ? (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.accent, fontWeight: 700 }}><Icon name="check" size={13} /> Completed · Report saved</div>
              ) : sent ? (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.accent, fontWeight: 700 }}><Icon name="check" size={13} /> Client notified</div>
              ) : (
                <div style={{ fontSize: 12, color: T.textMuted }}>Not yet started</div>
              )}
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button onClick={e => { e.stopPropagation(); setHeadHereModal({ stop: s, client: c }); }}
                  style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  <span style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="map" size={13} /> Head Here</span>
                </button>
                {!isComplete && perms.sendTexts && (
                  <button onClick={e => { e.stopPropagation(); setOmwModal({ stop: s, client: c, key: s.sid }); }}
                    style={{ background: "transparent", color: T.primary, border: `1.5px solid ${T.primary}`, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    <span style={{ display:"flex", alignItems:"center", gap:5 }}><Icon name="message" size={13} /> {sent ? "Resend" : "On My Way"}</span>
                  </button>
                )}
                {perms.completeStops && (
                  <button onClick={e => { e.stopPropagation(); setCompleteModal({ stop: s, client: c }); }}
                    style={{ background: isComplete ? "transparent" : T.accent, color: isComplete ? T.accent : "#fff", border: isComplete ? `1.5px solid ${T.accent}` : "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    <span style={{ display:"flex", alignItems:"center", gap:4 }}><Icon name="check" size={13} /> {isComplete ? "Re-send" : "Complete"}</span>
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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>Schedule</h2>
        {selectMode ? (
          <button onClick={exitSelect} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Done</button>
        ) : perms.editSchedule ? (
          <div style={{ display: "flex", gap: 8 }}>
            {allStops.length > 0 && <Btn variant="ghost" sm onClick={() => setSelectMode(true)}>Select</Btn>}
            <Btn sm onClick={() => setShowAdd(true)}>+ Add Stop</Btn>
          </div>
        ) : null}
      </div>

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

      {/* Day strip — toggle through days */}
      {!selectMode && schedule.length > 0 && (
        <div style={{ display: "flex", gap: 7, marginBottom: 16, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
          {dayCells.map(cell => {
            const on = cell.ds === selectedDate;
            const isToday = cell.ds === todayMDY();
            return (
              <button key={cell.ds} onClick={() => { setSelectedDate(cell.ds); setViewTech(null); }}
                style={{ flexShrink: 0, width: 52, padding: "8px 0", borderRadius: 14, border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "center", background: on ? T.primary : T.surfaceAlt, color: on ? "#fff" : T.text }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, opacity: on ? 0.9 : 0.6, textTransform: "uppercase", letterSpacing: "0.03em" }}>{cell.weekday}</div>
                <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2 }}>{cell.num}</div>
                <div style={{ height: 6, marginTop: 3, display: "flex", justifyContent: "center" }}>
                  {cell.hasStops && <span style={{ width: 5, height: 5, borderRadius: "50%", background: on ? "#fff" : T.primary }} />}
                </div>
                {isToday && !on && <div style={{ fontSize: 8, fontWeight: 800, color: T.primary, marginTop: -1 }}>TODAY</div>}
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

  const selectStyle = { width: "100%", padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none" };

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
            <label style={{ background: T.primary, color: "#fff", borderRadius: 8, padding: "10px 22px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
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
          <div><label style={labelStyle}>Phone</label><input style={field} value={branding.companyPhone || ""} onChange={e => setB("companyPhone", e.target.value)} placeholder="(610) 555-1234" inputMode="tel" /></div>
          <div><label style={labelStyle}>Contact Email</label><input style={field} value={branding.companyEmail || ""} onChange={e => setB("companyEmail", e.target.value)} placeholder="hello@yourcompany.com" /></div>
          <div><label style={labelStyle}>Website</label><input style={field} value={branding.companyWebsite || ""} onChange={e => setB("companyWebsite", e.target.value)} placeholder="yourcompany.com" /></div>
          <div><label style={labelStyle}>Business Address</label><input style={field} value={branding.companyAddress || ""} onChange={e => setB("companyAddress", e.target.value)} placeholder="123 Main St, Honey Brook, PA 19344" /></div>
        </div>
      </Card>

      {/* Email sender */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Email Sender" />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div><label style={labelStyle}>From Name</label><input style={field} value={email.fromName} onChange={e => set("fromName", e.target.value)} /></div>
          <div>
            <label style={labelStyle}>From Address</label>
            <input style={field} value={email.fromAddress} onChange={e => set("fromAddress", e.target.value)} placeholder="service@yourcompany.com" />
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
            <input style={field} value={email.subject} onChange={e => set("subject", e.target.value)} />
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
            <div style={{ flex: 1 }}><label style={labelStyle}>Sender Name</label><input style={field} value={email.senderName || ""} onChange={e => set("senderName", e.target.value)} placeholder="Brandon" /></div>
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

  const chipInput = { flex: 1, padding: "9px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const field = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
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
            <div><label style={labelStyle}>Name</label><input style={field} value={prodModal.data.name} onChange={e => setProdModal(m => ({ ...m, data: { ...m.data, name: e.target.value } }))} placeholder="Product name" autoFocus /></div>
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
            <div><label style={labelStyle}>Name</label><input style={field} value={txModal.data.name} onChange={e => setTxModal(m => ({ ...m, data: { ...m.data, name: e.target.value } }))} placeholder="e.g. Algaecide" autoFocus /></div>
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
                <button onClick={() => adjustInv(-1)} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 18, cursor: "pointer", fontFamily: "inherit" }}>−</button>
                <div style={{ position: "relative", flex: 1 }}>
                  <input value={txModal.data.inventoryOz} onChange={e => setTxModal(m => ({ ...m, data: { ...m.data, inventoryOz: e.target.value.replace(/[^\d.]/g, "") } }))}
                    style={{ width: "100%", padding: "10px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 16, fontWeight: 800, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "center" }} />
                  <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>oz</span>
                </div>
                <button onClick={() => adjustInv(1)} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontSize: 18, cursor: "pointer", fontFamily: "inherit" }}>+</button>
              </div>
              {/* quick add bottle sizes */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {[16, 32, 64, 128].map(sz => (
                  <button key={sz} onClick={() => adjustInv(sz)} style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${T.border}`, background: T.surface, color: T.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>+{sz}oz</button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ position: "relative", flex: 1 }}>
                  <input value={txModal.addOz} onChange={e => setTxModal(m => ({ ...m, addOz: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="Custom amount" style={{ width: "100%", padding: "9px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" }} />
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
                <input style={chipInput} value={svcModal.data.name} onChange={e => setSvc("name", e.target.value)} placeholder="e.g. Algae Treatment" autoFocus />
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
function BudgetManager({ budget, setBudget, clients, costs }) {
  const { T } = useApp();
  const money = (n) => `$${Math.round(n).toLocaleString()}`;
  const num = (v) => parseFloat(v) || 0;

  const fixedFromCosts = costs ? monthlyFixedCosts(costs) : 0;
  const incomeTotal = (budget.income || []).reduce((s, r) => s + num(r.amount), 0);
  const expenseManual = (budget.expenses || []).reduce((s, r) => s + num(r.amount), 0);
  const expenseTotal = expenseManual + fixedFromCosts;
  const projectedNet = incomeTotal - expenseTotal;

  const actuals = monthActuals(clients);
  const actualOut = actuals.cost + fixedFromCosts;
  const actualNet = actuals.revenue - actualOut;

  const editRow = (kind, id, field, value) =>
    setBudget(b => ({ ...b, [kind]: b[kind].map(r => r.id === id ? { ...r, [field]: field === "amount" ? value.replace(/[^\d.]/g, "") : value } : r) }));
  const addRow = (kind) =>
    setBudget(b => ({ ...b, [kind]: [...(b[kind] || []), { id: `${kind[0]}${Date.now()}`, label: "", amount: "" }] }));
  const removeRow = (kind, id) =>
    setBudget(b => ({ ...b, [kind]: b[kind].filter(r => r.id !== id) }));

  const lineInput = { flex: 1, padding: "9px 11px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const amtInput = { width: 96, padding: "9px 8px 9px 20px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" };

  const section = (kind, title, accent) => (
    <Card style={{ marginBottom: 14 }}>
      <CardHeader title={title} action={<Btn sm onClick={() => addRow(kind)}>+ Add</Btn>} />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {(budget[kind] || []).map(r => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input value={r.label} onChange={e => editRow(kind, r.id, "label", e.target.value)} placeholder="Label..." style={lineInput} />
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.textMuted }}>$</span>
              <input value={r.amount} onChange={e => editRow(kind, r.id, "amount", e.target.value)} placeholder="0" style={amtInput} />
            </div>
            <button onClick={() => removeRow(kind, r.id)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
        ))}
        {kind === "expenses" && fixedFromCosts > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.surfaceAlt, borderRadius: 8, padding: "9px 11px" }}>
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
              <input value={costs.hourlyRate} onChange={e => setRate(e.target.value)} style={{ width: "100%", padding: "9px 8px 9px 22px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
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
                        <input value={l.amount} onChange={e => setLine(key, { amount: e.target.value.replace(/[^\d.]/g, "") })} style={{ width: "100%", padding: "9px 8px 9px 20px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
                      </div>
                      <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
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
              <input style={field} value={modal.data.name} onChange={e => setD({ name: e.target.value })} placeholder="e.g. David Smith" autoFocus />
            </div>

            {/* Email */}
            <div>
              <label style={labelStyle}>Login Email</label>
              <input style={field} value={modal.data.email || ""} onChange={e => setD({ email: e.target.value })} placeholder="their work email address" inputMode="email" autoCapitalize="none" />
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
  const eff = effectiveStatus(iv);
  const total = invoiceTotals(iv).total;
  return (
    <div onClick={onClick} style={{ background: T.surface, borderRadius: 14, boxShadow: T.shadow, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{iv._client?.name || iv.clientName || "Client"}</div>
        <div style={{ fontSize: 12, color: T.textMuted }}>{iv.number} · {iv.date}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{`$${total.toFixed(2)}`}</div>
        <span style={{ display: "inline-block", marginTop: 3, background: hexA(invStatusColor(eff, T), 0.14), color: invStatusColor(eff, T), padding: "2px 9px", borderRadius: 100, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{eff}</span>
      </div>
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
            <input style={field} value={inv.number} onChange={e => set("number", e.target.value)} />
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
                    <div onClick={() => setLine(l.id, "taxable", !l.taxable)} title="Taxable" style={{ width: 32, height: 32, borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", background: l.taxable ? T.primary : T.surface, border: `1.5px solid ${l.taxable ? T.primary : T.border}`, color: "#fff", fontWeight: 800, fontSize: 13 }}>{l.taxable ? "✓" : ""}</div>
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

function InvoiceSettings({ invoicing, setInvoicing, branding, setBranding }) {
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
            <div style={{ flex: 1 }}><label style={labelStyle}>Number Prefix</label><input style={field} value={cfg.numberPrefix} onChange={e => set("numberPrefix", e.target.value)} placeholder="INV-" /></div>
            <div style={{ width: 110 }}><label style={labelStyle}>Next #</label><input style={field} value={cfg.nextNumber} onChange={e => set("nextNumber", e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" /></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><label style={labelStyle}>Default Tax Rate (%)</label><input style={field} value={cfg.taxRate} onChange={e => set("taxRate", e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" /></div>
            <div style={{ flex: 1 }}><label style={labelStyle}>Due In (days)</label><input style={field} value={cfg.dueDays} onChange={e => set("dueDays", e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" /></div>
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

function EstimatesScreen({ clients, catalog, branding, email, invoicing, T }) {
  const [estimates, setEstimates] = useStoredState("sps_estimates", []);
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
          <input style={field} value={form.title} onChange={e => set("title", e.target.value)} placeholder="e.g. Spring Pond Opening, New Installation..." />
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
        {sentMsg && <div style={{ fontSize: 12, color: T.textMuted, textAlign: "center", lineHeight: 1.5 }}>{sentMsg}</div>}
      </div>

      <Btn onClick={() => onSave(form)} block>Save Estimate</Btn>
    </div>
  );
}

function InvoicesScreen({ invoices, clients, invoicing, branding, onSave, onDelete }) {
  const { T, perms } = useApp();
  const money = (n) => `$${Math.round(n).toLocaleString()}`;
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);

  const all = (invoices || []).map(iv => ({ ...iv, _client: clients.find(c => c.id === iv.clientId) }));
  const now = new Date();
  const outstanding = all.filter(iv => effectiveStatus(iv) !== "Paid" && iv.status !== "Draft").reduce((s, iv) => s + invoiceTotals(iv).total, 0);
  const paidThisMonth = all.filter(iv => iv.status === "Paid").filter(iv => { const d = parseMDY(iv.paidDate || iv.date); return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }).reduce((s, iv) => s + invoiceTotals(iv).total, 0);
  const overdueCount = all.filter(iv => effectiveStatus(iv) === "Overdue").length;

  const q = search.toLowerCase();
  const filtered = all.filter(iv => {
    if (filter !== "All" && effectiveStatus(iv) !== filter) return false;
    if (q && !`${iv.number} ${iv._client?.name || iv.clientName || ""}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(b.number).localeCompare(String(a.number)));

  const livePreview = preview ? ((invoices || []).find(x => x.id === preview.id) || preview) : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: T.text, letterSpacing: "-0.03em" }}>Invoices</h2>
        {perms.canInvoice && <Btn sm onClick={() => setCreating(true)}>+ New</Btn>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
        <StatCard label="Outstanding" value={money(outstanding)} accent={T.warning} />
        <StatCard label="Paid (mo)" value={money(paidThisMonth)} accent={T.accent} />
        <StatCard label="Overdue" value={overdueCount} accent={overdueCount ? T.warning : T.textMuted} />
      </div>

      <div style={{ position: "relative", marginBottom: 12 }}>
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.textMuted, display:"flex" }}><Icon name="clients" size={16} /></span>
        <input placeholder="Search by number or client..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: "100%", padding: "10px 14px 10px 36px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
      </div>
      <div style={{ display: "flex", gap: 7, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {["All", ...INVOICE_STATUSES].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 100, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, background: filter === s ? T.primary : T.surfaceAlt, color: filter === s ? "#fff" : T.textMuted }}>{s}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: T.textMuted }}>
          <div style={{ width: 56, height: 56, borderRadius: 18, background: hexA(T.primary, 0.08), color: T.primary, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" }}><Icon name="invoice" size={28} /></div>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.text, marginBottom: 6 }}>No invoices{filter !== "All" ? ` marked ${filter}` : ""}</div>
          {perms.canInvoice && filter === "All" && <><div style={{ fontSize: 13, marginBottom: 18 }}>Create one, or generate it from a completed visit.</div><Btn onClick={() => setCreating(true)}>+ New Invoice</Btn></>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(iv => <InvoiceRow key={iv.id} iv={iv} onClick={() => setPreview(iv)} />)}
        </div>
      )}

      {creating && <InvoiceEditor clients={clients} invoices={invoices} invoicing={invoicing} onSave={onSave} onClose={() => setCreating(false)} />}
      {editing && <InvoiceEditor invoice={editing} clients={clients} invoices={invoices} invoicing={invoicing} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {livePreview && <InvoicePreview invoice={livePreview} client={clients.find(c => c.id === livePreview.clientId)} branding={branding} invoicing={invoicing} canManage={perms.canInvoice} onSave={onSave} onEdit={(iv) => { setPreview(null); setEditing(iv); }} onDelete={onDelete} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ClientInvoices({ client, invoices, invoicing, branding, onSave, onDelete }) {
  const { T, perms } = useApp();
  const list = clientInvoicesOf(invoices, client.id).map(iv => ({ ...iv, _client: client })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const owed = clientOutstanding(client, invoices);
  const livePreview = preview ? ((invoices || []).find(x => x.id === preview.id) || preview) : null;

  return (
    <Card>
      <CardHeader title={`Invoices (${list.length})`} action={perms.canInvoice ? <Btn sm onClick={() => setCreating(true)}>+ New</Btn> : null} />
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {owed > 0 && <div style={{ background: hexA(T.warning, 0.12), borderRadius: 10, padding: "10px 13px", fontSize: 13, color: T.text, fontWeight: 600 }}>Outstanding: ${owed.toFixed(2)}</div>}
        {list.length === 0 && <div style={{ fontSize: 13, color: T.textMuted, padding: "6px 0" }}>No invoices yet for this client.</div>}
        {list.map(iv => <InvoiceRow key={iv.id} iv={iv} onClick={() => setPreview(iv)} />)}
      </div>
      {creating && <InvoiceEditor clients={[client]} presetClientId={client.id} invoices={invoices} invoicing={invoicing} onSave={onSave} onClose={() => setCreating(false)} />}
      {editing && <InvoiceEditor invoice={editing} clients={[client]} invoices={invoices} invoicing={invoicing} onSave={onSave} onDelete={onDelete} onClose={() => setEditing(null)} />}
      {livePreview && <InvoicePreview invoice={livePreview} client={client} branding={branding} invoicing={invoicing} canManage={perms.canInvoice} onSave={onSave} onEdit={(iv) => { setPreview(null); setEditing(iv); }} onDelete={onDelete} onClose={() => setPreview(null)} />}
    </Card>
  );
}

function AppSettings({ branding, setBranding, catalog, setCatalog, email, setEmail, costs, setCosts, budget, setBudget, clients, scheduleCfg, setScheduleCfg, team, setTeam, invoicing, setInvoicing, currentUserId, onResetData }) {
  const { T, perms } = useApp();
  const fileRef = useRef();
  const [tab, setTab] = useState("branding");
  const [localBranding, setLocalBranding] = useState({ ...branding });
  const [confirmReset, setConfirmReset] = useState(false);
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
  if (perms.editCatalog) tabs.push(["catalog", "Catalog"]);
  if (perms.seeCostsBudget) { tabs.push(["costs", "Costs"], ["budget", "Budget"]); }
  if (perms.editSettings) tabs.push(["email", "Messaging"], ["schedule", "Schedule"]);
  if (perms.editSettings || perms.canInvoice) tabs.push(["invoicing", "Invoices"]);
  if (perms.isAdmin) tabs.push(["team", "Team & Logins"]);
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

      {activeTab === "catalog" && <CatalogManager catalog={catalog} setCatalog={setCatalog} />}
      {activeTab === "email" && <EmailSettings email={email} setEmail={setEmail} branding={branding} setBranding={setBranding} />}
      {activeTab === "invoicing" && <InvoiceSettings invoicing={invoicing} setInvoicing={setInvoicing} branding={branding} setBranding={setBranding} />}
      {activeTab === "costs" && perms.seeCostsBudget && <CostSettings costs={costs} setCosts={setCosts} />}
      {activeTab === "budget" && perms.seeCostsBudget && <BudgetManager budget={budget} setBudget={setBudget} clients={clients} costs={costs} />}
      {activeTab === "schedule" && <ScheduleSettings cfg={scheduleCfg} setCfg={setScheduleCfg} />}
      {activeTab === "team" && perms.isAdmin && <TeamManager team={team} setTeam={setTeam} currentUserId={currentUserId} />}
      </>)}

      {activeTab === "branding" && <>
      {/* Logo */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Logo & Identity" />
        <div style={{ padding: 18 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16 }}>
            <div style={{ width: 56, height: 56, borderRadius: 14, background: T.headerBg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {localBranding.logoType === "image" && localBranding.logoImage
                ? <img src={localBranding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 26 }}>{localBranding.logoEmoji}</span>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{localBranding.companyName}</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>{localBranding.division}</div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FieldRow label="Company Name"><Input value={localBranding.companyName} onChange={e => set("companyName", e.target.value)} /></FieldRow>
            <FieldRow label="Division Label"><Input value={localBranding.division} onChange={e => set("division", e.target.value)} /></FieldRow>

            <FieldRow label="Logo Type">
              <div style={{ display: "flex", gap: 8 }}>
                {["emoji","image"].map(opt => (
                  <button key={opt} onClick={() => set("logoType", opt)}
                    style={{ flex: 1, padding: "9px 12px", border: `1px solid ${localBranding.logoType === opt ? T.primary : T.border}`, borderRadius: 8, background: localBranding.logoType === opt ? T.navActiveBg : T.surface, color: localBranding.logoType === opt ? T.primary : T.text, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize" }}>
                    {opt === "emoji" ? "🎯 Emoji" : "🖼️ Image"}
                  </button>
                ))}
              </div>
            </FieldRow>

            {localBranding.logoType === "emoji" && (
              <FieldRow label="Logo Emoji">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {["💧","🌿","🏡","🐟","🌊","⚙️","🔧","🍃"].map(e => (
                    <button key={e} onClick={() => set("logoEmoji", e)}
                      style={{ width: 40, height: 40, borderRadius: 8, border: `2px solid ${localBranding.logoEmoji === e ? T.primary : T.border}`, background: T.surface, fontSize: 20, cursor: "pointer" }}>
                      {e}
                    </button>
                  ))}
                </div>
              </FieldRow>
            )}

            {localBranding.logoType === "image" && (
              <FieldRow label="Upload Logo">
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <label style={{ background: T.primary, color: "#fff", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    Upload Image
                    <input type="file" accept="image/*" ref={fileRef} onChange={handleLogoUpload} style={{ display: "none" }} />
                  </label>
                  {localBranding.logoImage && <button onClick={() => { set("logoImage", null); set("logoType", "emoji"); }} style={{ background: "none", border: "none", color: T.textMuted, fontSize: 12, cursor: "pointer" }}>Remove</button>}
                </div>
              </FieldRow>
            )}
          </div>
        </div>
      </Card>

      {/* Appearance */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Appearance" />
        <div style={{ padding: 18 }}>
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
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 10 }}>
            {(localBranding.appearance || "system") === "system"
              ? "Follows your device's light or dark setting automatically."
              : `Always ${localBranding.appearance} for whoever uses this device.`} Each person can set their own on their own device.
          </div>
        </div>
      </Card>

      {/* Themes */}
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Theme" />
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {Object.entries(THEMES).map(([key, theme]) => {
            const pal = palOf(theme);
            return (
            <button key={key} onClick={() => set("themeKey", key)}
              style={{ padding: "14px 14px", border: `2px solid ${localBranding.themeKey === key ? pal.primary : T.border}`, borderRadius: 14, background: pal.surface, cursor: "pointer", textAlign: "left", fontFamily: "inherit", position: "relative", overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: pal.primary }} />
                <div style={{ width: 18, height: 18, borderRadius: 5, background: pal.bg, border: `1px solid ${pal.border}` }} />
                <div style={{ width: 18, height: 18, borderRadius: 5, background: pal.accent }} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 13, color: pal.text }}>{theme.name}</div>
              {localBranding.themeKey === key && (
                <div style={{ position: "absolute", top: 8, right: 8, width: 18, height: 18, borderRadius: "50%", background: pal.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 700 }}>✓</div>
              )}
            </button>
          ); })}
          {/* Custom */}
          {(() => { const cu = buildCustomTheme(localBranding.custom, localMode); const key = "custom"; return (
            <button onClick={() => set("themeKey", key)}
              style={{ padding: "14px 14px", border: `2px solid ${localBranding.themeKey === key ? cu.primary : T.border}`, borderRadius: 14, background: cu.surface, cursor: "pointer", textAlign: "left", fontFamily: "inherit", position: "relative", overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, background: cu.primary }} />
                <div style={{ width: 18, height: 18, borderRadius: 5, background: cu.bg, border: `1px solid ${cu.border}` }} />
                <div style={{ width: 18, height: 18, borderRadius: 5, background: cu.accent }} />
              </div>
              <div style={{ fontWeight: 700, fontSize: 13, color: cu.text }}>Custom</div>
              {localBranding.themeKey === key && (
                <div style={{ position: "absolute", top: 8, right: 8, width: 18, height: 18, borderRadius: "50%", background: cu.primary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 700 }}>✓</div>
              )}
            </button>
          ); })()}
        </div>
      </Card>

      {/* Custom theme editor */}
      {localBranding.themeKey === "custom" && (() => {
        const cust = { ...DEFAULT_CUSTOM, ...(localBranding.custom || {}) };
        const setCustom = (k, v) => setLocalBranding(b => ({ ...b, custom: { ...DEFAULT_CUSTOM, ...(b.custom || {}), [k]: v } }));
        const preview = buildCustomTheme(cust, localMode);
        const swatch = (key, label) => (
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, color: T.textMuted, fontFamily: "monospace" }}>{cust[key].toUpperCase()}</span>
              <span style={{ position: "relative", width: 30, height: 30, borderRadius: 8, overflow: "hidden", border: `1px solid ${T.border}`, background: cust[key] }}>
                <input type="color" value={cust[key]} onChange={e => setCustom(key, e.target.value)} style={{ position: "absolute", inset: -4, width: 40, height: 40, border: "none", padding: 0, cursor: "pointer", background: "none" }} />
              </span>
            </span>
          </label>
        );
        return (
          <Card style={{ marginBottom: 14 }}>
            <CardHeader title="Customize Theme" />
            <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
              {/* font */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 }}>Font</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {Object.entries(FONTS).map(([key, f]) => (
                    <button key={key} onClick={() => setCustom("fontFamily", key)}
                      style={{ padding: "8px 14px", borderRadius: 100, border: `1.5px solid ${cust.fontFamily === key ? T.primary : T.border}`, background: cust.fontFamily === key ? T.navActiveBg : T.surface, color: cust.fontFamily === key ? T.primary : T.text, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: f.stack }}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* colors */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 }}>Colors</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {swatch("primary", "Primary / Accent Brand")}
                  {swatch("accent", "Success / Money")}
                  {swatch("bg", "Background")}
                  {swatch("surface", "Cards & Surfaces")}
                  {swatch("text", "Text")}
                </div>
              </div>
              {/* live preview */}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 }}>Preview</label>
                <div style={{ background: preview.bg, borderRadius: 16, padding: 16, fontFamily: FONTS[cust.fontFamily]?.stack }}>
                  <div style={{ background: preview.surface, borderRadius: 14, padding: 16, boxShadow: preview.shadow, marginBottom: 10 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: preview.text, letterSpacing: "-0.02em", marginBottom: 3 }}>Sample Card</div>
                    <div style={{ fontSize: 13, color: preview.textMuted, marginBottom: 12 }}>This is how your app will look.</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ background: preview.primary, color: "#fff", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600 }}>Primary</span>
                      <span style={{ background: preview.surfaceAlt, color: preview.text, borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 600 }}>Secondary</span>
                      <span style={{ color: preview.accent, fontWeight: 700, fontSize: 14, alignSelf: "center" }}>+$420</span>
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Tap "Apply" at the top to use your custom look across the whole app.</div>
            </div>
          </Card>
        );
      })()}

      <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 16px", fontSize: 12, color: T.textMuted, display: "flex", gap: 8 }}>
        <Icon name="check" size={14} />
        <span>Your clients, schedule, catalog, and settings are saved automatically and stay put across updates.</span>
      </div>

      <Card style={{ marginTop: 14 }}>
        <CardHeader title="Reset" />
        <div style={{ padding: 18 }}>
          {!confirmReset ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 13, color: T.textMuted }}>Clear all saved data and restore the demo defaults.</div>
              <button onClick={() => setConfirmReset(true)} style={{ flexShrink: 0, background: "transparent", color: "#C0392B", border: `1.5px solid #C0392B`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Reset All Data</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, color: T.text, marginBottom: 12 }}>This erases all saved clients, stops, and settings. Are you sure?</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => { onResetData(); setConfirmReset(false); }} style={{ background: "#C0392B", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Yes, Reset Everything</button>
                <button onClick={() => setConfirmReset(false)} style={{ background: T.surfaceAlt, color: T.text, border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </Card>
      </>}
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
function CPMessages({ client, T, currentUser }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "calc(100vh - 200px)" }}>
      <div style={{ paddingTop: 4 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Messages</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 3 }}>Chat with Stone Property Solutions</div>
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
  const allInvoices = invoices || [];
  const periodInvoices = allInvoices.filter(iv => inPeriod(iv.createdAt || iv.date));
  const paidInvoices  = periodInvoices.filter(iv => iv.status === "paid");
  const openInvoices  = allInvoices.filter(iv => iv.status !== "paid");

  const sumTotal = (arr) => arr.reduce((s, iv) => s + (parseFloat((iv.total||"0").replace(/[^0-9.-]/g,""))||0), 0);
  const revenue   = sumTotal(paidInvoices);
  const pipeline  = sumTotal(openInvoices);
  const allRevenue = sumTotal(allInvoices.filter(iv => iv.status === "paid"));

  // ── Jobs ──
  const allHistory = (clients||[]).flatMap(c => (c.history||[]).map(h => ({ ...h, clientId: c.id, division: c.division })));
  const periodJobs = allHistory.filter(h => inPeriod(h.date));
  const jobsByDivision = { Pond: 0, Pool: 0, Seasonal: 0 };
  periodJobs.forEach(h => { jobsByDivision[h.division] = (jobsByDivision[h.division]||0) + 1; });

  // ── Clients ──
  const activeClients = (clients||[]).filter(c => c.status === "Active");
  const byDivision = { Pond: 0, Pool: 0, Seasonal: 0 };
  activeClients.forEach(c => { byDivision[c.division] = (byDivision[c.division]||0) + 1; });

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
      const dt = new Date(iv.createdAt || iv.date || 0);
      return iv.status === "paid" && dt >= start && dt <= end;
    }));
    return { label, total };
  });
  const maxBar = Math.max(...monthlyRevenue.map(m => m.total), 1);

  const money = (n) => n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${n.toFixed(0)}`;
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ paddingTop: 4, marginBottom: 16 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: T.text, letterSpacing: "-0.03em" }}>Reports</div>
      </div>

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
            { label: "Collected", value: money(revenue), sub: `${paidInvoices.length} invoices`, color: T.accent },
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
                <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 600 }}>{m.total > 0 ? money(m.total) : ""}</div>
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

      {/* Client base */}
      <Section title="Client Base">
        <div style={{ background: T.surface, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {[
            { label: "Total Active Clients", value: activeClients.length },
            { label: "Pond Clients", value: byDivision.Pond, sub: `${pct(byDivision.Pond, activeClients.length)}%` },
            { label: "Pool Clients", value: byDivision.Pool, sub: `${pct(byDivision.Pool, activeClients.length)}%` },
            { label: "Seasonal Clients", value: byDivision.Seasonal, sub: `${pct(byDivision.Seasonal, activeClients.length)}%` },
            { label: "All-Time Revenue / Client", value: activeClients.length ? money(allRevenue / activeClients.length) : "$0", sub: "average" },
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
                  <div style={{ fontSize: 11, color: T.textMuted }}>{c.division} · {c.plan}</div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{visits} <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 500 }}>visits</span></div>
              </div>
            ))}
          {(clients||[]).length === 0 && (
            <div style={{ padding: "24px", textAlign: "center", color: T.textMuted, fontSize: 13 }}>No client data yet.</div>
          )}
        </div>
      </Section>
    </div>
  );
}

// All available pages — the user picks up to 5 for their dock
const ALL_NAV = [
  { id: "dashboard", label: "Home",      icon: "home" },
  { id: "clients",   label: "Clients",   icon: "clients" },
  { id: "schedule",  label: "Schedule",  icon: "calendar" },
  { id: "messages",  label: "Messages",  icon: "message" },
  { id: "invoices",  label: "Invoices",  icon: "invoice",   perm: "canInvoice" },
  { id: "estimates", label: "Estimates", icon: "clipboard", perm: "canInvoice" },
  { id: "reports",   label: "Reports",   icon: "dollar",    ownerOnly: true },
  { id: "settings",  label: "Customize", icon: "sliders" },
];

const DEFAULT_DOCK = ["dashboard", "clients", "schedule", "messages", "settings"];

// ─────────────────────────────────────────────
// OVERFLOW MENU + DOCK EDITOR
// Top-right menu showing all pages not in the dock,
// plus account info and the ability to edit the dock.
// ─────────────────────────────────────────────

function OverflowMenu({ page, perms, navUnread, dockIds, setDockIds, onNav, onSignOut, currentUser, T, branding, onClose }) {
  const [editMode, setEditMode] = useState(false);

  const availableNav = ALL_NAV.filter(n => {
    if (n.ownerOnly && !perms.isAdmin) return false;
    if (n.perm && !perms[n.perm]) return false;
    return true;
  });

  const inDock    = availableNav.filter(n => dockIds.includes(n.id));
  const overflow  = availableNav.filter(n => !dockIds.includes(n.id));

  const toggleDock = (id) => {
    setDockIds(prev => {
      if (prev.includes(id)) {
        // Remove from dock (always allowed)
        return prev.filter(x => x !== id);
      } else {
        // Add to dock — max 5
        if (prev.length >= 5) return prev;
        return [...prev, id];
      }
    });
  };

  const moveDock = (id, dir) => {
    setDockIds(prev => {
      const arr = [...prev];
      const i = arr.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr;
    });
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
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 0" }}>

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

          {/* Dock editor */}
          <div style={{ padding: "12px 20px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted }}>Bottom Bar ({dockIds.length}/5)</div>
              <button onClick={() => setEditMode(e => !e)}
                style={{ background: editMode ? T.primary : T.surfaceAlt, color: editMode ? "#fff" : T.textMuted, border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                {editMode ? "Done" : "Edit"}
              </button>
            </div>

            {availableNav.map(n => {
              const inD = dockIds.includes(n.id);
              const idx = dockIds.indexOf(n.id);
              return (
                <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                  {/* Reorder arrows — only in edit mode and in dock */}
                  {editMode && inD && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
                      <button onClick={() => moveDock(n.id, -1)} disabled={idx === 0}
                        style={{ background: "none", border: "none", color: idx === 0 ? T.border : T.textMuted, cursor: idx === 0 ? "default" : "pointer", padding: 2, display: "flex" }}>
                        <Icon name="chevronD" size={12} style={{ transform: "rotate(180deg)" }} />
                      </button>
                      <button onClick={() => moveDock(n.id, 1)} disabled={idx === dockIds.length - 1}
                        style={{ background: "none", border: "none", color: idx === dockIds.length - 1 ? T.border : T.textMuted, cursor: idx === dockIds.length - 1 ? "default" : "pointer", padding: 2, display: "flex" }}>
                        <Icon name="chevronD" size={12} />
                      </button>
                    </div>
                  )}

                  <div style={{ width: 32, height: 32, borderRadius: 9, background: inD ? hexA(T.primary, 0.1) : T.surfaceAlt, color: inD ? T.primary : T.textMuted, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Icon name={n.icon} size={16} />
                  </div>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.text }}>{n.label}</div>

                  {/* Add/remove toggle */}
                  <button onClick={() => toggleDock(n.id)}
                    disabled={!inD && dockIds.length >= 5}
                    style={{ background: inD ? hexA("#E5484D", 0.1) : hexA(T.primary, 0.1), color: inD ? "#E5484D" : (dockIds.length >= 5 ? T.border : T.primary), border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: (!inD && dockIds.length >= 5) ? "default" : "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                    {inD ? "Remove" : dockIds.length >= 5 ? "Full" : "Add"}
                  </button>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 10, lineHeight: 1.5 }}>Choose up to 5 items for your bottom bar. Everything else appears here in the menu.</div>
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
  { id: "cp_home",     label: "Home",     icon: "home" },
  { id: "cp_history",  label: "History",  icon: "history" },
  { id: "cp_invoices", label: "Invoices", icon: "invoice" },
  { id: "cp_messages", label: "Messages", icon: "message" },
  { id: "cp_request",  label: "Request",  icon: "plus" },
];

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
  const paths = {
    home:    "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
    history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
    invoice: "M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z",
    plus:    "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <path d={paths[name] || paths.home} />
    </svg>
  );
}

// ── CP HOME ──
function CPHome({ client, schedule, invoices, branding, onNav, T }) {
  const next = clientNextVisit(schedule, client.id);
  const myInvoices = (invoices || []).filter(iv => iv.clientId === client.id);
  const outstanding = myInvoices.filter(iv => iv.status !== "paid");
  const totalOwed = outstanding.reduce((s, iv) => s + (parseFloat((iv.total || "0").replace(/[^0-9.-]/g,"")) || 0), 0);
  const recentHistory = (client.history || []).slice(0, 3);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (client.name || "").split(" ")[0] || "there";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Greeting */}
      <div style={{ paddingTop: 6 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: T.text, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{greeting},<br />{firstName}.</div>
        <div style={{ fontSize: 14, color: T.textMuted, marginTop: 6 }}>{branding.companyName} client portal</div>
      </div>

      {/* Next Visit — premium card */}
      <div style={{ background: `linear-gradient(135deg, ${T.primary} 0%, ${mix(T.primary, "#000", 0.25)} 100%)`, borderRadius: 22, padding: "22px 22px 20px", color: "#fff", boxShadow: `0 8px 32px ${hexA(T.primary, 0.35)}`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", right: -20, top: -20, width: 120, height: 120, borderRadius: "50%", background: "rgba(255,255,255,0.06)" }} />
        <div style={{ position: "absolute", right: 20, bottom: -30, width: 80, height: 80, borderRadius: "50%", background: "rgba(255,255,255,0.04)" }} />
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.7, marginBottom: 10 }}>Next Visit</div>
        {next ? (
          <>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{fmtDate(next.label)}</div>
            <div style={{ fontSize: 14, opacity: 0.8, marginTop: 6 }}>{next.stop.type || "Service Visit"}</div>
          </>
        ) : (
          <div style={{ fontSize: 17, fontWeight: 600, opacity: 0.8 }}>No upcoming visits yet</div>
        )}
      </div>

      {/* Balance row */}
      {totalOwed > 0 && (
        <button onClick={() => onNav("cp_invoices")} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: "inherit", width: "100%", boxSizing: "border-box", boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.textMuted, marginBottom: 4, letterSpacing: "0.02em" }}>BALANCE DUE</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: T.warning, letterSpacing: "-0.02em" }}>${totalOwed.toFixed(2)}</div>
          </div>
          <div style={{ background: T.warning, color: "#fff", borderRadius: 12, padding: "10px 18px", fontSize: 13, fontWeight: 700 }}>View →</div>
        </button>
      )}

      {/* Recent Activity */}
      {recentHistory.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 10, letterSpacing: "0.02em", textTransform: "uppercase" }}>Recent Activity</div>
          <div style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
            {recentHistory.map((h, i) => (
              <div key={i} style={{ padding: "15px 18px", borderBottom: i < recentHistory.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", gap: 14, alignItems: "center" }}>
                <div style={{ width: 36, height: 36, borderRadius: 11, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg viewBox="0 0 24 24" width={18} height={18} fill={T.primary}><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text, letterSpacing: "-0.01em" }}>{h.type || "Service Visit"}</div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{fmtDate(h.date)}</div>
                </div>
              </div>
            ))}
            {(client.history || []).length > 3 && (
              <button onClick={() => onNav("cp_history")} style={{ width: "100%", padding: "13px", background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>View all history →</button>
            )}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 10, letterSpacing: "0.02em", textTransform: "uppercase" }}>Quick Actions</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "Service History", sub: `${(client.history||[]).length} visits`, icon: "history", page: "cp_history" },
            { label: "Request Service", sub: "Schedule a visit", icon: "plus", page: "cp_request" },
          ].map(q => (
            <button key={q.page} onClick={() => onNav(q.page)} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, padding: "18px 16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12, color: T.primary }}>
                <CIcon name={q.icon} size={20} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{q.label}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{q.sub}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── CP HISTORY ──
function CPHistory({ client, T }) {
  const history = client.history || [];
  if (!history.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 12, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: hexA(T.primary, 0.08), display: "flex", alignItems: "center", justifyContent: "center", color: T.primary }}><CIcon name="history" size={30} /></div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>No history yet</div>
        <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.5, maxWidth: 240 }}>Your service records will appear here after each visit.</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em", paddingTop: 4 }}>Service History</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {history.map((h, i) => (
          <div key={i} style={{ background: T.surface, borderRadius: 18, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
            <div style={{ padding: "16px 18px", display: "flex", gap: 14, alignItems: "center" }}>
              <div style={{ width: 42, height: 42, borderRadius: 13, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: T.primary }}>
                <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>{h.type || "Service Visit"}</div>
                <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{fmtDate(h.date)}{h.tech ? ` · ${h.tech}` : ""}</div>
              </div>
              {h.invoice && h.invoice !== "$0" && <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{h.invoice}</div>}
            </div>
            {h.notes && <div style={{ padding: "0 18px 14px", fontSize: 13, color: T.textMuted, lineHeight: 1.6, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>{h.notes}</div>}
            {(h.services?.length > 0 || h.products?.length > 0) && (
              <div style={{ padding: "10px 18px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(h.services || []).map((s, j) => (
                  <span key={j} style={{ fontSize: 11, fontWeight: 600, background: hexA(T.primary, 0.1), color: T.primary, borderRadius: 100, padding: "4px 11px" }}>{s}</span>
                ))}
                {(h.products || []).map((p, j) => (
                  <span key={j} style={{ fontSize: 11, fontWeight: 600, background: T.surfaceAlt, color: T.textMuted, borderRadius: 100, padding: "4px 11px" }}>{p}</span>
                ))}
              </div>
            )}
            {h.photos?.length > 0 && (
              <div style={{ padding: "0 18px 14px" }}><PhotoStrip photos={h.photos} size={56} /></div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── CP INVOICES ──
function CPInvoices({ client, invoices, branding, T }) {
  const myInvoices = (invoices || []).filter(iv => iv.clientId === client.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const [selected, setSelected] = useState(null);

  if (selected) {
    const iv = selected;
    const isPaid = iv.status === "paid";
    const qbLink = iv.qbLink || null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 14, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          Back
        </button>
        <div style={{ background: T.surface, borderRadius: 22, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "24px 22px 20px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: "0.06em", marginBottom: 6 }}>INVOICE</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>#{iv.number || iv.id}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "6px 14px", borderRadius: 100, background: isPaid ? hexA("#16a34a", 0.1) : hexA(T.warning, 0.1), color: isPaid ? "#16a34a" : T.warning, letterSpacing: "0.04em" }}>{isPaid ? "PAID" : "DUE"}</span>
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 8 }}>{fmtDate(iv.date || iv.createdAt)}</div>
          </div>
          {(iv.items || []).length > 0 && (
            <div style={{ padding: "16px 22px", borderBottom: `1px solid ${T.border}` }}>
              {(iv.items || []).map((item, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < iv.items.length - 1 ? `1px solid ${T.border}` : "none" }}>
                  <div>
                    <div style={{ fontSize: 14, color: T.text, fontWeight: 500 }}>{item.desc || item.name || "Service"}</div>
                    {item.qty > 1 && <div style={{ fontSize: 12, color: T.textMuted }}>×{item.qty}</div>}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>${(parseFloat(item.price || item.total || 0) * (item.qty || 1)).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Total</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>{iv.total || "$0.00"}</div>
          </div>
          {!isPaid && (
            <div style={{ padding: "0 22px 22px" }}>
              {qbLink
                ? <a href={qbLink} target="_blank" rel="noreferrer" style={{ display: "block", background: T.primary, color: "#fff", borderRadius: 16, padding: "15px", fontWeight: 800, fontSize: 15, textAlign: "center", textDecoration: "none", letterSpacing: "-0.01em", boxShadow: `0 4px 16px ${hexA(T.primary, 0.3)}` }}>Pay Now</a>
                : <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "16px", fontSize: 13, color: T.textMuted, textAlign: "center", lineHeight: 1.6 }}>Contact {branding.companyName} at {branding.companyPhone || branding.companyEmail || "the number on file"} to pay.</div>
              }
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!myInvoices.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px", gap: 12, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 20, background: hexA(T.primary, 0.08), display: "flex", alignItems: "center", justifyContent: "center", color: T.primary }}><CIcon name="invoice" size={30} /></div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>No invoices yet</div>
        <div style={{ fontSize: 14, color: T.textMuted, lineHeight: 1.5 }}>Your invoices will appear here.</div>
      </div>
    );
  }

  const open = myInvoices.filter(iv => iv.status !== "paid");
  const paid = myInvoices.filter(iv => iv.status === "paid");

  const InvoiceRow = ({ iv }) => {
    const isPaid = iv.status === "paid";
    return (
      <button onClick={() => setSelected(iv)} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 18, padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: "inherit", width: "100%", boxSizing: "border-box", opacity: isPaid ? 0.65 : 1, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: isPaid ? hexA("#16a34a", 0.1) : hexA(T.warning, 0.1), display: "flex", alignItems: "center", justifyContent: "center", color: isPaid ? "#16a34a" : T.warning, flexShrink: 0 }}>
            <CIcon name="invoice" size={18} />
          </div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: "-0.01em" }}>Invoice #{iv.number || iv.id}</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{fmtDate(iv.date || iv.createdAt)}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: isPaid ? "#16a34a" : T.warning, letterSpacing: "-0.01em" }}>{iv.total || "$0.00"}</div>
          <svg viewBox="0 0 24 24" width={16} height={16} fill={T.textMuted}><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </div>
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.03em", paddingTop: 4 }}>Invoices</div>
      {open.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Outstanding</div>
          {open.map(iv => <InvoiceRow key={iv.id} iv={iv} />)}
        </div>
      )}
      {paid.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Paid</div>
          {paid.map(iv => <InvoiceRow key={iv.id} iv={iv} />)}
        </div>
      )}
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
          <input style={field} value={form.dates} onChange={e => set("dates", e.target.value)} placeholder="e.g. Anytime next week, Mon/Wed mornings" />
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
function SPSClientPortal({ client, schedule, invoices, branding, T, fontStack, onSignOut, onServiceRequest, isStaffPreview = false }) {
  const [page, setPage] = useState("cp_home");

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
        background: hexA(T.surface, 0.92),
        backdropFilter: "saturate(180%) blur(24px)",
        WebkitBackdropFilter: "saturate(180%) blur(24px)",
        borderBottom: `1px solid ${T.border}`,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        {/* Safe area spacer — auto-adjusts to any phone's status bar */}
        {!isStaffPreview && <div style={{ height: "env(safe-area-inset-top)" }} />}
        <div style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", paddingLeft: 20, paddingRight: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: hexA(T.primary, 0.1), display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
              {branding.logoType === "image" && branding.logoImage
                ? <img src={branding.logoImage} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 16 }}>{branding.logoEmoji}</span>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text, letterSpacing: "-0.02em" }}>{branding.companyName}</div>
          </div>
          {!isStaffPreview && (
            <button onClick={onSignOut} style={{ background: "none", border: "none", color: T.textMuted, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button>
          )}
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, padding: "24px 18px", maxWidth: 600, margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: "calc(100px + env(safe-area-inset-bottom))" }}>
        {page === "cp_home"     && <CPHome client={client} schedule={schedule} invoices={invoices} branding={branding} onNav={setPage} T={T} />}
        {page === "cp_history"  && <CPHistory client={client} T={T} />}
        {page === "cp_invoices" && <CPInvoices client={client} invoices={invoices} branding={branding} T={T} />}
        {page === "cp_messages" && <CPMessages client={client} T={T} />}
        {page === "cp_request"  && <CPRequest client={client} branding={branding} onSubmit={onServiceRequest} T={T} />}
      </main>

      {/* Bottom nav — matches staff app style exactly */}
      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: hexA(T.surface, 0.88), backdropFilter: "saturate(180%) blur(24px)", WebkitBackdropFilter: "saturate(180%) blur(24px)", borderTop: `1px solid ${T.border}`, display: "flex", zIndex: 90, paddingTop: 6, paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}>
        {CLIENT_NAV.map(n => {
          const active = page === n.id;
          return (
            <button key={n.id} onClick={() => setPage(n.id)} style={{ flex: 1, border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: active ? T.primary : T.textMuted, fontFamily: "inherit", padding: "4px 0" }}>
              <span style={{ width: 46, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 100, background: active ? hexA(T.primary, 0.12) : "transparent", transition: "background 0.15s" }}>
                <CIcon name={n.icon} size={22} />
              </span>
              <span style={{ fontSize: 10.5, fontWeight: active ? 700 : 500, letterSpacing: "-0.01em" }}>{n.label}</span>
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
  const [page, setPage] = useState("dashboard");
  const [selectedClient, setSelectedClient] = useState(null);
  const [adding, setAdding] = useState(false);
  const [scheduleSeed, setScheduleSeed] = useState(null);

  // Persistent data — survives reloads and app updates
  const [clients, setClients, lc] = useStoredState("sps_clients", DEMO_CLIENTS);
  const [branding, setBranding, lb] = useStoredState("sps_branding", DEFAULT_BRANDING);
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
  const [menuOpen, setMenuOpen] = useState(false);

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

  const handleClientSelect = (c) => { setSelectedClient(c); setAdding(false); setPage("clients"); };
  const handleNav = (id) => { setPage(id); setSelectedClient(null); setAdding(false); };

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

  const handleSaveInvoice = (inv) => setInvoices(list => {
    const exists = (list || []).some(iv => iv.id === inv.id);
    return exists ? list.map(iv => iv.id === inv.id ? inv : iv) : [inv, ...(list || [])];
  });
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

  // Loading gate so the saved theme/data are ready before first paint
  if (!hydrated) {
    return (
      <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif', background: T.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted, WebkitFontSmoothing: "antialiased" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 28, height: 28, border: `3px solid ${T.border}`, borderTopColor: T.primary, borderRadius: "50%", margin: "0 auto 12px", animation: "spin 0.7s linear infinite" }} />
          <div style={{ fontSize: 13 }}>Loading your data...</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // Client portal — email matched a client record, not a staff member
  if (!currentUser && clientUser) {
    return (
      <SPSClientPortal
        client={clientUser}
        schedule={schedule}
        invoices={invoices}
        branding={branding}
        T={T}
        fontStack={fontStack}
        onSignOut={handleSignOut}
        onServiceRequest={handleServiceRequest}
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
    <AppCtx.Provider value={{ T, branding, perms }}>
      <div style={{
        fontFamily: fontStack,
        background: T.bg, minHeight: "100vh", display: "flex", flexDirection: "column", color: T.text,
        WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale", letterSpacing: "-0.01em",
        // CSS vars used by the global polish layer below
        ["--ring"]: hexA(T.primary, 0.22), ["--ringBorder"]: T.primary,
      }}>
        <style>{`
          * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
          input, select, textarea {
            transition: box-shadow .15s ease, border-color .15s ease;
            -webkit-appearance: none;
            appearance: none;
            border-radius: 12px;
            font-size: 16px !important;
          }
          input:focus, select:focus, textarea:focus {
            border-color: var(--ringBorder) !important;
            box-shadow: 0 0 0 3px var(--ring);
            outline: none;
          }
          button, a { transition: transform .08s ease, opacity .15s ease, background .15s ease, box-shadow .15s ease; }
          button:active, a:active { transform: scale(0.97); }
          @media (hover: hover) { button:hover:not(:disabled) { filter: brightness(1.04); } }
          ::selection { background: var(--ring); }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-thumb { background: ${hexA(T.textMuted, 0.25)}; border-radius: 100px; }
          ::-webkit-scrollbar-track { background: transparent; }
          select { background-image: none; }
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
          <button onClick={() => setMenuOpen(true)}
            style={{ background: menuOpen ? hexA(T.primary, 0.12) : T.surfaceAlt, border: "none", color: menuOpen ? T.primary : T.textMuted, cursor: "pointer", width: 36, height: 36, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
            <Icon name="sliders" size={18} />
            {navUnread > 0 && !dockIds.includes("messages") && (
              <span style={{ position: "absolute", top: 6, right: 6, width: 7, height: 7, borderRadius: "50%", background: T.primary, border: `1.5px solid ${T.surface}` }} />
            )}
          </button>
          </div>
        </header>



        {dbError && (
          <div style={{ background: "#FEF3C7", borderBottom: "1px solid #F59E0B", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, color: "#92400E" }}>
            <span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="warning" size={15} />{dbError}</span>
            <button onClick={() => window.location.reload()} style={{ background: "#F59E0B", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, display:"flex", alignItems:"center", gap:5 }}>Retry</button>
          </div>
        )}
        <main style={{ flex: 1, padding: "22px 16px", maxWidth: 740, margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: "calc(96px + env(safe-area-inset-bottom))" }}>
          {page === "dashboard" && <Dashboard clients={clients} invoices={invoices} schedule={schedule} home={home} setHome={setHome} officeAlerts={officeAlerts} onResolveAlert={handleResolveAlert} onNav={handleNav} />}
          {page === "clients" && adding && <ClientEditForm client={BLANK_CLIENT} title="Add Client" onSave={handleSaveNewClient} onCancel={() => setAdding(false)} />}
          {page === "clients" && !adding && !selectedClient && <ClientList clients={clients} onSelect={handleClientSelect} onAdd={() => setAdding(true)} onImport={() => handleNav("import")} onBatchUpdate={handleBatchUpdate} onBatchDelete={handleBatchDelete} onBatchSchedule={handleBatchSchedule} />}
          {page === "clients" && !adding && selectedClient && <ClientDetail client={selectedClient} invoices={invoices} invoicing={invoicing} branding={branding} schedule={schedule} onBack={() => setSelectedClient(null)} onUpdate={handleUpdateClient} onSaveInvoice={handleSaveInvoice} onDeleteInvoice={handleDeleteInvoice} />}
          {page === "schedule" && <Schedule clients={clients} catalog={catalog} costs={costs} schedule={schedule} setSchedule={setSchedule} scheduleCfg={scheduleCfg} team={team} onClientSelect={handleClientSelect} seedClientIds={scheduleSeed} clearSeed={() => setScheduleSeed(null)} email={email} onComplete={handleCompleteStop} completedSids={completedSids} onOfficeAlert={handleOfficeAlert} />}
          {page === "messages"  && <MessagesScreen clients={clients} currentUser={currentUser} T={T} />}
          {page === "reports"   && perms.isAdmin && <ReportsScreen clients={clients} invoices={invoices} schedule={schedule} costs={costs} T={T} />}
          {page === "estimates" && perms.canInvoice && <EstimatesScreen clients={clients} catalog={catalog} branding={branding} email={email} invoicing={invoicing} T={T} />}
          {page === "invoices"  && perms.canInvoice && <InvoicesScreen invoices={invoices} clients={clients} invoicing={invoicing} branding={branding} onSave={handleSaveInvoice} onDelete={handleDeleteInvoice} />}
          {page === "import"   && perms.canImport && <SkimmerImport onImport={handleImportClients} onGoToClients={() => handleNav("clients")} />}
          {page === "settings" && <AppSettings branding={branding} setBranding={setBranding} catalog={catalog} setCatalog={setCatalog} email={email} setEmail={setEmail} costs={costs} setCosts={setCosts} budget={budget} setBudget={setBudget} clients={clients} scheduleCfg={scheduleCfg} setScheduleCfg={setScheduleCfg} team={team} setTeam={setTeam} invoicing={invoicing} setInvoicing={setInvoicing} currentUserId={currentUser.id} onResetData={handleResetData} />}
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
