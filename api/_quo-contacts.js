import {
  cleanSmsValue,
  copyQuoMediaToPrivateStorage,
  isSmsE164,
  quoContactMetadata,
  toSmsE164,
} from "./_sms-history.js";

const DEFAULT_QUO_API_BASE = "https://api.quo.com/v1";
const CONTACT_TABLE = "sps_sms_contacts";

export const QUO_CONTACT_SYNC_LIMITS = Object.freeze({
  defaultContacts: 50,
  defaultPages: 1,
  maxContacts: 200,
  maxPages: 4,
  pageSize: 50,
  maxMessageLookups: 3,
});

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, number));
};

const schemaMissing = (value) => /sps_sms_contacts|42P01|PGRST205|schema cache/i.test(String(value || ""));

const serviceHeaders = (serviceKey) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
});

const providerHeaders = (apiKey) => ({
  Authorization: apiKey,
  Accept: "application/json",
});

const safeContactId = (value) => {
  const id = cleanSmsValue(value, 100);
  return /^[A-Za-z0-9_-]{2,100}$/.test(id) ? id : "";
};

const safePageToken = (value) => cleanSmsValue(value, 500);

async function fetchJsonWithin(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 100));
  try {
    const response = await fetchImpl(url, { ...(options || {}), signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function chunks(values, size = 100) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

export function quoContactIdsFromMessage(message, {
  max = QUO_CONTACT_SYNC_LIMITS.maxMessageLookups,
} = {}) {
  const object = message && typeof message === "object" ? message : {};
  const modern = Array.isArray(object.contactIds) ? object.contactIds : [];
  const legacy = [
    object.contactId,
    object.contact && typeof object.contact === "object" ? object.contact.id : "",
  ];
  const limit = clampInt(max, QUO_CONTACT_SYNC_LIMITS.maxMessageLookups, 1, QUO_CONTACT_SYNC_LIMITS.maxMessageLookups);
  return [...new Set([...modern, ...legacy].map(safeContactId).filter(Boolean))].slice(0, limit);
}

export async function fetchQuoContactById(contactId, {
  apiKey,
  fetchImpl = fetch,
  quoApiBase = DEFAULT_QUO_API_BASE,
  timeoutMs = 900,
} = {}) {
  const id = safeContactId(contactId);
  if (!id || !apiKey) return { ok: false, skipped: !id ? "invalid contact id" : "Quo API is not configured" };
  try {
    const { response, body } = await fetchJsonWithin(
      fetchImpl,
      `${String(quoApiBase).replace(/\/+$/, "")}/contacts/${encodeURIComponent(id)}`,
      { headers: providerHeaders(apiKey) },
      timeoutMs,
    );
    if (!response.ok || !body?.data || typeof body.data !== "object") {
      return { ok: false, status: Number(response.status) || 502, error: "Quo contact lookup failed" };
    }
    return { ok: true, contact: body.data };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error?.name === "AbortError" ? "Quo contact lookup timed out" : "Quo contact lookup failed",
    };
  }
}

async function listQuoContacts({
  apiKey,
  fetchImpl,
  quoApiBase,
  pageToken,
  maxResults,
  timeoutMs,
}) {
  const query = new URLSearchParams({ maxResults: String(maxResults) });
  const token = safePageToken(pageToken);
  if (token) query.set("pageToken", token);
  try {
    const { response, body } = await fetchJsonWithin(
      fetchImpl,
      `${String(quoApiBase).replace(/\/+$/, "")}/contacts?${query.toString()}`,
      { headers: providerHeaders(apiKey) },
      timeoutMs,
    );
    if (!response.ok || !Array.isArray(body?.data)) {
      return { ok: false, status: Number(response.status) || 502, error: "Quo contact list failed" };
    }
    return {
      ok: true,
      contacts: body.data,
      nextPageToken: safePageToken(body.nextPageToken) || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error?.name === "AbortError" ? "Quo contact list timed out" : "Quo contact list failed",
    };
  }
}

async function readExistingCache(phones, {
  supabaseUrl,
  serviceKey,
  fetchImpl,
  timeoutMs,
}) {
  const byPhone = new Map();
  for (const batch of chunks(phones, 100)) {
    const filter = batch.map(encodeURIComponent).join(",");
    try {
      const { response, body } = await fetchJsonWithin(
        fetchImpl,
        `${String(supabaseUrl).replace(/\/+$/, "")}/rest/v1/${CONTACT_TABLE}?select=phone,quo_contact_id,contact_name,avatar_path&phone=in.(${filter})`,
        { headers: serviceHeaders(serviceKey) },
        timeoutMs,
      );
      if (!response.ok || !Array.isArray(body)) {
        const text = body && typeof body === "object" ? JSON.stringify(body) : "";
        return schemaMissing(text) || response.status === 404
          ? { ok: true, skipped: "conversation schema not installed", byPhone }
          : { ok: false, error: "Contact cache lookup failed", byPhone };
      }
      for (const row of body) {
        const phone = toSmsE164(row?.phone);
        if (isSmsE164(phone)) byPhone.set(phone, row);
      }
    } catch {
      return { ok: false, error: "Contact cache lookup failed", byPhone };
    }
  }
  return { ok: true, byPhone };
}

async function writeChangedCache(rows, {
  supabaseUrl,
  serviceKey,
  fetchImpl,
  timeoutMs,
}) {
  let written = 0;
  for (const batch of chunks(rows, 100)) {
    let response;
    try {
      response = await fetchImpl(
        `${String(supabaseUrl).replace(/\/+$/, "")}/rest/v1/${CONTACT_TABLE}?on_conflict=phone`,
        {
          method: "POST",
          headers: {
            ...serviceHeaders(serviceKey),
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 100)),
        },
      );
    } catch {
      return { ok: false, error: "Contact cache update failed", written };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return schemaMissing(text) || response.status === 404
        ? { ok: true, skipped: "conversation schema not installed", written }
        : { ok: false, error: "Contact cache update failed", written };
    }
    written += batch.length;
  }
  return { ok: true, written };
}

function uniquePhoneOwners(metadataList) {
  const owners = new Map();
  const ambiguous = new Set();
  for (const metadata of metadataList) {
    for (const phone of metadata.phones) {
      const prior = owners.get(phone);
      if (prior && prior.id !== metadata.id) {
        owners.delete(phone);
        ambiguous.add(phone);
      } else if (!ambiguous.has(phone)) {
        owners.set(phone, metadata);
      }
    }
  }
  return { owners, ambiguous };
}

export async function cacheQuoContacts(contacts, {
  supabaseUrl,
  serviceKey,
  fetchImpl = fetch,
  timeoutMs = 1400,
  maxAvatars = 8,
  preserveExistingAvatar = true,
} = {}) {
  if (!supabaseUrl || !serviceKey) return { ok: false, error: "Contact cache is not configured" };
  const rawContacts = Array.isArray(contacts) ? contacts : [];
  const byId = new Map();
  for (const contact of rawContacts) {
    const metadata = quoContactMetadata(contact);
    if (!metadata.id || !metadata.phones.length) continue;
    const prior = byId.get(metadata.id);
    byId.set(metadata.id, prior ? {
      ...prior,
      name: metadata.name || prior.name,
      pictureUrl: metadata.pictureUrl || prior.pictureUrl,
      phones: [...new Set([...prior.phones, ...metadata.phones])],
    } : metadata);
  }
  const metadataList = [...byId.values()];
  const { owners, ambiguous } = uniquePhoneOwners(metadataList);
  const phones = [...owners.keys()];
  if (!phones.length) {
    return {
      ok: true,
      scanned: rawContacts.length,
      cached: 0,
      changed: 0,
      named: metadataList.filter((metadata) => !!metadata.name).length,
      avatarsStored: 0,
      ambiguousPhones: ambiguous.size,
      skipped: rawContacts.length - metadataList.length,
      identities: [],
    };
  }

  const existingRun = await readExistingCache(phones, {
    supabaseUrl,
    serviceKey,
    fetchImpl,
    timeoutMs,
  });
  if (!existingRun.ok || existingRun.skipped) {
    return {
      ok: existingRun.ok,
      error: existingRun.error,
      schemaSkipped: existingRun.skipped || "",
      scanned: rawContacts.length,
      cached: 0,
      changed: 0,
      named: metadataList.filter((metadata) => !!metadata.name).length,
      avatarsStored: 0,
      ambiguousPhones: ambiguous.size,
      skipped: rawContacts.length - metadataList.length,
      identities: metadataList.map((metadata) => ({ ...metadata, avatarPath: "" })),
    };
  }

  const avatarPaths = new Map();
  for (const [phone, metadata] of owners.entries()) {
    const existing = existingRun.byPhone.get(phone);
    if (preserveExistingAvatar && existing?.avatar_path) avatarPaths.set(metadata.id, String(existing.avatar_path));
  }

  let avatarsStored = 0;
  const avatarCandidates = metadataList
    .filter((metadata) => metadata.pictureUrl && !avatarPaths.has(metadata.id))
    .slice(0, clampInt(maxAvatars, 8, 0, 12));
  for (const metadata of avatarCandidates) {
    const copied = await copyQuoMediaToPrivateStorage({
      media: [{ url: metadata.pictureUrl, type: "image/jpeg" }],
      messageId: metadata.id,
      supabaseUrl,
      serviceKey,
      fetchImpl,
      timeoutMs: Math.max(300, Math.min(1200, Number(timeoutMs) || 1200)),
      maxItems: 1,
      maxBytes: 4 * 1024 * 1024,
      folder: "contacts",
    });
    if (copied[0]?.path) {
      avatarPaths.set(metadata.id, copied[0].path);
      avatarsStored += 1;
    }
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const [phone, metadata] of owners.entries()) {
    const existing = existingRun.byPhone.get(phone);
    const avatarPath = avatarPaths.get(metadata.id) || (preserveExistingAvatar ? String(existing?.avatar_path || "") : "");
    const row = {
      phone,
      quo_contact_id: metadata.id,
      // Quo sometimes returns partial contacts during paging/updates. A missing display name is
      // not a rename and must never erase a name already confirmed in the durable cache.
      contact_name: metadata.name || String(existing?.contact_name || ""),
      avatar_path: avatarPath,
      updated_at: now,
    };
    if (String(existing?.quo_contact_id || "") !== row.quo_contact_id
      || String(existing?.contact_name || "") !== row.contact_name
      || String(existing?.avatar_path || "") !== row.avatar_path) {
      rows.push(row);
    }
  }
  const write = await writeChangedCache(rows, {
    supabaseUrl,
    serviceKey,
    fetchImpl,
    timeoutMs,
  });
  const avatarById = new Map(metadataList.map((metadata) => [metadata.id, avatarPaths.get(metadata.id) || ""]));
  return {
    ok: write.ok,
    error: write.error,
    schemaSkipped: write.skipped || "",
    scanned: rawContacts.length,
    cached: write.ok ? owners.size : 0,
    changed: write.ok ? write.written : 0,
    named: metadataList.filter((metadata) => !!metadata.name).length,
    avatarsStored,
    ambiguousPhones: ambiguous.size,
    skipped: rawContacts.length - metadataList.length,
    identities: metadataList.map((metadata) => ({
      id: metadata.id,
      name: metadata.name,
      phones: metadata.phones,
      avatarPath: avatarById.get(metadata.id) || "",
    })),
  };
}

export async function lookupAndCacheQuoContactForPhone({
  contactIds,
  phone,
  apiKey,
  supabaseUrl,
  serviceKey,
  fetchImpl = fetch,
  quoApiBase = DEFAULT_QUO_API_BASE,
  timeoutMs = 900,
} = {}) {
  const peer = toSmsE164(phone);
  const ids = quoContactIdsFromMessage({ contactIds });
  if (!isSmsE164(peer) || !ids.length || !apiKey) {
    return { ok: true, matched: false, skipped: !ids.length ? "message has no contact ids" : "contact lookup is not configured" };
  }
  const lookups = await Promise.all(ids.map((id) => fetchQuoContactById(id, {
    apiKey,
    fetchImpl,
    quoApiBase,
    timeoutMs,
  })));
  const matches = lookups
    .filter((result) => result.ok)
    .map((result) => ({ contact: result.contact, metadata: quoContactMetadata(result.contact) }))
    .filter(({ metadata }) => metadata.id && metadata.phones.includes(peer));
  const uniqueMatches = [...new Map(matches.map((match) => [match.metadata.id, match])).values()];
  if (uniqueMatches.length !== 1) {
    return {
      ok: true,
      matched: false,
      ambiguous: uniqueMatches.length > 1,
      attempted: ids.length,
      skipped: uniqueMatches.length > 1 ? "multiple contacts match the sender" : "contact ids did not match the sender",
    };
  }
  const match = uniqueMatches[0];
  const cached = await cacheQuoContacts([match.contact], {
    supabaseUrl,
    serviceKey,
    fetchImpl,
    timeoutMs,
    maxAvatars: 1,
    preserveExistingAvatar: true,
  });
  const identity = cached.identities?.find((candidate) => candidate.id === match.metadata.id) || {
    id: match.metadata.id,
    name: match.metadata.name,
    phones: match.metadata.phones,
    avatarPath: "",
  };
  return {
    ok: cached.ok,
    matched: true,
    attempted: ids.length,
    metadata: {
      id: identity.id,
      name: identity.name,
      phones: identity.phones,
      pictureUrl: "",
    },
    avatarPath: identity.avatarPath || "",
    cacheChanged: cached.changed || 0,
    cacheSkipped: cached.schemaSkipped || "",
  };
}

export async function syncQuoContacts({
  apiKey,
  supabaseUrl,
  serviceKey,
  fetchImpl = fetch,
  quoApiBase = DEFAULT_QUO_API_BASE,
  pageToken = "",
  maxContacts = QUO_CONTACT_SYNC_LIMITS.defaultContacts,
  maxPages = QUO_CONTACT_SYNC_LIMITS.defaultPages,
  timeoutMs = 1800,
  maxAvatars = 8,
} = {}) {
  if (!apiKey) return { ok: false, status: 501, error: "Quo API is not configured" };
  if (!supabaseUrl || !serviceKey) return { ok: false, status: 501, error: "Contact cache is not configured" };
  const contactLimit = clampInt(maxContacts, QUO_CONTACT_SYNC_LIMITS.defaultContacts, 1, QUO_CONTACT_SYNC_LIMITS.maxContacts);
  const pageLimit = clampInt(maxPages, QUO_CONTACT_SYNC_LIMITS.defaultPages, 1, QUO_CONTACT_SYNC_LIMITS.maxPages);
  const contacts = [];
  let nextPageToken = safePageToken(pageToken) || null;
  let pages = 0;
  do {
    const remaining = contactLimit - contacts.length;
    if (remaining <= 0) break;
    const page = await listQuoContacts({
      apiKey,
      fetchImpl,
      quoApiBase,
      pageToken: nextPageToken,
      maxResults: Math.min(QUO_CONTACT_SYNC_LIMITS.pageSize, remaining),
      timeoutMs,
    });
    if (!page.ok) return { ...page, scanned: contacts.length, pages };
    contacts.push(...page.contacts.slice(0, remaining));
    nextPageToken = page.nextPageToken;
    pages += 1;
  } while (nextPageToken && pages < pageLimit && contacts.length < contactLimit);

  const cached = await cacheQuoContacts(contacts, {
    supabaseUrl,
    serviceKey,
    fetchImpl,
    timeoutMs,
    maxAvatars,
    preserveExistingAvatar: true,
  });
  return {
    ok: cached.ok,
    status: cached.ok ? 200 : 502,
    error: cached.error,
    scanned: cached.scanned || 0,
    cached: cached.cached || 0,
    changed: cached.changed || 0,
    named: cached.named || 0,
    avatarsStored: cached.avatarsStored || 0,
    ambiguousPhones: cached.ambiguousPhones || 0,
    skipped: cached.skipped || 0,
    schemaSkipped: cached.schemaSkipped || "",
    pages,
    nextPageToken,
    complete: !nextPageToken,
  };
}
