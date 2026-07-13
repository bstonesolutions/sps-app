// Choose the one stop that is explicitly active for geofence arrival.
// `sps_enroute` keeps historical start times so completed-stop duration remains accurate;
// the newest "Head Here" timestamp is therefore the active stop. If that newest stop has
// already arrived or completed, no older stop is allowed to become active again.
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
  if ((arrivals && arrivals[active.sid]) || (completedSids && completedSids[active.sid])) return null;
  return active;
}
