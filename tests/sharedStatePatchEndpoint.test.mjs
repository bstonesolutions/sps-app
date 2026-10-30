import test from "node:test";
import assert from "node:assert/strict";
import { buildSharedStateIntent } from "../sharedStateIntent.js";
import { createSharedStatePatchHandler } from "../api/shared-state-patch.js";
import { memberHasCapability } from "../api/_staff-auth.js";

const clone = value => structuredClone(value);
const client = { id: "c1", name: "Josh", address: "Original", history: [{ notes: "Original report" }] };
const res = () => ({ statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } });
const actor = { id: "owner-1", teamRole: "owner", teamMember: { role: "owner" } };

function harness(value = [client], { staff = actor, onCas, onRead } = {}) {
  let current = clone(value), version = 4;
  const calls = { reads: 0, writes: 0, auth: [] };
  const handler = createSharedStatePatchHandler({
    authorize: async (_req, response, capability) => {
      calls.auth.push(capability);
      if (!staff || !memberHasCapability(staff.teamMember, capability)) { response.status(403).json({ error: "Forbidden" }); return null; }
      return staff;
    },
    read: async key => { calls.reads += 1; await onRead?.({ calls, replace }); return { key, exists: true, value: clone(current), version }; },
    cas: async (key, expectedVersion, expectedCurrent, proposed, options) => {
      calls.writes += 1;
      assert.equal(options.actorId, staff.id);
      assert.equal(expectedVersion, version);
      assert.deepEqual(expectedCurrent, current);
      const override = await onCas?.({ key, expectedCurrent, proposed, calls, replace });
      if (override) return override;
      current = clone(proposed); version += 1;
      return { applied: true, currentVersion: version, value: clone(current), outcome: "updated" };
    },
  });
  function replace(value) { current = clone(value); version += 1; }
  return { calls, replace, get value() { return clone(current); }, async call(body) { const response = res(); await handler({ method: "POST", body }, response); return response; } };
}

test("a client name edit preserves another device's address, new client, and report", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Josh Blackman" }], { operationId: "rename" });
  const h = harness([{ ...client, address: "Newer address" }, { id: "c2", name: "Another client" }]);
  const response = await h.call(intent);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.actorId, actor.id);
  assert.equal(response.body.beforeVersion, 4);
  assert.equal(response.body.afterVersion, 5);
  assert.deepEqual(h.value, [{ ...client, name: "Josh Blackman", address: "Newer address" }, { id: "c2", name: "Another client" }]);
  assert.deepEqual(response.body.value, h.value);
});

test("same-field conflicts return exact review hashes and cannot overwrite a subsequent edit", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "My edit" }], { operationId: "rename" });
  const h = harness([{ ...client, name: "Other edit" }]);
  const conflict = await h.call(intent);
  assert.equal(conflict.statusCode, 409); assert.equal(h.calls.writes, 0);
  const item = conflict.body.conflicts[0];
  assert.equal(item.operationId, intent.operations[0].id);
  assert.deepEqual(item.path, ["name"]);
  assert.match(item.current.hash, /^[a-f0-9]{64}$/);
  const resolved = { ...intent, resolutions: [{ operationId: item.operationId, choice: "local", reviewed: item.current }] };
  h.replace([{ ...client, name: "Third edit" }]);
  const stale = await h.call(resolved);
  assert.equal(stale.statusCode, 409); assert.equal(h.calls.writes, 0);
  assert.equal(h.value[0].name, "Third edit");
  resolved.resolutions[0].reviewed = stale.body.conflicts[0].current;
  assert.equal((await h.call(resolved)).statusCode, 200);
  assert.equal(h.value[0].name, "My edit");
});

test("a CAS collision rebases unchanged intent without replacing newly saved fields", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Josh Blackman" }], { operationId: "rename" });
  const h = harness([client], { onCas({ calls, replace }) {
    if (calls.writes === 1) { replace([{ ...client, address: "Won while request was saving" }]); return { applied: false, outcome: "conflict" }; }
  } });
  assert.equal((await h.call(intent)).statusCode, 200);
  assert.equal(h.calls.writes, 2);
  assert.equal(h.value[0].address, "Won while request was saving");
});

test("a committed request with a lost response can be confirmed without another write", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Saved" }], { operationId: "rename" });
  const h = harness([client], { onCas({ proposed, replace }) { replace(proposed); throw new Error("connection lost"); } });
  const uncertain = await h.call(intent);
  assert.equal(uncertain.statusCode, 503); assert.equal(uncertain.body.commitState, "unconfirmed");
  const retried = await h.call(intent);
  assert.equal(retried.statusCode, 200); assert.equal(retried.body.replayed, true);
  assert.equal(h.calls.writes, 1);
});

test("an apparently applied database guard result is not reported saved if it omitted intended work", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Wanted" }], { operationId: "rename" });
  const h = harness([client], { onCas() { return { applied: true, currentVersion: 5, value: [client] }; } });
  const result = await h.call(intent);
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-protected-change");
});

test("schedule moves retain new completion links and another device's new stop", async () => {
  const stop = { sid: "s1", clientId: "c1", service: "Repair" };
  const base = [{ date: "10/22/2026", day: "Thu", stops: [stop] }];
  const local = [{ date: "10/23/2026", day: "Fri", stops: [stop] }];
  const intent = await buildSharedStateIntent("sps_schedule", base, local, { operationId: "move" });
  const h = harness([{ date: "10/22/2026", day: "Thu", stops: [{ ...stop, linkedBillingReviewId: "review1" }, { sid: "s2", clientId: "c2" }] }]);
  const response = await h.call(intent);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(h.value.find(day => day.date === "10/23/2026").stops, [{ ...stop, linkedBillingReviewId: "review1" }]);
  assert.deepEqual(h.value.find(day => day.date === "10/22/2026").stops, [{ sid: "s2", clientId: "c2" }]);
});

test("stale client deletion cannot discard another person's new notes", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [], { operationId: "delete" });
  const h = harness([{ ...client, notes: "Newer notes" }]);
  assert.equal((await h.call(intent)).statusCode, 409); assert.equal(h.calls.writes, 0);
});

test("field crew completion rights do not permit schedule editing or client mutation", async () => {
  const field = { id: "field", teamMember: { role: "field" } };
  assert.equal(memberHasCapability(field.teamMember, "completeStops"), true);
  assert.equal(memberHasCapability(field.teamMember, "editSchedule"), false);
  const h = harness([client], { staff: field });
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Changed" }], { operationId: "rename" });
  assert.equal((await h.call(intent)).statusCode, 403); assert.equal(h.calls.reads, 0);
  assert.equal(memberHasCapability({ role: "custom", perms: { canEditSchedule: false } }, "editSchedule"), false);
  assert.equal(memberHasCapability({ role: "lead", tabAccess: { schedule: "view" } }, "editSchedule"), false);
});

test("billing and linked identity changes retain their existing permission boundary", async () => {
  const staff = { id: "editor", teamMember: { role: "custom", perms: { canEditClients: true, canInvoice: false } } };
  for (const [field, value, code] of [["monthlyRate", "400", "shared-state-billing-forbidden"], ["qbId", "123", "shared-state-identity-forbidden"]]) {
    const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, [field]: value }], { operationId: field });
    const h = harness([client], { staff });
    const response = await h.call(intent);
    assert.equal(response.statusCode, 403); assert.equal(response.body.code, code); assert.equal(h.calls.writes, 0);
  }
  const h = harness();
  const prepaid = await buildSharedStateIntent("sps_clients", [client], [{ ...client, maintenanceBilling: { mode: "prepaid" } }], { operationId: "prepaid" });
  assert.equal((await h.call(prepaid)).body.code, "shared-state-targeted-billing-required");
});

test("ordinary unreceipted history edits are retained without weakening database report guards", async () => {
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, history: [{ notes: "Corrected historic note" }] }], { operationId: "history" });
  const h = harness();
  assert.equal((await h.call(intent)).statusCode, 200);
  assert.equal(h.value[0].history[0].notes, "Corrected historic note");
});

test("already-confirmed billing mirror does not block an unrelated client name save", async () => {
  const maintenanceBilling = { mode: "prepaid" };
  const intent = await buildSharedStateIntent("sps_clients", [client], [{ ...client, name: "Josh Blackman", maintenanceBilling }], { operationId: "profile-after-billing" });
  const h = harness([{ ...client, maintenanceBilling }]);
  assert.equal((await h.call(intent)).statusCode, 200);
  assert.equal(h.value[0].name, "Josh Blackman");
  assert.deepEqual(h.value[0].maintenanceBilling, maintenanceBilling);
});

test("ordinary schedule deletion cannot remove estimate-linked work", async () => {
  const before = [{ date: "10/22/2026", stops: [{ sid: "s1", sourceEstimateId: "e1" }] }];
  const intent = await buildSharedStateIntent("sps_schedule", before, [], { operationId: "delete-linked-stop" });
  const h = harness(before), result = await h.call(intent);
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-estimate-stop-protected"); assert.equal(h.calls.writes, 0);
});

test("ordinary schedule edits cannot forge completion receipts or replace estimate provenance", async () => {
  const before = [{ date: "10/22/2026", stops: [{ sid: "s1", sourceEstimateId: "e1" }] }];
  for (const change of [{ sourceEstimateId: "e2" }, { estimateFulfillment: { state: "completed", completionReceiptId: "forged" } }]) {
    const after = [{ date: "10/22/2026", stops: [{ ...before[0].stops[0], ...change }] }];
    const intent = await buildSharedStateIntent("sps_schedule", before, after, { operationId: "change-link" });
    const h = harness(before), result = await h.call(intent);
    assert.equal(result.statusCode, 409); assert.equal(h.calls.writes, 0);
  }
});

test("new scheduled stops cannot carry forged completion metadata", async () => {
  for (const completion of [{ completionReceiptId: "forged" }, { completedAt: "2026-10-22" }, { estimateFulfillment: { completionReceiptId: "forged" } }, { estimateFulfillment: { state: "completed" } }]) {
    const after = [{ date: "10/22/2026", stops: [{ sid: "s1", ...completion }] }];
    const h = harness([]), intent = await buildSharedStateIntent("sps_schedule", [], after, { operationId: "new-stop" });
    const result = await h.call(intent);
    assert.equal(result.statusCode, 409); assert.equal(result.body.code, "shared-state-completion-required"); assert.equal(h.calls.writes, 0);
  }
});

test('ordinary autosave cannot reinterpret a truncated route as 148 intentional removals', async () => {
  const before = [{ date: '10/29/2026', stops: Array.from({ length: 150 }, (_, i) => ({ sid: `s${i}`, clientId: 'c1' })) }];
  const local = [{ ...before[0], stops: before[0].stops.slice(148) }];
  const intent = await buildSharedStateIntent('sps_schedule', before, local, { operationId: 'stale-display' });
  const h = harness(before), response = await h.call(intent);
  assert.equal(response.statusCode, 409); assert.equal(response.body.code, 'shared-state-stop-delete-action-required');
  assert.equal(h.calls.writes, 0); assert.deepEqual(h.value, before);
});

test('explicit selected stop deletion preserves another device additions and archives its operation scope', async () => {
  const before = [{ date: '10/29/2026', stops: [{ sid: 's1', clientId: 'c1' }, { sid: 's2', clientId: 'c2' }] }];
  const after = [{ ...before[0], stops: [before[0].stops[1]] }];
  const intent = { ...await buildSharedStateIntent('sps_schedule', before, after, { operationId: 'user-delete' }), action: 'schedule-delete', deleteStopIds: ['s1'] };
  const current = structuredClone(before); current[0].stops.push({ sid: 's3', clientId: 'c3' });
  const h = harness(current, { onCas({ calls }) { assert.equal(calls.writes, 1); } });
  const response = await h.call(intent);
  assert.equal(response.statusCode, 200); assert.equal(response.body.complete, true);
  assert.deepEqual(h.value[0].stops.map(stop => stop.sid), ['s2', 's3']);
  const replay = await h.call(intent); assert.equal(replay.statusCode, 200); assert.equal(replay.body.replayed, true); assert.equal(h.calls.writes, 1);
});

test('explicit deletion refuses a target changed since the user reviewed it', async () => {
  const before = [{ date: '10/29/2026', stops: [{ sid: 's1', clientId: 'c1', notes: 'Original' }] }];
  const intent = { ...await buildSharedStateIntent('sps_schedule', before, [], { operationId: 'user-delete' }), action: 'schedule-delete', deleteStopIds: ['s1'] };
  const h = harness([{ ...before[0], stops: [{ ...before[0].stops[0], notes: 'Tech added work' }] }]);
  assert.equal((await h.call(intent)).statusCode, 409); assert.equal(h.calls.writes, 0);
});

test('explicit deletion requires exactly the selected IDs and cannot carry other edits', async () => {
  const before = [{ date: '10/29/2026', stops: [{ sid: 's1', clientId: 'c1' }, { sid: 's2', clientId: 'c2' }] }];
  const intent = { ...await buildSharedStateIntent('sps_schedule', before, [], { operationId: 'user-delete' }), action: 'schedule-delete', deleteStopIds: ['s1'] };
  const h = harness(before); assert.equal((await h.call(intent)).statusCode, 400); assert.equal(h.calls.writes, 0);
  const edit = { ...await buildSharedStateIntent('sps_schedule', before, [{ ...before[0], stops: [{ ...before[0].stops[1], notes: 'Unrelated edit' }] }], { operationId: 'user-delete' }), action: 'schedule-delete', deleteStopIds: ['s1'] };
  assert.equal((await h.call(edit)).statusCode, 400); assert.equal(h.calls.writes, 0);
});

test('explicit stop deletion respects fine add/remove permission and the schedule master switch', async () => {
  const before = [{ date: '10/29/2026', stops: [{ sid: 's1', clientId: 'c1' }] }];
  const intent = { ...await buildSharedStateIntent('sps_schedule', before, [], { operationId: 'restricted-delete' }), action: 'schedule-delete', deleteStopIds: ['s1'] };
  for (const flag of [false, 0, null, '']) {
    const staff = { id: 'restricted-editor', teamMember: { role: 'lead', tabAccess: { schedule: 'edit' }, fine: { scheduleAddRemove: flag } } };
    const h = harness(before, { staff }), response = await h.call(intent);
    assert.equal(response.statusCode, 403); assert.equal(response.body.code, 'shared-state-stop-delete-forbidden');
    assert.equal(h.calls.writes, 0); assert.deepEqual(h.value, before);
  }
  const owner = harness(before, { staff: { ...actor, teamMember: { role: 'owner', fine: { scheduleAddRemove: false } } } });
  assert.equal((await owner.call(intent)).statusCode, 200); assert.equal(owner.calls.writes, 1);
  const legacy = harness(before, { staff: { id: 'legacy-lead', teamMember: { role: 'lead' } } });
  assert.equal((await legacy.call(intent)).statusCode, 200); assert.equal(legacy.calls.writes, 1);
  const readOnly = harness(before, { staff: { id: 'read-only', teamMember: { role: 'lead', tabAccess: { schedule: 'view' }, fine: { scheduleAddRemove: true } } } });
  assert.equal((await readOnly.call(intent)).statusCode, 403); assert.equal(readOnly.calls.writes, 0);
});
