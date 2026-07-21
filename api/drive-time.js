// Staff-only driving ETA proxy. The native app is served from capacitor://localhost, where a
// website-restricted Maps JavaScript key cannot reliably receive an HTTPS referrer. Calculating
// here gives web and native one observable path and keeps a dedicated web-service key off devices.
//
// Optional Vercel env: GOOGLE_MAPS_SERVER_API_KEY (Directions API enabled; server-restricted).
// Never reuse VITE_GOOGLE_MAPS_API_KEY here: that key is public and website-restricted. Native iOS
// uses the MapKit bridge; HTTPS browsers retain the bounded Maps JavaScript fallback.

import { requireStaff } from "./_staff-auth.js";

const MAPS_KEY = String(
  process.env.GOOGLE_MAPS_SERVER_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  "",
).trim();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const rateWindows = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

const finiteCoordinate = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

const upstreamCode = (status) => {
  if (status === "ZERO_RESULTS" || status === "NOT_FOUND") return "route_not_found";
  if (status === "REQUEST_DENIED") return "route_provider_denied";
  if (status === "OVER_QUERY_LIMIT") return "route_provider_limit";
  return "route_provider_failed";
};

function consumeRateLimit(userId) {
  const key = String(userId || "");
  const now = Date.now();
  const previous = rateWindows.get(key);
  const entry = !previous || now - previous.startedAt >= RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : previous;
  entry.count += 1;
  rateWindows.set(key, entry);
  return entry.count <= RATE_LIMIT;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const staff = await requireStaff(req, res, "calculating drive time");
  if (!staff) return;
  if (!consumeRateLimit(staff.id)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ ok: false, code: "route_rate_limited", error: "Too many drive-time requests. Please wait a minute and retry." });
  }

  const origin = req.body && req.body.origin;
  const latitude = finiteCoordinate(origin && origin.lat, -90, 90);
  const longitude = finiteCoordinate(origin && origin.lng, -180, 180);
  const destination = String((req.body && req.body.destination) || "").trim();
  if (latitude == null || longitude == null) {
    return res.status(400).json({ ok: false, code: "invalid_origin", error: "A valid current location is required." });
  }
  if (!destination || destination.length > 400) {
    return res.status(400).json({ ok: false, code: "invalid_destination", error: "A valid stop address is required." });
  }
  if (!MAPS_KEY) {
    console.error("[drive-time] GOOGLE_MAPS_SERVER_API_KEY is missing");
    return res.status(501).json({ ok: false, code: "route_not_configured", error: "Drive-time routing is not configured.", missingEnv: true });
  }

  const query = new URLSearchParams({
    origin: `${latitude},${longitude}`,
    destination,
    mode: "driving",
    departure_time: "now",
    traffic_model: "best_guess",
    key: MAPS_KEY,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${query}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      // Preserve an AbortError from either fetch or response-body streaming so the caller receives
      // the correct timeout status instead of a generic provider failure.
      if ((error && error.name === "AbortError") || controller.signal.aborted) throw error;
      payload = {};
    }
    const status = String(payload && payload.status || "");
    if (!response.ok || status !== "OK") {
      const code = upstreamCode(status);
      // Do not log coordinates, destination, key, or Google's full response. Status is enough to
      // diagnose API enablement, restrictions, quota, and no-route failures in Vercel logs.
      console.warn("[drive-time] provider rejected route", { httpStatus: response.status, status: status || "HTTP_ERROR", code });
      return res.status(code === "route_not_found" ? 404 : 502).json({
        ok: false,
        code,
        error: code === "route_not_found" ? "No driving route was found for this address." : "The route provider could not calculate drive time.",
      });
    }

    const leg = payload.routes && payload.routes[0] && payload.routes[0].legs && payload.routes[0].legs[0];
    const seconds = Number((leg && leg.duration_in_traffic && leg.duration_in_traffic.value) || (leg && leg.duration && leg.duration.value));
    const distanceMeters = Number(leg && leg.distance && leg.distance.value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.warn("[drive-time] provider returned an empty route");
      return res.status(502).json({ ok: false, code: "route_provider_empty", error: "The route provider returned no drive time." });
    }

    return res.status(200).json({
      ok: true,
      minutes: Math.max(1, Math.round(seconds / 60)),
      distanceMiles: Number.isFinite(distanceMeters) && distanceMeters >= 0
        ? Math.round((distanceMeters / 1609.344) * 10) / 10
        : null,
      trafficAware: !!(leg && leg.duration_in_traffic && leg.duration_in_traffic.value),
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    console.error("[drive-time] provider request failed", timedOut ? "timeout" : "network_error");
    return res.status(504).json({
      ok: false,
      code: timedOut ? "route_timeout" : "route_provider_unavailable",
      error: timedOut ? "The route request timed out." : "The route provider is temporarily unavailable.",
    });
  } finally {
    clearTimeout(timeout);
  }
}
