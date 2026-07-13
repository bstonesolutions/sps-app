import test from "node:test";
import assert from "node:assert/strict";

import { selectActiveEnRouteStop } from "../geofenceSafety.js";

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
