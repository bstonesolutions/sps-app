import { requireOwner } from "./_staff-auth.js";
import {
  normalizePracticalGardenPondsProduct,
  practicalGardenPondsPreviewSource,
} from "../inventorySourcePreview.js";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const rateWindows = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

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

class SourceResponseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceResponseError";
    this.code = code;
  }
}

async function readBoundedText(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new SourceResponseError("source_too_large", "The supplier response was too large to preview safely.");
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        throw new SourceResponseError("source_too_large", "The supplier response was too large to preview safely.");
      }
      chunks.push(chunk);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new SourceResponseError("source_too_large", "The supplier response was too large to preview safely.");
  }
  return new TextDecoder().decode(body);
}

const errorResponse = (res, status, code, error) => res.status(status).json({ ok: false, code, error });

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return errorResponse(res, 405, "method_not_allowed", "Method not allowed");

  const owner = await requireOwner(req, res, "previewing supplier product details");
  if (!owner) return;
  if (!consumeRateLimit(owner.id)) {
    res.setHeader("Retry-After", "60");
    return errorResponse(res, 429, "source_rate_limited", "Too many supplier previews. Please wait a minute and retry.");
  }

  const source = practicalGardenPondsPreviewSource(req.body && req.body.url);
  if (!source.valid) return errorResponse(res, 400, source.code, source.error);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return errorResponse(res, 502, "source_redirected", "The supplier redirected this product request, so it was not followed.");
    }
    if (!response.ok) {
      const notFound = response.status === 404;
      return errorResponse(
        res,
        notFound ? 404 : 502,
        notFound ? "source_not_found" : "source_unavailable",
        notFound ? "That supplier product could not be found." : "The supplier product page is temporarily unavailable.",
      );
    }

    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (!(contentType.includes("application/json") || contentType.includes("+json"))) {
      return errorResponse(res, 502, "source_invalid_type", "The supplier returned an unexpected response format.");
    }

    const raw = await readBoundedText(response);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return errorResponse(res, 502, "source_invalid_json", "The supplier returned product data that could not be read.");
    }
    const product = normalizePracticalGardenPondsProduct(payload, source);
    if (!product) {
      return errorResponse(res, 502, "source_invalid_product", "The supplier response did not contain a complete product and variant list.");
    }
    return res.status(200).json({ ok: true, product });
  } catch (error) {
    if (error instanceof SourceResponseError) {
      return errorResponse(res, 502, error.code, error.message);
    }
    const timedOut = error?.name === "AbortError" || controller.signal.aborted;
    console.error("[inventory-source-preview] supplier request failed", timedOut ? "timeout" : "network_error");
    return errorResponse(
      res,
      timedOut ? 504 : 502,
      timedOut ? "source_timeout" : "source_unavailable",
      timedOut ? "The supplier preview timed out." : "The supplier product page is temporarily unavailable.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
