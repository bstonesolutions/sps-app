const STAFF_PAGE_TARGETS = Object.freeze({
  home: "dashboard",
  alerts: "dashboard",
  profit: "dashboard",
  schedule: "schedule",
  invoices: "invoices",
  invoice: "invoices",
  estimates: "estimates",
  leads: "leads",
  comms: "comms",
  budget: "budget",
  clients: "clients",
  reports: "reports",
  property: "clients",
  history: "clients",
});

// Public links use the label staff see (Comms → Inbox), while the internal section id remains
// `email` because that surface combines work email and both Quo text lines. Keep the translation in
// one place so a push tap, a warm native link, and a cold browser link cannot drift apart.
const COMMS_SECTION_TARGETS = Object.freeze({
  inbox: "email",
  email: "email",
  texts: "email",
  chat: "messages",
  messages: "messages",
  leads: "inbox",
  reminders: "reminders",
  broadcast: "broadcast",
  settings: "settings",
  activity: "log",
  log: "log",
});

export function resolveStaffDeepLink(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/, 1)[0];
  if (!normalized) return null;

  const [root, section, ...extra] = normalized.split("/");
  if (extra.length) return null;

  const page = STAFF_PAGE_TARGETS[root];
  if (!page) return null;
  if (root !== "comms" || !section) return { page, options: {} };

  const commsSection = COMMS_SECTION_TARGETS[section];
  return commsSection ? { page, options: { commsSection } } : null;
}
