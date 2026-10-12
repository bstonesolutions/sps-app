import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCompletionFailure,
  completionRetryDelay,
  enqueueCompletionIntent,
  readCompletionOutbox,
  retryCompletionIntent,
  updateCompletionIntent,
} from "../completionOutbox.js";
import { requestCompletedStop } from "../completionRequest.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
const { default: stopCompletionHandler } = await import("../api/stop-completion.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const drainStart = app.indexOf("  completionOutboxDrainRef.current = async () => {");
const drainEnd = app.indexOf("\n\n  useEffect(() => {", drainStart);
const drainSource = app.slice(drainStart, drainEnd);
const reopenStart = app.indexOf("  const handleUncompleteStop = async (clientId, sid) => {");
const reopenEnd = app.indexOf("\n\n  // Still loading", reopenStart);
const reopenSource = `${app.slice(reopenStart, reopenEnd)}\nreturn handleUncompleteStop;`;

class MemoryStorage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
  async del(key) { this.values.delete(key); }
}

const report = {
  uid: "crew-1", clientId: "client-1", sid: "stop-1", idempotencyKey: "completion-saved-key-1",
  entry: {
    date: "10/07/2026", type: "Pond Netting", invoice: "$0", notes: "Net installed",
    photos: [{ src: "sps-storage://client-media/net-after.jpg", label: "After" }],
    treatmentsUsed: [{ id: "t1", name: "Treatment", unit: "oz", oz: 2, locId: "truck" }],
  },
  delivery: { plan: { email: false, text: false, app: false } },
};
const unrelatedConflicts = [
  { key: "sps_invoices", conflicts: [{ path: "$.id:other-invoice.notes", kind: "same-field-edit" }] },
  { key: "sps_clients", conflicts: [{ path: "$.id:other-client.notes", kind: "same-field-edit" }] },
  { key: "sps_schedule", conflicts: [{ path: "$.stops.other-stop.date", kind: "same-field-edit" }] },
  { key: "sps_catalog", conflicts: [{ path: "$.parts.id:other-part.name", kind: "same-field-edit" }] },
  { key: "sps_completed", conflicts: [{ path: "$.other-stop", kind: "same-field-edit" }] },
];

function installServer() {
  const state = {
    sps_clients: { version: 1, value: [{ id: report.clientId, name: "Fixture client", balance: "$0", history: [] }] },
    sps_catalog: { version: 1, value: { locations: [{ id: "truck", name: "Truck" }], treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 9 }, inventoryOz: "9" }], parts: [], products: [] } },
    sps_schedule: { version: 1, value: [{ date: report.entry.date, stops: [{ sid: report.sid, clientId: report.clientId }] }] },
    sps_completed: { version: 1, value: {} },
    sps_invoices: { version: 1, value: [] },
  };
  let batchWrites = 0;
  const response = body => ({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: report.uid, email: "fixture@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ id: "team-1", email: "fixture@example.com", role: "field", tabAccess: { schedule: "edit" } }]) }]);
    if (href.includes("/rest/v1/app_state?")) {
      const keys = href.match(/key=in\.\(([^)]*)\)/)?.[1]?.split(",").map(decodeURIComponent) || [];
      return response(keys.flatMap(key => state[key] ? [{ key, version: state[key].version, value: JSON.stringify(state[key].value) }] : []));
    }
    if (href.endsWith("/rest/v1/rpc/sps_stop_completion_batch_cas")) {
      const operations = JSON.parse(options.body).p_operations;
      for (const operation of operations) assert.equal(operation.expected_version, state[operation.key]?.version || 0);
      for (const operation of operations) {
        if (!operation.check_only) state[operation.key] = { version: (state[operation.key]?.version || 0) + 1, value: JSON.parse(operation.value) };
      }
      batchWrites += 1;
      return response([{ applied: true, outcome: "applied", current_versions: {} }]);
    }
    throw new Error(`Unexpected network request: ${href}`);
  };
  const requests = [];
  const request = async body => {
    requests.push(structuredClone(body));
    return requestCompletedStop({
      url: "https://fixture.invalid/api/stop-completion", body, logger: null,
      fetchImpl: async (_url, options) => {
        const res = {
          statusCode: 200, body: null,
          setHeader() {}, status(code) { this.statusCode = code; return this; },
          json(body) { this.body = body; return this; }, end() {},
        };
        await stopCompletionHandler({ method: "POST", headers: { authorization: "Bearer fixture-token" }, body: JSON.parse(options.body) }, res);
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body };
      },
    });
  };
  return { state, requests, request, get batchWrites() { return batchWrites; } };
}

function createDrain(storage, server, conflicts = unrelatedConflicts) {
  const ref = { current: null };
  const deliveries = [], applied = [];
  const deps = {
    completionOutboxDrainRef: ref, authUserId: report.uid, completionOutboxBusyRef: { current: false },
    readCompletionOutbox: uid => readCompletionOutbox(uid, { storage }), publishCompletionOutbox() {},
    patchCompletionOutboxItem: (id, patch) => updateCompletionIntent(report.uid, id, patch, { storage }),
    store: { listConflicts: () => conflicts },
    STOP_MUTATION_KEYS: ["sps_clients", "sps_catalog", "sps_completed", "sps_schedule", "sps_invoices"],
    requestStopMutation: server.request,
    applyConfirmedCompletion: async (saved, item) => { applied.push({ saved, item }); },
    initializeCompletionDelivery: delivery => ({ ...delivery, channels: {} }),
    deliverConfirmedCompletion: async item => {
      const persisted = (await readCompletionOutbox(report.uid, { storage })).find(row => row.id === item.id);
      assert.equal(persisted?.state, "saved", "delivery can run only after the server-confirmed receipt is durable");
      deliveries.push(item);
    },
    classifyCompletionFailure, completionRetryDelay, refreshCompletionOutboxView: async () => {},
  };
  new Function(...Object.keys(deps), drainSource)(...Object.values(deps));
  return { run: ref.current, deliveries, applied };
}

test("the actual completion drain saves through the atomic API despite unrelated local conflicts", async () => {
  const storage = new MemoryStorage(), server = installServer();
  const original = await enqueueCompletionIntent(report, { storage });
  const drain = createDrain(storage, server);
  await drain.run();
  const [saved] = await readCompletionOutbox(report.uid, { storage });
  assert.equal(saved.state, "saved");
  assert.equal(server.requests.length, 1);
  assert.equal(server.batchWrites, 1);
  assert.deepEqual(server.requests[0], original.request);
  assert.deepEqual(server.state.sps_clients.value[0].history[0].photos, report.entry.photos);
  assert.equal(server.state.sps_catalog.value.treatments[0].stockByLoc.truck, 7);
  assert.equal(drain.deliveries.length, 1);
});

test("an older conflict review stays paused until explicit Retry preserves and submits its exact report", async () => {
  const storage = new MemoryStorage(), server = installServer();
  const original = await enqueueCompletionIntent(report, { storage });
  await updateCompletionIntent(report.uid, original.id, { state: "needs_review", errorCode: "app-state-conflict", errorStatus: 409 }, { storage });
  const drain = createDrain(storage, server);
  await drain.run();
  assert.equal(server.requests.length, 0);
  assert.equal(drain.deliveries.length, 0);
  const retried = await retryCompletionIntent(report.uid, original.id, { storage });
  assert.equal(retried.idempotencyKey, original.idempotencyKey);
  assert.deepEqual(retried.request, original.request);
  assert.deepEqual(retried.delivery, original.delivery);
  await drain.run();
  const [saved] = await readCompletionOutbox(report.uid, { storage });
  assert.equal(saved.state, "saved");
  assert.deepEqual(server.requests[0], original.request);
  assert.deepEqual(saved.request.entry.photos, original.request.entry.photos);
  await drain.run();
  assert.equal(server.requests.length, 1, "a saved report must not be sent to the completion API again");
  assert.equal(drain.deliveries.length, 1);
});

test("a competing same-stop report remains in review with its photos and sends nothing", async () => {
  const storage = new MemoryStorage(), server = installServer();
  const original = await enqueueCompletionIntent(report, { storage });
  await server.request({ ...original.request, idempotencyKey: "another-crew-completion-key" });
  const drain = createDrain(storage, server);
  await drain.run();
  const [held] = await readCompletionOutbox(report.uid, { storage });
  assert.equal(held.state, "needs_review");
  assert.equal(held.errorCode, "completion-already-owned");
  assert.deepEqual(held.request, original.request);
  assert.equal(server.batchWrites, 1);
  assert.equal(server.state.sps_clients.value[0].history.length, 1);
  assert.equal(drain.deliveries.length, 0);
  assert.equal(drain.applied.length, 0);
});

test("a cancelled shared stop remains in review despite an unrelated invoice conflict", async () => {
  const storage = new MemoryStorage(), server = installServer();
  server.state.sps_schedule.value[0].stops[0].cancelled = true;
  const original = await enqueueCompletionIntent(report, { storage });
  const drain = createDrain(storage, server);
  await drain.run();
  const [held] = await readCompletionOutbox(report.uid, { storage });
  assert.equal(held.state, "needs_review");
  assert.equal(held.errorCode, "stop-cancelled");
  assert.deepEqual(held.request, original.request);
  assert.equal(server.batchWrites, 0);
  assert.equal(drain.deliveries.length, 0);
});

test("reopening unwraps the confirmed API receipt and restores inventory despite unrelated conflicts", async () => {
  const server = installServer();
  await server.request({ mode: "complete", clientId: report.clientId, sid: report.sid, entry: report.entry, idempotencyKey: report.idempotencyKey });
  const inventoryLogs = [], alerts = [];
  const deps = {
    store: { listConflicts: () => unrelatedConflicts },
    STOP_MUTATION_KEYS: ["sps_clients", "sps_catalog", "sps_completed", "sps_schedule", "sps_invoices"],
    requestStopMutation: server.request,
    refreshStopBaseline: async () => Object.fromEntries(Object.entries(server.state).map(([key, row]) => [key, row.value])),
    catalog: server.state.sps_catalog.value, logInvChange: line => inventoryLogs.push(line),
    window: { confirm: () => false, alert: message => alerts.push(message) },
  };
  const reopen = new Function(...Object.keys(deps), reopenSource)(...Object.values(deps));
  const result = await reopen(report.clientId, report.sid);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(server.state.sps_completed.value[report.sid], undefined);
  assert.equal(server.state.sps_catalog.value.treatments[0].stockByLoc.truck, 9);
  assert.equal(inventoryLogs.length, 1);
  assert.equal(inventoryLogs[0].qty, 2);
  assert.deepEqual(alerts, []);
});

test("a failed outbox refresh preserves the visible saved reports instead of publishing an empty queue", async () => {
  const start = app.indexOf("  const refreshCompletionOutboxView = async (changedItem = null) => {");
  const end = app.indexOf("\n  const patchCompletionOutboxItem", start);
  const source = `${app.slice(start, end)}\nreturn refreshCompletionOutboxView;`;
  const published = [], messages = [];
  const deps = {
    authUserId: report.uid,
    readCompletionOutbox: async () => { throw new Error("IndexedDB unavailable"); },
    publishCompletionOutbox: items => published.push(items),
    setCompletionReviewMessage: message => messages.push(message),
    console: { warn() {} },
  };
  const refresh = new Function(...Object.keys(deps), source)(...Object.values(deps));
  assert.equal(await refresh(), null);
  assert.deepEqual(published, []);
  assert.match(messages[0], /reports already listed here have been kept/);
});

test("legacy reopening still requires its explicit choice and unwraps the confirmed result", async () => {
  const calls = [];
  let confirmations = 0;
  const deps = {
    store: { listConflicts: () => unrelatedConflicts },
    STOP_MUTATION_KEYS: ["sps_clients", "sps_catalog", "sps_completed", "sps_schedule", "sps_invoices"],
    requestStopMutation: async request => {
      calls.push(request);
      if (!request.allowLegacy) throw Object.assign(new Error("Legacy report"), { code: "legacy-completion" });
      return { data: { applied: true, legacy: true, inventoryRestored: [] }, requestId: "legacy-request", durationMs: 5 };
    },
    refreshStopBaseline: async () => ({ sps_catalog: { locations: [] } }),
    catalog: { locations: [] }, logInvChange() {},
    window: { confirm: () => { confirmations += 1; return true; }, alert: message => assert.fail(message) },
  };
  const reopen = new Function(...Object.keys(deps), reopenSource)(...Object.values(deps));
  const result = await reopen(report.clientId, report.sid);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.legacy, true);
  assert.equal(confirmations, 1);
  assert.deepEqual(calls.map(call => call.allowLegacy), [false, true]);
});
