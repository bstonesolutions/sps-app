import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const main = await readFile(new URL("../main.jsx", import.meta.url), "utf8");
const liveTrack = await readFile(new URL("../api/live-track.js", import.meta.url), "utf8");

test("arrival setup never grants live-location consent", () => {
  const start = app.indexOf("const enableFieldAlerts = async () =>");
  const end = app.indexOf("const disableArrivalPrompts = async () =>", start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);
  assert.match(source, /sps_arrival_prompts_enabled/);
  assert.doesNotMatch(source, /sps_loc_consent/);
});

test("clock-out is a durable live-location pause", () => {
  assert.match(app, /const LIVE_LOCATION_PAUSED_KEY = "sps_live_location_paused"/);
  assert.match(app, /localStorage\.setItem\(LIVE_LOCATION_PAUSED_KEY, "1"\)/);
  assert.match(app, /if \(localStorage\.getItem\(LIVE_LOCATION_PAUSED_KEY\) === "1"\) return null/);
  assert.match(app, /localStorage\.removeItem\(LIVE_LOCATION_PAUSED_KEY\)/);
});

test("client tracking links are persisted before notification delivery", () => {
  const headStart = app.indexOf("function HeadHereModal(");
  const headEnd = app.indexOf("// ─────────────────────────────────────────────\n// ROUTE ASSIGNMENTS", headStart);
  const head = app.slice(headStart, headEnd);
  assert.ok(head.indexOf("await onPrepareTracking()") < head.indexOf("await sendSms("));

  const arrivedStart = app.indexOf("function ArrivedModal(");
  const arrivedEnd = app.indexOf("// ─────────────────────────────────────────────\n// PHOTO VIEWER", arrivedStart);
  const arrived = app.slice(arrivedStart, arrivedEnd);
  assert.ok(arrived.indexOf("await onValidate()") < arrived.indexOf("runArrivalDeliveryOnce("));
  assert.ok(arrived.indexOf("await onPrepareTracking()") < arrived.indexOf("runArrivalDeliveryOnce("));
  assert.match(app, /const headToNext = \(\) => \{ if \(!nextStop\) return; setHeadHereModal\(\{ stop: \{ \.\.\.nextStop, trackToken: ensureTrackToken\(nextStop\) \}/);
});

test("live-location database failures reach field readiness", () => {
  assert.match(app, /if \(error\) throw error/);
  assert.match(app, /Your live location couldn't reach SPS Way/);
  assert.doesNotMatch(app, /\.then\(\(\) => \{\}, \(\) => \{\}\)/);
});

test("unexpected auth sign-out clears native customer state", () => {
  assert.match(app, /export async function cleanupNativeSessionAfterUnexpectedSignOut/);
  assert.match(app, /clearNativeArrival\(\)/);
  assert.match(app, /unregisterNativeDevicePush\(\)/);
  assert.match(main, /await cleanupNativeSessionAfterUnexpectedSignOut\(\)/);
  assert.match(main, /sessionStorage\.getItem\(SIGNOUT_CLEANUP_MARKER\)/);
});

test("sign-out stops live location before auth is removed and stale public coordinates expire quickly", () => {
  assert.match(app, /const activeLocationStaffId = pauseLocalLiveLocation\(\)/);
  assert.match(app, /await invalidateAndDrainLiveLocationWrites\(\)/);
  assert.match(app, /return deactivateServerLiveLocation\(activeLocationStaffId\)/);
  assert.match(app, /queueLiveLocationWrite\(writeEpoch/);
  const signOutStart = app.indexOf("const handleSignOut = async () =>");
  const signOutEnd = app.indexOf("const resetAppMainScroll", signOutStart);
  const signOut = app.slice(signOutStart, signOutEnd);
  assert.ok(signOut.indexOf("deactivateServerLiveLocation") < signOut.indexOf("await onSignOut()"));
  assert.match(signOut, /!locationCleared\?\.ok/);
  assert.match(liveTrack, /ageMs >= 0 && ageMs < 90 \* 1000/);
});
