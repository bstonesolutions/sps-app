// Server-mediated, client-safe portal snapshot. Every returned object is built from an
// explicit public allowlist after the caller is matched by bound auth UID (or one unique
// verified-email match for legacy client records).
import {
  clientOwnsInvoice,
  lc,
  readAppStateKeys,
  requirePortalClient,
  resolvePortalClient,
  setPortalCors,
  signPortalMedia,
} from "./_portal-auth.js";
import { estimateTotals, formatEstimateMoney } from "../estimateMath.js";

const KEYS = [
  "sps_clients",
  "sps_invoices",
  "sps_schedule",
  "sps_estimates",
  "sps_branding",
  "sps_invoicing",
  "sps_team",
  "sps_arrivals",
  "sps_completed",
  "sps_enroute",
];

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function pick(object, fields) {
  const out = {};
  for (const field of fields) {
    if (!own(object, field)) continue;
    const value = object[field];
    if (["string", "number", "boolean"].includes(typeof value) || value == null) out[field] = value;
  }
  return out;
}

function scalarMap(value, maxEntries = 40) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, maxEntries)) {
    if (!key || key.length > 80 || ["__proto__", "prototype", "constructor"].includes(key)) continue;
    if (["string", "number", "boolean"].includes(typeof item) || item == null) out[key] = item;
  }
  return out;
}

function mediaItem(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return pick(value, ["id", "src", "label", "caption", "name", "type", "date", "uploadedAt", "poster"]);
}

function mediaList(value, max = 100) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map(mediaItem).filter(Boolean);
}

function namedPublicItems(value, max = 100) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((item) => {
    if (typeof item === "string") return item;
    return item && typeof item === "object" && ["string", "number"].includes(typeof item.name)
      ? { name: String(item.name) }
      : null;
  }).filter(Boolean);
}

function publicHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 250).map((visit) => {
    const out = pick(visit, [
      "id", "sid", "completionReceiptId", "date", "type", "tech", "notes", "ph", "ammonia", "nitrite", "temp",
      "invoice", "satisfaction", "clientRating", "clientFeedback", "ratedAt",
    ]);
    if (visit && visit.readings) out.readings = scalarMap(visit.readings);
    if (visit && visit.photos) out.photos = mediaList(visit.photos);
    if (visit && visit.services) out.services = namedPublicItems(visit.services);
    if (visit && visit.products) out.products = namedPublicItems(visit.products);
    return out;
  });
}

function publicEquipment(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => {
    const out = pick(item, [
      "id", "name", "installed", "status", "serialNumber", "origin", "purchaseDate",
      "warrantyLength", "warrantyUnit", "notes",
    ]);
    if (item && item.photos) out.photos = mediaList(item.photos);
    return out;
  });
}

function publicFishHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 250).map((item) => {
    const out = pick(item, ["id", "species", "date", "count", "health", "notes"]);
    if (item && item.photos) out.photos = mediaList(item.photos);
    return out;
  });
}

function publicPurchaseHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 250).map((item) => pick(item, ["id", "item", "date", "category", "price"]));
}

function publicDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => pick(item, ["id", "name", "label", "type", "category", "uploadedAt", "src"]));
}

function publicNotifyPrefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = pick(value, [
    "serviceReminders", "onMyWay", "invoiceReady", "reportSummary",
    "paymentNudges", "winBack", "broadcasts",
  ]);
  const channels = value.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    out.channels = pick(channels, ["text", "email", "app"]);
  }
  return out;
}

function publicClient(client) {
  const out = pick(client, [
    "id", "name", "email", "address", "division", "plan", "planFreq", "monthlyRate",
    "preferredDay", "routeDay", "routeFreq",
    "nextService", "pondType", "pondSize", "pondGallons", "poolType", "poolSize",
    "poolGallons", "seasonalType", "seasonalSize", "servicePond", "servicePool",
    "serviceSeasonal",
  ]);
  out.plans = scalarMap(client && client.plans, 20);
  out.planRates = scalarMap(client && client.planRates, 20);
  out.notifyPrefs = publicNotifyPrefs(client && client.notifyPrefs);
  out.history = publicHistory(client && client.history);
  out.equipment = publicEquipment(client && client.equipment);
  out.fishHistory = publicFishHistory(client && client.fishHistory);
  out.purchaseHistory = publicPurchaseHistory(client && client.purchaseHistory);
  out.sitePhotos = mediaList(client && client.sitePhotos);
  out.siteVideos = mediaList(client && client.siteVideos);
  out.documents = publicDocuments(client && client.documents);
  return out;
}

function publicLineItem(line) {
  return pick(line, [
    "id", "desc", "description", "qty", "unitPrice", "taxable", "kind", "isLateFee",
    "bundleNote", "discount", "discountType", "rate", "amount",
  ]);
}

function publicInvoice(invoice) {
  const out = pick(invoice, [
    "id", "qbId", "number", "clientId", "clientName", "clientAddress", "clientEmail",
    "date", "issueDate", "dueDate", "status", "source", "amount", "total", "subTotal", "subtotal", "taxAmount", "tax",
    "balance", "locallyEdited", "taxRate", "discount", "discountType", "notes", "paymentLink",
    "paidDate", "createdAt",
  ]);
  out.lineItems = Array.isArray(invoice && invoice.lineItems)
    ? invoice.lineItems.slice(0, 250).map(publicLineItem)
    : [];
  if (invoice && invoice.payment && typeof invoice.payment === "object") {
    out.payment = pick(invoice.payment, ["method", "date"]);
  }
  return out;
}

function publicEstimateItem(line) {
  return pick(line, ["id", "desc", "description", "qty", "price", "unitPrice", "kind", "amount"]);
}

function estimateMoneyNumber(value) {
  const parsed = Number.parseFloat(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicEstimate(estimate) {
  const out = pick(estimate, [
    "id", "number", "clientId", "title", "service", "date", "issueDate", "status",
    "notes", "validDays", "createdAt", "sentAt", "approvedAt",
  ]);
  out.items = Array.isArray(estimate && estimate.items)
    ? estimate.items.slice(0, 250).map(publicEstimateItem)
    : [];

  // Never expose or display caller-supplied aggregate fields without checking them. Rebuild the
  // client-facing numbers from the sanitized line items and the estimate's explicit tax snapshot.
  const computed = estimateTotals({
    items: out.items,
    taxEnabled: estimate && estimate.taxEnabled === true,
    taxRate: estimate && estimate.taxRate,
  });
  // Older estimates occasionally stored only aggregate values. Keep those readable without ever
  // making a legacy estimate taxable: new/itemized estimates are still rebuilt from their lines.
  const hasItemizedPricing = out.items.length > 0;
  const legacyTax = estimate && estimate.taxEnabled === true ? estimateMoneyNumber(estimate.taxAmount ?? estimate.tax) : 0;
  const legacyTotal = estimateMoneyNumber(estimate && estimate.total);
  const legacySubtotal = estimateMoneyNumber(estimate && estimate.subtotal) || Math.max(0, legacyTotal - legacyTax);
  const totals = hasItemizedPricing ? computed : {
    subtotal: legacySubtotal,
    taxEnabled: estimate && estimate.taxEnabled === true,
    taxRate: Math.max(0, estimateMoneyNumber(estimate && estimate.taxRate)),
    tax: legacyTax,
    total: legacyTotal || legacySubtotal + legacyTax,
  };
  out.subtotal = totals.subtotal;
  out.taxEnabled = totals.taxEnabled;
  out.taxRate = totals.taxRate;
  out.taxAmount = totals.tax;
  out.tax = totals.tax;
  // Keep the existing portal total contract string-shaped while still deriving it server-side.
  out.total = formatEstimateMoney(totals.total);
  return out;
}

function stopMatches(stop, client, clients) {
  if (!stop) return false;
  const hasBoundId = stop.id != null || stop.clientId != null;
  if (hasBoundId) {
    return (stop.id != null && String(stop.id) === String(client.id)) ||
      (stop.clientId != null && String(stop.clientId) === String(client.id));
  }
  const name = lc(client && client.name);
  if (!name || lc(stop.client) !== name) return false;
  // Old stops may have only a client-name snapshot. Treat that as ownership only when the name
  // identifies exactly one client; duplicate names fail closed so a tracking token/address cannot
  // be exposed to both records.
  return Array.isArray(clients) && clients.filter((item) => lc(item && item.name) === name).length === 1;
}

function publicStop(stop, state = {}) {
  const out = pick(stop, ["id", "sid", "clientId", "client", "address", "type", "time", "assigneeId", "trackToken"]);
  const sid = stop && stop.sid;
  const rawArrivedAt = sid != null && state.arrivals ? state.arrivals[sid] : null;
  const arrivedAt = ["string", "number"].includes(typeof rawArrivedAt) ? rawArrivedAt : null;
  out.portalStage = sid != null && state.completed && state.completed[sid] ? "complete"
    : arrivedAt ? "arrived"
      : sid != null && state.enroute && state.enroute[sid] ? "enroute"
        : "scheduled";
  if (arrivedAt) out.arrivedAt = arrivedAt;
  return out;
}

function publicSchedule(value, client, clients, state) {
  if (!Array.isArray(value)) return [];
  return value.map((day) => ({
    ...pick(day, ["date", "label"]),
    stops: Array.isArray(day && day.stops)
      ? day.stops.filter((stop) => stopMatches(stop, client, clients)).map((stop) => publicStop(stop, state))
      : [],
  })).filter((day) => day.stops.length > 0);
}

function publicBranding(value) {
  const out = pick(value, [
    "companyName", "division", "logoType", "logoEmoji", "logoImage", "themeKey", "appearance",
    "appFont", "companyPhone", "companyEmail", "companyWebsite", "companyAddress",
    "googleReviewLink", "portalAppName", "portalTagline", "portalHeroImage", "portalDefaultPage",
  ]);
  if (value && value.custom && typeof value.custom === "object") {
    out.custom = pick(value.custom, ["fontFamily", "primary", "accent", "bg", "surface", "text"]);
  }
  return out;
}

function publicInvoicing(value) {
  return pick(value, [
    "taxRate", "dueDays", "terms", "accent", "showLogo", "showContact", "footer", "headerStyle",
    "accentStyle", "showQtyPrice", "showItemTax", "zebraRows", "density", "cornerStyle",
    "thankYou", "showThankYou", "showDueBanner", "labelInvoice",
  ]);
}

export default async function handler(req, res) {
  setPortalCors(res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const portal = await requirePortalClient(req, res);
  if (!portal) return;

  try {
    const state = await readAppStateKeys(KEYS);
    // Re-resolve from the same snapshot used for the response so a removed/reassigned client
    // cannot receive stale data between the initial auth lookup and this read.
    const clients = Array.isArray(state.sps_clients) ? state.sps_clients : [];
    const resolved = resolvePortalClient(clients, portal.user);
    if (["duplicate_binding", "duplicate_email", "duplicate_client_id"].includes(resolved.reason)) {
      return res.status(409).json({ error: "This sign-in matches more than one client record. Ask the office to link the correct portal account." });
    }
    const client = resolved.client;
    if (!client || !["string", "number"].includes(typeof client.id) || String(client.id).trim() === "") return res.status(200).json({ client: null });

    const invoices = (Array.isArray(state.sps_invoices) ? state.sps_invoices : [])
      .filter((invoice) => clientOwnsInvoice(invoice, client, clients) && lc(invoice.status) !== "draft")
      .map(publicInvoice);
    const estimates = (Array.isArray(state.sps_estimates) ? state.sps_estimates : [])
      .filter((estimate) => estimate && estimate.clientId != null && String(estimate.clientId) === String(client.id) && lc(estimate.status) !== "draft")
      .map(publicEstimate);
    const schedule = publicSchedule(state.sps_schedule, client, clients, {
      arrivals: state.sps_arrivals && typeof state.sps_arrivals === "object" ? state.sps_arrivals : {},
      completed: state.sps_completed && typeof state.sps_completed === "object" ? state.sps_completed : {},
      enroute: state.sps_enroute && typeof state.sps_enroute === "object" ? state.sps_enroute : {},
    });
    const assignedIds = new Set(schedule.flatMap((day) => day.stops.map((stop) => String(stop.assigneeId || "")).filter(Boolean)));
    const team = (Array.isArray(state.sps_team) ? state.sps_team : [])
      .filter((member) => member && assignedIds.has(String(member.id)))
      .map((member) => pick(member, ["id", "name"]));

    const payload = {
      client: publicClient(client),
      invoices,
      schedule,
      estimates,
      branding: publicBranding(state.sps_branding || {}),
      invoicing: publicInvoicing(state.sps_invoicing || {}),
      team,
    };
    try {
      return res.status(200).json({ ...(await signPortalMedia(payload)), mediaStatus: { ok: true, unavailable: 0 } });
    } catch (error) {
      // Keep the portal usable for text/scheduling if Storage is temporarily unavailable. Private
      // locators remain non-readable; they are never converted back to permanent public URLs.
      console.warn("portal media signing failed:", error && error.message ? error.message : error);
      return res.status(200).json({
        ...((error && error.partialValue) || payload),
        mediaStatus: { ok: false, unavailable: Math.max(1, Number(error && error.unavailableCount) || 1) },
      });
    }
  } catch (error) {
    console.error("portal-data failed:", error && error.message ? error.message : error);
    return res.status(502).json({ error: "Could not load the client portal." });
  }
}
