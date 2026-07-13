export const CLIENT_MEDIA_BUCKET = "client-media";

export const BACKUP_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

const safeDecode = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

export function storageSafeName(name) {
  return String(name || "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(-100) || "file";
}

export function buildStorageObjectPath({ kind = "media", clientId = "shared", name = "", mime = "application/octet-stream", now = Date.now(), nonce = Math.random().toString(36).slice(2, 12) } = {}) {
  const fallbackExt = (String(mime).split("/")[1] || "bin").replace("jpeg", "jpg").replace(/\+xml$/, "");
  const suppliedName = storageSafeName(name || `upload.${fallbackExt}`);
  const filename = /\.[a-z0-9]{1,8}$/i.test(suppliedName) ? suppliedName : `${suppliedName}.${fallbackExt}`;
  return `media/${storageSafeName(kind)}/${storageSafeName(clientId)}/${now}-${storageSafeName(nonce)}-${filename}`;
}

export function makeStorageRef(bucket, path) {
  const safeBucket = encodeURIComponent(String(bucket || CLIENT_MEDIA_BUCKET));
  const safePath = String(path || "").split("/").map(encodeURIComponent).join("/");
  return `sps-storage://${safeBucket}/${safePath}`;
}

// Accepts the durable reference used by the app and every Supabase Storage URL form
// that older records may contain (public, signed, and authenticated object URLs).
export function parseStorageLocator(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("sps-storage://")) {
    try {
      const u = new URL(value);
      const bucket = safeDecode(u.hostname);
      const path = u.pathname.replace(/^\/+/, "").split("/").map(safeDecode).join("/");
      return bucket && path ? { bucket, path, ref: makeStorageRef(bucket, path) } : null;
    } catch { return null; }
  }
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const u = new URL(value);
    const match = u.pathname.match(/\/storage\/v1\/(?:render\/image\/)?object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    const bucket = safeDecode(match[1]);
    const path = match[2].split("/").map(safeDecode).join("/");
    return bucket && path ? { bucket, path, ref: makeStorageRef(bucket, path) } : null;
  } catch { return null; }
}

export function parseDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const match = value.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  if (!match) return null;
  const mime = String(match[1] || "application/octet-stream").toLowerCase();
  const b64 = match[2];
  const compact = b64.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return { mime, b64, size: Math.max(0, Math.floor(compact.length * 3 / 4) - padding) };
}

function extensionFor(mime, locator) {
  const known = BACKUP_MIME_EXT[String(mime || "").toLowerCase()];
  if (known) return known;
  const tail = locator?.path?.split("/").pop() || "";
  const ext = tail.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return ext ? ext.toLowerCase() : "bin";
}

function safeExternalSource(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch { return "external media"; }
}

function pathCanContainExternalMedia(path) {
  const directFields = new Set(["logoImage", "portalHeroImage", "poster"]);
  const collections = new Set(["sitePhotos", "siteVideos", "photos", "documents", "attachments", "signedDoc"]);
  const pointerFields = new Set(["src", "url", "poster"]);
  const last = path[path.length - 1];
  if (typeof last === "string" && directFields.has(last)) return true;

  // A URL elsewhere inside a media record can still be ordinary text (for example a
  // document note or a photo caption). Only the media value itself, or its src/url/poster
  // field, is an archive candidate. This prevents a successful backup/restore from turning
  // an informational link into a Storage object reference.
  let collectionIndex = -1;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (typeof path[index] === "string" && collections.has(path[index])) {
      collectionIndex = index;
      break;
    }
  }
  if (collectionIndex < 0) return false;
  const tail = path.slice(collectionIndex + 1);
  if (tail.length === 0) return true; // e.g. signedDoc: "https://..."
  if (tail.length === 1) return typeof tail[0] === "number" || pointerFields.has(tail[0]);
  return tail.length === 2 && typeof tail[0] === "number" && pointerFields.has(tail[1]);
}

// Match restored or legacy records only when one candidate owns the same stable identifier.
// Trying each key lets a unique sid disambiguate duplicated legacy ids, while a fully ambiguous
// record fails closed instead of borrowing another client's/visit's media.
export function findUniqueStableMatch(list, item, keys = []) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(list)) return null;
  let target = null;
  const ambiguousSets = [];
  for (const key of keys) {
    if (item[key] == null || String(item[key]) === "") continue;
    const value = String(item[key]);
    const matches = list.filter((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      candidate[key] != null && String(candidate[key]) === value
    );
    if (matches.length === 1) {
      if (target && target !== matches[0]) return null; // two identifiers point at different records
      target = matches[0];
    } else if (matches.length > 1) {
      ambiguousSets.push(matches);
    }
  }
  if (!target) return null;
  return ambiguousSets.every((matches) => matches.includes(target)) ? target : null;
}

export function validateBackupMediaSize(path, actualSize, declaredSize = 0) {
  const actual = Number(actualSize);
  const declared = Number(declaredSize) || 0;
  if (!Number.isSafeInteger(actual) || actual <= 0) {
    throw new Error(`Backup media file is empty: ${path}`);
  }
  if (declared > 0 && actual !== declared) {
    throw new Error(`Backup media file has the wrong size: ${path}`);
  }
  return actual;
}

export function selectLegacyMediaForMigration(liveMedia, backupMedia, { recoverFromBackup = false } = {}) {
  if (!recoverFromBackup) return liveMedia;
  return Array.isArray(liveMedia) && liveMedia.length ? liveMedia : backupMedia;
}

function safeFailureSource(locator, external, index) {
  if (locator) return `${locator.bucket}/${locator.path}`;
  if (external) return safeExternalSource(external);
  return `inline media ${index}`;
}

// Replaces both inline data URLs and Supabase Storage URLs/references with archive
// pointers. Storage objects are downloaded through the caller so authenticated access
// can be used. A failed object remains an explicit missing pointer and is reported in
// `failures`; it can never be counted as successfully backed up.
export async function buildMediaArchive(dataObj, { includeMedia, loadStorage, loadExternal }) {
  const media = [];
  const failures = [];
  const seen = new Map();
  let candidateCount = 0;

  const walk = async (value, path = []) => {
    const inline = parseDataUrl(value);
    const locator = parseStorageLocator(value);
    const external = !locator && typeof value === "string" && /^https?:\/\//i.test(value) && pathCanContainExternalMedia(path)
      ? value
      : null;
    if (inline || locator || external) {
      candidateCount += 1;
      const identity = inline ? `inline:${value}` : locator ? `storage:${locator.ref}` : `external:${external}`;
      if (seen.has(identity)) return { ...seen.get(identity) };
      const sequence = seen.size + 1;
      const mimeHint = inline?.mime || "application/octet-stream";
      const path = `media/${String(sequence).padStart(5, "0")}.${extensionFor(mimeHint, locator)}`;
      const marker = {
        _media: path,
        _mime: mimeHint,
        ...(locator ? { _storageRef: locator.ref } : {}),
        ...(external ? { _externalRef: external } : {}),
      };
      seen.set(identity, marker);

      if (!includeMedia) return { ...marker };
      try {
        const loaded = inline || (locator ? await loadStorage(locator) : await loadExternal(external));
        if (!loaded?.b64) throw new Error("The downloaded object was empty");
        const mime = loaded.mime || mimeHint;
        const finalPath = `media/${String(sequence).padStart(5, "0")}.${extensionFor(mime, locator)}`;
        marker._media = finalPath;
        marker._mime = mime;
        seen.set(identity, marker);
        media.push({
          path: finalPath,
          b64: loaded.b64,
          mime,
          size: Number(loaded.size) || Math.round(loaded.b64.length * 0.75),
          source: safeFailureSource(locator, external, sequence),
        });
        return { ...marker };
      } catch (error) {
        marker._missing = true;
        seen.set(identity, marker);
        failures.push({
          path,
          source: safeFailureSource(locator, external, sequence),
          error: error?.message || "Media download failed",
        });
        return { ...marker };
      }
    }
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) result.push(await walk(value[index], [...path, index]));
      return result;
    }
    if (value && typeof value === "object") {
      const result = {};
      for (const key of Object.keys(value)) result[key] = await walk(value[key], [...path, key]);
      return result;
    }
    return value;
  };

  return {
    refData: await walk(dataObj),
    media,
    failures,
    candidateCount,
    uniqueMediaCount: seen.size,
  };
}

export function backupManifestStatus(manifest = {}) {
  const dataOnly = !!manifest.dataOnly;
  const failures = Number(manifest.mediaFailedCount) || 0;
  const verified = Number(manifest.backupVersion) >= 2;
  const complete = dataOnly ? true : verified && manifest.mediaComplete === true && failures === 0;
  return { dataOnly, failures, complete, verified };
}
