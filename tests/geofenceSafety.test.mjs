import test from "node:test";
import assert from "node:assert/strict";

import { foregroundFenceTransition, selectActiveEnRouteStop, selectArrivalWatchStop } from "../geofenceSafety.js";

const stops = [
  { sid: "first", client: "First client" },
  { sid: "active", client: "Active client" },
  { sid: "future", client: "Future client" },
];

test("selects only the most recently explicit en-route stop", () => {
  const selected = selectActiveEnRouteStop(stops, {
    first: "2026-07-12T12:00:00.000Z",
    active: "2026-07-12T13:00:00.000Z",
  }, {}, {});

  assert.equal(selected && selected.sid, "active");
});

test("does not select an assigned stop that was never marked en route", () => {
  const selected = selectActiveEnRouteStop(stops, {
    first: "2026-07-12T12:00:00.000Z",
  }, {}, {});

  assert.equal(selected && selected.sid, "first");
  assert.notEqual(selected && selected.sid, "future");
});

test("does not fall back to an older stop after the active stop arrives or completes", () => {
  const enRoute = {
    first: "2026-07-12T12:00:00.000Z",
    active: "2026-07-12T13:00:00.000Z",
  };

  assert.equal(selectActiveEnRouteStop(stops, enRoute, { active: "2026-07-12T13:20:00.000Z" }, {}), null);
  assert.equal(selectActiveEnRouteStop(stops, enRoute, {}, { active: true }), null);
});

test("never selects a cancelled explicit Head Here stop", () => {
  const route = [
    { sid: "older", client: "Older" },
    { sid: "cancelled", client: "Cancelled", cancelled: true },
  ];
  const enRoute = {
    older: "2026-07-12T12:00:00.000Z",
    cancelled: "2026-07-12T13:00:00.000Z",
  };

  assert.equal(selectActiveEnRouteStop(route, enRoute, {}, {}), null);
});

test("arrival prompting watches the next unfinished addressed stop without Head Here", () => {
  const route = [
    { sid: "done", client: "Done", address: "1 Main St" },
    { sid: "missing", client: "Missing address" },
    { sid: "next", client: "Next", address: "3 Main St" },
  ];
  assert.equal(selectArrivalWatchStop(route, {}, {}, { done: true })?.sid, "next");
});

test("an explicit Head Here stop wins over route-order arrival prompting", () => {
  const route = [
    { sid: "next", client: "Next", address: "3 Main St" },
    { sid: "headed", client: "Headed", address: "9 Main St" },
  ];
  const selected = selectArrivalWatchStop(route, { headed: "2026-07-20T14:00:00.000Z" }, {}, {});
  assert.equal(selected?.sid, "headed");
});

test("a Head Here stop with a missing or blank address falls back to the next valid route stop", () => {
  for (const address of [undefined, "", "   \n  "]) {
    const route = [
      { sid: "headed", client: "Headed without destination", address },
      { sid: "next", client: "Next", address: "3 Main St" },
    ];
    const selected = selectArrivalWatchStop(route, { headed: "2026-07-20T14:00:00.000Z" }, {}, {});
    assert.equal(selected?.sid, "next");
  }
});

test("cancelled stops are skipped by route-order arrival prompting", () => {
  const route = [
    { sid: "cancelled", client: "Cancelled", address: "1 Main St", cancelled: true },
    { sid: "american-spelling", client: "Canceled", address: "2 Main St", canceled: true },
    { sid: "cancelled-status", client: "Cancelled status", address: "3 Main St", status: "CANCELLED" },
    { sid: "next", client: "Next", address: "4 Main St" },
  ];

  assert.equal(selectArrivalWatchStop(route, {}, {}, {})?.sid, "next");
});

test("a cancelled explicit Head Here stop cannot override the next valid route stop", () => {
  const route = [
    { sid: "cancelled", client: "Cancelled", address: "1 Main St", cancelled: true },
    { sid: "next", client: "Next", address: "2 Main St" },
  ];
  const selected = selectArrivalWatchStop(route, { cancelled: "2026-07-20T14:00:00.000Z" }, {}, {});

  assert.equal(selected?.sid, "next");
});

test("a dismissed foreground prompt waits for a wider exit before re-arming", () => {
  assert.deepEqual(
    foregroundFenceTransition(0.04, { fired: true, waitForExit: true }),
    { fired: true, waitForExit: true, prompt: false },
  );
  assert.deepEqual(
    foregroundFenceTransition(0.11, { fired: true, waitForExit: true }),
    { fired: false, waitForExit: false, prompt: false },
  );
  assert.deepEqual(
    foregroundFenceTransition(0.06, { fired: false, waitForExit: false }),
    { fired: true, waitForExit: false, prompt: true },
  );
});

test("GPS jitter between entry and exit boundaries cannot reopen a dismissed prompt", () => {
  const stillSuppressed = foregroundFenceTransition(0.085, { fired: true, waitForExit: true });
  assert.equal(stillSuppressed.prompt, false);
  assert.equal(stillSuppressed.waitForExit, true);
});
