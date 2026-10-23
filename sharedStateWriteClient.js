import { PROD_URL } from "./config.js";
import { requestAppState } from "./appStateRequest.js";

// Keep an ambiguous request bound to the original durable field intent. Retrying
// must never derive permission to overwrite from a newly downloaded snapshot.
export async function sendSharedStateIntent(intent, {
  getSession, expectedActorId, isCurrentIdentity, fetchImpl = globalThis.fetch,
  resolutions, signal: cancellationSignal, requestOptions = {},
} = {}) {
  const identityError = () => Object.assign(new Error("The signed-in account changed before this save could be confirmed. The original account's pending work is preserved."), {
    code: "SHARED_STATE_IDENTITY_CHANGED", status: 401, staleIdentity: true,
  });
  const cancellationError = () => Object.assign(new Error("The save was cancelled before confirmation. Your pending changes are preserved."), {
    code: "SHARED_STATE_REQUEST_CANCELLED", cancelled: true, commitState: "unconfirmed",
  });
  const actor = typeof expectedActorId === "string" ? expectedActorId : "";
  const currentIdentity = () => {
    try { return !!actor.trim() && typeof isCurrentIdentity === "function" && isCurrentIdentity() === true; }
    catch (_) { return false; }
  };
  if (!currentIdentity() || typeof getSession !== "function") return { data: null, error: identityError() };
  if (cancellationSignal?.aborted) return { data: null, error: cancellationError() };

  // Capture the request now. Neither a later form edit nor a mutable resolutions
  // array may change the intent while session retrieval is awaiting a refresh.
  let body;
  try { body = JSON.stringify({ ...intent, ...(resolutions?.length ? { resolutions } : {}) }); }
  catch (error) { return { data: null, error }; }
  return requestAppState("shared-state-patch", async deadlineSignal => {
    const controller = new AbortController();
    const watched = [deadlineSignal, cancellationSignal].filter(Boolean);
    let settleAborted;
    const aborted = new Promise(resolve => { settleAborted = resolve; });
    const abort = () => {
      controller.abort();
      settleAborted({ data: null, error: cancellationError() });
    };
    for (const signal of watched) signal.addEventListener("abort", abort, { once: true });
    if (watched.some(signal => signal.aborted)) abort();
    const fence = () => {
      if (controller.signal.aborted) throw cancellationError();
      if (!currentIdentity()) throw identityError();
    };
    const work = async () => {
      fence();
      const result = await getSession();
      fence();
      const session = result?.data?.session;
      if (session?.user?.id !== actor) throw identityError();
      const token = session?.access_token;
      if (!token) throw Object.assign(new Error("Sign in again before saving. Your changes are still on this device."), { status: 401 });
      // getSession can finish after sign-out, after a different account signs in,
      // or even after the request deadline. Check again before any mutation.
      fence();
      const response = await fetchImpl(`${PROD_URL}/api/shared-state-patch`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body,
      });
      fence();
      const data = await response.json().catch(() => null);
      fence();
      if (response.status === 409 && data?.code === "shared-state-field-conflict") return { data, error: null };
      if (!response.ok || data?.ok !== true) return { data: null, error: Object.assign(new Error(data?.error || "The save was not confirmed. Your changes are still on this device."), { status: response.status, code: data?.code }) };
      return { data, error: null };
    };
    try { return await Promise.race([work().catch(error => ({ data: null, error })), aborted]); }
    finally { for (const signal of watched) signal.removeEventListener("abort", abort); }
  }, requestOptions);
}
