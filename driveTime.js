const makeDriveTimeError = (code, message, cause) => {
  const error = new Error(message || code || "Drive time unavailable");
  error.code = code || "drive_time_unavailable";
  if (cause) error.cause = cause;
  return error;
};

export function withDeadline(promise, timeoutMs, code = "drive_time_timeout") {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(makeDriveTimeError(code, "The drive-time request timed out.")), timeoutMs);
    Promise.resolve(promise).then(resolve, reject);
  }).finally(() => { if (timer) clearTimeout(timer); });
}

// WebKit's geolocation timeout has not been dependable across every iOS release. Keep an outer
// deadline as well so a denied/restricted/native prompt can never leave the staff modal spinning.
export function getCurrentPositionWithDeadline(geolocation, options = {}, timeoutMs = 12000, signal = null) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
    return Promise.reject(makeDriveTimeError("location_unavailable", "Location is not available on this device."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const onAbort = () => finish(reject, makeDriveTimeError("drive_time_cancelled", "Drive-time calculation was cancelled."));
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    if (signal && signal.aborted) { finish(reject, makeDriveTimeError("drive_time_cancelled", "Drive-time calculation was cancelled.")); return; }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(reject, makeDriveTimeError("location_timeout", "Location took too long.")), timeoutMs);
    try {
      geolocation.getCurrentPosition(
        (position) => finish(resolve, position),
        (error) => {
          const code = Number(error && error.code);
          if (code === 1) finish(reject, makeDriveTimeError("location_denied", "Location access is off.", error));
          else if (code === 3) finish(reject, makeDriveTimeError("location_timeout", "Location took too long.", error));
          else finish(reject, makeDriveTimeError("location_unavailable", "Your current location could not be read.", error));
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: Math.max(1000, timeoutMs - 1000), ...options },
      );
    } catch (error) {
      finish(reject, makeDriveTimeError("location_unavailable", "Your current location could not be read.", error));
    }
  });
}

// Use the callback form for compatibility with older Maps JS builds, but still accept a returned
// Promise. A hard deadline covers SDK requests that neither invoke the callback nor reject.
export function requestGoogleDrivingRoute(maps, request, timeoutMs = 12000, signal = null) {
  if (!maps || typeof maps.DirectionsService !== "function") {
    return Promise.reject(makeDriveTimeError("maps_unavailable", "Google Maps did not load."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const onAbort = () => finish(reject, makeDriveTimeError("drive_time_cancelled", "Drive-time calculation was cancelled."));
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    if (signal && signal.aborted) { finish(reject, makeDriveTimeError("drive_time_cancelled", "Drive-time calculation was cancelled.")); return; }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(reject, makeDriveTimeError("route_timeout", "The route request took too long.")), timeoutMs);
    const callback = (result, status) => {
      const ok = status === "OK" || status === (maps.DirectionsStatus && maps.DirectionsStatus.OK);
      if (ok && result) finish(resolve, result);
      else finish(reject, makeDriveTimeError("route_failed", `Google Maps could not calculate this route${status ? ` (${status})` : ""}.`));
    };
    try {
      const returned = new maps.DirectionsService().route(request, callback);
      if (returned && typeof returned.then === "function") {
        returned.then((result) => finish(resolve, result), (error) => finish(reject, makeDriveTimeError("route_failed", "Google Maps could not calculate this route.", error)));
      }
    } catch (error) {
      finish(reject, makeDriveTimeError("route_failed", "Google Maps could not calculate this route.", error));
    }
  });
}

export function summarizeGoogleRoute(result) {
  const leg = result && result.routes && result.routes[0] && result.routes[0].legs && result.routes[0].legs[0];
  if (!leg) throw makeDriveTimeError("route_empty", "No driving route was returned.");
  const seconds = Number((leg.duration_in_traffic && leg.duration_in_traffic.value) || (leg.duration && leg.duration.value));
  if (!Number.isFinite(seconds) || seconds <= 0) throw makeDriveTimeError("route_empty", "No drive time was returned.");
  const distanceMeters = Number(leg.distance && leg.distance.value);
  return {
    minutes: Math.max(1, Math.round(seconds / 60)),
    distanceMiles: Number.isFinite(distanceMeters) && distanceMeters >= 0
      ? Math.round((distanceMeters / 1609.344) * 10) / 10
      : null,
    trafficAware: !!(leg.duration_in_traffic && leg.duration_in_traffic.value),
  };
}

export function driveTimeErrorMessage(error) {
  const code = String((error && error.code) || "");
  if (code === "location_denied") return "Location access is off. Turn it on for SPS Way, then retry.";
  if (code === "location_timeout" || code === "location_unavailable") return "Current location wasn't available. Check Location Services, then retry.";
  if (code === "route_not_configured") return "Live drive time needs its server map key configured.";
  if (code === "route_not_found") return "No driving route was found for this address.";
  return "Live drive time couldn't be calculated. Retry or choose an arrival time below.";
}
