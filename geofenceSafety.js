function isCancelledStop(stop) {
  if (!stop) return false;
  const status = String(stop.status || "").trim().toLowerCase();
  return stop.cancelled === true
    || stop.canceled === true
    || status === "cancelled"
    || status === "canceled";
}

function hasUsableAddress(stop) {
  return !!String((stop && stop.address) || "").trim();
}

// Choose the one stop that is explicitly active for geofence arrival.
// `sps_enroute` keeps historical start times so completed-stop duration remains accurate;
// the newest "Head Here" timestamp is therefore the active stop. If that newest stop has
// already arrived, completed, or been cancelled, no older stop is allowed to become active again.
export function selectActiveEnRouteStop(stops, enRoute, arrivals, completedSids) {
  const candidates = (Array.isArray(stops) ? stops : [])
    .map((stop, index) => {
      const sid = stop && stop.sid;
      const startedAt = sid && enRoute ? enRoute[sid] : null;
      if (!sid || !startedAt) return null;
      const parsedAt = Date.parse(String(startedAt));
      return { stop, index, startedAt: Number.isFinite(parsedAt) ? parsedAt : 0 };
    })
    .filter(Boolean)
    .sort((a, b) => (b.startedAt - a.startedAt) || (b.index - a.index));

  const active = candidates[0] && candidates[0].stop;
  if (!active) return null;
  if (isCancelledStop(active)) return null;
  if ((arrivals && arrivals[active.sid]) || (completedSids && completedSids[active.sid])) return null;
  return active;
}

// Pick the one stop iOS should watch for an arrival prompt. An explicit "Head Here" stop wins;
// otherwise watch the next unfinished stop in route order so a tech who simply pulls into the next
// property still gets prompted. This is deliberately a PROMPT candidate only — selecting a stop
// here must never mark it arrived or contact the client.
export function selectArrivalWatchStop(stops, enRoute, arrivals, completedSids) {
  const list = Array.isArray(stops) ? stops : [];
  const explicit = selectActiveEnRouteStop(list, enRoute, arrivals, completedSids);
  // A Head Here record without a usable destination cannot be monitored. Let route order choose
  // the next valid assigned stop instead of allowing that stale record to disable arrival prompts.
  if (explicit && hasUsableAddress(explicit)) return explicit;
  return list.find((stop) => {
    const sid = stop && stop.sid;
    if (!sid || isCancelledStop(stop) || !hasUsableAddress(stop)) return false;
    return !(arrivals && arrivals[sid]) && !(completedSids && completedSids[sid]);
  }) || null;
}

// Foreground geolocation is a fallback for the native iOS region monitor. After a tech dismisses
// a false positive, keep the fence latched until they move beyond a wider exit boundary; only a
// later re-entry may prompt again. The wider boundary prevents GPS jitter at the driveway from
// immediately reopening the sheet.
export function foregroundFenceTransition(distanceMiles, state = {}, enterMiles = 0.07, exitMiles = 0.1) {
  const distance = Number(distanceMiles);
  const fired = !!state.fired;
  const waitForExit = !!state.waitForExit;
  if (!Number.isFinite(distance) || distance < 0) return { fired, waitForExit, prompt: false };

  if (waitForExit) {
    if (distance >= exitMiles) return { fired: false, waitForExit: false, prompt: false };
    return { fired: true, waitForExit: true, prompt: false };
  }
  if (fired) return { fired: true, waitForExit: false, prompt: false };
  if (distance <= enterMiles) return { fired: true, waitForExit: false, prompt: true };
  return { fired: false, waitForExit: false, prompt: false };
}
