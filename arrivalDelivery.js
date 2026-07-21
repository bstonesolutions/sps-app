// One arrival can be presented by the Schedule button and by native/foreground detection at the
// same time. Keep the complete confirmation workflow shared by stop so two sheets (or a fast
// double tap) cannot post two portal notices or ask the server to send two texts.
const arrivalAttempts = new Map();

export function arrivalDeliveryKey(stopId) {
  const sid = String(stopId == null ? "" : stopId).trim();
  if (!sid) return "";
  return `arrival:${encodeURIComponent(sid)}:sms`;
}

export function runArrivalDeliveryOnce(stopId, factory) {
  const key = arrivalDeliveryKey(stopId);
  if (!key) return Promise.reject(new Error("arrival_stop_required"));
  if (typeof factory !== "function") return Promise.reject(new TypeError("arrival_factory_required"));
  const existing = arrivalAttempts.get(key);
  if (existing) return existing;

  // Install the promise before the factory's first instruction. That makes the guard synchronous
  // even though React has not had time to render its disabled state yet.
  const attempt = Promise.resolve().then(factory).catch((error) => ({
    portal: null,
    sms: {
      ok: false,
      accepted: false,
      held: false,
      uncertain: true,
      retrySafe: false,
      error: error && error.message ? error.message : "Arrival delivery could not be confirmed.",
    },
  }));
  // Keep every settled result for this app session. A user must check Comms before deliberately
  // sending anything else; silently clearing an error here would recreate the duplicate-text race.
  arrivalAttempts.set(key, attempt);
  return attempt;
}

// Exported only to keep the coalescer deterministic in unit tests. Production never clears a
// completed arrival attempt during the running app session.
export function resetArrivalDeliveriesForTests() {
  arrivalAttempts.clear();
}
