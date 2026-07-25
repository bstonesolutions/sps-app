export const WORKSPACE_STATE_PREFIX = "sps_workspace_state_v1:";

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 8;
const SKIP = Symbol("skip-workspace-value");

const emptyWorkspaceState = () => ({
  page: null,
  comms: {},
  client: {},
  scroll: {},
});

function defaultStorage() {
  try {
    return typeof globalThis !== "undefined" ? globalThis.localStorage : null;
  } catch (_) {
    return null;
  }
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonSafeClone(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : SKIP;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return SKIP;

  if (seen.has(value)) return SKIP;
  seen.add(value);

  if (Array.isArray(value)) {
    const cloned = [];
    value.forEach((item) => {
      const safe = jsonSafeClone(item, depth + 1, seen);
      if (safe !== SKIP) cloned.push(safe);
    });
    seen.delete(value);
    return cloned;
  }

  if (!isPlainObject(value)) {
    seen.delete(value);
    return SKIP;
  }

  const cloned = {};
  Object.keys(value).forEach((key) => {
    if (BLOCKED_KEYS.has(key)) return;
    const safe = jsonSafeClone(value[key], depth + 1, seen);
    if (safe !== SKIP) cloned[key] = safe;
  });
  seen.delete(value);
  return cloned;
}

function safeSection(value) {
  const cloned = jsonSafeClone(value);
  return cloned !== SKIP && isPlainObject(cloned) ? cloned : {};
}

export function normalizeWorkspaceState(value) {
  const source = isPlainObject(value) ? value : {};
  const page = source.page === null || typeof source.page === "string"
    ? source.page
    : null;

  return {
    page,
    comms: safeSection(source.comms),
    client: safeSection(source.client),
    scroll: safeSection(source.scroll),
  };
}

export function workspaceStateKey(authUserId) {
  const id = typeof authUserId === "string" ? authUserId.trim() : "";
  return id ? `${WORKSPACE_STATE_PREFIX}${encodeURIComponent(id)}` : "";
}

function mergeObjects(current, patch) {
  const next = { ...current };
  Object.keys(patch).forEach((key) => {
    if (BLOCKED_KEYS.has(key)) return;
    const incoming = patch[key];
    if (isPlainObject(incoming) && isPlainObject(current[key])) {
      next[key] = mergeObjects(current[key], incoming);
    } else {
      next[key] = incoming;
    }
  });
  return next;
}

export function readWorkspaceState(authUserId, storage = defaultStorage()) {
  const key = workspaceStateKey(authUserId);
  if (!key || !storage || typeof storage.getItem !== "function") return emptyWorkspaceState();
  try {
    const raw = storage.getItem(key);
    if (!raw) return emptyWorkspaceState();
    return normalizeWorkspaceState(JSON.parse(raw));
  } catch (_) {
    return emptyWorkspaceState();
  }
}

export function patchWorkspaceState(authUserId, patch, storage = defaultStorage()) {
  const key = workspaceStateKey(authUserId);
  const current = readWorkspaceState(authUserId, storage);
  if (!key || !storage || typeof storage.setItem !== "function" || !isPlainObject(patch)) {
    return current;
  }

  const safePatch = {};
  if (Object.prototype.hasOwnProperty.call(patch, "page")) {
    const page = jsonSafeClone(patch.page);
    if (page === null || typeof page === "string") safePatch.page = page;
  }
  ["comms", "client", "scroll"].forEach((section) => {
    if (!Object.prototype.hasOwnProperty.call(patch, section)) return;
    const safe = jsonSafeClone(patch[section]);
    if (safe !== SKIP && isPlainObject(safe)) safePatch[section] = safe;
  });

  const next = normalizeWorkspaceState(mergeObjects(current, safePatch));
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch (_) {
    // Storage can be unavailable or full. The caller can still continue with the in-memory result.
  }
  return next;
}

export function clearWorkspaceState(authUserId, storage = defaultStorage()) {
  const key = workspaceStateKey(authUserId);
  if (!key || !storage || typeof storage.removeItem !== "function") return false;
  try {
    storage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

export function clearAllWorkspaceStates(storage = defaultStorage()) {
  if (!storage || typeof storage.key !== "function" || typeof storage.removeItem !== "function") return 0;
  try {
    const keys = [];
    const length = Math.max(0, Number(storage.length) || 0);
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(WORKSPACE_STATE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
    return keys.length;
  } catch (_) {
    return 0;
  }
}
