import assert from "node:assert/strict";
import test from "node:test";
import { createMaintenanceRefreshController } from "../maintenanceCalendarRefresh.js";

test("calendar focus and timer events share one in-flight QuickBooks refresh", async () => {
  let resolve;
  let calls = 0;
  const controller = createMaintenanceRefreshController({ refresh: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = controller.request();
  const second = controller.request();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve({ confirmed: true });
  assert.deepEqual(await first, { confirmed: true });
});

test("returning to the calendar refreshes after a minute, repeated focus stays quiet", async () => {
  let time = 0;
  let calls = 0;
  const controller = createMaintenanceRefreshController({ now: () => time, refresh: async () => ++calls });
  assert.equal(await controller.request(), 1);
  time = 59_999;
  assert.equal(await controller.request(), null);
  time = 60_000;
  assert.equal(await controller.request(), 2);
  assert.equal(await controller.request({ force: true }), 3);
});

test("failed refreshes can retry without a loop and leaving the calendar stops requests", async () => {
  let time = 0;
  let calls = 0;
  const controller = createMaintenanceRefreshController({ now: () => time, refresh: async () => { calls++; throw new Error("offline"); } });
  await assert.rejects(controller.request(), /offline/);
  assert.equal(await controller.request(), null);
  time = 60_000;
  await assert.rejects(controller.request(), /offline/);
  controller.stop();
  assert.equal(await controller.request({ force: true }), null);
  assert.equal(calls, 2);
});
