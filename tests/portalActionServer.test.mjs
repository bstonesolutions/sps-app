import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: portalActionHandler } = await import("../api/portal-action.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function makeRes() {
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

function portalRequest(action, payload) {
  return {
    method: "POST",
    headers: { authorization: "Bearer client-token" },
    body: { action, payload },
  };
}

function installStateFetch(initial) {
  const state = new Map(Object.entries(initial).map(([key, value]) => [key, { value, version: 1 }]));
  const calls = { cas: 0, batch: 0 };

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "user-1", email: "client@example.test" });
    }
    if (target.endsWith("/rest/v1/rpc/sps_app_state_cas")) {
      calls.cas += 1;
      const body = JSON.parse(options.body);
      const row = state.get(body.p_key);
      const actualVersion = row ? row.version : 0;
      if (actualVersion !== body.p_expected_version) {
        return response([{ applied: false, outcome: "conflict", current_version: actualVersion, changed_at: null }]);
      }
      state.set(body.p_key, { value: JSON.parse(body.p_value), version: actualVersion + 1 });
      return response([{ applied: true, outcome: "updated", current_version: actualVersion + 1, changed_at: null }]);
    }
    if (target.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      calls.batch += 1;
      const body = JSON.parse(options.body);
      const operations = body.p_operations || [];
      const conflict = operations.find((operation) => (state.get(operation.key)?.version || 0) !== operation.expected_version);
      if (conflict) {
        return response([{ applied: false, outcome: "conflict", conflict_key: conflict.key, current_versions: {} }]);
      }
      for (const operation of operations) {
        const currentVersion = state.get(operation.key)?.version || 0;
        state.set(operation.key, { value: JSON.parse(operation.value), version: currentVersion + 1 });
      }
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    if (target.includes("/rest/v1/app_state?")) {
      const parsed = new URL(target);
      const rawKey = parsed.searchParams.get("key") || "";
      const key = rawKey.startsWith("eq.") ? rawKey.slice(3) : "";
      const row = state.get(key);
      return response(row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : []);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  return {
    calls,
    value(key) { return state.get(key)?.value; },
    replace(key, value) {
      const currentVersion = state.get(key)?.version || 0;
      state.set(key, { value, version: currentVersion + 1 });
    },
  };
}

const client = (overrides = {}) => ({
  id: "client-1",
  name: "Client One",
  email: "client@example.test",
  auth_user_id: "user-1",
  history: [],
  ...overrides,
});

test("a low rating and its office alert commit atomically and retry without duplicates", async () => {
  const harness = installStateFetch({
    sps_clients: [client({
      history: [
        { sid: "stop-1", date: "7/12/2026", type: "Morning Visit" },
        { sid: "stop-2", date: "7/12/2026", type: "Afternoon Visit" },
      ],
    })],
    sps_officeAlerts: [],
  });
  const req = portalRequest("rateVisit", { sid: "stop-2", rating: 2, feedback: "Please call me." });

  const first = makeRes();
  await portalActionHandler(req, first);
  const second = makeRes();
  await portalActionHandler(req, second);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(harness.calls.batch, 1);
  assert.equal(harness.calls.cas, 0);
  const history = harness.value("sps_clients")[0].history;
  assert.equal(history[0].clientRating, undefined);
  assert.equal(history[1].clientRating, 2);
  const alerts = harness.value("sps_officeAlerts");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "feedback");
  assert.equal(first.body.alert.id, alerts[0].id);
  assert.equal(second.body.alert.id, alerts[0].id);
  assert.deepEqual(first.body.visitRef, { field: "sid", value: "stop-2" });
  assert.equal(second.body.ratedAt, first.body.ratedAt);
  assert.deepEqual(second.body, first.body);

  // Resolving/removing the staff alert later must not let a replay recreate it.
  harness.replace("sps_officeAlerts", []);
  const third = makeRes();
  await portalActionHandler(req, third);
  assert.deepEqual(third.body, first.body);
  assert.equal(harness.calls.batch, 1);
  assert.deepEqual(harness.value("sps_officeAlerts"), []);
});

test("legacy date-only rating fails closed when more than one visit shares the date", async () => {
  const harness = installStateFetch({
    sps_clients: [client({ history: [
      { date: "7/12/2026", type: "Morning Visit" },
      { date: "7/12/2026", type: "Afternoon Visit" },
    ] })],
  });
  const res = makeRes();
  await portalActionHandler(portalRequest("rateVisit", { visitDate: "7/12/2026", rating: 5 }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /more than one visit/i);
  assert.equal(harness.calls.cas, 0);
  assert.equal(harness.calls.batch, 0);
});

test("preference patches merge into the latest server value instead of replacing it", async () => {
  const harness = installStateFetch({
    sps_clients: [client({ notifyPrefs: { serviceReminders: true, invoiceReady: true, channels: { text: true, email: true } } })],
  });
  const first = makeRes();
  await portalActionHandler(portalRequest("savePrefs", { notifyPrefsPatch: { serviceReminders: false } }), first);
  const second = makeRes();
  await portalActionHandler(portalRequest("savePrefs", { notifyPrefsPatch: { channels: { email: false } } }), second);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(harness.value("sps_clients")[0].notifyPrefs, {
    serviceReminders: false,
    invoiceReady: true,
    channels: { text: true, email: false },
  });
  assert.deepEqual(second.body.notifyPrefs, harness.value("sps_clients")[0].notifyPrefs);
});

test("a declined estimate cannot be approved by the portal", async () => {
  const harness = installStateFetch({
    sps_clients: [client()],
    sps_estimates: [{ id: "estimate-1", clientId: "client-1", status: "declined" }],
  });
  const res = makeRes();
  await portalActionHandler(portalRequest("approveEstimate", { id: "estimate-1", status: "approved" }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /only a sent estimate/i);
  assert.equal(harness.calls.cas, 0);
  assert.equal(harness.value("sps_estimates")[0].status, "declined");
});

test("estimate approval echoes its stable id and fails closed on duplicate owned ids", async () => {
  const approvedHarness = installStateFetch({
    sps_clients: [client()],
    sps_estimates: [{ id: "estimate-1", clientId: "client-1", status: "sent" }],
  });
  const approved = makeRes();
  await portalActionHandler(portalRequest("approveEstimate", { id: "estimate-1" }), approved);

  assert.equal(approved.statusCode, 200);
  assert.deepEqual(approved.body, { ok: true, id: "estimate-1", status: "approved" });
  assert.equal(approvedHarness.value("sps_estimates")[0].status, "approved");

  const duplicateHarness = installStateFetch({
    sps_clients: [client()],
    sps_estimates: [
      { id: "estimate-duplicate", clientId: "client-1", status: "sent", total: "100" },
      { id: "estimate-duplicate", clientId: "client-1", status: "sent", total: "200" },
    ],
  });
  const duplicate = makeRes();
  await portalActionHandler(portalRequest("approveEstimate", { id: "estimate-duplicate" }), duplicate);

  assert.equal(duplicate.statusCode, 409);
  assert.match(duplicate.body.error, /not unique/i);
  assert.equal(duplicateHarness.calls.cas, 0);
  assert.deepEqual(duplicateHarness.value("sps_estimates").map((estimate) => estimate.status), ["sent", "sent"]);
});
