const DEFAULT_BASE_MS = 5_000;
const DEFAULT_MAX_MS = 300_000;
const DEFAULT_JITTER = 0.2;

const numericStatus = (error) => {
  const raw = error && (error.status ?? error.statusCode ?? error.httpStatus);
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
};

/**
 * Only infrastructure/network failures belong in the automatic retry lane.
 * Authorization, RLS, validation, and merge conflicts require a real fix or a
 * user choice; repeatedly replaying those requests only adds database load.
 */
export function isTransientAppStateError(error) {
  if (!error) return false;
  const status = numericStatus(error);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;

  const code = String(error.code || "").toUpperCase();
  if (
    code === "57014"
    || code === "53300"
    || code === "57P03"
    || code === "ETIMEDOUT"
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "EAI_AGAIN"
    || code.startsWith("08")
  ) return true;

  const message = [
    error.message,
    error.details,
    error.hint,
  ].filter(Boolean).join(" ");
  return /timed?\s*out|timeout|network|failed to fetch|fetch failed|load failed|unable to connect|could not connect|connection (?:closed|reset|refused|queued?)|gateway|temporar(?:y|ily) unavailable|server unavailable|upstream|socket hang up|\b(?:520|521|522|523|524)\b/i.test(message);
}

/**
 * Full-jitter would occasionally retry almost immediately, which is unsafe
 * during a shared outage. Keep a bounded ±20% spread around an exponential
 * delay and never exceed the five-minute ceiling.
 */
export function nextAppStateRetry(
  previousCount,
  {
    now = Date.now(),
    random = Math.random,
    baseMs = DEFAULT_BASE_MS,
    maxMs = DEFAULT_MAX_MS,
    jitter = DEFAULT_JITTER,
  } = {}
) {
  const retryCount = Math.max(0, Number(previousCount) || 0) + 1;
  const exponent = Math.min(20, retryCount - 1);
  const rawDelay = Math.min(maxMs, baseMs * (2 ** exponent));
  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  const jitterFactor = (1 - jitter) + (randomValue * jitter * 2);
  const delayMs = Math.max(baseMs, Math.min(maxMs, Math.round(rawDelay * jitterFactor)));
  return {
    retryCount,
    delayMs,
    retryAt: now + delayMs,
  };
}

export const APP_STATE_RETRY_MAX_MS = DEFAULT_MAX_MS;
