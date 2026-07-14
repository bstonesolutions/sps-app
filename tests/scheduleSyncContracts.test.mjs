import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("staff schedule sync listens live and refreshes on foreground/open-page fallbacks", async () => {
  const app = await read("App.jsx");

  assert.match(app, /const SCHEDULE_SYNC_KEYS = \["sps_schedule", "sps_completed", "sps_arrivals", "sps_enroute", "sps_route_assignments", "sps_schedule_cfg"\]/);
  assert.match(app, /const SCHEDULE_REFRESH_KEYS = Array\.from\(new Set\(\[\.\.\.SCHEDULE_SYNC_KEYS, \.\.\.STOP_MUTATION_KEYS\]\)\)/);
  assert.match(app, /store\.refreshChanged\(SCHEDULE_REFRESH_KEYS, \{ reconcileUnchanged \}\)/);
  assert.match(app, /targetedKeys\.map\(\(key\) => store\.refresh\(key\)\)/);
  assert.match(app, /SCHEDULE_REFRESH_KEYS\.forEach\(\(key\) =>/);
  assert.match(app, /\(\) => pullSchedule\(\[key\]\)/);
  assert.match(app, /filter:\s*`key=eq\.\$\{key\}`/);
  assert.match(app, /addEventListener\("visibilitychange",\s*onVisible\)/);
  assert.match(app, /addEventListener\("focus",\s*onFocus\)/);
  assert.match(app, /addEventListener\("online",\s*onOnline\)/);
  assert.match(app, /addListener\("appStateChange",\s*onActive\)/);
  assert.match(app, /schedulePageRef\.current\s*===\s*"schedule"/);
  assert.match(app, /page\s*===\s*"schedule"\s*&&\s*schedulePullRef\.current/);
});

test("targeted refresh is serialized with writes and uses the dirty-aware reconcile path", async () => {
  const client = await read("supabaseClient.js");

  assert.match(client, /function enqueueRefresh\(key,[\s\S]*?const prior = _chains\[key\]/);
  assert.match(client, /\.select\("key, version"\)[\s\S]*?\.in\("key", safeKeys\)/);
  assert.match(client, /changedKeys\.map\(\(key\) => enqueueRefresh\(key, identityVersion\)\)/);
  assert.match(client, /adoptRemote\(key, remote, !_pending\[key\]\)/);
  assert.match(client, /notifyReconciled\(key, false, !remote\.exists\)/);
  assert.doesNotMatch(client, /refreshKey[\s\S]*?notifyReconciled\(key, true/);
});

test("rescheduling resolves the live stop and cannot resurrect a deleted modal snapshot", async () => {
  const app = await read("App.jsx");

  assert.match(app, /const currentDay = \(prev \|\| \[\]\)\.find[\s\S]*?String\(s\.sid\) === String\(stop\.sid\)/);
  assert.match(app, /if \(!currentDay \|\| !currentStop\) return prev/);
  assert.match(app, /const moved = \{ \.\.\.currentStop,/);
  assert.doesNotMatch(app, /const moved = \{ \.\.\.stop, cancelled: false, rescheduledFrom:/);
});
