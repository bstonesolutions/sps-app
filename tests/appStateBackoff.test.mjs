import test from "node:test";
import assert from "node:assert/strict";

import {
  APP_STATE_RETRY_MAX_MS,
  isTransientAppStateError,
  nextAppStateRetry,
} from "../appStateBackoff.js";

test("app-state retry classification includes gateway, timeout, and connection failures", () => {
  assert.equal(isTransientAppStateError({ status: 522, message: "Connection timed out" }), true);
  assert.equal(isTransientAppStateError({ status: 503, message: "Service unavailable" }), true);
  assert.equal(isTransientAppStateError({ code: "57014", message: "canceling statement due to statement timeout" }), true);
  assert.equal(isTransientAppStateError(new TypeError("Failed to fetch")), true);
});

test("authorization, validation, and merge errors do not enter the outage retry lane", () => {
  assert.equal(isTransientAppStateError({ status: 401, message: "JWT expired" }), false);
  assert.equal(isTransientAppStateError({ status: 403, message: "permission denied for table app_state" }), false);
  assert.equal(isTransientAppStateError({ status: 400, message: "invalid input syntax" }), false);
  assert.equal(isTransientAppStateError({ status: 409, message: "version conflict" }), false);
});

test("app-state retry delay grows exponentially with bounded jitter and a five-minute cap", () => {
  const now = 1_000_000;
  const first = nextAppStateRetry(0, { now, random: () => 0.5 });
  const second = nextAppStateRetry(first.retryCount, { now, random: () => 0.5 });
  const third = nextAppStateRetry(second.retryCount, { now, random: () => 0.5 });
  const capped = nextAppStateRetry(20, { now, random: () => 1 });

  assert.deepEqual(first, { retryCount: 1, delayMs: 5_000, retryAt: now + 5_000 });
  assert.equal(second.delayMs, 10_000);
  assert.equal(third.delayMs, 20_000);
  assert.equal(capped.delayMs, APP_STATE_RETRY_MAX_MS);
  assert.equal(capped.retryAt, now + APP_STATE_RETRY_MAX_MS);

  const lowJitter = nextAppStateRetry(3, { now, random: () => 0 });
  const highJitter = nextAppStateRetry(3, { now, random: () => 1 });
  assert.ok(lowJitter.delayMs >= 5_000);
  assert.ok(highJitter.delayMs <= APP_STATE_RETRY_MAX_MS);
  assert.ok(lowJitter.delayMs < highJitter.delayMs);
});
