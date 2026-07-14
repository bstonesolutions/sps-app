import test from "node:test";
import assert from "node:assert/strict";

import { withEstimateTotals } from "../estimateMath.js";
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

test("merges independent estimate line pricing and cost edits by stable line id", () => {
  const baseEstimate = withEstimateTotals({
    id: "estimate-1",
    taxEnabled: true,
    taxRate: "6",
    items: [
      { id: "line-service", desc: "Service", qty: "1", price: "100", unitCost: "40", costKnown: true },
      { id: "line-part", desc: "Part", qty: "1", price: "20", unitCost: "8", costKnown: true },
    ],
  });
  const base = [baseEstimate];
  const local = structuredClone(base);
  local[0].items[0].unitCost = "45";
  local[0] = withEstimateTotals(local[0]);
  const remote = structuredClone(base);
  remote[0].items[1].price = "25";
  remote[0] = withEstimateTotals(remote[0]);

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(byId(estimate.items, "line-service").unitCost, "45");
  assert.equal(byId(estimate.items, "line-part").price, "25");
  assert.equal(estimate.subtotal, 125);
  assert.equal(estimate.taxAmount, 7.5);
  assert.equal(estimate.tax, 7.5);
  assert.equal(estimate.total, "$132.50");
  assert.equal(estimate.estimatedCost, 53);
  assert.equal(estimate.estimatedProfit, 72);
  assert.equal(estimate.estimatedMargin, 57.6);
  assert.equal(estimate.costComplete, true);
  assert.equal(estimate.missingCostLines, 0);
});

test("reports a concurrent edit to the same estimate line cost", () => {
  const base = [withEstimateTotals({
    id: "estimate-1",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100", unitCost: "40", costKnown: true }],
  })];
  const local = [withEstimateTotals({
    ...base[0],
    items: [{ ...base[0].items[0], unitCost: "45" }],
  })];
  const remote = [withEstimateTotals({
    ...base[0],
    items: [{ ...base[0].items[0], unitCost: "50" }],
  })];

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, "same-field-edit");
  assert.match(result.conflicts[0].path, /unitCost$/);
  assert.equal(estimate.items[0].unitCost, "50");
  assert.equal(estimate.subtotal, 100);
  assert.equal(estimate.estimatedCost, 50);
  assert.equal(estimate.estimatedProfit, 50);
  assert.equal(estimate.estimatedMargin, 50);
});

test("returns a concurrently revised estimate to draft instead of preserving an older send or decision", () => {
  const base = [withEstimateTotals({
    id: "estimate-1",
    status: "draft",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100", unitCost: "40", costKnown: true }],
  })];
  const local = [withEstimateTotals({
    ...base[0],
    items: [{ ...base[0].items[0], price: "125" }],
  })];
  const transitions = [
    { status: "sent", sentAt: "2026-07-14T14:00:00.000Z" },
    { status: "approved", sentAt: "2026-07-14T14:00:00.000Z", approvedAt: "2026-07-14T14:05:00.000Z" },
    { status: "declined", sentAt: "2026-07-14T14:00:00.000Z", declinedAt: "2026-07-14T14:05:00.000Z" },
  ];

  transitions.forEach((transition) => {
    const result = runMerge("sps_estimates", base, local, [{ ...base[0], ...transition }]);
    const estimate = result.data[0];

    assert.deepEqual(result.conflicts, []);
    assert.equal(estimate.items[0].price, "125");
    assert.equal(estimate.subtotal, 125);
    assert.equal(estimate.status, "draft");
    assert.equal(Object.hasOwn(estimate, "sentAt"), false);
    assert.equal(Object.hasOwn(estimate, "approvedAt"), false);
    assert.equal(Object.hasOwn(estimate, "declinedAt"), false);
  });
});

test("returns to draft when the status transition is local and the quote revision is remote", () => {
  const base = [withEstimateTotals({
    id: "estimate-1",
    title: "Original scope",
    status: "draft",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100", unitCost: "40", costKnown: true }],
  })];
  const local = [{
    ...base[0],
    status: "sent",
    sentAt: "2026-07-14T14:00:00.000Z",
  }];
  const remote = [{ ...base[0], title: "Revised scope" }];

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(estimate.title, "Revised scope");
  assert.equal(estimate.status, "draft");
  assert.equal(Object.hasOwn(estimate, "sentAt"), false);
});

test("preserves approval when the concurrent estimate edit changes internal cost only", () => {
  const base = [withEstimateTotals({
    id: "estimate-1",
    status: "draft",
    items: [{ id: "line-1", desc: "Service", qty: "1", price: "100", unitCost: "40", costKnown: true }],
  })];
  const local = [withEstimateTotals({
    ...base[0],
    items: [{ ...base[0].items[0], unitCost: "50" }],
  })];
  const remote = [{
    ...base[0],
    status: "approved",
    sentAt: "2026-07-14T14:00:00.000Z",
    approvedAt: "2026-07-14T14:05:00.000Z",
  }];

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(estimate.items[0].unitCost, "50");
  assert.equal(estimate.estimatedCost, 50);
  assert.equal(estimate.status, "approved");
  assert.equal(estimate.sentAt, "2026-07-14T14:00:00.000Z");
  assert.equal(estimate.approvedAt, "2026-07-14T14:05:00.000Z");
});

test("returns an aggregate-only legacy estimate to draft when its quoted total changes during send", () => {
  const base = [{
    id: "legacy-estimate",
    status: "draft",
    subtotal: 100,
    tax: 0,
    total: "$100.00",
  }];
  const local = [{ ...base[0], subtotal: 150, total: "$150.00" }];
  const remote = [{ ...base[0], status: "sent", sentAt: "2026-07-14T18:00:00.000Z" }];

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(estimate.subtotal, 150);
  assert.equal(estimate.total, "$150.00");
  assert.equal(estimate.status, "draft");
  assert.equal(Object.hasOwn(estimate, "sentAt"), false);
});

test("preserves aggregate-only legacy estimate values", () => {
  const base = [{
    id: "legacy-estimate",
    title: "Legacy",
    items: [],
    subtotal: 450,
    total: "$450.00",
    estimatedCost: 250,
    estimatedProfit: 200,
  }];
  const local = [{ ...base[0], title: "Legacy estimate" }];
  const remote = [{ ...base[0], notes: "Keep historical totals" }];

  const result = runMerge("sps_estimates", base, local, remote);
  const estimate = result.data[0];

  assert.deepEqual(result.conflicts, []);
  assert.equal(estimate.title, "Legacy estimate");
  assert.equal(estimate.notes, "Keep historical totals");
  assert.equal(estimate.subtotal, 450);
  assert.equal(estimate.total, "$450.00");
  assert.equal(estimate.estimatedCost, 250);
  assert.equal(estimate.estimatedProfit, 200);
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
