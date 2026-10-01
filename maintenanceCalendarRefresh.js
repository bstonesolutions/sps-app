// Coalesce focus/timer/manual refreshes and avoid retry storms while switching tabs.
export function createMaintenanceRefreshController({ refresh, now = Date.now, minimumIntervalMs = 60_000 }) {
  let running = null;
  let lastAttempt = -Infinity;
  let stopped = false;
  return {
    request({ force = false } = {}) {
      if (stopped) return Promise.resolve(null);
      if (running) return running;
      if (!force && now() - lastAttempt < minimumIntervalMs) return Promise.resolve(null);
      running = Promise.resolve().then(() => {
        if (stopped) return null;
        lastAttempt = now();
        return refresh();
      }).finally(() => { running = null; });
      return running;
    },
    stop() { stopped = true; },
  };
}
