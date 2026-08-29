const DEFAULT_MAX_MEDIA_ENTRIES = 50_000;
const DEFAULT_MAX_DATA_URL_CHARACTERS = 128 * 1024 * 1024;
const DEFAULT_MAX_CLIENT_RECORDS = 50_000;
const DEFAULT_MAX_RELATED_ROWS = 100_000;
const MAX_DATA_URL_METADATA_CHARACTERS = 4_096;

const EMPTY_HEALTH = Object.freeze({
  inlineDataUrlCount: 0,
  approximateDecodedBytes: 0,
  affectedClientCount: 0,
  affectedHistoryRowCount: 0,
  affectedEquipmentRowCount: 0,
  malformedDataUrlCount: 0,
  inspectedMediaEntryCount: 0,
  truncated: false,
});

function finiteLimit(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function safeRead(value, key) {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

function safeIsArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function safeArrayLength(value) {
  if (!safeIsArray(value)) return 0;
  const length = Number(safeRead(value, "length"));
  return Number.isSafeInteger(length) && length >= 0 ? length : 0;
}

function isDataUrl(value) {
  return typeof value === "string" && value.length >= 5 && value.slice(0, 5).toLowerCase() === "data:";
}

function isAsciiWhitespace(code) {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isHex(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

// Estimates the decoded payload without calling atob, fetch, Blob, or decodeURIComponent.
// The return value deliberately distinguishes a malformed data URL from an empty one.
export function approximateDataUrlBytes(value, { maxCharacters = DEFAULT_MAX_DATA_URL_CHARACTERS } = {}) {
  if (!isDataUrl(value)) return { bytes: 0, malformed: false, truncated: false };

  const comma = value.indexOf(",", 5);
  if (comma < 0) return { bytes: 0, malformed: true, truncated: false };
  if (comma - 5 > MAX_DATA_URL_METADATA_CHARACTERS) return { bytes: 0, malformed: true, truncated: true };

  const characterLimit = finiteLimit(maxCharacters, DEFAULT_MAX_DATA_URL_CHARACTERS);
  const payloadStart = comma + 1;
  const payloadLength = value.length - payloadStart;
  const charactersToInspect = Math.min(payloadLength, characterLimit);
  const truncated = charactersToInspect < payloadLength;
  const metadata = value.slice(5, comma);
  const base64 = /(?:^|;)base64(?:;|$)/i.test(metadata);

  if (base64) {
    let encodedCharacters = 0;
    let padding = 0;
    let malformed = false;
    let sawPadding = false;

    for (let offset = 0; offset < charactersToInspect; offset += 1) {
      const code = value.charCodeAt(payloadStart + offset);
      if (isAsciiWhitespace(code)) continue;
      if (code === 61) {
        sawPadding = true;
        padding += 1;
        encodedCharacters += 1;
        if (padding > 2) malformed = true;
        continue;
      }
      const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 45 || code === 95;
      if (!valid || sawPadding) malformed = true;
      encodedCharacters += 1;
    }

    if (!truncated && encodedCharacters % 4 === 1) malformed = true;
    const bytes = Math.max(0, Math.floor(encodedCharacters * 3 / 4) - (truncated ? 0 : Math.min(padding, 2)));
    return { bytes, malformed, truncated };
  }

  let bytes = 0;
  let malformed = false;
  for (let offset = 0; offset < charactersToInspect; offset += 1) {
    const index = payloadStart + offset;
    const code = value.charCodeAt(index);
    if (code === 37) {
      const first = value.charCodeAt(index + 1);
      const second = value.charCodeAt(index + 2);
      if (offset + 2 < charactersToInspect && isHex(first) && isHex(second)) {
        bytes += 1;
        offset += 2;
      } else if (truncated && offset + 2 >= charactersToInspect) {
        break;
      } else {
        malformed = true;
        bytes += 1;
      }
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (offset + 1 < charactersToInspect && next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        offset += 1;
      } else if (truncated && offset + 1 >= charactersToInspect) {
        break;
      } else {
        malformed = true;
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return { bytes, malformed, truncated };
}

function mediaSource(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  for (const key of ["src", "url", "poster"]) {
    const candidate = safeRead(entry, key);
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

/**
 * Inspect only the client fields that are known to contain legacy inline media.
 *
 * This is intentionally not a general object walker. Restricting traversal to these
 * fields prevents cycles, getters, or unrelated large client data from hanging the UI.
 * Counts represent stored occurrences, so the same data URL in two records counts twice.
 */
export function inspectLegacyMediaHealth(clients, options = {}) {
  if (!safeIsArray(clients)) return { ...EMPTY_HEALTH };

  const maxMediaEntries = finiteLimit(options.maxMediaEntries, DEFAULT_MAX_MEDIA_ENTRIES);
  const maxDataUrlCharacters = finiteLimit(options.maxDataUrlCharacters, DEFAULT_MAX_DATA_URL_CHARACTERS);
  const maxClientRecords = finiteLimit(options.maxClientRecords, DEFAULT_MAX_CLIENT_RECORDS);
  const maxRelatedRows = finiteLimit(options.maxRelatedRows, DEFAULT_MAX_RELATED_ROWS);
  const result = { ...EMPTY_HEALTH };
  let stop = false;

  const inspectEntry = (entry) => {
    if (stop) return false;
    if (result.inspectedMediaEntryCount >= maxMediaEntries) {
      result.truncated = true;
      stop = true;
      return false;
    }
    result.inspectedMediaEntryCount += 1;
    const source = mediaSource(entry);
    if (!isDataUrl(source)) return false;

    const estimate = approximateDataUrlBytes(source, { maxCharacters: maxDataUrlCharacters });
    result.inlineDataUrlCount += 1;
    result.approximateDecodedBytes += estimate.bytes;
    if (estimate.malformed) result.malformedDataUrlCount += 1;
    if (estimate.truncated) {
      result.truncated = true;
      stop = true;
    }
    return true;
  };

  const inspectCollection = (collection) => {
    if (stop || collection == null) return false;
    if (!safeIsArray(collection)) return inspectEntry(collection);
    let affected = false;
    const collectionLength = safeArrayLength(collection);
    const length = Math.min(collectionLength, maxMediaEntries);
    for (let index = 0; index < length && !stop; index += 1) {
      if (inspectEntry(safeRead(collection, index))) affected = true;
    }
    if (!stop && length < collectionLength) {
      result.truncated = true;
      stop = true;
    }
    return affected;
  };

  const inspectRows = (rows, mediaKey, affectedCounter) => {
    if (stop || !safeIsArray(rows)) return false;
    let clientAffected = false;
    const rowCount = safeArrayLength(rows);
    const length = Math.min(rowCount, maxRelatedRows);
    for (let index = 0; index < length && !stop; index += 1) {
      const row = safeRead(rows, index);
      if (!row || typeof row !== "object") continue;
      if (inspectCollection(safeRead(row, mediaKey))) {
        result[affectedCounter] += 1;
        clientAffected = true;
      }
    }
    if (!stop && length < rowCount) {
      result.truncated = true;
      stop = true;
    }
    return clientAffected;
  };

  const clientCount = safeArrayLength(clients);
  const clientsToInspect = Math.min(clientCount, maxClientRecords);
  for (let clientIndex = 0; clientIndex < clientsToInspect && !stop; clientIndex += 1) {
    const client = safeRead(clients, clientIndex);
    if (!client || typeof client !== "object") continue;
    let affected = false;

    for (const key of ["sitePhotos", "siteVideos", "documents"]) {
      if (inspectCollection(safeRead(client, key))) affected = true;
      if (stop) break;
    }
    if (!stop && inspectRows(safeRead(client, "history"), "photos", "affectedHistoryRowCount")) affected = true;
    if (!stop && inspectRows(safeRead(client, "equipment"), "photos", "affectedEquipmentRowCount")) affected = true;
    if (affected) result.affectedClientCount += 1;
  }

  if (!stop && clientsToInspect < clientCount) result.truncated = true;
  return result;
}
