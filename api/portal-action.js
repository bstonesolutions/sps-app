// Strict, ownership-checked client portal mutations. A bound auth UID (or one unique legacy email
// match) determines the client; request bodies cannot choose identity, status, alert id, or resolution.
import { randomUUID } from "node:crypto";
import { compareAndSetAppStateBatch, mutateAppState, NO_APP_STATE_CHANGE, readAppStateVersioned } from "./_app-state.js";
import { pushOwner } from "./_push.js";
import { resolveFrom } from "./_sender.js";
import {
  lc,
  portalServiceHeaders,
  readAppState,
  requirePortalClient,
  resolvePortalClient,
  setPortalCors,
  SUPABASE_URL,
} from "./_portal-auth.js";

const ACTIONS = new Set(["savePrefs", "approveEstimate", "rateVisit", "officeAlert"]);
const ALERT_TYPES = new Set(["request", "feedback", "upgrade_request"]);
const PREF_KEYS = new Set([
  "serviceReminders", "onMyWay", "invoiceReady", "reportSummary",
  "paymentNudges", "winBack", "broadcasts", "channels",
]);
const CHANNEL_KEYS = new Set(["text", "email", "app"]);

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value, allowed) => isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
const cleanText = (value, max) => String(value == null ? "" : value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
  .trim()
  .slice(0, max);
const cleanLine = (value, max) => cleanText(value, max).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function saveFailure(res) {
  return res.status(502).json({ ok: false, error: "Could not save that change. Please try again." });
}

class PortalMutationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function mutationClient(clients, user) {
  const list = Array.isArray(clients) ? clients : [];
  const resolved = resolvePortalClient(list, user);
  if (["duplicate_binding", "duplicate_email", "duplicate_client_id"].includes(resolved.reason)) {
    throw new PortalMutationError(409, "This sign-in matches more than one client record. Ask the office to link the correct portal account.");
  }
  if (!resolved.client) throw new PortalMutationError(403, "This account is not linked to a client portal.");
  return { list, client: resolved.client };
}

function validatePrefsPatch(value) {
  if (!hasOnlyKeys(value, PREF_KEYS) || Object.keys(value).length === 0) return null;
  const out = {};
  for (const key of PREF_KEYS) {
    if (key === "channels" || !Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] !== "boolean") return null;
    out[key] = value[key];
  }
  if (Object.prototype.hasOwnProperty.call(value, "channels")) {
    if (!hasOnlyKeys(value.channels, CHANNEL_KEYS) || Object.keys(value.channels).length === 0) return null;
    out.channels = {};
    for (const key of CHANNEL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value.channels, key)) continue;
      if (typeof value.channels[key] !== "boolean") return null;
      out.channels[key] = value.channels[key];
    }
  }
  return out;
}

function mergePrefsPatch(current, patch) {
  const base = isRecord(current) ? current : {};
  return {
    ...base,
    ...patch,
    ...(patch.channels ? { channels: { ...(isRecord(base.channels) ? base.channels : {}), ...patch.channels } } : {}),
  };
}

function currentClientPlan(client) {
  const division = client && (client.division || "Pond");
  if (client && client.plans && Object.prototype.hasOwnProperty.call(client.plans, division)) {
    return cleanLine(client.plans[division], 80);
  }
  return cleanLine(client && client.plan, 80);
}

function buildAlert(raw, client) {
  if (!isRecord(raw) || !ALERT_TYPES.has(raw.type)) return null;
  const allowed = new Set([
    "type", "title", "body", "message", "clientId", "clientName", "currentPlan",
    "requestedPlan", "submittedAt", "upgradeStep", "date",
  ]);
  if (!hasOnlyKeys(raw, allowed)) return null;
  if (raw.body != null && typeof raw.body !== "string") return null;
  if (raw.message != null && typeof raw.message !== "string") return null;

  const body = cleanText(raw.body || raw.message, 2000);
  if (!body) return null;
  const now = Date.now();
  const base = {
    id: `portal-${now}-${randomUUID()}`,
    resolved: false,
    type: raw.type,
    clientId: client.id,
    clientName: cleanLine(client.name, 120),
    submittedAt: now,
    date: new Date(now).toLocaleDateString("en-US"),
    body,
  };

  if (raw.type === "request") {
    return { ...base, title: `Service Request: ${base.clientName || "Client"}` };
  }
  if (raw.type === "feedback") {
    return { ...base, title: `Service Feedback: ${base.clientName || "Client"}` };
  }

  if (typeof raw.requestedPlan !== "string") return null;
  const requestedPlan = cleanLine(raw.requestedPlan, 80);
  if (!requestedPlan) return null;
  return {
    ...base,
    title: `Upgrade Request: ${base.clientName || "Client"}`,
    currentPlan: currentClientPlan(client),
    requestedPlan,
    upgradeStep: 0,
  };
}

const asArray = (value) => Array.isArray(value) ? value : [];

function ratingReference(payload) {
  const candidates = [
    ["completionReceiptId", "completionReceiptId"],
    ["sid", "sid"],
    ["visitId", "id"],
  ].filter(([payloadField]) => Object.prototype.hasOwnProperty.call(payload, payloadField));
  if (candidates.length > 1) throw new PortalMutationError(400, "Choose one service visit identifier.");
  if (candidates.length === 1) {
    const [field, historyField] = candidates[0];
    const rawValue = payload[field];
    if (!["string", "number"].includes(typeof rawValue)) throw new PortalMutationError(400, "Invalid service visit identifier.");
    const value = cleanText(rawValue, 200);
    if (!value) throw new PortalMutationError(400, "Invalid service visit identifier.");
    return { field, historyField, value, legacy: false };
  }
  const value = cleanText(payload.visitDate, 40);
  if (!value) throw new PortalMutationError(400, "Choose a valid service visit.");
  return { field: "visitDate", historyField: "date", value, legacy: true };
}

function findVisit(history, reference) {
  const matches = [];
  asArray(history).forEach((visit, index) => {
    const rawValue = visit && visit[reference.historyField];
    if (["string", "number"].includes(typeof rawValue) && String(rawValue).trim() === reference.value) matches.push(index);
  });
  if (!matches.length) throw new PortalMutationError(404, "Visit not found.");
  if (matches.length > 1) {
    throw new PortalMutationError(
      409,
      reference.legacy
        ? "More than one visit occurred on that date. Refresh the portal and try again."
        : "That service visit identifier is not unique. Ask the office to correct the visit history."
    );
  }
  return matches[0];
}

const publicVisitReference = (reference) => ({ field: reference.field, value: reference.value });
const ratingAlertKey = (clientId, reference) => JSON.stringify([String(clientId), reference.field, reference.value]);

function applyRatingToClientList(list, client, reference, rating, feedback, ratedAt) {
  const clientIndex = list.findIndex((item) => String(item && item.id) === String(client.id));
  if (clientIndex < 0) throw new PortalMutationError(404, "Client not found.");
  const history = asArray(list[clientIndex].history).slice();
  const visitIndex = findVisit(history, reference);
  const existing = history[visitIndex];
  if (existing && existing.clientRating) {
    const existingRating = Number(existing.clientRating);
    const existingFeedback = cleanText(existing.clientFeedback, 2000);
    if (existingRating !== rating || existingFeedback !== feedback) {
      throw new PortalMutationError(409, "That visit has already been rated.");
    }
    return { changed: false, list, visit: existing, clientIndex, visitIndex };
  }
  const visit = {
    ...existing,
    clientRating: rating,
    clientFeedback: feedback,
    ratedAt,
  };
  history[visitIndex] = visit;
  const next = list.slice();
  next[clientIndex] = { ...next[clientIndex], history };
  return { changed: true, list: next, visit, clientIndex, visitIndex };
}

function attachRatingAlertReceipt(rated, alertId) {
  if (!alertId || rated.visit.portalRatingAlertId === alertId) return rated;
  const list = rated.list.slice();
  const client = { ...list[rated.clientIndex] };
  const history = asArray(client.history).slice();
  const visit = { ...history[rated.visitIndex], portalRatingAlertId: alertId };
  history[rated.visitIndex] = visit;
  list[rated.clientIndex] = { ...client, history };
  return { ...rated, changed: true, list, visit };
}

async function commitLowRating({ user, reference, rating, feedback, ratedAt }) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const [clientsState, alertsState] = await Promise.all([
      readAppStateVersioned("sps_clients"),
      readAppStateVersioned("sps_officeAlerts"),
    ]);
    const { list, client } = mutationClient(clientsState.exists ? clientsState.value : [], user);
    const rated = applyRatingToClientList(list, client, reference, rating, feedback, ratedAt);
    const key = ratingAlertKey(client.id, reference);
    const alerts = asArray(alertsState.exists ? alertsState.value : []);
    const existingAlert = alerts.find((item) =>
      item && item.type === "feedback" && String(item.clientId) === String(client.id) && item.portalRatingKey === key
    ) || null;

    if (!rated.changed && existingAlert) {
      return { visit: rated.visit, alert: existingAlert, alertCreated: false, deduped: true };
    }
    if (!rated.changed && rated.visit.portalRatingAlertId) {
      return { visit: rated.visit, alert: { id: rated.visit.portalRatingAlertId }, alertCreated: false, deduped: true };
    }
    const proposedAlert = existingAlert ? null : {
      ...buildAlert({ type: "feedback", body: `${rating}★${feedback ? ` — ${feedback}` : ""}` }, client),
      portalRatingKey: key,
    };
    const alert = existingAlert || proposedAlert;
    const ratedWithReceipt = attachRatingAlertReceipt(rated, alert.id);
    const nextAlerts = existingAlert ? alerts : [alert, ...alerts];
    const result = await compareAndSetAppStateBatch([
      {
        key: "sps_clients",
        expectedVersion: clientsState.exists ? clientsState.version : 0,
        value: ratedWithReceipt.list,
      },
      {
        key: "sps_officeAlerts",
        expectedVersion: alertsState.exists ? alertsState.version : 0,
        value: nextAlerts,
      },
    ]);
    if (result.applied) {
      return { visit: ratedWithReceipt.visit, alert, alertCreated: !existingAlert, deduped: !rated.changed && !!existingAlert };
    }
    if (result.outcome !== "conflict") throw new Error(`portal_rating_batch_failed:${result.outcome || "unknown"}`);
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 12 * attempt + Math.floor(Math.random() * 18)));
  }
  throw new Error("portal_rating_contention");
}

async function sendOwnerAlertEmail(eventKey, alert) {
  try {
    const [emailValue, brandingValue] = await Promise.all([
      readAppState("sps_email"),
      readAppState("sps_branding"),
    ]);
    const email = isRecord(emailValue) ? emailValue : {};
    const branding = isRecord(brandingValue) ? brandingValue : {};
    const notify = isRecord(email.notify) ? email.notify : {};
    const events = isRecord(notify.events) ? notify.events : {};
    const event = isRecord(events[eventKey]) ? events[eventKey] : null;
    if (!event || event.email !== true) return { skipped: "owner email disabled" };

    const configuredRecipient = [notify.ownerEmail, email.ownerEmail, branding.companyEmail]
      .map((value) => String(value || "").trim())
      .find(validEmail);
    if (!configuredRecipient) return { skipped: "no owner email" };
    if (!process.env.RESEND_API_KEY) return { skipped: "resend not configured" };

    let recipient = configuredRecipient;
    let subjectPrefix = "";
    const testMode = isRecord(email.testMode) ? email.testMode : {};
    if (testMode.on) {
      if (testMode.mode === "hold") return { skipped: "test mode hold" };
      const redirect = [testMode.email, notify.ownerEmail, email.ownerEmail, branding.companyEmail]
        .map((value) => String(value || "").trim())
        .find(validEmail);
      if (!redirect) return { skipped: "test mode has no redirect email" };
      recipient = redirect;
      subjectPrefix = `[TEST → ${configuredRecipient}] `;
    }

    const clientName = alert.clientName || "Client";
    const eventContent = eventKey === "service_request"
      ? {
          subject: `Service request: ${clientName}`,
          heading: `${clientName} requested service`,
          rows: [["Client", clientName]],
        }
      : eventKey === "low_rating"
        ? {
            subject: `Low rating: ${clientName}`,
            heading: `${clientName} left service feedback`,
            rows: [["Client", clientName]],
          }
        : {
            subject: `Upgrade request: ${clientName} → ${alert.requestedPlan || "new plan"}`,
            heading: `${clientName} wants to upgrade`,
            rows: [
              ["Client", clientName],
              ["Current plan", alert.currentPlan || "None"],
              ["Requested plan", alert.requestedPlan || "—"],
            ],
          };

    const company = cleanLine(branding.companyName, 120) || "Stone Property Solutions";
    const rawAccent = String(branding.accentColor || (branding.custom && branding.custom.primary) || "");
    const accent = /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent : "#B81D24";
    const rowsHtml = eventContent.rows.map(([label, value]) => `<tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:6px 0 6px 14px;color:#111827;font-size:13px;font-weight:700;vertical-align:top">${escapeHtml(value)}</td>
    </tr>`).join("");
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;color:#111827">
      <div style="background:${accent};border-radius:14px 14px 0 0;padding:18px 20px;color:#fff;font-size:17px;font-weight:800">${escapeHtml(company)}</div>
      <div style="border:1px solid #eef0f2;border-top:none;border-radius:0 0 14px 14px;padding:20px">
        <div style="font-size:16px;font-weight:800;margin-bottom:10px">${escapeHtml(eventContent.heading)}</div>
        <div style="font-size:14px;color:#374151;line-height:1.55;white-space:pre-wrap">${escapeHtml(alert.body)}</div>
        <table style="width:100%;border-collapse:collapse;margin-top:14px;border-top:1px solid #eef0f2">${rowsHtml}</table>
        <div style="margin-top:18px"><a href="spsway://alerts" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;font-size:14px">Open in the SPS app</a></div>
      </div>
    </div>`;
    const text = [eventContent.heading, "", alert.body, "", ...eventContent.rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
    const from = resolveFrom(
      { fromName: cleanLine(email.fromName, 100), fromAddress: email.fromAddress },
      process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>"
    );
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: subjectPrefix + eventContent.subject,
        html,
        text,
      }),
    });
    if (!r.ok) {
      const response = await r.json().catch(() => ({}));
      console.warn("portal owner email failed:", response && (response.message || response.error) || r.status);
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.warn("portal owner email failed:", error && error.message ? error.message : error);
    return { ok: false };
  }
}

async function insertAlertEcho(alert) {
  if (!alert || !["request", "upgrade_request"].includes(alert.type)) return;
  const body = alert.type === "upgrade_request"
    ? `I'd like to upgrade to ${alert.requestedPlan}${alert.currentPlan ? ` (from ${alert.currentPlan})` : ""}.${alert.body ? ` ${alert.body}` : ""} [[echo]]`
    : `${alert.body} [[echo]]`;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sps_messages`, {
      method: "POST",
      headers: portalServiceHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({
        client_id: String(alert.clientId),
        sender: "client",
        sender_name: alert.clientName || "Client",
        body: body.slice(0, 4000),
      }),
    });
    if (!r.ok) console.warn("portal alert echo failed:", r.status);
  } catch (error) {
    console.warn("portal alert echo failed:", error && error.message ? error.message : error);
  }
}

export default async function handler(req, res) {
  setPortalCors(res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const portal = await requirePortalClient(req, res);
  if (!portal) return;
  const body = isRecord(req.body) ? req.body : {};
  if (!Object.keys(body).every((key) => key === "action" || key === "payload")) {
    return res.status(400).json({ error: "Invalid portal action." });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const payload = isRecord(body.payload) ? body.payload : {};
  if (!ACTIONS.has(action)) return res.status(400).json({ error: "Unknown portal action." });

  try {
    if (action === "savePrefs") {
      if (!hasOnlyKeys(payload, new Set(["notifyPrefsPatch"]))) {
        return res.status(400).json({ error: "Invalid preference update." });
      }
      const notifyPrefsPatch = validatePrefsPatch(payload.notifyPrefsPatch);
      if (!notifyPrefsPatch) return res.status(400).json({ error: "Invalid preference update." });
      let savedPrefs = null;
      try {
        await mutateAppState("sps_clients", (current) => {
          const { list, client } = mutationClient(current, portal.user);
          savedPrefs = mergePrefsPatch(client.notifyPrefs, notifyPrefsPatch);
          if (JSON.stringify(client.notifyPrefs || {}) === JSON.stringify(savedPrefs)) return NO_APP_STATE_CHANGE;
          return list.map((item) =>
            String(item && item.id) === String(client.id) ? { ...item, notifyPrefs: savedPrefs } : item
          );
        });
      } catch (error) {
        if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
        return saveFailure(res);
      }
      return res.status(200).json({ ok: true, notifyPrefs: savedPrefs || {} });
    }

    if (action === "approveEstimate") {
      if (!hasOnlyKeys(payload, new Set(["id", "status"])) || payload.id == null) {
        return res.status(400).json({ error: "Invalid estimate approval." });
      }
      if (Object.prototype.hasOwnProperty.call(payload, "status") && payload.status != null && lc(payload.status) !== "approved") {
        return res.status(400).json({ error: "Clients may only approve estimates." });
      }
      const id = cleanText(payload.id, 120);
      if (!id) return res.status(400).json({ error: "Invalid estimate approval." });
      const approvedAt = new Date().toISOString();
      try {
        await mutateAppState("sps_estimates", async (current) => {
          // Re-resolve the authenticated portal identity on every CAS attempt. Request data never
          // chooses the client id, even if the roster changes during a retry.
          const { client } = mutationClient(await readAppState("sps_clients"), portal.user);
          const estimates = Array.isArray(current) ? current : [];
          const matches = estimates.map((estimate, index) =>
            String(estimate && estimate.id) === id && String(estimate && estimate.clientId) === String(client.id)
              ? index
              : -1
          ).filter((index) => index >= 0);
          if (!matches.length) throw new PortalMutationError(404, "Estimate not found.");
          if (matches.length > 1) {
            throw new PortalMutationError(409, "That estimate identifier is not unique. Ask the office to correct the estimates.");
          }
          const index = matches[0];
          const currentStatus = lc(estimates[index].status);
          if (currentStatus === "approved") return NO_APP_STATE_CHANGE;
          if (currentStatus !== "sent") throw new PortalMutationError(409, "Only a sent estimate can be approved.");
          const next = estimates.slice();
          next[index] = { ...next[index], status: "approved", approvedAt };
          return next;
        });
      } catch (error) {
        if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
        return saveFailure(res);
      }
      return res.status(200).json({ ok: true, id, status: "approved" });
    }

    if (action === "rateVisit") {
      if (!hasOnlyKeys(payload, new Set(["completionReceiptId", "sid", "visitId", "visitDate", "rating", "feedback"]))) {
        return res.status(400).json({ error: "Invalid visit rating." });
      }
      const rating = Number(payload.rating);
      if (payload.feedback != null && typeof payload.feedback !== "string") {
        return res.status(400).json({ error: "Invalid visit rating." });
      }
      const feedback = cleanText(payload.feedback, 2000);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Choose a valid visit and a rating from 1 to 5." });
      }
      let reference;
      try { reference = ratingReference(payload); }
      catch (error) {
        if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
        return res.status(400).json({ error: "Invalid visit rating." });
      }
      const ratedAt = Date.now();
      let savedVisit = null;
      let alert = null;
      try {
        if (rating <= 3) {
          const committed = await commitLowRating({ user: portal.user, reference, rating, feedback, ratedAt });
          savedVisit = committed.visit;
          alert = committed.alert;
          if (committed.alertCreated) {
            await Promise.allSettled([
              pushOwner("low_rating", alert.title, alert.body.slice(0, 200), "alerts"),
              sendOwnerAlertEmail("low_rating", alert),
            ]);
          }
        } else {
          await mutateAppState("sps_clients", (current) => {
            const { list, client } = mutationClient(current, portal.user);
            const rated = applyRatingToClientList(list, client, reference, rating, feedback, ratedAt);
            savedVisit = rated.visit;
            return rated.changed ? rated.list : NO_APP_STATE_CHANGE;
          });
        }
      } catch (error) {
        if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
        return saveFailure(res);
      }
      return res.status(200).json({
        ok: true,
        visitRef: publicVisitReference(reference),
        visitDate: cleanText(savedVisit && savedVisit.date, 40),
        rating: Number(savedVisit && savedVisit.clientRating) || rating,
        feedback: cleanText(savedVisit && savedVisit.clientFeedback, 2000),
        ratedAt: Number(savedVisit && savedVisit.ratedAt) || ratedAt,
        ...(alert ? { alert: { id: alert.id } } : {}),
      });
    }

    if (action === "officeAlert") {
      if (!hasOnlyKeys(payload, new Set(["alert"]))) {
        return res.status(400).json({ error: "Invalid alert." });
      }
      const alert = buildAlert(payload.alert, portal.client);
      if (!alert) return res.status(400).json({ error: "Invalid alert." });
      let duplicate = null;
      try {
        await mutateAppState("sps_officeAlerts", async (current) => {
          const { client } = mutationClient(await readAppState("sps_clients"), portal.user);
          if (String(client.id) !== String(alert.clientId)) {
            throw new PortalMutationError(409, "Your portal link changed while saving. Please try again.");
          }
          const alerts = Array.isArray(current) ? current : [];
          duplicate = alerts.find((item) =>
            String(item && item.clientId) === String(client.id) &&
            item && item.type === alert.type && item.body === alert.body &&
            Number(item.submittedAt) > Date.now() - 60 * 1000
          ) || null;
          if (duplicate) return NO_APP_STATE_CHANGE;
          const recent = alerts.filter((item) =>
            String(item && item.clientId) === String(client.id) &&
            Number(item && item.submittedAt) > Date.now() - 10 * 60 * 1000
          ).length;
          if (recent >= 5) throw new PortalMutationError(429, "Too many recent requests. Please wait a few minutes.");
          return [alert, ...alerts];
        });
      } catch (error) {
        if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
        return saveFailure(res);
      }
      if (duplicate) return res.status(200).json({ ok: true, alert: { id: duplicate.id }, deduped: true });

      const pushKey = alert.type === "request" ? "service_request"
        : alert.type === "feedback" ? "low_rating"
          : "upgrade_request";
      await Promise.allSettled([
        pushOwner(pushKey, alert.title, alert.body.slice(0, 200), "alerts"),
        sendOwnerAlertEmail(pushKey, alert),
        insertAlertEcho(alert),
      ]);
      return res.status(200).json({ ok: true, alert: { id: alert.id } });
    }
  } catch (error) {
    if (error instanceof PortalMutationError) return res.status(error.status).json({ error: error.message });
    console.error("portal-action failed:", error && error.message ? error.message : error);
    return res.status(502).json({ ok: false, error: "Could not save that change. Please try again." });
  }
}
