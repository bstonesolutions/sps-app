// Versioned app_state access for Vercel functions.
//
// app_state values intentionally remain JSON strings inside the jsonb column for compatibility
// with the browser app. All writes go through the database CAS function, so a serverless request
// can never replace a row it read before another device/request changed it.

export const APP_STATE_SUPABASE_URL = process.env.SUPABASE_URL || "https://ysqarusrewceezckawlo.supabase.co";
export const APP_STATE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const MAX_MUTATION_ATTEMPTS = 6;
const DEFAULT_APP_STATE_REQUEST_TIMEOUT_MS = 12_000;
const MIN_APP_STATE_REQUEST_TIMEOUT_MS = 250;
const MAX_APP_STATE_REQUEST_TIMEOUT_MS = 25_000;
export const NO_APP_STATE_CHANGE = Symbol("NO_APP_STATE_CHANGE");

function boundedRequestTimeout(value) {
  const configured = Number(value);
  const fallback = Number(process.env.APP_STATE_REQUEST_TIMEOUT_MS) || DEFAULT_APP_STATE_REQUEST_TIMEOUT_MS;
  return Math.max(
    MIN_APP_STATE_REQUEST_TIMEOUT_MS,
    Math.min(MAX_APP_STATE_REQUEST_TIMEOUT_MS, Math.round(Number.isFinite(configured) ? configured : fallback)),
  );
}

// Bound the complete Supabase exchange, including response-body parsing. Aborting only the initial
// fetch is not sufficient for these large JSON rows because a stalled body stream could otherwise
// keep a completion request open indefinitely after the headers arrive.
export async function withAppStateRequestDeadline(operation, action, options = {}) {
  if (typeof action !== "function") throw new TypeError("app_state_request_action_required");
  const timeoutMs = boundedRequestTimeout(options.timeoutMs);
  const AbortControllerImpl = options.AbortControllerImpl || globalThis.AbortController;
  const setTimer = options.setTimer || globalThis.setTimeout;
  const clearTimer = options.clearTimer || globalThis.clearTimeout;
  if (typeof AbortControllerImpl !== "function") throw new Error("app_state_abort_controller_unavailable");
  const controller = new AbortControllerImpl();
  let timedOut = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeoutError = () => {
    const error = new Error("app_state_request_timeout");
    error.code = "APP_STATE_REQUEST_TIMEOUT";
    error.operation = String(operation || "request");
    error.timeoutMs = timeoutMs;
    return error;
  };
  const timer = setTimer(() => {
    timedOut = true;
    try { controller.abort(); } catch (_) {}
    rejectTimeout(timeoutError());
  }, timeoutMs);
  if (timer && typeof timer.unref === "function") timer.unref();

  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimer(timer);
  }
}

export function decodeAppStateValue(value) {
  let out = value;
  // The normal wire shape is one JSON string inside jsonb. A few legacy/admin writes may already
  // be decoded (or double encoded), so unwrap conservatively without changing the stored format.
  for (let i = 0; i < 2 && typeof out === "string"; i += 1) {
    try { out = JSON.parse(out); } catch (_) { break; }
  }
  return out;
}

function headers(extra = {}) {
  if (!APP_STATE_SERVICE_KEY) throw new Error("server_not_configured");
  return {
    apikey: APP_STATE_SERVICE_KEY,
    Authorization: `Bearer ${APP_STATE_SERVICE_KEY}`,
    ...extra,
  };
}

async function responseError(prefix, response) {
  const body = await response.text().catch(() => "");
  const error = new Error(`${prefix}${body ? `: ${body.slice(0, 400)}` : ` (${response.status})`}`);
  error.status = response.status;
  return error;
}

export async function readAppStateVersioned(key, requestOptions = {}) {
  const safeKey = String(key || "");
  if (!safeKey) throw new Error("app_state_key_required");
  return withAppStateRequestDeadline("read", async (signal) => {
    const response = await fetch(
      `${APP_STATE_SUPABASE_URL}/rest/v1/app_state?select=key,value,version,updated_at&key=eq.${encodeURIComponent(safeKey)}&limit=1`,
      { headers: headers(), signal }
    );
    if (!response.ok) throw await responseError("app_state_read_failed", response);
    const rows = await response.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { key: safeKey, exists: false, value: null, rawValue: undefined, version: 0, updatedAt: null };
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("app_state_invalid_version");
    return {
      key: safeKey,
      exists: true,
      value: decodeAppStateValue(row.value),
      rawValue: row.value,
      version,
      updatedAt: row.updated_at || null,
    };
  }, requestOptions);
}

// Read a related app_state snapshot in one PostgREST request. This is intentionally separate from
// readAppStateVersioned so narrow routes keep their existing wire contract while transaction
// endpoints avoid one network round trip per key on every contention retry.
export async function readAppStatesVersioned(keys, requestOptions = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 128) throw new Error("app_state_keys_required");
  const safeKeys = [];
  const seen = new Set();
  for (const candidate of keys) {
    const key = String(candidate || "");
    if (!/^[A-Za-z0-9_.:-]{1,220}$/.test(key) || seen.has(key)) throw new Error("app_state_key_invalid");
    seen.add(key);
    safeKeys.push(key);
  }
  const filter = safeKeys.map((key) => encodeURIComponent(key)).join(",");
  return withAppStateRequestDeadline("batch-read", async (signal) => {
    const response = await fetch(
      `${APP_STATE_SUPABASE_URL}/rest/v1/app_state?select=key,value,version,updated_at&key=in.(${filter})`,
      { headers: headers(), signal }
    );
    if (!response.ok) throw await responseError("app_state_read_failed", response);
    const payload = await response.json().catch(() => []);
    const rows = Array.isArray(payload) ? payload : [];
    const byKey = new Map(rows.map((row) => [String(row?.key || ""), row]));
    return Object.fromEntries(safeKeys.map((key) => {
      const row = byKey.get(key);
      if (!row) return [key, { key, exists: false, value: null, rawValue: undefined, version: 0, updatedAt: null }];
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("app_state_invalid_version");
      return [key, {
        key,
        exists: true,
        value: decodeAppStateValue(row.value),
        rawValue: row.value,
        version,
        updatedAt: row.updated_at || null,
      }];
    }));
  }, requestOptions);
}

// Atomic insert/update. expectedVersion=0 means insert-only; a positive version means update only
// when that exact row version is still current. The SQL function returns the winning version but
// deliberately never accepts an unversioned overwrite.
export async function compareAndSetAppState(key, expectedVersion, value, requestOptions = {}) {
  const safeKey = String(key || "");
  const version = Number(expectedVersion);
  if (!safeKey) throw new Error("app_state_key_required");
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("app_state_expected_version_invalid");
  return withAppStateRequestDeadline("cas", async (signal) => {
    const response = await fetch(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/sps_app_state_cas`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        p_key: safeKey,
        p_expected_version: version,
        // Preserve the existing JSON-string-inside-jsonb representation.
        p_value: JSON.stringify(value),
      }),
      signal,
    });
    if (!response.ok) throw await responseError("app_state_cas_failed", response);
    const payload = await response.json().catch(() => null);
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row.applied !== "boolean") throw new Error("app_state_cas_invalid_response");
    const currentVersion = row.current_version == null ? null : Number(row.current_version);
    return {
      applied: row.applied,
      outcome: String(row.outcome || ""),
      currentVersion: Number.isSafeInteger(currentVersion) ? currentVersion : null,
      changedAt: row.changed_at || null,
    };
  }, requestOptions);
}

// Trusted server routes can use the owner-protected batch RPC through the service role after they
// have performed their own narrow authorization and payload validation. This is intentionally not
// exposed to browsers: callers provide decoded values and the helper preserves the app's existing
// JSON-string-inside-jsonb representation for every row.
export async function compareAndSetAppStateBatch(operations, requestOptions = {}) {
  if (!Array.isArray(operations) || operations.length < 2) throw new Error("app_state_batch_operations_invalid");
  const seen = new Set();
  const wire = operations.map((operation) => {
    const key = String((operation && operation.key) || "");
    const expectedVersion = Number(operation && operation.expectedVersion);
    const checkOnly = operation && operation.checkOnly === true;
    const hasValue = Object.prototype.hasOwnProperty.call(operation || {}, "value");
    if (!key || seen.has(key) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (!checkOnly && !hasValue)) {
      throw new Error("app_state_batch_operation_invalid");
    }
    // A missing row cannot be protected by a row lock. Keep expectedVersion=0 as a normal
    // insert/write operation so the unique key remains the atomic absence fence.
    if (checkOnly && expectedVersion === 0) throw new Error("app_state_batch_check_requires_existing_row");
    seen.add(key);
    const encoded = {
      key,
      expected_version: expectedVersion,
      ...(checkOnly ? { check_only: true } : {}),
    };
    if (!checkOnly) encoded.value = JSON.stringify(operation.value);
    return encoded;
  });
  return withAppStateRequestDeadline("batch-cas", async (signal) => {
    const response = await fetch(`${APP_STATE_SUPABASE_URL}/rest/v1/rpc/sps_app_state_batch_cas`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ p_operations: wire }),
      signal,
    });
    if (!response.ok) throw await responseError("app_state_batch_cas_failed", response);
    const payload = await response.json().catch(() => null);
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row.applied !== "boolean") throw new Error("app_state_batch_cas_invalid_response");
    return {
      applied: row.applied,
      outcome: String(row.outcome || ""),
      conflictKey: row.conflict_key || null,
      currentVersions: row.current_versions && typeof row.current_versions === "object" ? row.current_versions : {},
    };
  }, requestOptions);
}

// Re-read and re-run a targeted, idempotent updater whenever another writer wins the CAS.
// Updaters must have no external side effects: they may be invoked more than once.
export async function mutateAppState(key, updater, options = {}) {
  if (typeof updater !== "function") throw new TypeError("app_state_updater_required");
  const configured = Number(options.maxAttempts);
  const maxAttempts = Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 12)
    : MAX_MUTATION_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await readAppStateVersioned(key);
    const next = await updater(current.exists ? current.value : undefined, {
      attempt,
      exists: current.exists,
      version: current.version,
    });
    if (next === NO_APP_STATE_CHANGE) {
      return { changed: false, value: current.value, version: current.version, attempts: attempt };
    }
    if (next === undefined) throw new Error("app_state_updater_returned_undefined");

    const result = await compareAndSetAppState(key, current.exists ? current.version : 0, next);
    if (result.applied) {
      return {
        changed: true,
        value: next,
        version: result.currentVersion,
        changedAt: result.changedAt,
        attempts: attempt,
      };
    }
    if (!['conflict', 'missing'].includes(result.outcome)) {
      throw new Error(`app_state_cas_unexpected_outcome:${result.outcome || "unknown"}`);
    }
    // Small bounded jitter reduces repeat collisions between simultaneous Vercel invocations.
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 12 * attempt + Math.floor(Math.random() * 18)));
  }
  const error = new Error("app_state_contention");
  error.code = "APP_STATE_CONTENTION";
  throw error;
}
