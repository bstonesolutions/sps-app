import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const {
  compareAndSetAppStateBatch,
  mutateAppState,
  NO_APP_STATE_CHANGE,
  readAppStatesVersioned,
  withAppStateRequestDeadline,
} = await import("../api/_app-state.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

test("server mutation reruns against the winner of a CAS conflict", async () => {
  let state = { value: { original: true }, version: 1 };
  let conflictOnce = true;
  let updaterCalls = 0;
  const writtenPayloads = [];

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rest/v1/app_state?")) {
      return response([{ key: "sps_clients", value: JSON.stringify(state.value), version: state.version, updated_at: null }]);
    }
    assert.match(String(url), /\/rest\/v1\/rpc\/sps_app_state_cas$/);
    const body = JSON.parse(options.body);
    writtenPayloads.push(body);
    assert.equal(typeof body.p_value, "string", "app_state must keep its JSON string representation");
    if (conflictOnce) {
      conflictOnce = false;
      state = { value: { original: true, remote: true }, version: 2 };
      return response([{ applied: false, outcome: "conflict", current_version: 2, changed_at: null }]);
    }
    assert.equal(body.p_expected_version, state.version);
    state = { value: JSON.parse(body.p_value), version: state.version + 1 };
    return response([{ applied: true, outcome: "updated", current_version: state.version, changed_at: null }]);
  };

  const result = await mutateAppState("sps_clients", (current) => {
    updaterCalls += 1;
    return { ...current, local: true };
  });

  assert.equal(result.changed, true);
  assert.equal(updaterCalls, 2);
  assert.deepEqual(state.value, { original: true, remote: true, local: true });
  assert.deepEqual(JSON.parse(writtenPayloads.at(-1).p_value), state.value);
});

test("server mutation inserts a missing key with expected version zero", async () => {
  let rpcBody = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/rest/v1/app_state?")) return response([]);
    rpcBody = JSON.parse(options.body);
    return response([{ applied: true, outcome: "inserted", current_version: 1, changed_at: null }]);
  };

  const result = await mutateAppState("sps_auto_log", () => ({ sent: true }));

  assert.equal(result.version, 1);
  assert.equal(rpcBody.p_expected_version, 0);
  assert.deepEqual(JSON.parse(rpcBody.p_value), { sent: true });
});

test("server no-change mutation performs no write", async () => {
  let writes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rest/v1/app_state?")) {
      return response([{ key: "sps_digest_log", value: JSON.stringify({ daily: "done" }), version: 4, updated_at: null }]);
    }
    writes += 1;
    return response([]);
  };

  const result = await mutateAppState("sps_digest_log", () => NO_APP_STATE_CHANGE);

  assert.equal(result.changed, false);
  assert.equal(result.version, 4);
  assert.equal(writes, 0);
});

test("server reads a related app_state baseline in one request", async () => {
  let reads = 0;
  globalThis.fetch = async (url) => {
    reads += 1;
    assert.match(String(url), /key=in\.\(sps_clients,sps_schedule,sps_invoices\)$/);
    return response([
      { key: "sps_clients", value: JSON.stringify([{ id: "c1" }]), version: 3, updated_at: null },
      { key: "sps_schedule", value: JSON.stringify([]), version: 7, updated_at: null },
    ]);
  };

  const snapshot = await readAppStatesVersioned(["sps_clients", "sps_schedule", "sps_invoices"]);

  assert.equal(reads, 1);
  assert.deepEqual(snapshot.sps_clients.value, [{ id: "c1" }]);
  assert.equal(snapshot.sps_schedule.version, 7);
  assert.equal(snapshot.sps_invoices.exists, false);
});

test("app_state request deadline aborts a stalled Supabase exchange with a stable retryable code", async () => {
  let observedSignal = null;
  let aborted = false;
  await assert.rejects(
    withAppStateRequestDeadline("batch-read", (signal) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }, {
      timeoutMs: 500,
      setTimer(callback) { setImmediate(callback); return 1; },
      clearTimer() {},
    }),
    (error) => {
      assert.equal(error.code, "APP_STATE_REQUEST_TIMEOUT");
      assert.equal(error.operation, "batch-read");
      assert.equal(error.timeoutMs, 500);
      return true;
    },
  );
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(aborted, true);
});

test("batched app_state reads bound response-body parsing as well as initial fetch", async () => {
  let observedSignal = null;
  globalThis.fetch = async (_url, options = {}) => {
    observedSignal = options.signal;
    return {
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
      text: async () => "",
    };
  };

  await assert.rejects(
    readAppStatesVersioned(["sps_clients", "sps_schedule"], {
      timeoutMs: 500,
      setTimer(callback) { setImmediate(callback); return 1; },
      clearTimer() {},
    }),
    (error) => {
      assert.equal(error.code, "APP_STATE_REQUEST_TIMEOUT");
      assert.equal(error.operation, "batch-read");
      return true;
    },
  );
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, true);
});

test("trusted server batch CAS preserves JSON-string rows and returns conflicts without partial fallback", async () => {
  let requestBody = null;
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/sps_app_state_batch_cas$/);
    requestBody = JSON.parse(options.body);
    return response([{
      applied: false,
      outcome: "conflict",
      conflict_key: "sps_catalog",
      current_versions: { sps_clients: 3, sps_catalog: 8, sps_completed: 4 },
    }]);
  };

  const result = await compareAndSetAppStateBatch([
    { key: "sps_clients", expectedVersion: 3, value: [{ id: "c1" }] },
    { key: "sps_catalog", expectedVersion: 7, value: { treatments: [] } },
    { key: "sps_completed", expectedVersion: 4, value: { s1: true } },
  ]);

  assert.equal(result.applied, false);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.conflictKey, "sps_catalog");
  assert.deepEqual(JSON.parse(requestBody.p_operations[0].value), [{ id: "c1" }]);
  assert.deepEqual(JSON.parse(requestBody.p_operations[1].value), { treatments: [] });
  assert.equal(requestBody.p_operations[1].expected_version, 7);
});

test("trusted batch CAS sends check-only fences without serializing their unchanged value", async () => {
  let requestBody = null;
  globalThis.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/sps_app_state_batch_cas$/);
    requestBody = JSON.parse(options.body);
    return response([{
      applied: true,
      outcome: "applied",
      conflict_key: null,
      current_versions: { sps_clients: 4, sps_schedule: 9 },
    }]);
  };

  await compareAndSetAppStateBatch([
    { key: "sps_clients", expectedVersion: 3, value: [{ id: "c1" }] },
    { key: "sps_schedule", expectedVersion: 9, checkOnly: true },
  ]);

  assert.deepEqual(requestBody.p_operations[0], {
    key: "sps_clients",
    expected_version: 3,
    value: JSON.stringify([{ id: "c1" }]),
  });
  assert.deepEqual(requestBody.p_operations[1], {
    key: "sps_schedule",
    expected_version: 9,
    check_only: true,
  });
  await assert.rejects(
    compareAndSetAppStateBatch([
      { key: "sps_clients", expectedVersion: 1, value: [] },
      { key: "sps_missing", expectedVersion: 0, checkOnly: true },
    ]),
    /check_requires_existing_row/,
  );
});
