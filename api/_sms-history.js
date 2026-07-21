import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

export const SMS_MEDIA_BUCKET = "sms-media";

const E164 = /^\+[1-9]\d{7,14}$/;
const MODERN_SMS_FIELDS = new Set([
  "sms_direction",
  "sms_line",
  "sms_peer_phone",
  "quo_message_id",
  "quo_conversation_id",
  "quo_phone_number_id",
  "sms_status",
  "sms_media",
  "quo_contact_id",
  "sms_contact_name",
  "sms_contact_avatar_path",
  "sms_provider_created_at",
]);

export function toSmsE164(value) {
  const raw = String(value == null ? "" : value).trim();
  if (raw.startsWith("+")) return `+${raw.slice(1).replace(/\D/g, "")}`;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

export function isSmsE164(value) {
  return E164.test(toSmsE164(value));
}

export function cleanSmsValue(value, max = 200) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, Math.max(0, Number(max) || 0))
    .trim();
}

// Test Mode redirects automation texts to a server-owned test destination with this exact prefix.
// If that destination is also a Quo line, Quo emits a second inbound event. Treating the echo as a
// customer message creates the many fake one-message rows reported by staff.
export function parseTestRedirect(content) {
  const raw = String(content == null ? "" : content);
  const match = /^\[TEST\s*→\s*([^\]]+)\]\s*/i.exec(raw);
  if (!match) return null;
  const intendedPeer = toSmsE164(match[1]);
  if (!E164.test(intendedPeer)) return null;
  return {
    intendedPeer,
    content: raw.slice(match[0].length).trim(),
    prefix: match[0],
  };
}

export function smsLineForNumber(value, { automation, main } = {}) {
  const phone = toSmsE164(value);
  const automationPhone = toSmsE164(automation);
  const mainPhone = toSmsE164(main);
  if (phone && phone === automationPhone) return "automation";
  if (phone && phone === mainPhone && mainPhone !== automationPhone) return "main";
  return "";
}

export function legacySmsInboxRow(row) {
  const legacy = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!MODERN_SMS_FIELDS.has(key)) legacy[key] = value;
  }
  return legacy;
}

export function smsHistorySchemaMissing(text) {
  const value = String(text || "");
  const names = /(sms_direction|sms_line|sms_peer_phone|quo_message_id|quo_conversation_id|quo_phone_number_id|sms_status|sms_media|quo_contact_id|sms_contact_name|sms_contact_avatar_path|sms_provider_created_at)/i;
  return (/PGRST204|42703/i.test(value) && names.test(value))
    || (names.test(value) && /does not exist|schema cache|could not find/i.test(value));
}

export function quoContactMetadata(contact) {
  const object = contact && typeof contact === "object" ? contact : {};
  const defaults = object.defaultFields && typeof object.defaultFields === "object" ? object.defaultFields : {};
  const fields = Array.isArray(object.fields) ? object.fields : [];
  const defaultPhones = Array.isArray(defaults.phoneNumbers) ? defaults.phoneNumbers : [];
  const phones = [...new Set([...fields
    .filter((field) => String(field?.type || "").toLowerCase() === "phone-number")
    .map((field) => field?.value), ...defaultPhones.map((phone) => phone?.value ?? phone)]
    .map(toSmsE164)
    .filter((phone) => E164.test(phone)))];
  const first = cleanSmsValue(object.firstName ?? defaults.firstName, 100);
  const last = cleanSmsValue(object.lastName ?? defaults.lastName, 100);
  const company = cleanSmsValue(object.company ?? defaults.company, 140);
  return {
    id: cleanSmsValue(object.id, 100),
    name: cleanSmsValue([first, last].filter(Boolean).join(" ") || company, 180),
    phones,
    pictureUrl: safeHttpsUrl(object.pictureUrl),
  };
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIp(address) {
  const value = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  const version = net.isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version !== 6) return true;
  if (value.startsWith("::ffff:")) return isPrivateIpv4(value.slice(7));
  return value === "::"
    || value === "::1"
    || value.startsWith("fc")
    || value.startsWith("fd")
    || /^fe[89ab]/.test(value)
    || value.startsWith("ff")
    || value.startsWith("2001:db8:");
}

async function defaultResolveHost(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function resolveWithin(resolveHost, hostname, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("media_dns_timeout")), Math.max(100, Math.min(1000, Number(timeoutMs) || 800)));
    Promise.resolve(resolveHost(hostname)).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function validatedRemoteUrl(value, resolveHost, timeoutMs) {
  const raw = safeHttpsUrl(value);
  if (!raw) throw new Error("media_url_invalid");
  const parsed = new URL(raw);
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) throw new Error("media_url_invalid");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")) {
    throw new Error("media_url_private");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("media_url_private");
    return parsed;
  }
  const answers = await resolveWithin(resolveHost, hostname, timeoutMs);
  if (!Array.isArray(answers) || !answers.length || answers.some((answer) => isPrivateIp(answer?.address || answer))) {
    throw new Error("media_url_private");
  }
  return parsed;
}

async function fetchValidatedRemote(fetchImpl, initialUrl, { timeoutMs, resolveHost, maxRedirects = 2 } = {}) {
  let next = initialUrl;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const parsed = await validatedRemoteUrl(next, resolveHost, timeoutMs);
    const response = await withTimeout(fetchImpl, parsed.toString(), { redirect: "manual" }, timeoutMs);
    if (![301, 302, 303, 307, 308].includes(Number(response.status))) return response;
    clearBodyTimeout(response);
    if (redirect >= maxRedirects) throw new Error("media_redirect_limit");
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("media_redirect_invalid");
    next = new URL(location, parsed).toString();
  }
  throw new Error("media_redirect_limit");
}

function mediaExtension(mime) {
  const known = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
  };
  return known[String(mime || "").toLowerCase()] || "bin";
}

function acceptedMediaType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return type;
  if (type === "application/pdf") return type;
  return "";
}

async function readBoundedBody(response, maxBytes) {
  try {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("media_too_large");
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("media_too_large");
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    }
    const value = Buffer.from(await response.arrayBuffer());
    if (value.byteLength > maxBytes) throw new Error("media_too_large");
    return value;
  } finally {
    clearBodyTimeout(response);
  }
}

const bodyTimeoutCleanups = new WeakMap();

function clearBodyTimeout(response) {
  const cleanup = bodyTimeoutCleanups.get(response);
  if (cleanup) {
    bodyTimeoutCleanups.delete(response);
    cleanup();
  }
}

function withTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 100));
  const cleanup = () => clearTimeout(timer);
  return Promise.resolve(fetchImpl(url, { ...(options || {}), signal: controller.signal }))
    .then((response) => {
      // Keep the deadline active while the response body streams. A provider can return headers
      // promptly and then stall forever; readBoundedBody clears this only after consuming/cancelling.
      bodyTimeoutCleanups.set(response, cleanup);
      return response;
    }, (error) => {
      cleanup();
      throw error;
    });
}

function storageObjectUrl(supabaseUrl, bucket, path) {
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  return `${String(supabaseUrl || "").replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
}

// Provider-hosted URLs are read only in memory. The returned metadata contains private Supabase
// object paths and never contains the original URL.
export async function copyQuoMediaToPrivateStorage({
  media,
  messageId,
  supabaseUrl,
  serviceKey,
  fetchImpl = fetch,
  timeoutMs = 1800,
  maxItems = 4,
  maxBytes = 12 * 1024 * 1024,
  folder = "messages",
  resolveHost = defaultResolveHost,
} = {}) {
  if (!supabaseUrl || !serviceKey) return [];
  const items = (Array.isArray(media) ? media : [])
    .slice(0, Math.max(0, Number(maxItems) || 0))
    .map((entry) => typeof entry === "string" ? { url: entry } : entry)
    .filter((entry) => entry && safeHttpsUrl(entry.url));
  if (!items.length) return [];
  const safeMessageId = cleanSmsValue(messageId, 120).replace(/[^a-zA-Z0-9_-]+/g, "_") || crypto.randomUUID();
  const results = [];
  let remainingBytes = Math.max(1, Number(maxBytes) || 1);

  // Sequential copying deliberately caps peak memory and total payload. Four 12 MB attachments
  // must not become a 48 MB Vercel allocation or four simultaneous Supabase writes.
  for (let index = 0; index < items.length && remainingBytes > 0; index += 1) {
    const entry = items[index];
    try {
      const providerUrl = safeHttpsUrl(entry.url);
      const download = await fetchValidatedRemote(fetchImpl, providerUrl, { timeoutMs, resolveHost, maxRedirects: 2 });
      if (!download.ok) continue;
      const mimeType = acceptedMediaType(download.headers?.get?.("content-type") || entry.type);
      if (!mimeType) continue;
      const bytes = await readBoundedBody(download, remainingBytes);
      remainingBytes -= bytes.byteLength;
      const fingerprint = crypto.createHash("sha256").update(providerUrl).digest("hex").slice(0, 16);
      const path = `${folder}/${safeMessageId}/${index + 1}-${fingerprint}.${mediaExtension(mimeType)}`;
      const upload = await withTimeout(fetchImpl, storageObjectUrl(supabaseUrl, SMS_MEDIA_BUCKET, path), {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": mimeType,
          "x-upsert": "false",
        },
        body: bytes,
      }, timeoutMs);
      if (!upload.ok && upload.status !== 409) continue;
      results.push({ bucket: SMS_MEDIA_BUCKET, path, mimeType, size: bytes.byteLength });
    } catch {
      // Quo delivery must not fail because an attachment host is unavailable. The inbox row keeps
      // an honest attachment-count note and no provider URL is logged or persisted.
    }
  }
  return results;
}

export async function signPrivateSmsMedia(media, {
  supabaseUrl,
  serviceKey,
  fetchImpl = fetch,
  expiresIn = 300,
} = {}) {
  if (!supabaseUrl || !serviceKey || !Array.isArray(media) || !media.length) return [];
  const safeExpiry = Math.max(60, Math.min(600, Number(expiresIn) || 300));
  const signed = await Promise.all(media.map(async (item) => {
    const bucket = item?.bucket === SMS_MEDIA_BUCKET ? SMS_MEDIA_BUCKET : "";
    const path = cleanSmsValue(item?.path, 500);
    if (!bucket || !path || path.includes("..")) return null;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    try {
      const response = await fetchImpl(
        `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
        {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: safeExpiry }),
        },
      );
      if (!response.ok) return null;
      const body = await response.json().catch(() => ({}));
      const signedPath = String(body.signedURL || body.signedUrl || "");
      if (!signedPath) return null;
      const url = signedPath.startsWith("http")
        ? signedPath
        : `${String(supabaseUrl).replace(/\/+$/, "")}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
      return { ...item, url, expiresIn: safeExpiry };
    } catch {
      return null;
    }
  }));
  return signed.filter(Boolean);
}
