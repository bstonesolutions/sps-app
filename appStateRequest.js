// A stalled WebView fetch must release the per-key save queue. A timed-out write
// is ambiguous, so callers retain its durable CAS intent and reconcile on retry.
export const APP_STATE_BROWSER_TIMEOUT_MS = 20_000;

export async function requestAppState(operation, createRequest, {
  timeoutMs = APP_STATE_BROWSER_TIMEOUT_MS,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  AbortControllerImpl = globalThis.AbortController,
} = {}) {
  const controller = typeof AbortControllerImpl === "function" ? new AbortControllerImpl() : null;
  let timedOut = false;
  let timer;
  const timeoutError = Object.assign(new Error("The shared data request timed out. Your pending changes will be retried."), {
    code: "APP_STATE_REQUEST_TIMEOUT", operation, timeoutMs,
  });
  try {
    const deadline = new Promise(resolve => {
      timer = setTimer(() => {
        timedOut = true;
        resolve({ data: null, error: timeoutError });
        try { controller?.abort(); } catch (_) {}
      }, timeoutMs);
    });
    const request = Promise.resolve().then(() => {
      const builder = createRequest(controller?.signal);
      return controller && typeof builder?.abortSignal === "function" ? builder.abortSignal(controller.signal) : builder;
    }).catch(error => ({ data: null, error }));
    const response = await Promise.race([request, deadline]);
    return timedOut ? { data: null, error: timeoutError } : response;
  } catch (error) {
    return { data: null, error };
  } finally {
    clearTimer(timer);
  }
}
