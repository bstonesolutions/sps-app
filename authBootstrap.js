export const AUTH_BOOTSTRAP_TIMEOUT_MS = 12_000;

export class AuthBootstrapTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Authentication did not respond within ${timeoutMs}ms.`);
    this.name = "AuthBootstrapTimeoutError";
    this.code = "AUTH_BOOTSTRAP_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolve Supabase's initial auth session without allowing a storage lock or
 * network refresh to hold the application shell forever.
 *
 * Supabase getSession() resolves to { data, error }; the error is not
 * necessarily thrown, so both rejection paths are normalized here.
 */
export async function loadInitialSession(getSession, {
  timeoutMs = AUTH_BOOTSTRAP_TIMEOUT_MS,
} = {}) {
  if (typeof getSession !== "function") {
    throw new TypeError("getSession must be a function");
  }

  let timeoutId;
  const operation = Promise.resolve().then(() => getSession());
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new AuthBootstrapTimeoutError(timeoutMs)),
      Math.max(0, timeoutMs),
    );
  });

  try {
    const result = await Promise.race([operation, timeout]);
    if (result && result.error) throw result.error;
    return result && result.data ? (result.data.session ?? null) : null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createStartupReference(prefix = "startup") {
  const timestamp = Date.now().toString(36);
  let entropy = "";
  try {
    entropy = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 8) || "";
  } catch (_) {}
  if (!entropy) entropy = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${timestamp}-${entropy}`;
}
