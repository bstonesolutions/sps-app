import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: stopCompletionHandler } = await import("../api/stop-completion.js");
const { memberHasCapability, resolveStaffUser } = await import("../api/_staff-auth.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test("completeStops capability allows field edit access but rejects viewers and schedule read-only", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "edit" } }, "completeStops"), true);
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "view" } }, "completeStops"), false);
  assert.equal(memberHasCapability({ role: "viewer" }, "completeStops"), false);
  assert.equal(memberHasCapability({ role: "field", perms: { canCompleteStops: false } }, "completeStops"), false);
});

test("server roster checks treat string active/disabled flags like database policies", async () => {
  const user = { id: "auth-1", email: "tech@example.com" };
  for (const member of [
    { email: user.email, role: "field", active: "false" },
    { email: user.email, role: "field", disabled: "true" },
    { email: user.email, role: "field", status: "INACTIVE" },
  ]) {
    globalThis.fetch = async () => response([{ value: JSON.stringify([member]) }]);
    assert.equal(await resolveStaffUser(user), null);
  }
  globalThis.fetch = async () => response([{ value: JSON.stringify([{ email: user.email, role: "field", active: "true", disabled: "false" }]) }]);
  assert.equal((await resolveStaffUser(user)).teamRole, "field");
});

test("portal users and schedule read-only staff fail closed before shared stop data is read", async () => {
  for (const team of [
    [{ id: "c1", email: "owner@example.com", role: "owner" }],
    [{ id: "e1", email: "caller@example.com", role: "field", tabAccess: { schedule: "view" } }],
  ]) {
    let businessReads = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/auth/v1/user")) return response({ id: "auth-portal", email: "caller@example.com" });
      if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
      if (href.includes("/rest/v1/app_state?")) businessReads += 1;
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer caller-token" },
      body: { mode: "complete", clientId: "c1", sid: "s1", idempotencyKey: "attempt-not-authorized", entry: { invoice: "$0" } },
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(businessReads, 0);
  }
});

test("team lookup failure returns 503 and never reads or writes stop data", async () => {
  let businessRequests = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response({ error: "unavailable" }, false, 500);
    businessRequests += 1;
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: { mode: "complete", clientId: "c1", sid: "s1", idempotencyKey: "attempt-team-unavailable", entry: { invoice: "$0" } },
  }, res);

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /authorization is temporarily unavailable/i);
  assert.equal(businessRequests, 0);
});

test("field completion is validated server-side and committed through one service-role batch", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$10", history: [] }], version: 2 },
    sps_catalog: { value: { locations: [{ id: "truck", name: "Truck" }], treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 9 }, inventoryOz: "9" }], parts: [], products: [] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 7 },
  };
  let batchBody = null;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("/rest/v1/app_state?") && href.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team) }]);
    }
    if (href.includes("/rest/v1/app_state?")) {
      const match = href.match(/key=eq\.([^&]+)/);
      const key = match ? decodeURIComponent(match[1]) : "";
      const row = state[key];
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchBody = JSON.parse(options.body);
      return response([{
        applied: true,
        outcome: "applied",
        conflict_key: null,
        current_versions: { sps_clients: 3, sps_catalog: 6, sps_completed: 4, sps_schedule: 8 },
      }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const req = {
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "s1",
      idempotencyKey: "attempt-field-device-1",
      entry: {
        invoice: "$75",
        notes: "Done",
        treatmentsUsed: [{ id: "t1", name: "Treatment", unit: "oz", oz: 4, locId: "truck" }],
        partsUsed: [],
        productsPurchased: [],
      },
    },
  };
  const res = mockResponse();
  await stopCompletionHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applied, true);
  assert.deepEqual(res.body.inventoryDeducted[0].deductions, [{ locationId: "truck", amount: 4 }]);
  assert.deepEqual(batchBody.p_operations.map((operation) => operation.key).sort(), ["sps_catalog", "sps_clients", "sps_completed", "sps_schedule"]);
  assert.equal(batchBody.p_operations.find((operation) => operation.key === "sps_clients").expected_version, 2);
  assert.equal(batchBody.p_operations.find((operation) => operation.key === "sps_schedule").expected_version, 7);
  assert.deepEqual(JSON.parse(batchBody.p_operations.find((operation) => operation.key === "sps_schedule").value), state.sps_schedule.value);
  const writtenClients = JSON.parse(batchBody.p_operations.find((operation) => operation.key === "sps_clients").value);
  assert.equal(writtenClients[0].balance, "$75");
  assert.equal(writtenClients[0].history.length, 1);
});

test("server rejects completing a cancelled scheduled stop before any batch write", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", history: [] }], version: 1 },
    sps_catalog: { value: { treatments: [], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", cancelled: true }] }], version: 1 },
  };
  let batchWrites = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const match = href.match(/key=eq\.([^&]+)/);
      const key = match ? decodeURIComponent(match[1]) : "";
      const row = state[key];
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) { batchWrites += 1; return response([]); }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: { mode: "complete", clientId: "c1", sid: "s1", idempotencyKey: "attempt-cancelled-stop", entry: { invoice: "$0" } },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "stop-cancelled");
  assert.equal(batchWrites, 0);
});

test("server rejects duplicate scheduled stop IDs instead of mutating the first match", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", history: [] }, { id: "c2", history: [] }], version: 1 },
    sps_catalog: { value: { treatments: [], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "duplicate", clientId: "c1" }, { sid: "duplicate", clientId: "c2" }] }], version: 1 },
  };
  let batchWrites = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const match = href.match(/key=eq\.([^&]+)/);
      const key = match ? decodeURIComponent(match[1]) : "";
      const row = state[key];
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) { batchWrites += 1; return response([]); }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: { mode: "complete", clientId: "c1", sid: "duplicate", idempotencyKey: "attempt-duplicate-sid", entry: { invoice: "$0" } },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "stop-id-ambiguous");
  assert.equal(batchWrites, 0);
});

test("same completion key is idempotent, a competing key conflicts, and requested usage fences catalog", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
    sps_catalog: { value: { locations: [{ id: "truck", name: "Truck" }], treatments: [{ id: "t1", name: "Empty", stockByLoc: { truck: 0 }, inventoryOz: "0" }], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1" }] }], version: 1 },
  };
  let batchWrites = 0;
  let firstBatchKeys = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const match = href.match(/key=eq\.([^&]+)/);
      const key = match ? decodeURIComponent(match[1]) : "";
      const row = state[key];
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      const operations = JSON.parse(options.body).p_operations;
      if (batchWrites === 1) firstBatchKeys = operations.map((operation) => operation.key).sort();
      for (const operation of operations) {
        assert.equal(operation.expected_version, state[operation.key].version);
        state[operation.key] = { value: JSON.parse(operation.value), version: state[operation.key].version + 1 };
      }
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const invoke = async (idempotencyKey) => {
    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token" },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: "s1",
        idempotencyKey,
        entry: { invoice: "$20.00", treatmentsUsed: [{ id: "t1", name: "Empty", oz: 2, locId: "truck" }] },
      },
    }, res);
    return res;
  };

  const first = await invoke("attempt-device-one");
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.applied, true);
  assert.deepEqual(firstBatchKeys, ["sps_catalog", "sps_clients", "sps_completed", "sps_schedule"], "positive requested usage fences catalog even when actual deduction is zero");

  const retry = await invoke("attempt-device-one");
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.applied, false);
  assert.equal(retry.body.sameRequest, true);
  assert.equal(batchWrites, 1);

  const competitor = await invoke("attempt-device-two");
  assert.equal(competitor.statusCode, 409);
  assert.equal(competitor.body.code, "completion-already-owned");
  assert.match(competitor.body.error, /draft was kept/i);
  assert.equal(batchWrites, 1);
});
