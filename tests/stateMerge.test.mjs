import test from "node:test";
import assert from "node:assert/strict";

import { mergeStoredState } from "../stateMerge.js";

const json = (value) => JSON.stringify(value);
const runMerge = (key, base, local, remote, options) => {
  const result = mergeStoredState(key, json(base), json(local), json(remote), options);
  return { ...result, data: JSON.parse(result.value) };
};

const byId = (items, id) => items.find((item) => String(item.id) === String(id));
const allStops = (days) => days.flatMap((day) => day.stops || []);

test("merges edits to different client entities", () => {
  const base = [
    { id: "c1", name: "Alpha", phone: "111" },
    { id: "c2", name: "Beta", address: "Old" },
  ];
  const local = structuredClone(base);
  local[0].phone = "222";
  const remote = structuredClone(base);
  remote[1].address = "New";

  const result = runMerge("sps_clients", base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(byId(result.data, "c1").phone, "222");
  assert.equal(byId(result.data, "c2").address, "New");
});

test("merges different fields changed on the same client", () => {
  const base = [{ id: "c1", name: "Alpha", phone: "111", email: "old@example.com" }];
  const local = [{ ...base[0], phone: "222" }];
  const remote = [{ ...base[0], email: "new@example.com" }];

  const result = runMerge("sps_clients", base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data[0].phone, "222");
  assert.equal(result.data[0].email, "new@example.com");
});

test("reports a same-field conflict and uses the configured preference", () => {
  const base = [{ id: "c1", name: "Original" }];
  const local = [{ id: "c1", name: "Local" }];
  const remote = [{ id: "c1", name: "Remote" }];

  const remotePreferred = runMerge("sps_clients", base, local, remote);
  assert.equal(remotePreferred.data[0].name, "Remote");
  assert.equal(remotePreferred.conflicts.length, 1);
  assert.equal(remotePreferred.conflicts[0].kind, "same-field-edit");
  assert.match(remotePreferred.conflicts[0].path, /name$/);

  const localPreferred = runMerge("sps_clients", base, local, remote, { prefer: "local" });
  assert.equal(localPreferred.data[0].name, "Local");
});

test("reports delete-vs-edit and does not silently discard the edited entity", () => {
  const base = [{ id: "c1", name: "Keep" }, { id: "c2", name: "Original" }];
  const local = [{ id: "c1", name: "Keep" }];
  const remote = [{ id: "c1", name: "Keep" }, { id: "c2", name: "Edited remotely" }];

  const result = runMerge("sps_clients", base, local, remote);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "delete-vs-edit");
  assert.equal(byId(result.data, "c2").name, "Edited remotely");
});

test("retains concurrent additions with different identities", () => {
  const result = runMerge(
    "sps_clients",
    [],
    [{ id: "local-client", name: "Local" }],
    [{ id: "remote-client", name: "Remote" }]
  );

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(new Set(result.data.map((item) => item.id)), new Set(["local-client", "remote-client"]));
});

test("merges a schedule stop move with an independent edit without duplicating the stop", () => {
  const stop = { sid: "s1", clientId: "c1", time: "8:00 AM", assigneeId: "e1", type: "Service" };
  const base = [{ date: "07/12/2026", day: "Sun", stops: [stop] }];
  const local = [{ date: "07/13/2026", day: "Mon", stops: [{ ...stop }] }];
  const remote = [{ date: "07/12/2026", day: "Sun", stops: [{ ...stop, assigneeId: "e2" }] }];

  const result = runMerge("sps_schedule", base, local, remote);
  const stops = allStops(result.data);

  assert.deepEqual(result.conflicts, []);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sid, "s1");
  assert.equal(stops[0].assigneeId, "e2");
  assert.equal(result.data.find((day) => day.stops.some((item) => item.sid === "s1")).date, "07/13/2026");
});

test("reports conflicting moves of the same stop and still emits it only once", () => {
  const stop = { sid: "s1", clientId: "c1", time: "8:00 AM" };
  const base = [{ date: "07/12/2026", stops: [stop] }];
  const local = [{ date: "07/13/2026", stops: [{ ...stop }] }];
  const remote = [{ date: "07/14/2026", stops: [{ ...stop }] }];

  const result = runMerge("sps_schedule", base, local, remote);
  const stops = allStops(result.data);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "same-field-edit");
  assert.match(result.conflicts[0].path, /\.date$/);
  assert.equal(stops.length, 1);
  assert.equal(result.data.find((day) => day.stops.some((item) => item.sid === "s1")).date, "07/14/2026");
});

test("merges catalog stock edits at different locations and recomputes inventoryOz", () => {
  const base = {
    treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 10, shed: 20 }, inventoryOz: "30" }],
  };
  const local = structuredClone(base);
  local.treatments[0].stockByLoc.truck = 8;
  local.treatments[0].inventoryOz = "28";
  const remote = structuredClone(base);
  remote.treatments[0].stockByLoc.shed = 15;
  remote.treatments[0].inventoryOz = "25";

  const result = runMerge("sps_catalog", base, local, remote);
  const item = result.data.treatments[0];

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(item.stockByLoc, { truck: 8, shed: 15 });
  assert.equal(item.inventoryOz, "23");
});

test("reports concurrent edits to the same inventory cell without a mirror conflict", () => {
  const base = {
    treatments: [{ id: "t1", name: "Treatment", stockByLoc: { truck: 10, shed: 20 }, inventoryOz: "30" }],
  };
  const local = structuredClone(base);
  local.treatments[0].stockByLoc.truck = 8;
  local.treatments[0].inventoryOz = "28";
  const remote = structuredClone(base);
  remote.treatments[0].stockByLoc.truck = 7;
  remote.treatments[0].inventoryOz = "27";

  const result = runMerge("sps_catalog", base, local, remote);
  const item = result.data.treatments[0];

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "same-field-edit");
  assert.match(result.conflicts[0].path, /stockByLoc\.truck$/);
  assert.equal(item.stockByLoc.truck, 7);
  assert.equal(item.inventoryOz, "27");
});

test("preserves an app invoice id, merges QB fields, and keeps timestamp extrema", () => {
  const base = [{
    id: "iv-local", qbId: "42", status: "Sent", notes: "Base", createdAt: 100, updatedAt: 1000,
  }];
  const local = [{
    ...base[0], notes: "Edited locally", createdAt: 200, updatedAt: 1100,
  }];
  const remote = [{
    ...base[0], id: "qb_42", status: "Paid", createdAt: 300, updatedAt: 1200,
  }];

  const result = runMerge("sps_invoices", base, local, remote);
  const invoice = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.length, 1);
  assert.equal(invoice.id, "iv-local");
  assert.equal(invoice.qbId, "42");
  assert.equal(invoice.status, "Paid");
  assert.equal(invoice.notes, "Edited locally");
  assert.equal(invoice.createdAt, 100);
  assert.equal(invoice.updatedAt, 1200);
});

test("deduplicates concurrent app and QuickBooks additions sharing a qbId", () => {
  const local = [{ id: "iv-local", qbId: "42", status: "Sent", createdAt: 100 }];
  const remote = [{ id: "qb_42", qbId: "42", status: "Sent", createdAt: 200 }];

  const result = runMerge("sps_invoices", [], local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, "iv-local");
  assert.equal(result.data[0].createdAt, 100);
});

test("does not duplicate an invoice when qbId is attached during a concurrent edit", () => {
  const base = [{ id: "iv-local", status: "Draft", notes: "Base" }];
  const local = [{ ...base[0], qbId: "42" }];
  const remote = [{ ...base[0], notes: "Edited on another device" }];

  const result = runMerge("sps_invoices", base, local, remote);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, "iv-local");
  assert.equal(result.data[0].qbId, "42");
  assert.equal(result.data[0].notes, "Edited on another device");
});

test("keeps the earliest concurrent arrival timestamp", () => {
  const result = runMerge(
    "sps_arrivals",
    { s1: "2026-07-12T14:00:00.000Z" },
    { s1: "2026-07-12T14:02:00.000Z" },
    { s1: "2026-07-12T14:01:00.000Z" }
  );

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.data.s1, "2026-07-12T14:00:00.000Z");
});

test("reports incompatible concurrent ordering changes", () => {
  const makeStop = (sid) => ({ sid, clientId: sid });
  const a = makeStop("a"), b = makeStop("b"), c = makeStop("c");
  const base = [{ date: "07/12/2026", stops: [a, b, c] }];
  const local = [{ date: "07/12/2026", stops: [b, a, c] }];
  const remote = [{ date: "07/12/2026", stops: [a, c, b] }];

  const result = runMerge("sps_schedule", base, local, remote);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "concurrent-reorder");
  assert.deepEqual(result.data[0].stops.map((stop) => stop.sid), ["a", "c", "b"]);
});
