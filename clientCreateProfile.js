// The compact creation route accepts a new contact profile, never an imported
// customer identity, report, prepaid policy, or existing accounting balance.
const TEXT_FIELDS = new Set([
  "name", "address", "street", "city", "state", "zip", "phone", "email",
  "division", "plan", "planFreq", "status", "pondType", "pondSize", "poolType",
  "poolSize", "seasonalType", "seasonalSize", "nextService", "referralSource",
  "referredBy", "preferredDay", "routeDay", "notes",
]);
const BOOLEAN_FIELDS = new Set(["servicePond", "servicePool", "serviceSeasonal", "preferredDayOverride"]);
const FORBIDDEN_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REQUEST_ID = /^(?:client-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTO_INVOICE = new Set(["", "Off", "Monthly", "Bi-Weekly", "Weekly"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, code = "client-create-profile-invalid", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

export function isClientCreateRequestId(value) {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function rate(value) {
  const validString = typeof value === "string" && value.length <= 160
    && (value === "" || /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value));
  if ((!validString && typeof value !== "number") || !Number.isFinite(Number(value))
    || Number(value) < 0 || Number(value) > 1_000_000_000) {
    fail("A client rate must be a valid nonnegative amount.");
  }
  return value;
}

function profileMap(value, rates) {
  if (!isRecord(value) || Object.keys(value).length > 32) fail("The client service plans could not be read.");
  const entries = Object.entries(value).map(([key, entry]) => {
    if (!key || key.length > 50 || FORBIDDEN_MAP_KEYS.has(key)) fail("A client service plan name is invalid.");
    if (rates) return [key, rate(entry)];
    if (typeof entry !== "string" || entry.length > 160) fail("A client service plan is invalid.");
    return [key, entry];
  });
  return Object.fromEntries(entries);
}

export function stableClientCreateJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableClientCreateJSON).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableClientCreateJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalizeNewClientProfile(client, { allowBilling = true } = {}) {
  if (!isRecord(client)) fail("A new client profile is required.");
  if (!isClientCreateRequestId(client.id)) fail("This client form has no valid save identity. Reopen Add Client before saving.");
  let serialized;
  try { serialized = JSON.stringify(client); } catch (_) { fail("The client profile could not be read."); }
  if (new TextEncoder().encode(serialized).byteLength > 32_768) fail("This new client profile is too large to save.", "client-create-profile-too-large", 413);

  const next = { id: client.id };
  for (const [key, value] of Object.entries(client)) {
    if (key === "id") continue;
    if (TEXT_FIELDS.has(key) || /^[a-z][a-z0-9 _-]{0,39}(Type|Size)$/.test(key)) {
      if (typeof value !== "string" || value.length > (key === "name" ? 200 : 2000)) fail("A client profile field is invalid or too long.");
      next[key] = key === "name" ? value.trim() : value;
    } else if (BOOLEAN_FIELDS.has(key) || /^service[A-Z][A-Za-z0-9 _-]{0,39}$/.test(key)) {
      if (typeof value !== "boolean") fail("A client service selection is invalid.");
      next[key] = value;
    } else if (key === "plans" || key === "planRates") {
      next[key] = profileMap(value, key === "planRates");
    } else if (key === "monthlyRate") {
      next[key] = rate(value);
    } else if (key === "autoInvoice") {
      if (typeof value !== "string" || !AUTO_INVOICE.has(value)) fail("Choose a valid automatic invoice schedule.");
      next[key] = value;
    } else if (key === "equipment" || key === "history") {
      if (!Array.isArray(value) || value.length) fail("Create the client first, then add equipment or service reports.");
    } else if (key === "balance") {
      if (![0, "0", "0.00", "$0.00"].includes(value)) fail("A new client must start with a zero balance.");
    } else if (key === "maintenanceBilling") {
      fail("Create the client first, then save prepaid coverage in the client billing settings.");
    } else {
      fail("This request includes fields that cannot be set when creating a client.");
    }
  }
  if (!next.name) fail("Enter the client's full name before saving.");
  if (!allowBilling && (Number(next.monthlyRate || 0) > 0
    || Object.values(next.planRates || {}).some(value => Number(value) > 0)
    || (next.autoInvoice && next.autoInvoice !== "Off"))) {
    fail("Your team permissions do not allow setting client rates or automatic billing.", "client-create-billing-forbidden", 403);
  }
  next.status = next.status || "Active";
  next.balance = "$0.00";
  next.history = [];
  next.equipment = [];
  return next;
}
