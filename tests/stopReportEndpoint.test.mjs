import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyStopCompletion } from "../stopCompletion.js";
import { stableReportJSON } from "../stopReport.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
const { default: handler, canEditReportFinancials } = await import("../api/stop-report.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, ok = true, status = 200) => ({ ok, status, async json() { return body; }, async text() { return JSON.stringify(body); } });
const hash = entry => createHash("sha256").update(stableReportJSON(entry)).digest("hex");

function fixture({ role = "field", tabAccess = { schedule: "edit", clients: "edit" }, beforeCas } = {}) {
  const completed = applyStopCompletion({
    clients: [{ id: "c1", name: "Client", phone: "111", history: [{ sid: "older", notes: "Older report", photos: [{ src: "older.jpg" }] }] }],
    catalog: { locations: [], treatments: [], products: [], parts: [] }, completed: {},
    clientId: "c1", sid: "s1", receiptId: "receipt-one", idempotencyKey: "completion-attempt-one",
    completedAt: "2026-10-12T10:00:00.000Z", postBalance: false,
    entry: { date: "10/12/2026", type: "Pond service", invoice: "$100", notes: "Original notes", photos: [{ src: "original.jpg" }], readings: { pH: 7 }, partsUsed: [], services: [{ name: "Pond service", price: 100 }] },
  });
  assert.equal(completed.ok, true);
  const state = {
    sps_clients: { value: completed.clients, version: 2 },
    sps_completed: { value: completed.completed, version: 3 },
  };
  const calls = [], writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url); calls.push(href);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "staff@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ id: "e1", email: "staff@example.com", role, tabAccess }]) }]);
    if (href.includes("/rest/v1/app_state?")) return response(Object.entries(state).map(([key, row]) => ({ key, value: JSON.stringify(row.value), version: row.version })));
    assert.match(href, /\/rpc\/sps_stop_completion_batch_cas$/);
    const body = JSON.parse(options.body); writes.push(body);
    assert.equal(body.p_mode, "edit"); assert.equal(body.p_sid, "s1"); assert.equal(body.p_receipt_id, "receipt-one");
    assert.deepEqual(body.p_operations.map(op => op.key), ["sps_clients", "sps_completed"]);
    assert.deepEqual(body.p_operations[1], { key: "sps_completed", expected_version: state.sps_completed.version, check_only: true });
    if (beforeCas) {
      const result = beforeCas({ state, body, count: writes.length });
      if (result) return result;
    }
    for (const op of body.p_operations) {
      assert.equal(op.expected_version, state[op.key].version);
      if (!op.check_only) state[op.key] = { value: JSON.parse(op.value), version: state[op.key].version + 1 };
    }
    return response([{ applied: true, outcome: "applied", current_versions: {} }]);
  };
  const original = structuredClone(state.sps_clients.value[0].history[0]);
  const request = changes => ({ clientId: "c1", sid: "s1", receiptId: "receipt-one", expectedHash: hash(original), changes });
  async function invoke(body) {
    const res = { statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
    await handler({ method: "POST", headers: { authorization: "Bearer staff-token" }, body }, res);
    return res;
  }
  return { state, calls, writes, original, request, invoke };
}

test("a field report edit preserves original receipt, accounting fields and every other saved report", async () => {
  const f = fixture();
  const result = await f.invoke(f.request({ notes: "Finished cleaning", photos: [{ src: "original.jpg" }, { src: "new.jpg" }], readings: { pH: 7.4 } }));
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.applied, true);
  assert.equal(result.body.entry.invoice, "$100");
  assert.equal(result.body.entry.completionReceiptId, "receipt-one");
  assert.equal(result.body.entry.sid, "s1");
  assert.equal(f.state.sps_clients.value[0].history[1].notes, "Older report");
  assert.equal(f.state.sps_clients.value[0].phone, "111");
  assert.equal(f.state.sps_completed.version, 3);
  assert.equal(f.calls.some(url => /send-|quickbooks|messages/.test(url)), false);
});

test("stale report edits are rejected but a lost success reply can retry without another mutation", async () => {
  const f = fixture();
  const body = f.request({ notes: "New report notes" });
  assert.equal((await f.invoke(body)).body.applied, true);
  const retry = await f.invoke(body);
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.alreadyApplied, true);
  assert.equal(f.writes.length, 1);
  const stale = await f.invoke({ ...body, changes: { notes: "Different stale notes" } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.body.code, "report-changed");
  assert.equal(f.state.sps_clients.value[0].history[0].notes, "New report notes");
  assert.equal(f.writes.length, 1);
});

test("a report hash ignores object key order and concurrent unrelated client edits survive retry", async () => {
  const f = fixture({ beforeCas({ state, count }) {
    if (count !== 1) return null;
    state.sps_clients.value[0].phone = "222";
    state.sps_clients.value.push({ id: "c2", name: "Another client", history: [{ notes: "Other crew report" }] });
    state.sps_clients.version += 1;
    return response([{ applied: false, outcome: "conflict", conflict_key: "sps_clients", current_versions: {} }]);
  } });
  const reordered = Object.fromEntries(Object.entries(f.original).reverse());
  const result = await f.invoke({ ...f.request({ notes: "Corrected notes" }), expectedHash: hash(reordered) });
  assert.equal(result.statusCode, 200); assert.equal(f.writes.length, 2);
  assert.equal(f.state.sps_clients.value[0].phone, "222");
  assert.equal(f.state.sps_clients.value[1].history[0].notes, "Other crew report");
  assert.equal(f.state.sps_clients.value[0].history[0].notes, "Corrected notes");
});

test("report editing cannot change inventory, receipt, source billing links or another client", async () => {
  for (const changes of [{ partsUsed: [] }, { completionReceiptId: "replacement" }, { sid: "other" }, { linkedInvoiceId: "another-invoice" }, { usageLoc: "truck" }]) {
    const f = fixture();
    assert.equal((await f.invoke(f.request(changes))).statusCode, 400);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  assert.equal((await f.invoke({ ...f.request({ notes: "Wrong client" }), clientId: "c2" })).statusCode, 409);
  assert.equal(f.writes.length, 0);
});

test("financial snapshots require report profit permission and do not post invoices or inventory", async () => {
  const field = fixture();
  assert.equal((await field.invoke(field.request({ invoice: "$200" }))).statusCode, 403);
  assert.equal(field.writes.length, 0);
  const owner = fixture({ role: "owner" });
  const result = await owner.invoke(owner.request({ invoice: "$200", quoted_price: 200, breakdown: { revenue: 200, profit: 100 } }));
  assert.equal(result.statusCode, 200); assert.equal(result.body.entry.invoice, "$200");
  assert.equal(owner.writes.length, 1);
  assert.equal(canEditReportFinancials({ role: "full", tabAccess: { reports: "hidden" } }), false);
  assert.equal(canEditReportFinancials({ role: "field", tabAccess: { reports: "view" } }), true);
  assert.equal(canEditReportFinancials({ role: "custom", perms: { canSeeProfit: true } }), true);
});

test("read-only staff cannot edit a saved service report", async () => {
  const f = fixture({ role: "viewer", tabAccess: { schedule: "view", clients: "view" } });
  assert.equal((await f.invoke(f.request({ notes: "Forbidden" }))).statusCode, 403);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.some(url => url.includes("key=in.(")), false);
});

test("permission to complete stops alone does not grant permission to edit saved history", async () => {
  const f = fixture({ tabAccess: { schedule: "edit", clients: "view" } });
  assert.equal((await f.invoke(f.request({ notes: "Forbidden edit" }))).statusCode, 403);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.some(url => url.includes("key=in.(")), false);
});

test("an exact missing report can be rebuilt from its surviving receipt and retried safely", async () => {
  const f = fixture();
  f.state.sps_clients.value[0].history.shift();
  const body = { ...f.request({ notes: "Recovered visit notes", photos: [{ src: "recovered.jpg" }], date: "10/12/2026", invoice: "$0" }), expectedHash: null };
  const saved = await f.invoke(body);
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.entry.recoveredFromSchedule, true);
  assert.equal(saved.body.entry.completionReceiptId, "receipt-one");
  assert.equal(saved.body.entry.invoice, "$0");
  assert.equal(f.state.sps_clients.value[0].history.length, 2);
  assert.equal((await f.invoke(body)).body.alreadyApplied, true);
  assert.equal(f.writes.length, 1);
});

test("rebuilding requires actual visit details and an active exact receipt", async () => {
  const f = fixture();
  f.state.sps_clients.value[0].history.shift();
  assert.equal((await f.invoke({ ...f.request({}), expectedHash: null })).body.code, "report-recovery-empty");
  delete f.state.sps_completed.value.s1;
  assert.equal((await f.invoke({ ...f.request({ notes: "Cannot recreate reopened work" }), expectedHash: null })).body.code, "report-receipt-mismatch");
  assert.equal(f.writes.length, 0);
});
