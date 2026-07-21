import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  arrivalDeliveryKey,
  resetArrivalDeliveriesForTests,
  runArrivalDeliveryOnce,
} from "../arrivalDelivery.js";

beforeEach(() => resetArrivalDeliveriesForTests());

test("arrival delivery keys are stable and safely encode imported stop ids", () => {
  assert.equal(arrivalDeliveryKey("route 1/client"), "arrival:route%201%2Fclient:sms");
  assert.equal(arrivalDeliveryKey("  "), "");
});

test("manual and detected arrival surfaces share one complete workflow per stop", async () => {
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const factory = async () => {
    runs += 1;
    await gate;
    return { portal: { accepted: true }, sms: { accepted: true } };
  };
  const manual = runArrivalDeliveryOnce("stop-1", factory);
  const detected = runArrivalDeliveryOnce("stop-1", factory);
  assert.strictEqual(manual, detected);
  release();
  const [a, b] = await Promise.all([manual, detected]);
  assert.equal(runs, 1);
  assert.deepEqual(a, b);
});

test("settled and uncertain arrival outcomes stay latched for the app session", async () => {
  let runs = 0;
  const first = await runArrivalDeliveryOnce("stop-2", async () => {
    runs += 1;
    return { portal: null, sms: { uncertain: true } };
  });
  const replay = await runArrivalDeliveryOnce("stop-2", async () => {
    runs += 1;
    return { portal: null, sms: { accepted: true } };
  });
  assert.equal(runs, 1);
  assert.deepEqual(replay, first);

  await runArrivalDeliveryOnce("stop-3", async () => {
    runs += 1;
    return { portal: null, sms: null };
  });
  assert.equal(runs, 2, "different stops remain independent");
});
