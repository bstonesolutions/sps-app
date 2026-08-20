import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLETION_REQUEST_TIMEOUT_MS,
  createCompletionRequestId,
  requestCompletedStop,
} from "../completionRequest.js";

const body = () => ({
  mode: "complete",
  sid: "stop-42",
  clientId: "client-7",
  entry: { notes: "Completed safely", invoice: "$175.00" },
  idempotencyKey: "complete-stop-42-key",
});

function logger() {
  const rows = [];
  return {
    rows,
    info(message, details) { rows.push({ level: "info", message, details }); },
    warn(message, details) { rows.push({ level: "warn", message, details }); },
  };
}

test("completed-stop request preserves the exact idempotent body and records timing", async () => {
  const events = logger();
  const request = body();
  const calls = [];
  const times = [1000, 1125];
  const result = await requestCompletedStop({
    url: "https://spsway.app/api/stop-completion",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: request,
    requestId: "completion-request-1",
    logger: events,
    now: () => times.shift() ?? 1125,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, receiptId: "receipt-1" }) };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  assert.equal(calls[0].options.headers["X-Request-Id"], "completion-request-1");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(result.requestId, "completion-request-1");
  assert.equal(result.durationMs, 125);
  assert.equal(result.data.receiptId, "receipt-1");
  assert.equal(events.rows[0].details.idempotencyKey, "complete-stop-42-key");
  assert.deepEqual(events.rows.map(row => row.message), [
    "[completion-sync] request started",
    "[completion-sync] request confirmed",
  ]);
});

test("completed-stop timeout aborts the request and remains retryable", async () => {
  const events = logger();
  let abortObserved = false;
  await assert.rejects(
    requestCompletedStop({
      url: "https://spsway.app/api/stop-completion",
      body: body(),
      timeoutMs: 1000,
      requestId: "completion-timeout-1",
      logger: events,
      setTimer: (callback) => { queueMicrotask(callback); return 1; },
      clearTimer: () => {},
      fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          abortObserved = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    }),
    error => {
      assert.equal(error.status, 408);
      assert.equal(error.code, "completion-request-timeout");
      assert.equal(error.requestId, "completion-timeout-1");
      assert.match(error.message, /safe on this device and will retry automatically/i);
      return true;
    },
  );
  assert.equal(abortObserved, true);
  assert.equal(events.rows.at(-1).message, "[completion-sync] request timed out");
});

test("server rejection keeps status, code, request id, and duration for outbox review", async () => {
  const events = logger();
  const times = [500, 725];
  await assert.rejects(
    requestCompletedStop({
      url: "https://spsway.app/api/stop-completion",
      body: body(),
      requestId: "completion-rejected-1",
      logger: events,
      now: () => times.shift() ?? 725,
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, code: "completion-already-owned", error: "Another employee completed this stop." }),
      }),
    }),
    error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "completion-already-owned");
      assert.equal(error.requestId, "completion-rejected-1");
      assert.equal(error.durationMs, 225);
      return true;
    },
  );
  assert.equal(events.rows.at(-1).message, "[completion-sync] request rejected");
  assert.equal(events.rows.at(-1).details.status, 409);
});

test("request ids remain available without Web Crypto", () => {
  const id = createCompletionRequestId({
    cryptoImpl: null,
    now: () => 123456,
    random: () => 0.25,
  });
  assert.match(id, /^completion-2n9c-[a-z0-9]{7}$/);
  assert.equal(COMPLETION_REQUEST_TIMEOUT_MS, 30_000);
});
