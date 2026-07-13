import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const {
  compareAndSetAppStateBatch,
  mutateAppState,
  NO_APP_STATE_CHANGE,
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
