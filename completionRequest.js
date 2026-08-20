export const COMPLETION_REQUEST_TIMEOUT_MS = 30_000;

const cleanPart = (value) => String(value == null ? "" : value).trim();
const elapsedMs = (startedAt, now) => Math.max(0, Math.round(Number(now()) - Number(startedAt)));

function fallbackRequestId(now, random) {
  const stamp = Math.max(0, Math.round(Number(now()) || Date.now())).toString(36);
  const nonce = Math.floor(Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * 0x100000000)
    .toString(36)
    .padStart(7, "0");
  return `completion-${stamp}-${nonce}`;
}

export function createCompletionRequestId({ now = Date.now, random = Math.random, cryptoImpl = globalThis.crypto } = {}) {
  try {
    const uuid = cryptoImpl?.randomUUID?.();
    if (uuid) return `completion-${uuid}`;
  } catch (_) {}
  return fallbackRequestId(now, random);
}

function log(logger, level, event, details) {
  const writer = logger && typeof logger[level] === "function" ? logger[level] : null;
  if (writer) writer.call(logger, `[completion-sync] ${event}`, details);
}

function requestError(message, { status = 0, code = "", legacy = false, requestId, durationMs } = {}) {
  return Object.assign(new Error(message), {
    status,
    code,
    legacy,
    requestId,
    durationMs,
  });
}

export async function requestCompletedStop({
  url,
  headers,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = COMPLETION_REQUEST_TIMEOUT_MS,
  requestId = createCompletionRequestId(),
  logger = console,
  now = Date.now,
  AbortControllerImpl = globalThis.AbortController,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!cleanPart(url) || typeof fetchImpl !== "function" || !body || typeof body !== "object") {
    throw new Error("The completed stop request is missing required information.");
  }
  if (typeof AbortControllerImpl !== "function") {
    throw new Error("This device cannot safely time out the completed stop request.");
  }

  const boundedTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(Number(timeoutMs) || COMPLETION_REQUEST_TIMEOUT_MS)));
  const controller = new AbortControllerImpl();
  const startedAt = Number(now());
  let didTimeout = false;
  const timer = setTimer(() => {
    didTimeout = true;
    controller.abort();
  }, boundedTimeoutMs);
  const context = {
    requestId,
    stopId: cleanPart(body.sid),
    idempotencyKey: cleanPart(body.idempotencyKey),
    timeoutMs: boundedTimeoutMs,
  };

  log(logger, "info", "request started", context);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...(headers || {}), "X-Request-Id": requestId },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    const durationMs = elapsedMs(startedAt, now);
    if (!response.ok || data.ok !== true) {
      const error = requestError(data.error || "The stop could not be saved. Nothing was changed.", {
        status: Number(response.status) || 0,
        code: cleanPart(data.code),
        legacy: !!data.legacy,
        requestId,
        durationMs,
      });
      log(logger, "warn", "request rejected", {
        ...context,
        durationMs,
        status: error.status,
        code: error.code,
      });
      throw error;
    }
    log(logger, "info", "request confirmed", {
      ...context,
      durationMs,
      status: Number(response.status) || 200,
      applied: !!data.applied,
      alreadyCompleted: !!data.alreadyCompleted,
    });
    return { data, requestId, durationMs };
  } catch (error) {
    if (error?.requestId === requestId) throw error;
    const durationMs = elapsedMs(startedAt, now);
    if (didTimeout || error?.name === "AbortError") {
      const timeoutError = requestError(
        `The completed stop request timed out after ${Math.round(boundedTimeoutMs / 1000)} seconds. The report is safe on this device and will retry automatically.`,
        { status: 408, code: "completion-request-timeout", requestId, durationMs },
      );
      log(logger, "warn", "request timed out", { ...context, durationMs, status: 408, code: timeoutError.code });
      throw timeoutError;
    }
    const networkError = requestError(error?.message || "The completed stop request could not reach the server.", {
      status: Number(error?.status) || 0,
      code: cleanPart(error?.code) || "completion-request-network",
      legacy: !!error?.legacy,
      requestId,
      durationMs,
    });
    log(logger, "warn", "request failed", {
      ...context,
      durationMs,
      status: networkError.status,
      code: networkError.code,
    });
    throw networkError;
  } finally {
    clearTimer(timer);
  }
}
