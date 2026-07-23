import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LIVE_LOCATION_HEARTBEAT_MS,
  LIVE_LOCATION_MIN_MOVE_METERS,
  liveLocationAccuracyBand,
  liveLocationDistanceMeters,
  shouldWriteLiveLocation,
} from "../liveLocationThrottle.js";

const base = {
  lat: 40,
  lng: -75,
  accuracy: 12,
  status: "active",
  at: 1_000,
};

test("live-location writes immediately for the first valid sample", () => {
  assert.equal(shouldWriteLiveLocation(null, base, base.at), true);
  assert.equal(shouldWriteLiveLocation(base, null, base.at), false);
});

test("stationary GPS jitter stays local until the 90-second heartbeat", () => {
  const jitter = { ...base, lat: 40.00008, at: 30_000 };
  assert.ok(liveLocationDistanceMeters(base, jitter) < LIVE_LOCATION_MIN_MOVE_METERS);
  assert.equal(shouldWriteLiveLocation(base, jitter, 30_000), false);
  assert.equal(shouldWriteLiveLocation(base, jitter, base.at + LIVE_LOCATION_HEARTBEAT_MS), true);
});

test("moving about 40 meters triggers a new server location", () => {
  const moved = { ...base, lat: 40.0004, at: 20_000 };
  assert.ok(liveLocationDistanceMeters(base, moved) >= LIVE_LOCATION_MIN_MOVE_METERS);
  assert.equal(shouldWriteLiveLocation(base, moved, moved.at), true);
});

test("material accuracy and activity changes bypass the heartbeat", () => {
  assert.equal(liveLocationAccuracyBand(12), "precise");
  assert.equal(liveLocationAccuracyBand(45), "usable");
  assert.equal(liveLocationAccuracyBand(100), "coarse");
  assert.equal(liveLocationAccuracyBand(null), "unknown");
  assert.equal(shouldWriteLiveLocation(base, { ...base, accuracy: 45 }, 2_000), true);
  assert.equal(shouldWriteLiveLocation(base, { ...base, status: "paused" }, 2_000), true);
});

test("small changes within the same accuracy band do not write", () => {
  assert.equal(shouldWriteLiveLocation(base, { ...base, accuracy: 18 }, 2_000), false);
});

test("the app evaluates foreground arrival before deciding whether to write", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const callbackStart = app.indexOf("navigator.geolocation.watchPosition(");
  const callbackEnd = app.indexOf("onLocationError(error?.code", callbackStart);
  const callback = app.slice(callbackStart, callbackEnd);

  const fenceEvaluation = callback.indexOf("foregroundFenceTransition(");
  const writeDecision = callback.indexOf("shouldWriteLiveLocation(lastBroadcast, sample, t)");
  assert.ok(fenceEvaluation >= 0, "foreground geofence evaluation is present");
  assert.ok(writeDecision > fenceEvaluation, "arrival evaluation happens before the database throttle");
  assert.doesNotMatch(callback, /t - lastSent < 30000/);
  assert.match(callback, /lastBroadcast = sample;/);
});
