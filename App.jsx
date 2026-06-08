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
      if (e.status && e.status !== "Good") alerts.push({ icon: "⚠️", title: `${c.name} — ${e.name}`, sub: `Marked "${e.status}"` });
    });
    const owed = clientOutstanding(c, invoices);
    if (owed > 0) alerts.push({ icon: "💰", title: `${c.name} — $${owed.toFixed(2)} outstanding`, sub: "Open balance" });
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
      border: "none",
      borderRadius: 20,
      overflow: "hidden",
      boxShadow: T.shadow,
      ...style,
    }}>{children}</div>
  );
}

function CardHeader({ title, action }) {
  const { T } = useApp();
  return (
    <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontWeight: 600, fontSize: 14, color: T.text, letterSpacing: "-0.01em" }}>{title}</span>
      {action}
    </div>
  );
}

function Btn({ children, onClick, href, variant = "primary", sm, lg, block, disabled, style }) {
  const { T } = useApp();
  const grad = (c) => `linear-gradient(180deg, ${mix(c, "#ffffff", 0.12)} 0%, ${c} 52%, ${mix(c, "#000000", 0.07)} 100%)`;
  const styles = {
    primary: { background: grad(T.primary), color: "#fff", border: "none", boxShadow: `0 1px 1.5px ${hexA(T.primary, 0.4)}, 0 3px 10px ${hexA(T.primary, 0.22)}` },
    accent:  { background: grad(T.accent), color: "#fff", border: "none", boxShadow: `0 1px 1.5px ${hexA(T.accent, 0.4)}, 0 3px 10px ${hexA(T.accent, 0.22)}` },
    ghost:   { background: T.surfaceAlt, color: T.text, border: "none" },
    outline: { background: "transparent", color: T.primary, border: `1.5px solid ${hexA(T.primary, 0.45)}` },
    danger:  { background: grad("#E5484D"), color: "#fff", border: "none", boxShadow: `0 1px 1.5px ${hexA("#E5484D", 0.4)}, 0 3px 10px ${hexA("#E5484D", 0.2)}` },
    text:    { background: "transparent", color: T.primary, border: "none" },
  };
  const css = {
    ...(styles[variant] || styles.primary),
    borderRadius: lg ? 14 : 12,
    padding: lg ? "14px 24px" : sm ? "8px 15px" : "11px 20px",
    fontSize: lg ? 15.5 : sm ? 12.5 : 14,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontFamily: "inherit",
    letterSpacing: "-0.01em",
    width: block ? "100%" : undefined,
    display: block ? "block" : (href ? "inline-block" : undefined),
    textAlign: "center",
    textDecoration: "none",
    boxSizing: "border-box",
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
      border: "none",
      borderRadius: 20,
      padding: "20px 20px",
      boxShadow: T.shadow,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: accent || T.primary, flexShrink: 0 }} />
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "-0.01em", color: T.textMuted }}>{label}</div>
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, color: T.text, lineHeight: 1, letterSpacing: "-0.035em" }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 7 }}>{sub}</div>}
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
      style={{ width: "100%", padding: "11px 14px", border: `1px solid ${T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", boxSizing: "border-box", outline: "none", color: T.text, background: T.surface }} />
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
            <span style={{ fontSize: 18, lineHeight: 1.2 }}>🚩</span>
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
            <span style={{ fontSize: 18, lineHeight: 1.2 }}>{a.icon}</span>
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
      {checked && <span style={{ color: "#fff", fontSize: 12, fontWeight: 800, lineHeight: 1 }}>✓</span>}
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
          <button onClick={onClose} style={{ background: T.surfaceAlt, border: "none", borderRadius: "50%", width: 30, height: 30, fontSize: 14, cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
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
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>🔍</span>
        <input placeholder="Search clients or address..."
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
            <div style={{ fontSize: 32, marginBottom: 10 }}>🔍</div>
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
              { label: "📅 Schedule", fn: doSchedule },
              { label: "🏷️ Division", fn: () => setModal("division") },
              { label: "⭐ Plan", fn: () => setModal("plan") },
              { label: "🗑️ Delete", fn: () => setModal("delete"), danger: true },
            ].map(a => (
              <button key={a.label} onClick={a.fn}
                style={{ flex: "1 0 auto", background: a.danger ? "rgba(255,80,80,0.15)" : "rgba(255,255,255,0.1)", color: a.danger ? "#ff8080" : "#fff", border: "none", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                {a.label}
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
                    <input style={halfInput} value={form.city} onChange={e => setAddr("city", e.target.value)} placeholder="Elverson" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>State</label>
                    <input style={halfInput} value={form.state} onChange={e => setAddr("state", e.target.value)} placeholder="PA" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 5 }}>ZIP</label>
                    <input style={halfInput} value={form.zip} onChange={e => setAddr("zip", e.target.value)} placeholder="19520" />
                  </div>
                </div>
                {combined && <div style={{ fontSize: 12, color: T.textMuted, background: T.surfaceAlt, borderRadius: 9, padding: "9px 12px" }}>📍 {combined}</div>}

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
function ClientDetail({ client: init, invoices, invoicing, branding, onBack, onUpdate, onSaveInvoice, onDeleteInvoice }) {
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
              {perms.editClients && <Btn variant="ghost" sm onClick={() => setEditing(true)}>✏️ Edit</Btn>}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 12, color: T.textMuted }}>
            <span>📞 {client.phone}</span>
            <span>✉️ {client.email}</span>
            <span>📅 {client.nextService}</span>
            {perms.seeBalances && <span style={{ color: owed <= 0 ? T.accent : T.warning, fontWeight: 600 }}>💰 ${owed.toFixed(2)}</span>}
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

      {tab === "overview" && <ClientOverview client={client} invoices={invoices} />}
      {tab === "equipment" && <ClientEquipment client={client} onChange={eq => update({ equipment: eq })} />}
      {tab === "history" && <ClientHistory client={client} onChange={hist => update({ history: hist })} />}
      {tab === "invoices" && perms.canInvoice && <ClientInvoices client={client} invoices={invoices} invoicing={invoicing} branding={branding} onSave={onSaveInvoice} onDelete={onDeleteInvoice} />}
      {tab === "portal" && <ClientPortal client={client} />}
    </div>
  );
}

function ClientOverview({ client }) {
  const { T } = useApp();
  const h = client.history[0];
  const m = dMeta(client.division);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card>
        <CardHeader title="Service Details" />
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {[["Division", client.division || "Pond"],[m.typeLabel, client.pondType],[m.sizeLabel, client.pondSize],["Plan", `${client.plan} (${client.planFreq})`]].map(([k,v]) => (
            <div key={k}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{k}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>
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
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Photos</div>
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
  const [modal, setModal] = useState(null); // { mode:"add"|"edit", index, data }
  const equipment = client.equipment || [];
  const STATUSES = ["Good", "Monitor", "Replace Soon"];

  const openAdd = () => setModal({ mode: "add", data: { name: "", installed: "", status: "Good" } });
  const openEdit = (eq, i) => { if (perms.editClients) setModal({ mode: "edit", index: i, data: { ...eq } }); };

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
  const field = { width: "100%", padding: "10px 13px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 6 };

  return (
    <Card>
      <CardHeader title={`Equipment (${equipment.length})`} action={perms.editClients ? <Btn sm onClick={openAdd}>+ Add</Btn> : null} />
      {equipment.length === 0 && (
        <div style={{ padding: "28px 18px", textAlign: "center", color: T.textMuted }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚙️</div>
          <div style={{ fontSize: 13 }}>No equipment yet. Tap "+ Add" to log a pump, filter, or other gear.</div>
        </div>
      )}
      {equipment.map((eq, i) => (
        <div key={i} onClick={() => openEdit(eq, i)}
          style={{ padding: "14px 18px", borderBottom: i < equipment.length - 1 ? `1px solid ${T.border}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: perms.editClients ? "pointer" : "default" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: T.text }}>{eq.name}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Installed {eq.installed || "—"}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(eq.status, T) }} />
              <span style={{ fontSize: 12, color: T.text, fontWeight: 600 }}>{eq.status}</span>
            </div>
            <span style={{ color: T.textMuted, fontSize: 14 }}>✏️</span>
          </div>
        </div>
      ))}

      {modal && (
        <Modal title={modal.mode === "add" ? "Add Equipment" : "Edit Equipment"} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={labelStyle}>Name</label><input style={field} value={modal.data.name} onChange={e => setD("name", e.target.value)} placeholder="e.g. Aquascape 3000 Pump" autoFocus /></div>
            <div><label style={labelStyle}>Installed</label><input style={field} value={modal.data.installed} onChange={e => setD("installed", e.target.value)} placeholder="MM/YYYY" /></div>
            <div>
              <label style={labelStyle}>Status</label>
              <div style={{ display: "flex", gap: 8 }}>
                {STATUSES.map(s => (
                  <button key={s} onClick={() => setD("status", s)}
                    style={{ flex: 1, padding: "9px 6px", borderRadius: 8, border: `1.5px solid ${modal.data.status === s ? statusColor(s, T) : T.border}`, background: modal.data.status === s ? `${statusColor(s, T)}14` : T.surface, color: modal.data.status === s ? statusColor(s, T) : T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <Btn onClick={save} style={{ width: "100%", padding: "12px", borderRadius: 12, marginTop: 4 }}>
              {modal.mode === "add" ? "Add Equipment" : "Save Changes"}
            </Btn>
            {modal.mode === "edit" && (
              <button onClick={remove} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Delete this equipment</button>
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
        <input value={val} onChange={e => setter(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "7px 8px 7px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
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
          <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
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
                  {perms.editHistory && <button onClick={() => setEditIdx(i)} style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 14 }}>✏️</button>}
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
                <div style={{ marginTop: 12, fontSize: 12, color: T.textMuted }}>🧪 {h.treatmentsUsed.map(t => `${t.name} (${t.oz}oz)`).join(", ")}</div>
              )}

              {h.photos && h.photos.length > 0 && (
                <div style={{ marginTop: 12 }}><PhotoStrip photos={h.photos} /></div>
              )}

              {b && perms.seeProfit && (
                <details style={{ marginTop: 14, background: T.surfaceAlt, borderRadius: 10, padding: "10px 12px" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: T.text, listStyle: "none" }}>
                    💵 Profitability — {b.profit >= 0 ? "Profit" : "Loss"} {money(Math.abs(b.profit))} ({(b.margin || 0).toFixed(0)}%)
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

function ClientPortal({ client }) {
  const { T } = useApp();
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const portalUrl = `portal.stonepropertysolutions.com/${client.name.split(" ").pop().toLowerCase()}`;

  const copyLink = () => {
    try { navigator.clipboard?.writeText("https://" + portalUrl); } catch (e) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      <Card>
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: T.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>🔗</div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16, color: T.text }}>Client Portal</div>
              <div style={{ fontSize: 12, color: T.textMuted }}>What {client.name.split(" ")[0]} sees when they log in</div>
            </div>
          </div>

          <div style={{ background: T.surfaceAlt, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: T.textMuted, marginBottom: 16, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis" }}>
            {portalUrl}
          </div>

          <Btn onClick={() => setPreview(true)} style={{ width: "100%", padding: "12px", borderRadius: 10, marginBottom: 10 }}>
            👁️ Preview as Client
          </Btn>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn variant="ghost" style={{ flex: 1 }}>Send Invite</Btn>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={copyLink}>{copied ? "✓ Copied" : "Copy Link"}</Btn>
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: T.textMuted, display: "flex", gap: 6 }}>
            <span>🔒</span>
            <span>Login goes live with the backend in the next phase. This preview shows the real layout and the client's actual data.</span>
          </div>
        </div>
      </Card>

      {preview && <PortalPreview client={client} onClose={() => setPreview(false)} />}
    </>
  );
}

// ─────────────────────────────────────────────
// CLIENT-FACING PORTAL VIEW
// What the customer sees. Reused behind client login in Phase 2.
// ─────────────────────────────────────────────
function PortalPreview({ client, onClose }) {
  const { T, branding, perms } = useApp();
  const firstName = client.name.split(" ")[0];
  const balanceDue = client.balance && client.balance !== "$0.00";
  const equipNeedsAttention = (client.equipment || []).filter(e => e.status !== "Good");

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: T.bg, overflowY: "auto" }}>
      {/* Preview banner (operator only — not part of the real client view) */}
      <div style={{ background: T.headerBg, color: "#fff", padding: "8px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
        <span style={{ opacity: 0.7 }}>👁️ Client Preview</span>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 6, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Exit Preview</button>
      </div>

      {/* Branded client header */}
      <div style={{ background: T.primary, color: "#fff", padding: "24px 20px 28px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, opacity: 0.95 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, overflow: "hidden" }}>
            {branding.logoType === "image" && branding.logoImage
              ? <img src={branding.logoImage} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span>{branding.logoEmoji}</span>}
          </div>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{branding.companyName}</span>
        </div>
        <div style={{ fontSize: 14, opacity: 0.85 }}>Welcome back,</div>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{firstName}</div>
      </div>

      <div style={{ maxWidth: 560, margin: "0 auto", padding: "18px 16px 60px" }}>
        {/* Next service */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18, marginBottom: 14, marginTop: -20, boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Your Next Service</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: T.text }}>{client.nextService || "To be scheduled"}</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{client.plan} Plan · {client.planFreq}</div>
            </div>
            <div style={{ fontSize: 30 }}>🗓️</div>
          </div>
        </div>

        {/* Balance */}
        {perms.seeBalances && (
        <div style={{ background: balanceDue ? `${T.warning}14` : `${T.accent}14`, border: `1px solid ${balanceDue ? T.warning : T.accent}40`, borderRadius: 16, padding: 18, marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 4 }}>Account Balance</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: balanceDue ? T.warning : T.accent }}>{client.balance}</div>
          </div>
          {balanceDue
            ? <Btn style={{ borderRadius: 10 }}>Pay Now</Btn>
            : <span style={{ fontSize: 13, color: T.accent, fontWeight: 700 }}>✓ Paid in full</span>}
        </div>
        )}

        {/* Equipment status */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 12 }}>Your {dMeta(client.division).siteLabel}</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 2 }}>{client.pondType}</div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 14 }}>{client.pondSize}</div>
          {equipNeedsAttention.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.accent, fontWeight: 600 }}>
              <span>✓</span> All equipment in good condition
            </div>
          ) : (
            equipNeedsAttention.map((e, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: T.text, marginBottom: 4 }}>
                <span style={{ color: T.warning }}>⚠️</span> {e.name} — {e.status}
              </div>
            ))
          )}
        </div>

        {/* Service history */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10, paddingLeft: 4 }}>Service History</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {(client.history || []).length === 0 && (
            <div style={{ fontSize: 13, color: T.textMuted, padding: "12px 4px" }}>No service visits yet.</div>
          )}
          {(client.history || []).map((h, i) => (
            <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{h.type}</div>
                <div style={{ fontSize: 12, color: T.textMuted }}>{h.date}</div>
              </div>
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5, marginBottom: 12 }}>{h.notes}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {[["pH", h.ph],["NH₃", h.ammonia],["NO₂", h.nitrite],["Temp", h.temp]].map(([k, v]) => (
                  <div key={k} style={{ background: T.surfaceAlt, borderRadius: 10, padding: "7px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{k}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginTop: 2 }}>{v}</div>
                  </div>
                ))}
              </div>
              {h.photos && h.photos.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <PhotoStrip photos={h.photos} size={60} />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Contact / request */}
        {(() => {
          const cPhone = (branding.companyPhone || "").replace(/[^\d+]/g, "");
          const cEmail = branding.companyEmail || "";
          const reqHref = cEmail
            ? `mailto:${cEmail}?subject=${encodeURIComponent("Service Request — " + client.name)}&body=${encodeURIComponent("Hi " + (branding.companyName || "") + ",\n\nI'd like to request service for my account (" + client.name + ").\n\nThank you!")}`
            : (cPhone ? `sms:${cPhone}` : null);
          const contactHref = cPhone ? `tel:${cPhone}` : (cEmail ? `mailto:${cEmail}` : null);
          const haveContact = reqHref || contactHref;
          return (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18, textAlign: "center" }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: T.text, marginBottom: 4 }}>Need something?</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 14 }}>{haveContact ? "Request a service or reach out to our team." : "Add your phone or email in Customize → Messaging to enable these."}</div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn href={reqHref || undefined} disabled={!reqHref} block style={{ flex: 1, borderRadius: 12 }}>Request Service</Btn>
                <Btn href={contactHref || undefined} disabled={!contactHref} variant="outline" block style={{ flex: 1, borderRadius: 12 }}>Contact Us</Btn>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ON MY WAY MODAL
// ─────────────────────────────────────────────
function OnMyWayModal({ stop, client, email, onClose, onSent }) {
  const { T, branding } = useApp();
  const trackLink = (email && email.trackLink) || "";

  // GPS state: locating | ready
  const [gpsState, setGpsState] = useState("locating");
  const [baseEta, setBaseEta] = useState(0);   // auto-calculated drive time (min)
  const [buffer, setBuffer] = useState(0);      // extra minutes the driver adds

  // Simulate a GPS lookup that returns a drive-time ETA.
  // In production this is replaced by a real distance/traffic API call.
  useEffect(() => {
    const timer = setTimeout(() => {
      // mock: derive a believable ETA from GPS distance + traffic
      const mockMinutes = 8 + Math.floor(Math.random() * 18); // 8–25 min
      setBaseEta(mockMinutes);
      setGpsState("ready");
    }, 1400);
    return () => clearTimeout(timer);
  }, []);

  const totalEta = baseEta + buffer;
  const firstName = client?.name?.split(" ")[0] || "there";
  const phone = client?.phone?.replace(/\D/g, "") || "";

  // arrival clock time
  const arrival = new Date(Date.now() + totalEta * 60000);
  const arrivalStr = arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const message = (() => {
    const tpl = (email && email.smsOnMyWay) || DEFAULT_EMAIL.smsOnMyWay;
    const trackText = trackLink ? `Track my live location here: ${trackLink} — ` : "";
    return tpl
      .replace(/\{first\}/g, firstName)
      .replace(/\{sender\}/g, (email && email.senderName) || (email && email.fromName) || branding.companyName)
      .replace(/\{company\}/g, branding.companyName)
      .replace(/\{eta\}/g, String(totalEta))
      .replace(/\{arrival\}/g, arrivalStr)
      .replace(/\{track\}/g, trackText);
  })();

  const handleSend = () => {
    const smsUrl = `sms:${phone}${/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(message)}`;
    window.open(smsUrl, "_blank");
    onSent();
    onClose();
  };

  const QUICK_ADD = [5, 10, 15, 30];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: T.surface, borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 600, padding: "24px 20px 36px", boxShadow: "0 -8px 40px rgba(0,0,0,0.2)" }}>

        <div style={{ width: 40, height: 4, background: T.border, borderRadius: 2, margin: "0 auto 20px" }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17, color: T.text }}>On My Way</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>{client?.name} · {client?.phone}</div>
          </div>
          <button onClick={onClose} style={{ background: T.surfaceAlt, border: "none", borderRadius: "50%", width: 32, height: 32, fontSize: 16, cursor: "pointer", color: T.textMuted, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>

        {/* GPS ETA display */}
        {gpsState === "locating" ? (
          <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "28px 20px", textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span style={{ display: "inline-block", width: 14, height: 14, border: `2px solid ${T.border}`, borderTopColor: T.primary, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
              Calculating ETA from GPS...
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : (
          <div style={{ background: T.surfaceAlt, borderRadius: 16, padding: "20px", marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textMuted, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
              <span style={{ color: T.accent }}>📍</span> GPS Estimated Arrival
            </div>
            <div style={{ fontSize: 42, fontWeight: 800, color: T.text, lineHeight: 1 }}>{totalEta} <span style={{ fontSize: 18, fontWeight: 700, color: T.textMuted }}>min</span></div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 6 }}>
              Arriving around <strong style={{ color: T.text }}>{arrivalStr}</strong>
            </div>
            {buffer > 0 && (
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                {baseEta} min drive + {buffer} min buffer
              </div>
            )}
          </div>
        )}

        {/* Buffer controls */}
        {gpsState === "ready" && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10 }}>Add Buffer Time</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <button onClick={() => setBuffer(b => Math.max(0, b - 5))}
                style={{ width: 44, height: 44, borderRadius: 12, border: `1.5px solid ${T.border}`, background: T.surface, fontSize: 22, fontWeight: 700, color: T.text, cursor: "pointer", flexShrink: 0 }}>−</button>
              <div style={{ flex: 1, textAlign: "center", background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: 12, padding: "10px", fontSize: 15, fontWeight: 700, color: buffer > 0 ? T.primary : T.textMuted }}>
                +{buffer} min
              </div>
              <button onClick={() => setBuffer(b => b + 5)}
                style={{ width: 44, height: 44, borderRadius: 12, border: `1.5px solid ${T.border}`, background: T.surface, fontSize: 22, fontWeight: 700, color: T.text, cursor: "pointer", flexShrink: 0 }}>+</button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {QUICK_ADD.map(m => (
                <button key={m} onClick={() => setBuffer(m)}
                  style={{ flex: 1, padding: "8px", borderRadius: 20, border: `1.5px solid ${buffer === m ? T.primary : T.border}`, background: buffer === m ? T.navActiveBg : T.surface, color: buffer === m ? T.primary : T.text, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  +{m}
                </button>
              ))}
              {buffer > 0 && (
                <button onClick={() => setBuffer(0)}
                  style={{ padding: "8px 14px", borderRadius: 20, border: `1.5px solid ${T.border}`, background: T.surface, color: T.textMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                  Reset
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8 }}>Grabbing lunch or gas? Pad the ETA so the client isn't left waiting.</div>
          </div>
        )}

        {/* Message preview */}
        {gpsState === "ready" && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 8 }}>Message Preview</div>
            <div style={{ background: T.surfaceAlt, borderRadius: 14, padding: "14px 16px", fontSize: 13, color: T.text, lineHeight: 1.6, position: "relative" }}>
              <div style={{ position: "absolute", top: -6, left: 16, width: 12, height: 12, background: T.surfaceAlt, transform: "rotate(45deg)", borderRadius: 2 }} />
              {message}
            </div>
            {trackLink && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <span>🔗</span> Includes live tracking link
            </div>}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={handleSend} style={{ flex: 1, padding: "13px", fontSize: 14, borderRadius: 12, opacity: gpsState === "ready" ? 1 : 0.5, pointerEvents: gpsState === "ready" ? "auto" : "none" }}>
            📱 Open in Messages
          </Btn>
          <button onClick={onClose}
            style={{ background: T.surfaceAlt, border: "none", borderRadius: 12, padding: "13px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer", color: T.text, fontFamily: "inherit" }}>
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
      <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "50%", width: 38, height: 38, fontSize: 18, cursor: "pointer" }}>✕</button>
      {photos.length > 1 && <button onClick={prev} style={{ position: "absolute", left: 12, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: "50%", width: 42, height: 42, fontSize: 22, cursor: "pointer" }}>‹</button>}
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
          <div style={{ fontSize: 44, marginBottom: 10 }}>✅</div>
          <div style={{ fontWeight: 800, fontSize: 17, color: T.text, marginBottom: 6 }}>Saved to {firstName}'s history</div>
          {/* profit chip */}
          <div style={{ display: "inline-block", background: profit >= 0 ? `${T.accent}18` : "#C0392B18", color: profit >= 0 ? T.accent : "#C0392B", borderRadius: 20, padding: "6px 16px", fontSize: 14, fontWeight: 800, marginBottom: 16 }}>
            {profit >= 0 ? "Profit" : "Loss"}: {money(Math.abs(profit))} · {margin.toFixed(0)}% margin
          </div>
          <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 18, lineHeight: 1.5 }}>Send the client their report:</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <Btn onClick={sendEmail} style={{ flex: 1, padding: "13px", borderRadius: 12 }}>✉️ Email Report</Btn>
            <Btn onClick={sendText} variant="ghost" style={{ flex: 1, padding: "13px", borderRadius: 12 }}>💬 Text Report</Btn>
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
                {t.done && <span style={{ color: "#fff", fontSize: 12, fontWeight: 800, lineHeight: 1 }}>✓</span>}
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
          <input value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === "Enter" && addTask()} placeholder="Add a task..."
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
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>🚩 Flag for office attention</span>
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
              <input value={val} onChange={e => setter(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: "100%", padding: "6px 8px 6px 20px", border: `1px solid ${T.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", textAlign: "right" }} />
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
          <input placeholder="Search clients..." value={clientSearch} onChange={e => setClientSearch(e.target.value)}
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

function HeadHereModal({ stop, client, email, branding, onClose }) {
  const { T } = useApp();
  const [pref, setPref] = React.useState(() => { try { return localStorage.getItem("sps_map_app") || null; } catch { return null; } });
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
  const mapApps = [{ key: "apple", label: "Apple Maps", icon: "🍎" }, { key: "google", label: "Google Maps", icon: "🔵" }, { key: "waze", label: "Waze", icon: "💜" }];
  const lbl = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: T.textMuted, marginBottom: 10, display: "block" };
  return (
    <Modal title={`Head to ${stop.client || "Stop"}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {addr && <div style={{ fontSize: 13, color: T.textMuted, marginTop: -8, lineHeight: 1.4 }}>📍 {addr}</div>}
        <div>
          <span style={lbl}>On My Way Text</span>
          {smsHref ? <Btn href={smsHref} variant="outline" block>📱 Send On My Way to {firstName}</Btn>
            : <div style={{ fontSize: 13, color: T.textMuted, background: T.surfaceAlt, borderRadius: 10, padding: "11px 14px" }}>Add a phone number to this client to send texts.</div>}
        </div>
        <div>
          <span style={lbl}>Open in Maps</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {mapApps.map(a => (
              <Btn key={a.key} href={buildMapUrl(addr, a.key)} variant={pref === a.key ? "primary" : "ghost"} block onClick={() => openMap(a.key)}>
                {a.icon} {a.label}{pref === a.key ? " ✓" : ""}
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

  // ── Route-dashboard state + helpers ──
  const [selectedDate, setSelectedDate] = useState(() => {
    const t = todayMDY();
    return schedule.some(d => d.date === t) ? t : (schedule[0] ? schedule[0].date : t);
  });
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
                {isComplete && <span style={{ color: T.accent }}>✓</span>}{s.client}
              </div>
              {cfg.showAddress && <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.address}</div>}
              {cfg.showServices && s.services && s.services.length > 0 ? (
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  🧰 {s.services.map(sv => typeof sv === "string" ? sv : `${sv.name}${sv.price ? ` $${sv.price}` : ""}`).join(" · ")}
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
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.accent, fontWeight: 700 }}><span>✅</span> Completed · Report saved</div>
              ) : sent ? (
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.accent, fontWeight: 700 }}><span>📍</span> Client notified</div>
              ) : (
                <div style={{ fontSize: 12, color: T.textMuted }}>Not yet started</div>
              )}
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button onClick={e => { e.stopPropagation(); setHeadHereModal({ stop: s, client: c }); }}
                  style={{ background: T.primary, color: "#fff", border: "none", borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  🗺 Head Here
                </button>
                {!isComplete && perms.sendTexts && (
                  <button onClick={e => { e.stopPropagation(); setOmwModal({ stop: s, client: c, key: s.sid }); }}
                    style={{ background: "transparent", color: T.primary, border: `1.5px solid ${T.primary}`, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    📱 {sent ? "Resend" : "On My Way"}
                  </button>
                )}
                {perms.completeStops && (
                  <button onClick={e => { e.stopPropagation(); setCompleteModal({ stop: s, client: c }); }}
                    style={{ background: isComplete ? "transparent" : T.accent, color: isComplete ? T.accent : "#fff", border: isComplete ? `1.5px solid ${T.accent}` : "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    ✓ {isComplete ? "Re-send" : "Complete"}
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
          <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
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
                <div style={{ fontSize: 34, marginBottom: 10 }}>🗓️</div>
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
              <button onClick={() => setViewTech(null)} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>‹ All routes</button>
              <span style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{stripDate(selectedDate)}{isToday ? " · Today" : ""}</span>
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
              🗑️ Remove {selCount} {selCount === 1 ? "Stop" : "Stops"}
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
      {headHereModal && <HeadHereModal stop={headHereModal.stop} client={headHereModal.client} email={email} branding={branding} onClose={() => setHeadHereModal(null)} />}

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
        <span>🔗</span>
        <span>Live two-way QuickBooks Online sync is coming in Phase 2 (needs a secure account connection). For now, CSV import works right away.</span>
      </div>

      {stage === "idle" && (
        <div>
          <div style={{ border: `2px dashed ${T.border}`, borderRadius: 14, padding: "40px 24px", textAlign: "center", marginBottom: 16, background: T.surface }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
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
          <div style={{ fontSize: 52, marginBottom: 16 }}>✅</div>
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
          <div><label style={labelStyle}>Live Tracking Link <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(optional)</span></label><input style={field} value={email.trackLink || ""} onChange={e => set("trackLink", e.target.value)} placeholder="Leave blank to omit tracking" /></div>
          <div><label style={labelStyle}>"On My Way" Text</label><textarea style={{ ...field, resize: "vertical" }} rows={3} value={email.smsOnMyWay || ""} onChange={e => set("smsOnMyWay", e.target.value)} /></div>
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
      {value} <span style={{ color: T.textMuted, fontSize: 11 }}>✏️</span>
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
                  <span style={{ color: T.textMuted, fontSize: 13 }}>✏️</span>
                </div>
              </div>
              {s.description && <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6, lineHeight: 1.4 }}>{s.description}</div>}
              {(s.products?.length > 0) && <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 3 }}>🧴 {s.products.map(productName).filter(Boolean).join(", ")}</div>}
              {(s.tests?.length > 0) && <div style={{ fontSize: 11, color: T.textMuted }}>🧪 {s.tests.join(", ")}</div>}
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
                <span style={{ color: T.textMuted, fontSize: 13 }}>✏️</span>
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
                    <span style={{ color: T.textMuted, fontSize: 13 }}>✏️</span>
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
        <span>💡</span>
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
        <span>🚚</span>
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
  const list = team || [];
  const openAdd = () => setModal({ mode: "add", data: { id: `e${Date.now()}`, name: "", rate: "", role: "field", pin: "", email: "", perms: { ...ROLE_PRESETS.field } } });
  const openEdit = (e) => setModal({ mode: "edit", data: { perms: { ...(ROLE_PRESETS[e.role] || ROLE_PRESETS.field) }, ...e } });
  const setD = (patch) => setModal(m => ({ ...m, data: { ...m.data, ...patch } }));
  const save = () => {
    const d = modal.data; if (!d.name.trim()) return;
    setTeam(t => {
      const exists = (t || []).some(x => x.id === d.id);
      return exists ? t.map(x => x.id === d.id ? d : x) : [...(t || []), d];
    });
    setModal(null);
  };
  const del = () => { setTeam(t => (t || []).filter(x => x.id !== modal.data.id)); setModal(null); };
  const field = { width: "100%", padding: "11px 14px", border: `1px solid ${T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box" };
  const labelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: T.textMuted, display: "block", marginBottom: 8 };

  const ownerCount = list.filter(m => m.role === "owner").length;
  const isLastOwner = modal && modal.data.role === "owner" && ownerCount <= 1 && list.some(m => m.id === modal.data.id && m.role === "owner");

  return (
    <>
      <Card style={{ marginBottom: 14 }}>
        <CardHeader title="Team & Logins" action={<Btn sm onClick={openAdd}>+ Add</Btn>} />
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 4 }}>Each person signs in with their own account and sees only what their role allows. Tap a member to set their role, PIN, and pay rate.</div>
          {list.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>No team members yet. Tap "+ Add" to create one.</div>}
          {list.map(e => (
            <div key={e.id} onClick={() => openEdit(e)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: T.surfaceAlt, borderRadius: 12, cursor: "pointer" }}>
              <span style={{ width: 38, height: 38, borderRadius: "50%", background: e.role === "owner" ? T.primary : hexA(T.primary, 0.14), color: e.role === "owner" ? "#fff" : T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{initials(e.name)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{e.name} {e.id === currentUserId && <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600 }}>· you</span>}</div>
                <div style={{ fontSize: 12, color: T.textMuted }}>{roleLabel(e.role)}{e.pin ? " · PIN set" : ""}{e.rate !== "" && e.rate != null ? ` · $${e.rate}/hr` : ""}</div>
              </div>
              <span style={{ color: T.textMuted, fontSize: 13 }}>✏️</span>
            </div>
          ))}
        </div>
      </Card>

      <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "12px 16px", fontSize: 12, color: T.textMuted, display: "flex", gap: 8, lineHeight: 1.5 }}>
        <span>🔒</span>
        <span>This is a working prototype of logins on this device. Real accounts with secure passwords that sync across phones arrive with the cloud backend at deployment.</span>
      </div>

      {modal && (
        <Modal title={modal.mode === "add" ? "Add Team Member" : "Edit Team Member"} onClose={() => setModal(null)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div><label style={labelStyle}>Name</label><input style={field} value={modal.data.name} onChange={e => setD({ name: e.target.value })} placeholder="e.g. David" autoFocus /></div>
            <div><label style={labelStyle}>Login Email</label><input style={field} value={modal.data.email || ""} onChange={e => setD({ email: e.target.value })} placeholder="the email they sign in with" inputMode="email" autoCapitalize="none" /></div>

            <div>
              <label style={labelStyle}>Role</label>
              <select value={modal.data.role || "field"} onChange={e => { const role = e.target.value; setD({ role, ...(role === "custom" && !modal.data.perms ? { perms: { ...ROLE_PRESETS.field } } : {}) }); }}
                style={{ ...field, appearance: "none", WebkitAppearance: "none" }}>
                {MEMBER_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>
                {modal.data.role === "owner" ? "Full control, including managing team and logins."
                  : "Pick a starting role, then fine-tune the exact permissions below."}
              </div>
            </div>

            <div>
              <label style={labelStyle}>Login PIN <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(optional)</span></label>
              <input style={field} value={modal.data.pin || ""} onChange={e => setD({ pin: e.target.value.replace(/\D/g, "").slice(0, 6) })} placeholder="4–6 digits, or leave blank for tap-to-sign-in" inputMode="numeric" />
            </div>

            <div>
              <label style={labelStyle}>Hourly Labor Rate <span style={{ textTransform: "none", color: T.textMuted, fontWeight: 400 }}>(optional)</span></label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>$</span>
                <input style={{ ...field, paddingLeft: 24 }} value={modal.data.rate} onChange={e => setD({ rate: e.target.value.replace(/[^\d.]/g, "") })} placeholder="Leave blank for default" />
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Used to value the labor on jobs they're assigned to.</div>
            </div>

            {modal.data.role === "owner" ? (
              <div style={{ background: T.surfaceAlt, borderRadius: 10, padding: "11px 14px", fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>👑 Owners have full access to everything, including team and login management.</div>
            ) : (
              <div>
                <label style={{ ...labelStyle, marginBottom: 6 }}>Permissions for this login</label>
                <div style={{ fontSize: 11.5, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>Toggle anything to control exactly what this person sees and can do. A new hire stays locked down; a manager can be opened up. Changes save to this login only.</div>
                <PermissionGroups
                  value={modal.data.role === "custom" ? (modal.data.perms || {}) : (ROLE_PRESETS[modal.data.role] || ROLE_PRESETS.field)}
                  onChange={p => setD({ role: "custom", perms: p })}
                />
              </div>
            )}

            <Btn onClick={save} block lg style={{ borderRadius: 12 }}>{modal.mode === "add" ? "Add Member" : "Save Changes"}</Btn>
            {modal.mode === "edit" && !isLastOwner && <button onClick={del} style={{ background: "none", border: "none", color: "#C0392B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 6, fontFamily: "inherit" }}>Remove this member</button>}
            {isLastOwner && <div style={{ fontSize: 11, color: T.textMuted, textAlign: "center" }}>This is your only Owner account, so it can't be removed.</div>}
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
        <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: T.textMuted }}>🔍</span>
        <input placeholder="Search by number or client..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: "100%", padding: "10px 14px 10px 36px", border: `1px solid ${T.border}`, borderRadius: 10, fontSize: 14, boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: T.text, background: T.surface }} />
      </div>
      <div style={{ display: "flex", gap: 7, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
        {["All", ...INVOICE_STATUSES].map(s => (
          <button key={s} onClick={() => setFilter(s)} style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 100, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, background: filter === s ? T.primary : T.surfaceAlt, color: filter === s ? "#fff" : T.textMuted }}>{s}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "50px 20px", color: T.textMuted }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🧾</div>
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
            <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
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
            {[["light", "☀︎ Light"], ["dark", "☾ Dark"], ["system", "⚙ System"]].map(([m, label]) => (
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
              <div style={{ fontWeight: 700, fontSize: 13, color: cu.text }}>✨ Custom</div>
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
        <span>💾</span>
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
function Icon({ name, size = 22 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    home: <><path d="M4 10.5 12 4l8 6.5" /><path d="M5.5 9.5V19a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1V9.5" /></>,
    clients: <><circle cx="12" cy="8" r="3.4" /><path d="M5.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6" /></>,
    calendar: <><rect x="4" y="5" width="16" height="16" rx="2.5" /><path d="M4 9.5h16M9 3v4M15 3v4" /></>,
    sliders: <><path d="M5 8h9M19 8h0M5 16h0M10 16h9" /><circle cx="16.5" cy="8" r="2.2" /><circle cx="7.5" cy="16" r="2.2" /></>,
    download: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 20h14" /></>,
    invoice: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3.5" /></>,
  };
  return <svg {...common}>{paths[name] || null}</svg>;
}

const NAV = [
  { id: "dashboard", label: "Home",      icon: "home" },
  { id: "clients",   label: "Clients",   icon: "clients" },
  { id: "schedule",  label: "Schedule",  icon: "calendar" },
  { id: "settings",  label: "Customize", icon: "sliders" },
];

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

  // Not signed in → show the account picker
  if (!currentUser) {
    if (!anyEmail) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: fontStack, background: T.bg, color: T.textMuted, fontSize: 14 }}>Setting up your account…</div>;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: fontStack, background: T.bg, color: T.text }}>
        <div style={{ textAlign: "center", maxWidth: 340 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
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
          * { -webkit-tap-highlight-color: transparent; }
          input, select, textarea { transition: box-shadow .15s ease, border-color .15s ease; }
          input:focus, select:focus, textarea:focus { border-color: var(--ringBorder) !important; box-shadow: 0 0 0 3.5px var(--ring); }
          button, a { transition: transform .08s ease, opacity .15s ease, filter .15s ease, background .15s ease, box-shadow .15s ease; }
          button:active, a:active { transform: scale(0.97); }
          @media (hover: hover) { button:hover:not(:disabled) { filter: brightness(1.04); } }
          ::selection { background: var(--ring); }
          ::-webkit-scrollbar { width: 9px; height: 9px; }
          ::-webkit-scrollbar-thumb { background: ${hexA(T.textMuted, 0.35)}; border-radius: 100px; }
          ::-webkit-scrollbar-track { background: transparent; }
        `}</style>

        {/* Header — light frosted, matches theme surface */}
        <header style={{ background: hexA(T.surface, 0.8), backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", color: T.text, padding: "0 18px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, borderBottom: `1px solid ${T.border}` }}>
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
          <button onClick={() => handleNav("settings")}
            style={{ background: page === "settings" ? hexA(T.primary, 0.12) : T.surfaceAlt, border: "none", color: page === "settings" ? T.primary : T.textMuted, fontSize: 17, cursor: "pointer", width: 36, height: 36, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            ⚙
          </button>
        </header>

        {/* Signed-in identity + sign out / switch user */}
        <div style={{ position: "sticky", top: 56, zIndex: 99, background: T.surfaceAlt, borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 16px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.textMuted, minWidth: 0 }}>
            <span style={{ width: 22, height: 22, borderRadius: "50%", background: currentUser.role === "owner" ? T.primary : hexA(T.primary, 0.16), color: currentUser.role === "owner" ? "#fff" : T.primary, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 9.5, flexShrink: 0 }}>{initials(currentUser.name)}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Signed in as <span style={{ color: T.text, fontWeight: 700 }}>{currentUser.name}</span> · {roleLabel(currentUser.role)}</span>
          </span>
          <div style={{ display: "flex", gap: 12, flexShrink: 0, alignItems: "center" }}><button onClick={() => window.location.reload()} title="Sync" style={{ background: "none", border: "none", color: T.textMuted, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 0 }}>↻</button><button onClick={handleSignOut} style={{ background: "none", border: "none", color: T.primary, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Sign out</button></div>
        </div>

        {/* Main */}
        <main style={{ flex: 1, padding: "22px 16px", maxWidth: 740, margin: "0 auto", width: "100%", boxSizing: "border-box", paddingBottom: "calc(96px + env(safe-area-inset-bottom))" }}>
          {page === "dashboard" && <Dashboard clients={clients} invoices={invoices} schedule={schedule} home={home} setHome={setHome} officeAlerts={officeAlerts} onResolveAlert={handleResolveAlert} onNav={handleNav} />}
          {page === "clients" && adding && <ClientEditForm client={BLANK_CLIENT} title="Add Client" onSave={handleSaveNewClient} onCancel={() => setAdding(false)} />}
          {page === "clients" && !adding && !selectedClient && <ClientList clients={clients} onSelect={handleClientSelect} onAdd={() => setAdding(true)} onImport={() => handleNav("import")} onBatchUpdate={handleBatchUpdate} onBatchDelete={handleBatchDelete} onBatchSchedule={handleBatchSchedule} />}
          {page === "clients" && !adding && selectedClient && <ClientDetail client={selectedClient} invoices={invoices} invoicing={invoicing} branding={branding} onBack={() => setSelectedClient(null)} onUpdate={handleUpdateClient} onSaveInvoice={handleSaveInvoice} onDeleteInvoice={handleDeleteInvoice} />}
          {page === "schedule" && <Schedule clients={clients} catalog={catalog} costs={costs} schedule={schedule} setSchedule={setSchedule} scheduleCfg={scheduleCfg} team={team} onClientSelect={handleClientSelect} seedClientIds={scheduleSeed} clearSeed={() => setScheduleSeed(null)} email={email} onComplete={handleCompleteStop} completedSids={completedSids} onOfficeAlert={handleOfficeAlert} />}
          {page === "invoices" && perms.canInvoice && <InvoicesScreen invoices={invoices} clients={clients} invoicing={invoicing} branding={branding} onSave={handleSaveInvoice} onDelete={handleDeleteInvoice} />}
          {page === "import"   && perms.canImport && <SkimmerImport onImport={handleImportClients} onGoToClients={() => handleNav("clients")} />}
          {page === "settings" && <AppSettings branding={branding} setBranding={setBranding} catalog={catalog} setCatalog={setCatalog} email={email} setEmail={setEmail} costs={costs} setCosts={setCosts} budget={budget} setBudget={setBudget} clients={clients} scheduleCfg={scheduleCfg} setScheduleCfg={setScheduleCfg} team={team} setTeam={setTeam} invoicing={invoicing} setInvoicing={setInvoicing} currentUserId={currentUser.id} onResetData={handleResetData} />}
        </main>

        {/* Bottom Nav — frosted with active pill */}
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: hexA(T.surface, 0.82), backdropFilter: "saturate(180%) blur(20px)", WebkitBackdropFilter: "saturate(180%) blur(20px)", borderTop: `1px solid ${T.border}`, display: "flex", zIndex: 90, minHeight: 60, paddingTop: 4, paddingBottom: "calc(8px + env(safe-area-inset-bottom))" }}>
          {NAV.flatMap(n => (n.id === "settings" && perms.canInvoice) ? [{ id: "invoices", icon: "invoice", label: "Invoices" }, n] : [n]).map(n => {
            const active = page === n.id;
            return (
              <button key={n.id} onClick={() => handleNav(n.id)}
                style={{ flex: 1, border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: active ? T.primary : T.textMuted, fontFamily: "inherit" }}>
                <span style={{ width: 46, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 100, background: active ? hexA(T.primary, 0.12) : "transparent", transition: "background .15s" }}><Icon name={n.icon} size={22} /></span>
                <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500, letterSpacing: "-0.01em" }}>{n.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </AppCtx.Provider>
  );
}
