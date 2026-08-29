import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.STOP_COMPLETION_FETCH_TIMEOUT_MS = "250";

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

function observableResponse() {
  const res = mockResponse();
  const listeners = new Map();
  res.once = function once(event, listener) {
    listeners.set(event, listener);
    return this;
  };
  const emitFinish = () => {
    const listener = listeners.get("finish");
    if (listener) {
      listeners.delete("finish");
      listener();
    }
  };
  res.json = function json(body) {
    this.body = body;
    emitFinish();
    return this;
  };
  res.end = function end() {
    emitFinish();
    return this;
  };
  return res;
}

function requestedStateKeys(href) {
  const equals = href.match(/key=eq\.([^&]+)/);
  if (equals) return [decodeURIComponent(equals[1])];
  const included = href.match(/key=in\.\(([^)]*)\)/);
  return included && included[1]
    ? included[1].split(",").map((key) => decodeURIComponent(key))
    : [];
}

function stateRows(href, state) {
  return requestedStateKeys(href).flatMap((key) => {
    const row = state[key];
    return row ? [{ key, value: JSON.stringify(row.value), version: row.version, updated_at: null }] : [];
  });
}

function applyBatchOperations(state, operations) {
  for (const operation of operations) {
    const current = state[operation.key] || { version: 0 };
    assert.equal(operation.expected_version, current.version);
    if (operation.check_only) {
      assert.equal(Object.prototype.hasOwnProperty.call(operation, "value"), false);
      continue;
    }
    assert.equal(Object.prototype.hasOwnProperty.call(operation, "value"), true);
    state[operation.key] = { value: JSON.parse(operation.value), version: current.version + 1 };
  }
}

test("completeStops capability allows field edit access but rejects viewers and schedule read-only", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "edit" } }, "completeStops"), true);
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "view" } }, "completeStops"), false);
  assert.equal(memberHasCapability({ role: "viewer" }, "completeStops"), false);
  assert.equal(memberHasCapability({ role: "field", perms: { canCompleteStops: false } }, "completeStops"), false);
});

test("completion endpoint reflects a safe request id and exposes it through CORS", async () => {
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  try {
    const res = observableResponse();
    await stopCompletionHandler({
      method: "OPTIONS",
      headers: { "x-request-id": "completion-preflight-1" },
    }, res);

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["X-Request-Id"], "completion-preflight-1");
    assert.match(res.headers["Access-Control-Allow-Headers"], /X-Request-Id/);
    assert.equal(res.headers["Access-Control-Expose-Headers"], "X-Request-Id");
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0][1]);
    assert.equal(event.requestId, "completion-preflight-1");
    assert.equal(event.status, 204);
    assert.equal(event.event, "request_finished");
    assert.equal(typeof event.durationMs, "number");
  } finally {
    console.info = originalInfo;
  }
});

test("completion endpoint replaces an unsafe request id instead of logging or reflecting it", async () => {
  const res = mockResponse();
  await stopCompletionHandler({
    method: "OPTIONS",
    headers: { "x-request-id": "bad request id\nforged" },
  }, res);

  assert.match(res.headers["X-Request-Id"], /^stop-[0-9a-f-]{36}$/);
  assert.doesNotMatch(res.headers["X-Request-Id"], /bad|forged/);
});

test("a stalled shared-state read returns a retryable 504 before the client outbox deadline", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  let baselineAborted = false;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("key=in.(")) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          baselineAborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: {
        authorization: "Bearer field-token",
        "x-request-id": "completion-timeout-server-1",
      },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: "s1",
        idempotencyKey: "attempt-timeout-server-1",
        entry: { invoice: "$0" },
      },
    }, res);

    assert.equal(baselineAborted, true);
    assert.equal(res.statusCode, 504);
    assert.equal(res.body.code, "shared-data-timeout");
    assert.equal(res.body.requestId, "completion-timeout-server-1");
    assert.match(res.body.error, /retry automatically/i);
    assert.equal(res.headers["X-Request-Id"], "completion-timeout-server-1");
    assert.equal(logs.length, 1);
    const event = JSON.parse(logs[0][1]);
    assert.equal(event.requestId, "completion-timeout-server-1");
    assert.equal(event.code, "APP_STATE_REQUEST_TIMEOUT");
    assert.equal(event.operation, "batch-read");
  } finally {
    console.error = originalError;
  }
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
  let baselineReads = 0;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("/rest/v1/app_state?") && href.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify(team) }]);
    }
    if (href.includes("/rest/v1/app_state?")) {
      if (href.includes("key=in.(")) baselineReads += 1;
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchBody = JSON.parse(options.body);
      applyBatchOperations(state, batchBody.p_operations);
      return response([{
        applied: true,
        outcome: "applied",
        conflict_key: null,
        current_versions: { sps_clients: 3, sps_catalog: 6, sps_completed: 4, sps_schedule: 7 },
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
  assert.equal(baselineReads, 1, "all related app_state rows are read in one baseline request");
  assert.equal(res.body.invoiceOutcome.status, "created");
  assert.equal(res.body.invoiceOutcome.kind, "one-off");
  assert.deepEqual(res.body.inventoryDeducted[0].deductions, [{ locationId: "truck", amount: 4 }]);
  assert.deepEqual(batchBody.p_operations.map((operation) => operation.key).sort(), ["sps_catalog", "sps_clients", "sps_completed", "sps_invoices", "sps_maintenance_billing", "sps_schedule"]);
  assert.equal(batchBody.p_operations.find((operation) => operation.key === "sps_clients").expected_version, 2);
  const scheduleFence = batchBody.p_operations.find((operation) => operation.key === "sps_schedule");
  assert.deepEqual(scheduleFence, { key: "sps_schedule", expected_version: 7, check_only: true });
  const writtenClients = JSON.parse(batchBody.p_operations.find((operation) => operation.key === "sps_clients").value);
  assert.equal(writtenClients[0].balance, "$75");
  assert.equal(writtenClients[0].history.length, 1);
  const writtenInvoices = JSON.parse(batchBody.p_operations.find((operation) => operation.key === "sps_invoices").value);
  assert.equal(writtenInvoices.length, 1);
  assert.equal(writtenInvoices[0].id, "iv_stop_s1");
  assert.equal(writtenInvoices[0].status, "Draft");
  assert.equal(writtenInvoices[0].lineItems[0].unitPrice, "75");
  assert.equal(state.sps_schedule.version, 7, "the unchanged schedule fence is not rewritten or versioned");
  assert.equal(state.sps_clients.version, 3);
  assert.equal(state.sps_catalog.version, 6);
  assert.equal(state.sps_completed.version, 4);
  assert.equal(state.sps_invoices.version, 1);
  assert.equal(state.sps_maintenance_billing.version, 1);
});

test("a lost batch response is confirmed from authoritative state and returned as success", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
    sps_catalog: {
      value: {
        locations: [{ id: "truck", name: "Truck" }],
        treatments: [{ id: "t1", name: "Treatment", unit: "oz", inventoryOz: "5", stockByLoc: { truck: 5 } }],
        parts: [],
        products: [],
      },
      version: 1,
    },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 1 },
    sps_invoices: { value: [], version: 1 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 2000, dueDays: 15, taxRate: "6" }, version: 1 },
  };
  let batchWrites = 0;
  const stateReadKeySets = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      stateReadKeySets.push(requestedStateKeys(href).sort());
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      const operations = JSON.parse(options.body).p_operations;
      applyBatchOperations(state, operations);
      throw new TypeError("fetch failed after commit");
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token", "x-request-id": "completion-lost-response-1" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "s1",
      idempotencyKey: "attempt-lost-response-1",
      entry: {
        invoice: "$75",
        notes: "Done",
        treatmentsUsed: [{ id: "t1", name: "Treatment", unit: "oz", oz: 2, locId: "truck" }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.confirmedAfterUncertainWrite, true);
  assert.match(res.body.receiptId, /^stop-s1-/);
  assert.equal(res.body.clientName, "Client");
  assert.equal(res.body.invoiceOutcome.status, "created");
  assert.equal(res.body.invoiceOutcome.invoiceId, "iv_stop_s1");
  assert.deepEqual(res.body.inventoryDeducted[0].deductions, [{ locationId: "truck", amount: 2 }]);
  assert.equal(batchWrites, 1);
  assert.equal(stateReadKeySets.length, 2);
  assert.deepEqual(stateReadKeySets[1], ["sps_clients", "sps_completed", "sps_invoices"]);
  assert.equal(state.sps_clients.value[0].history.length, 1);
  assert.equal(state.sps_invoices.value.length, 1);
  assert.equal(state.sps_invoices.value[0].id, "iv_stop_s1");
  assert.equal(state.sps_catalog.value.treatments[0].stockByLoc.truck, 3);
});

test("a pre-commit batch timeout returns an unconfirmed retryable result without claiming no change", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
    sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 1 },
    sps_invoices: { value: [], version: 1 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 2000, dueDays: 15, taxRate: "6" }, version: 1 },
  };
  let batchWrites = 0;
  let batchAborted = false;
  const stateReadKeySets = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      stateReadKeySets.push(requestedStateKeys(href).sort());
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          batchAborted = true;
          reject(Object.assign(new Error("aborted before commit"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token", "x-request-id": "completion-precommit-timeout-1" },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: "s1",
        idempotencyKey: "attempt-precommit-timeout-1",
        entry: { invoice: "$75", notes: "Done" },
      },
    }, res);

    assert.equal(batchAborted, true);
    assert.equal(batchWrites, 1);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "completion-save-unconfirmed");
    assert.equal(res.body.retryable, true);
    assert.equal(res.body.commitState, "unconfirmed");
    assert.equal(res.body.requestId, "completion-precommit-timeout-1");
    assert.match(res.body.error, /retry automatically/i);
    assert.doesNotMatch(res.body.error, /nothing (was )?changed/i);
    assert.equal(stateReadKeySets.length, 2);
    assert.deepEqual(stateReadKeySets[1], ["sps_clients", "sps_completed", "sps_invoices"]);
    assert.equal(state.sps_clients.value[0].history.length, 0);
    assert.equal(Object.keys(state.sps_completed.value).length, 0);
    assert.equal(state.sps_invoices.value.length, 0);
  } finally {
    console.error = originalError;
  }
});

test("repeated fence conflicts leave every stop mutation untouched and use one reread per attempt", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$10", history: [] }], version: 2 },
    sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 7 },
    sps_invoices: { value: [], version: 4 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 4000 }, version: 2 },
    sps_maintenance_billing: { value: { version: 1, policies: {} }, version: 1 },
  };
  const before = structuredClone(state);
  const batches = [];
  let baselineReads = 0;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      if (href.includes("key=in.(")) baselineReads += 1;
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      const operations = JSON.parse(options.body).p_operations;
      batches.push(operations);
      return response([{
        applied: false,
        outcome: "conflict",
        conflict_key: "sps_schedule",
        current_versions: { sps_schedule: 8 },
      }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "s1",
      idempotencyKey: "attempt-conflict-exhaustion",
      entry: { invoice: "$75", notes: "Done" },
    },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "contention");
  assert.equal(batches.length, 6);
  assert.equal(baselineReads, 6, "each retry uses one batched baseline request instead of one request per key");
  for (const operations of batches) {
    assert.deepEqual(
      operations.find((operation) => operation.key === "sps_schedule"),
      { key: "sps_schedule", expected_version: 7, check_only: true },
    );
    assert.deepEqual(
      operations.find((operation) => operation.key === "sps_maintenance_billing"),
      { key: "sps_maintenance_billing", expected_version: 1, check_only: true },
    );
  }
  assert.deepEqual(state, before, "a rejected atomic batch cannot partially apply history, balance, invoice, or completion writes");
});

test("server-enforced prepaid maintenance preserves quoted value without changing balance or creating a service draft", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: {
      value: [{
        id: "c1",
        name: "Prepaid Client",
        balance: "$410",
        history: [],
      }],
      version: 2,
    },
    sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: {
      value: [{ date: "08/31/2026", stops: [{ sid: "prepaid-weekly", clientId: "c1", type: "Weekly Service" }] }],
      version: 7,
    },
    sps_invoices: { value: [], version: 4 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 4000 }, version: 2 },
    sps_maintenance_billing: {
      value: {
        version: 1,
        policies: {
          c1: {
            version: 1,
            mode: "prepaid",
            coveredFrom: "2026-08-01",
            coveredThrough: "2026-08-31",
            sourceInvoiceId: "invoice-prepaid",
          },
        },
      },
      version: 1,
    },
  };
  let writtenOperations = null;

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      writtenOperations = JSON.parse(options.body).p_operations;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "prepaid-weekly",
      idempotencyKey: "prepaid-weekly-device-attempt",
      entry: {
        invoice: "$175.00",
        services: [{ id: "weekly", name: "Weekly maintenance", price: 175, cost: 50 }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.invoiceOutcome, {
    status: "covered",
    kind: "prepaid-maintenance",
    action: "no-draft",
    sourceStopId: "prepaid-weekly",
    coverage: {
      version: 1,
      mode: "prepaid",
      coveredFrom: "2026-08-01",
      coveredThrough: "2026-08-31",
      sourceInvoiceId: "invoice-prepaid",
    },
  });
  assert.deepEqual(
    writtenOperations.map((operation) => operation.key).sort(),
    ["sps_clients", "sps_completed", "sps_maintenance_billing", "sps_schedule"],
    "a covered service with no extras does not write invoices or unchanged catalog data",
  );
  const writtenClient = JSON.parse(writtenOperations.find((operation) => operation.key === "sps_clients").value)[0];
  assert.equal(writtenClient.balance, "$410");
  assert.equal(writtenClient.history[0].invoice, "$0");
  assert.equal(writtenClient.history[0].quoted_price, 175);
  assert.equal(writtenClient.history[0].billingDisposition, "prepaid-maintenance");
  assert.deepEqual(writtenClient.history[0].maintenanceBillingSnapshot, {
    version: 1,
    mode: "prepaid",
    coveredFrom: "2026-08-01",
    coveredThrough: "2026-08-31",
    sourceInvoiceId: "invoice-prepaid",
  });
  assert.equal(writtenClient.history[0].maintenanceBillingServiceDate, "2026-08-31");
  const completedWrite = JSON.parse(writtenOperations.find((operation) => operation.key === "sps_completed").value);
  const receipt = completedWrite.__stopReversalReceipts[completedWrite["prepaid-weekly"].receiptId];
  assert.equal(receipt.balance.changed, false);
  assert.deepEqual(
    writtenOperations.find((operation) => operation.key === "sps_schedule"),
    { key: "sps_schedule", expected_version: 7, check_only: true },
  );
  assert.deepEqual(
    writtenOperations.find((operation) => operation.key === "sps_maintenance_billing"),
    { key: "sps_maintenance_billing", expected_version: 1, check_only: true },
  );
});

test("a prepaid mirror on the client cannot suppress billing without protected server policy", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: {
      value: [{
        id: "c1",
        name: "Prepaid Client",
        balance: "$410",
        history: [],
        maintenanceBilling: {
          version: 1,
          mode: "prepaid",
          coveredFrom: "2026-08-01",
          coveredThrough: "2026-08-31",
        },
      }],
      version: 2,
    },
    sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: {
      value: [{ date: "08/31/2026", stops: [{ sid: "prepaid-partial", clientId: "c1", type: "Weekly Service" }] }],
      version: 7,
    },
    sps_invoices: { value: [], version: 4 },
  };
  let batchWrites = 0;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "prepaid-partial",
      idempotencyKey: "prepaid-partial-attempt",
      entry: { invoice: "$175.00" },
    },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.invoiceOutcome.status, "covered");
  assert.equal(batchWrites, 1);
});

test("ordinary completion rejects insufficient tracked stock before any shared state is written", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$10", history: [] }], version: 2 },
    sps_catalog: { value: { locations: [{ id: "truck", name: "Truck" }], treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 3 }, inventoryOz: "3" }], parts: [], products: [] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 7 },
    sps_invoices: { value: [], version: 1 },
  };
  let batchWrites = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "s1",
      idempotencyKey: "attempt-insufficient-stock",
      entry: {
        invoice: "$75",
        treatmentsUsed: [{ id: "t1", name: "Treatment", unit: "oz", oz: 4, locId: "truck" }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "inventory-stock-insufficient");
  assert.match(res.body.error, /Treatment does not have enough tracked stock/i);
  assert.equal(batchWrites, 0, "a failed completion cannot persist history, balance, inventory, invoice, or schedule changes");
});

test("ordinary completion accepts a legacy untracked product without fabricating inventory movement", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 2 },
    sps_catalog: { value: { locations: [{ id: "truck", name: "Truck" }], treatments: [], parts: [], products: [{ id: "legacy-product", name: "Legacy sale item", price: "20", cost: "8" }] }, version: 5 },
    sps_completed: { value: {}, version: 3 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1", assigneeId: "e1" }] }], version: 7 },
    sps_invoices: { value: [], version: 1 },
  };
  let writtenOperations = null;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      writtenOperations = JSON.parse(options.body).p_operations;
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "s1",
      idempotencyKey: "attempt-legacy-product",
      entry: {
        invoice: "$20.00",
        productsPurchased: [{ id: "legacy-product", name: "Legacy sale item", unit: "each", qty: 1, price: 20, cost: 8 }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.inventoryDeducted, []);
  const catalogWrite = writtenOperations.find((operation) => operation.key === "sps_catalog");
  assert.deepEqual(JSON.parse(catalogWrite.value).products, state.sps_catalog.value.products);
  const clientWrite = writtenOperations.find((operation) => operation.key === "sps_clients");
  assert.equal(JSON.parse(clientWrite.value)[0].history[0].productsPurchased[0].id, "legacy-product");
});

test("the final weekly maintenance visit atomically creates one monthly draft", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const firstEntry = {
    sid: "weekly-1",
    completionReceiptId: "receipt-weekly-1",
    productsPurchased: [{ id: "p1", name: "Bacteria", qty: 1, price: 15, cost: 5, bill: true }],
  };
  const state = {
    sps_clients: {
      value: [{
        id: "c1",
        name: "Maintenance Client",
        planFreq: "Weekly",
        monthlyRate: "400",
        balance: "$0",
        history: [firstEntry],
      }],
      version: 1,
    },
    sps_catalog: {
      value: { locations: [{ id: "truck", name: "Truck" }], treatments: [], parts: [], products: [{ id: "p1", name: "Bacteria", stockByLoc: { truck: 2 }, inventoryOz: "2" }] },
      version: 1,
    },
    sps_completed: {
      value: { "weekly-1": { v: 2, receiptId: firstEntry.completionReceiptId, completedAt: "2026-08-03T12:00:00.000Z" } },
      version: 1,
    },
    sps_schedule: {
      value: [{ date: "08/03/2026", stops: [{ sid: "weekly-1", clientId: "c1", type: "Weekly Service" }] }, {
        date: "08/10/2026",
        stops: [{ sid: "weekly-2", clientId: "c1", type: "Weekly Service" }],
      }],
      version: 1,
    },
    sps_invoices: { value: [], version: 1 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 3000, dueDays: 15, taxRate: "6" }, version: 1 },
  };
  let writtenOperations = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      writtenOperations = JSON.parse(options.body).p_operations;
      applyBatchOperations(state, writtenOperations);
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: "weekly-2",
      idempotencyKey: "weekly-final-device-attempt",
      entry: {
        invoice: "$0",
        productsPurchased: [{ id: "p1", name: "Bacteria", qty: 2, price: 15, cost: 5, bill: true }],
      },
    },
  }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.invoiceOutcome, {
    status: "created",
    kind: "monthly",
    period: "2026-08",
    invoiceId: "iv_maint_c1_2026-08",
    invoiceNumber: "INV-3000",
    visitCount: 2,
  });
  assert.deepEqual(writtenOperations.map((operation) => operation.key).sort(), ["sps_catalog", "sps_clients", "sps_completed", "sps_invoices", "sps_maintenance_billing", "sps_schedule"]);
  assert.equal(state.sps_invoices.value.length, 1);
  assert.equal(state.sps_invoices.value[0].lineItems[0].unitPrice, "400");
  assert.equal(state.sps_invoices.value[0].lineItems[1].qty, "3");
  assert.deepEqual(state.sps_invoices.value[0].sourceStopIds, ["weekly-1", "weekly-2"]);
});

test("reopening removes an untouched auto-draft but preserves a sent draft for office review", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];

  for (const scenario of [
    { name: "untouched", editInvoice: (invoice) => invoice, expectedStatus: "removed", invoiceWriteOnReverse: true },
    { name: "sent", editInvoice: (invoice) => ({ ...invoice, status: "Sent", sentDate: "08/11/2026" }), expectedStatus: "review_required", invoiceWriteOnReverse: false },
  ]) {
    const state = {
      sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
      sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 1 },
      sps_completed: { value: {}, version: 1 },
      sps_schedule: { value: [{ date: "08/11/2026", stops: [{ sid: "repair-reopen", clientId: "c1", type: "Repair Visit" }] }], version: 1 },
      sps_invoices: { value: [], version: 1 },
      sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 3100 }, version: 1 },
    };
    const batches = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
      if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
      if (href.includes("/rest/v1/app_state?")) {
        return response(stateRows(href, state));
      }
      if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
        const operations = JSON.parse(options.body).p_operations;
        batches.push(operations);
        applyBatchOperations(state, operations);
        return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const completedResponse = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token" },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: "repair-reopen",
        idempotencyKey: `repair-reopen-${scenario.name}`,
        entry: { invoice: "$125" },
      },
    }, completedResponse);
    assert.equal(completedResponse.statusCode, 200);
    assert.equal(state.sps_invoices.value.length, 1);

    state.sps_invoices = {
      value: [scenario.editInvoice(state.sps_invoices.value[0])],
      version: state.sps_invoices.version + 1,
    };
    const reopenedResponse = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token" },
      body: { mode: "reverse", clientId: "c1", sid: "repair-reopen" },
    }, reopenedResponse);

    assert.equal(reopenedResponse.statusCode, 200, scenario.name);
    assert.equal(reopenedResponse.body.invoiceOutcome.status, scenario.expectedStatus, scenario.name);
    assert.equal(reopenedResponse.body.invoiceOutcome.safeToRemove, scenario.name === "untouched", scenario.name);
    assert.equal(state.sps_invoices.value.length, scenario.name === "untouched" ? 0 : 1, scenario.name);
    assert.equal(
      batches[1].some((operation) => operation.key === "sps_invoices"),
      scenario.invoiceWriteOnReverse,
      scenario.name,
    );
  }
});

test("estimate-linked completion and reopening advance the same fulfillment receipt without double posting sales", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const linkedStop = {
    sid: "stop-estimate-1",
    clientId: "c1",
    assigneeId: "e1",
    source: "estimate",
    sourceEstimateId: "estimate-1",
    sourceEstimateNumber: "EST-1001",
    linkedInvoiceId: "invoice-1",
    plannedMaterials: [{
      id: "planned-product",
      kind: "product",
      refId: "p1",
      name: "Pump treatment",
      quantity: "2",
      unit: "bottles",
      billingDisposition: "included-in-estimate",
    }],
    estimateFulfillment: {
      state: "scheduled",
      inventoryDisposition: "consume-on-completion",
      billingDisposition: "linked-invoice",
      completionReceiptId: null,
    },
  };
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
    sps_catalog: {
      value: {
        locations: [{ id: "truck", name: "Truck" }],
        treatments: [],
        parts: [],
        products: [{ id: "p1", name: "Renamed catalog treatment", unit: "bottles", stockByLoc: { truck: 5 } }],
      },
      version: 1,
    },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/28/2026", stops: [linkedStop] }], version: 1 },
    sps_invoices: {
      value: [{
        id: "invoice-1",
        clientId: "c1",
        source: "estimate",
        sourceEstimateId: "estimate-1",
        status: "Draft",
      }],
      version: 1,
    },
  };
  const batchWrites = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      const operations = JSON.parse(options.body).p_operations;
      batchWrites.push(operations);
      applyBatchOperations(state, operations);
      return response([{ applied: true, outcome: "applied", conflict_key: null, current_versions: {} }]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const completedResponse = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: linkedStop.sid,
      idempotencyKey: "estimate-completion-attempt-1",
      entry: {
        invoice: "$0",
        sourceEstimateId: "estimate-1",
        linkedInvoiceId: "invoice-1",
        billingDisposition: "linked-invoice",
        // The server must restore the scheduled plan even when a stale/malicious form omits it.
        productsPurchased: [],
      },
    },
  }, completedResponse);

  assert.equal(completedResponse.statusCode, 200);
  assert.equal(completedResponse.body.estimateFulfillment.state, "completed");
  assert.equal(completedResponse.body.estimateFulfillment.shouldCreateInvoice, false);
  const completedStop = state.sps_schedule.value[0].stops[0];
  assert.equal(completedStop.estimateFulfillment.completionReceiptId, completedResponse.body.receiptId);
  assert.equal(state.sps_clients.value[0].balance, "$0");
  assert.equal(state.sps_catalog.value.products[0].stockByLoc.truck, 3);
  assert.deepEqual(
    state.sps_clients.value[0].history[0].productsPurchased,
    [{
      id: "p1",
      name: "Renamed catalog treatment",
      unit: "bottles",
      qty: 2,
    }],
    "the durable plan is rebuilt with the current catalog name instead of trusting the browser",
  );
  assert.equal(
    batchWrites[0].some((operation) => operation.key === "sps_invoices"),
    true,
    "the unchanged linked invoice is included as a CAS fence",
  );
  assert.deepEqual(
    batchWrites[0].find((operation) => operation.key === "sps_invoices"),
    { key: "sps_invoices", expected_version: 1, check_only: true },
    "the linked invoice fence is checked without sending or rewriting the invoice document",
  );

  const reopenedResponse = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "reverse",
      clientId: "c1",
      sid: linkedStop.sid,
    },
  }, reopenedResponse);

  assert.equal(reopenedResponse.statusCode, 200);
  assert.equal(reopenedResponse.body.estimateFulfillment.state, "reopened");
  assert.equal(state.sps_schedule.value[0].stops[0].estimateFulfillment.completionReceiptId, null);
  assert.equal(state.sps_catalog.value.products[0].stockByLoc.truck, 5);
  assert.equal(batchWrites.length, 2);
});

test("estimate completion fails closed when a planned catalog item is missing or cannot be fully deducted", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const makeStop = () => ({
    sid: "stop-estimate-stock",
    clientId: "c1",
    assigneeId: "e1",
    source: "estimate",
    sourceEstimateId: "estimate-stock",
    linkedInvoiceId: "invoice-stock",
    plannedMaterials: [{
      id: "planned-p1",
      kind: "product",
      refId: "p1",
      name: "Quoted product",
      quantity: "2",
      unit: "bottles",
    }],
    estimateFulfillment: {
      state: "scheduled",
      inventoryDisposition: "consume-on-completion",
      billingDisposition: "linked-invoice",
      completionReceiptId: null,
    },
  });

  for (const scenario of [
    { products: [], expectedCode: "inventory-item-missing" },
    {
      products: [{ id: "p1", name: "Quoted product", unit: "bottles", stockByLoc: { truck: 1 } }],
      expectedCode: "estimate-inventory-not-applied",
    },
  ]) {
    const stop = makeStop();
    const state = {
      sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
      sps_catalog: {
        value: {
          locations: [{ id: "truck", name: "Truck" }],
          treatments: [],
          parts: [],
          products: scenario.products,
        },
        version: 1,
      },
      sps_completed: { value: {}, version: 1 },
      sps_schedule: { value: [{ date: "07/28/2026", stops: [stop] }], version: 1 },
      sps_invoices: {
        value: [{
          id: "invoice-stock",
          clientId: "c1",
          sourceEstimateId: "estimate-stock",
          status: "Draft",
        }],
        version: 1,
      },
    };
    let batchWrites = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
      if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
      if (href.includes("/rest/v1/app_state?")) {
        return response(stateRows(href, state));
      }
      if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
        batchWrites += 1;
        throw new Error("No shared state may be written when planned inventory cannot be applied");
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token" },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: stop.sid,
        idempotencyKey: `estimate-stock-${scenario.expectedCode}`,
        entry: { invoice: "$0", productsPurchased: [] },
      },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, scenario.expectedCode);
    assert.equal(batchWrites, 0);
    assert.deepEqual(state.sps_completed.value, {});
    assert.equal(state.sps_clients.value[0].history.length, 0);
  }
});

test("estimate completion validates the linked invoice's client and source estimate before any write", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const stop = {
    sid: "stop-invoice-integrity",
    clientId: "c1",
    source: "estimate",
    sourceEstimateId: "estimate-integrity",
    linkedInvoiceId: "invoice-integrity",
    plannedMaterials: [],
    estimateFulfillment: {
      state: "scheduled",
      inventoryDisposition: "consume-on-completion",
      billingDisposition: "linked-invoice",
      completionReceiptId: null,
    },
  };

  for (const scenario of [
    {
      invoice: { id: "invoice-integrity", clientId: "different-client", sourceEstimateId: "estimate-integrity" },
      expectedCode: "estimate-invoice-client-mismatch",
    },
    {
      invoice: { id: "invoice-integrity", clientId: "c1", sourceEstimateId: "different-estimate" },
      expectedCode: "estimate-invoice-source-mismatch",
    },
  ]) {
    const state = {
      sps_clients: { value: [{ id: "c1", name: "Client", history: [] }], version: 1 },
      sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 1 },
      sps_completed: { value: {}, version: 1 },
      sps_schedule: { value: [{ date: "07/28/2026", stops: [stop] }], version: 1 },
      sps_invoices: { value: [scenario.invoice], version: 1 },
    };
    let batchWrites = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
      if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
      if (href.includes("/rest/v1/app_state?")) {
        return response(stateRows(href, state));
      }
      if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
        batchWrites += 1;
        throw new Error("No shared state may be written with a mismatched invoice link");
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };

    const res = mockResponse();
    await stopCompletionHandler({
      method: "POST",
      headers: { authorization: "Bearer field-token" },
      body: {
        mode: "complete",
        clientId: "c1",
        sid: stop.sid,
        idempotencyKey: `invoice-integrity-${scenario.expectedCode}`,
        entry: { invoice: "$0" },
      },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, scenario.expectedCode);
    assert.equal(batchWrites, 0);
  }
});

test("estimate-linked completion without a draft invoice fails before any shared write", async () => {
  const team = [{ id: "e1", email: "tech@example.com", role: "field", tabAccess: { schedule: "edit" } }];
  const stop = {
    sid: "stop-needs-invoice",
    clientId: "c1",
    assigneeId: "e1",
    source: "estimate",
    sourceEstimateId: "estimate-needs-invoice",
    sourceEstimateNumber: "EST-1002",
    plannedMaterials: [],
    estimateFulfillment: {
      state: "scheduled",
      inventoryDisposition: "consume-on-completion",
      billingDisposition: "convert-estimate-once",
      completionReceiptId: null,
    },
  };
  const state = {
    sps_clients: { value: [{ id: "c1", name: "Client", balance: "$0", history: [] }], version: 1 },
    sps_catalog: { value: { locations: [], treatments: [], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/28/2026", stops: [stop] }], version: 1 },
  };
  let batchWrites = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      throw new Error("The endpoint must not write without a linked invoice");
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  const res = mockResponse();
  await stopCompletionHandler({
    method: "POST",
    headers: { authorization: "Bearer field-token" },
    body: {
      mode: "complete",
      clientId: "c1",
      sid: stop.sid,
      idempotencyKey: "estimate-needs-invoice-attempt",
      entry: {
        invoice: "$0",
        sourceEstimateId: stop.sourceEstimateId,
        billingDisposition: "convert-estimate-once",
        productsPurchased: [],
      },
    },
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "estimate-invoice-required");
  assert.match(res.body.error, /draft invoice/i);
  assert.equal(batchWrites, 0);
  assert.deepEqual(state.sps_completed.value, {});
  assert.equal(state.sps_clients.value[0].history.length, 0);
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
      return response(stateRows(href, state));
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
      return response(stateRows(href, state));
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
    sps_catalog: { value: { locations: [{ id: "truck", name: "Truck" }], treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 2 }, inventoryOz: "2" }], parts: [], products: [] }, version: 1 },
    sps_completed: { value: {}, version: 1 },
    sps_schedule: { value: [{ date: "07/12/2026", stops: [{ sid: "s1", clientId: "c1" }] }], version: 1 },
    sps_invoices: { value: [], version: 1 },
    sps_invoicing: { value: { numberPrefix: "INV-", nextNumber: 2000, dueDays: 15, taxRate: "6" }, version: 1 },
  };
  let batchWrites = 0;
  let firstBatchKeys = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify(team) }]);
    if (href.includes("/rest/v1/app_state?")) {
      return response(stateRows(href, state));
    }
    if (href.endsWith("/rest/v1/rpc/sps_app_state_batch_cas")) {
      batchWrites += 1;
      const operations = JSON.parse(options.body).p_operations;
      if (batchWrites === 1) firstBatchKeys = operations.map((operation) => operation.key).sort();
      applyBatchOperations(state, operations);
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
        entry: { invoice: "$20.00", treatmentsUsed: [{ id: "t1", name: "Treatment", oz: 2, locId: "truck" }] },
      },
    }, res);
    return res;
  };

  const first = await invoke("attempt-device-one");
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.applied, true);
  assert.equal(first.body.invoiceOutcome.status, "created");
  assert.deepEqual(firstBatchKeys, ["sps_catalog", "sps_clients", "sps_completed", "sps_invoices", "sps_maintenance_billing", "sps_schedule"], "the draft invoice, billing policy fence, and requested inventory fence commit with the stop");

  const retry = await invoke("attempt-device-one");
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.applied, false);
  assert.equal(retry.body.sameRequest, true);
  assert.equal(retry.body.invoiceOutcome.status, "existing");
  assert.equal(retry.body.invoiceOutcome.invoiceId, "iv_stop_s1");
  assert.equal(batchWrites, 1);

  const competitor = await invoke("attempt-device-two");
  assert.equal(competitor.statusCode, 409);
  assert.equal(competitor.body.code, "completion-already-owned");
  assert.match(competitor.body.error, /draft was kept/i);
  assert.equal(batchWrites, 1);
});
