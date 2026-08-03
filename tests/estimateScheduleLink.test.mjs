import assert from "node:assert/strict";
import test from "node:test";

import {
  claimScheduledEstimateCompletion,
  estimateScheduledStopId,
  findScheduledStopForEstimate,
  releaseScheduledEstimateCompletion,
  scheduleApprovedEstimate,
} from "../estimateScheduleLink.js";

const estimate = () => ({
  id: "estimate-42",
  number: "EST-1042",
  clientId: "client-7",
  clientName: "Jordan Hale",
  title: "Pond rebuild",
  status: "approved",
  linkedInvoiceId: "invoice-88",
  taxEnabled: true,
  taxRate: "6",
  taxModel: "line-item-v1",
  items: [
    {
      id: "service-line",
      desc: "Rebuild labor",
      qty: "2",
      price: "125",
      unitCost: "70",
      costKnown: true,
      kind: "service",
      chargeType: "labor",
      refId: "service-rebuild",
      unit: "service",
    },
    {
      id: "product-line",
      desc: "Beneficial bacteria",
      qty: "3",
      price: "20",
      unitCost: "8",
      costKnown: true,
      kind: "product",
      chargeType: "equipment",
      refId: "product-bacteria",
      unit: "bottle",
    },
    {
      id: "bundle-line",
      desc: "Parts & Materials",
      qty: "2",
      price: "45",
      kind: "bundle",
      chargeType: "custom",
      chargeLabel: "Special installation parts",
      bundleItems: [
        { kind: "part", refId: "part-valve", name: "Valve", qty: "2", unit: "pieces" },
        { kind: "part", refId: "part-clamp", name: "Clamp", qty: "1", unit: "pieces" },
      ],
    },
  ],
});

const client = {
  id: "client-7",
  name: "Jordan Hale",
  address: "10 Main Street",
};

test("an approved estimate becomes one linked stop with quote and material snapshots", () => {
  const sourceEstimate = estimate();
  const sourceSchedule = [{ date: "07/31/2026", day: "Friday", stops: [{ sid: "existing" }] }];
  const result = scheduleApprovedEstimate(sourceEstimate, sourceSchedule, {
    client,
    date: "08/03/2026",
    time: "9:30 AM",
    duration: "90",
    assigneeId: "tech-2",
    createdAt: Date.parse("2026-07-28T17:00:00.000Z"),
  });

  assert.equal(result.existing, false);
  assert.equal(result.stop.sid, "stop_est_estimate-42");
  assert.equal(result.stop.sourceEstimateId, "estimate-42");
  assert.equal(result.stop.linkedInvoiceId, "invoice-88");
  assert.equal(result.stop.estimateTaxEnabled, true);
  assert.equal(result.stop.estimateTaxRate, "6");
  assert.equal(result.stop.estimateTaxModel, "line-item-v1");
  assert.equal(result.stop.clientId, "client-7");
  assert.equal(result.stop.duration, "90 min");
  assert.equal(result.stop.services.length, 3);
  assert.deepEqual(
    result.stop.services.map(({ name, price }) => ({ name, price })),
    [
      { name: "Rebuild labor", price: "250" },
      { name: "Beneficial bacteria", price: "60" },
      { name: "Parts & Materials", price: "90" },
    ],
  );
  assert.deepEqual(
    result.stop.estimateItems.map(({ id, taxable }) => ({ id, taxable })),
    [
      { id: "service-line", taxable: false },
      { id: "product-line", taxable: true },
      { id: "bundle-line", taxable: true },
    ],
  );
  assert.deepEqual(
    result.stop.services.map(({ sourceEstimateLineId, taxable }) => ({ sourceEstimateLineId, taxable })),
    [
      { sourceEstimateLineId: "service-line", taxable: false },
      { sourceEstimateLineId: "product-line", taxable: true },
      { sourceEstimateLineId: "bundle-line", taxable: true },
    ],
  );
  assert.deepEqual(
    result.stop.estimateItems.map(({ chargeType, chargeLabel }) => ({ chargeType, chargeLabel })),
    [
      { chargeType: "labor", chargeLabel: undefined },
      { chargeType: "equipment", chargeLabel: undefined },
      { chargeType: "custom", chargeLabel: "Special installation parts" },
    ],
  );
  assert.deepEqual(
    result.stop.services.map(({ chargeType, chargeLabel }) => ({ chargeType, chargeLabel })),
    [
      { chargeType: "labor", chargeLabel: undefined },
      { chargeType: "equipment", chargeLabel: undefined },
      { chargeType: "custom", chargeLabel: "Special installation parts" },
    ],
  );
  assert.deepEqual(
    result.stop.plannedMaterials.map(({ refId, quantity, billingDisposition }) => ({
      refId,
      quantity,
      billingDisposition,
    })),
    [
      { refId: "product-bacteria", quantity: "3", billingDisposition: "included-in-estimate" },
      { refId: "part-valve", quantity: "4", billingDisposition: "included-in-estimate" },
      { refId: "part-clamp", quantity: "2", billingDisposition: "included-in-estimate" },
    ],
  );
  assert.equal(result.stop.estimateFulfillment.inventoryDisposition, "consume-on-completion");
  assert.equal(result.stop.estimateFulfillment.billingDisposition, "linked-invoice");
  assert.equal(result.estimate.linkedScheduledStopId, result.stop.sid);
  assert.equal(result.estimate.scheduledDate, "08/03/2026");
  assert.equal(result.schedule.length, 2);
  assert.equal(sourceSchedule.length, 1);
  assert.equal(sourceSchedule[0].stops.length, 1);
  assert.equal("linkedScheduledStopId" in sourceEstimate, false);
});

test("scheduling is idempotent and repairs an estimate's missing stop link without adding a duplicate", () => {
  const first = scheduleApprovedEstimate(estimate(), [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  });
  const estimateWithoutLink = { ...estimate() };
  delete estimateWithoutLink.linkedScheduledStopId;

  const retry = scheduleApprovedEstimate(estimateWithoutLink, first.schedule, {
    client,
    date: "08/10/2026",
    createdAt: 2,
  });

  assert.equal(retry.existing, true);
  assert.equal(retry.stop, first.stop);
  assert.equal(retry.schedule, first.schedule);
  assert.equal(retry.estimate.linkedScheduledStopId, first.stop.sid);
  assert.equal(retry.schedule.flatMap((day) => day.stops).length, 1);
  assert.equal(findScheduledStopForEstimate(retry.schedule, retry.estimate).stop, first.stop);
});

test("a schedule created before invoice conversion atomically backfills the invoice and final status before completion", () => {
  const beforeConversion = estimate();
  delete beforeConversion.linkedInvoiceId;
  const scheduled = scheduleApprovedEstimate(beforeConversion, [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  });
  assert.equal(scheduled.stop.linkedInvoiceId, undefined);
  assert.equal(scheduled.stop.estimateFulfillment.billingDisposition, "convert-estimate-once");

  const afterConversion = {
    ...scheduled.estimate,
    status: "complete",
    linkedInvoiceId: "invoice-after-scheduling",
  };
  const linked = scheduleApprovedEstimate(afterConversion, scheduled.schedule, {
    client,
    date: "08/03/2026",
    createdAt: 2,
  });

  assert.equal(linked.existing, true);
  assert.notEqual(linked.schedule, scheduled.schedule);
  assert.notEqual(linked.stop, scheduled.stop);
  assert.equal(linked.stop.linkedInvoiceId, "invoice-after-scheduling");
  assert.equal(linked.stop.sourceEstimateStatus, "complete");
  assert.equal(linked.stop.estimateFulfillment.billingDisposition, "linked-invoice");
  assert.equal(scheduled.stop.linkedInvoiceId, undefined);
  assert.equal(scheduled.stop.sourceEstimateStatus, "approved");
  assert.equal(scheduled.stop.estimateFulfillment.billingDisposition, "convert-estimate-once");
  assert.equal(linked.schedule.flatMap((day) => day.stops).length, 1);

  const repeat = scheduleApprovedEstimate(afterConversion, linked.schedule, {
    client,
    date: "08/03/2026",
    createdAt: 3,
  });
  assert.equal(repeat.schedule, linked.schedule);
  assert.equal(repeat.stop, linked.stop);

  const completed = claimScheduledEstimateCompletion(linked.stop, {
    completionReceiptId: "receipt-after-conversion",
    completedAt: "2026-08-03T15:00:00.000Z",
  });
  assert.equal(completed.shouldCreateInvoice, false);
  assert.equal(completed.shouldPostInventory, true);
  assert.equal(completed.shouldPostRevenue, false);
  assert.equal(completed.stop.linkedInvoiceId, "invoice-after-scheduling");
  assert.equal(completed.stop.estimateFulfillment.billingDisposition, "linked-invoice");
});

test("an existing pre-tax linked stop is upgraded without changing its frozen prices or creating another stop", () => {
  const current = scheduleApprovedEstimate(estimate(), [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  });
  const legacyStop = structuredClone(current.stop);
  delete legacyStop.estimateTaxEnabled;
  delete legacyStop.estimateTaxRate;
  delete legacyStop.estimateTaxModel;
  legacyStop.estimateScheduleVersion = 1;
  legacyStop.estimateFulfillment.version = 1;
  legacyStop.estimateItems.forEach((line) => { delete line.taxable; });
  legacyStop.services.forEach((line) => { delete line.taxable; });
  const legacySchedule = [{ ...current.schedule[0], stops: [legacyStop] }];
  const frozenPrices = legacyStop.estimateItems.map((line) => line.lineTotal);

  const upgraded = scheduleApprovedEstimate(current.estimate, legacySchedule, {
    client,
    date: "08/03/2026",
  });

  assert.equal(upgraded.existing, true);
  assert.equal(upgraded.schedule.flatMap((day) => day.stops).length, 1);
  assert.deepEqual(upgraded.stop.estimateItems.map((line) => line.lineTotal), frozenPrices);
  assert.deepEqual(
    upgraded.stop.estimateItems.map((line) => line.taxable),
    [false, true, true],
  );
  assert.deepEqual(
    upgraded.stop.services.map((line) => line.taxable),
    [false, true, true],
  );
  assert.equal(upgraded.stop.estimateTaxEnabled, true);
  assert.equal(upgraded.stop.estimateTaxRate, "6");
  assert.equal(upgraded.stop.estimateTaxModel, "line-item-v1");
  assert.equal(legacyStop.estimateTaxEnabled, undefined);
  assert.equal(legacyStop.estimateItems[0].taxable, undefined);
});

test("duplicate estimate stop links fail closed rather than choosing one arbitrarily", () => {
  const source = estimate();
  const schedule = [
    { date: "08/03/2026", stops: [{ sid: "one", sourceEstimateId: source.id }] },
    { date: "08/04/2026", stops: [{ sid: "two", sourceEstimateId: source.id }] },
  ];

  assert.throws(
    () => findScheduledStopForEstimate(schedule, source),
    /more than one scheduled stop/i,
  );
  assert.throws(
    () => scheduleApprovedEstimate(source, schedule, { client, date: "08/05/2026" }),
    /more than one scheduled stop/i,
  );
});

test("an existing stop and estimate with different invoice links fail closed", () => {
  const scheduled = scheduleApprovedEstimate(estimate(), [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  });
  assert.throws(
    () => scheduleApprovedEstimate(
      { ...scheduled.estimate, linkedInvoiceId: "different-invoice" },
      scheduled.schedule,
      { client, date: "08/03/2026" },
    ),
    /linked to different invoices/i,
  );
});

test("draft, declined, mismatched-client, unsaved, and empty estimates cannot schedule work", () => {
  assert.throws(
    () => scheduleApprovedEstimate({ ...estimate(), status: "draft" }, [], { client, date: "08/03/2026" }),
    /approve the estimate/i,
  );
  assert.throws(
    () => scheduleApprovedEstimate({ ...estimate(), status: "declined" }, [], { client, date: "08/03/2026" }),
    /approve the estimate/i,
  );
  assert.throws(
    () => scheduleApprovedEstimate({ ...estimate(), id: "" }, [], { client, date: "08/03/2026" }),
    /save the estimate/i,
  );
  assert.throws(
    () => scheduleApprovedEstimate(estimate(), [], {
      client: { ...client, id: "other-client" },
      date: "08/03/2026",
    }),
    /must match the estimate/i,
  );
  assert.throws(
    () => scheduleApprovedEstimate({ ...estimate(), items: [] }, [], { client, date: "08/03/2026" }),
    /priced line/i,
  );
});

test("completion claims planned materials and invoice conversion only once", () => {
  const scheduled = scheduleApprovedEstimate(estimate(), [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  }).stop;
  const originalMaterials = structuredClone(scheduled.plannedMaterials);
  const first = claimScheduledEstimateCompletion(scheduled, {
    completionReceiptId: "receipt-stop-42",
    completedAt: "2026-08-03T15:00:00.000Z",
  });

  assert.equal(first.alreadyClaimed, false);
  assert.equal(first.shouldPostInventory, true);
  assert.equal(first.shouldCreateInvoice, false);
  assert.equal(first.shouldPostRevenue, false);
  assert.deepEqual(first.inventoryUsage, originalMaterials);
  assert.notEqual(first.inventoryUsage, scheduled.plannedMaterials);
  assert.equal(first.stop.estimateFulfillment.completionReceiptId, "receipt-stop-42");
  assert.equal(scheduled.estimateFulfillment.completionReceiptId, null);

  const retry = claimScheduledEstimateCompletion(first.stop, {
    completionReceiptId: "receipt-stop-42",
  });
  assert.equal(retry.alreadyClaimed, true);
  assert.equal(retry.shouldPostInventory, false);
  assert.equal(retry.shouldCreateInvoice, false);
  assert.equal(retry.shouldPostRevenue, false);
  assert.deepEqual(retry.inventoryUsage, []);
  assert.equal(retry.stop, first.stop);

  assert.throws(
    () => claimScheduledEstimateCompletion(first.stop, {
      completionReceiptId: "competing-receipt",
    }),
    /different receipt/i,
  );
});

test("an unconverted estimate requests one draft invoice at first completion but never posts revenue directly", () => {
  const source = estimate();
  delete source.linkedInvoiceId;
  const scheduled = scheduleApprovedEstimate(source, [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  }).stop;

  const claimed = claimScheduledEstimateCompletion(scheduled, {
    completionReceiptId: "receipt-no-invoice",
  });

  assert.equal(claimed.shouldCreateInvoice, true);
  assert.equal(claimed.shouldPostRevenue, false);
  assert.equal(claimed.stop.estimateFulfillment.billingDisposition, "convert-estimate-once");
});

test("scheduled stop identity is deterministic and does not accept a blank estimate", () => {
  assert.equal(
    estimateScheduledStopId({ id: "estimate:shared/42" }),
    "stop_est_estimate_shared_42",
  );
  assert.throws(() => estimateScheduledStopId({}), /save the estimate/i);
});

test("planned catalog usage is coalesced, unlinked materials stay display-only, and reopening releases the claim", () => {
  const source = estimate();
  source.items.push({
    id: "same-product-again",
    desc: "More beneficial bacteria",
    qty: "2",
    price: "10",
    kind: "product",
    refId: "product-bacteria",
  });
  source.items.push({
    id: "unlinked-product",
    desc: "One-off material",
    qty: "1",
    price: "5",
    kind: "product",
  });
  const scheduled = scheduleApprovedEstimate(source, [], {
    client,
    date: "08/03/2026",
    createdAt: 1,
  }).stop;

  assert.equal(
    scheduled.plannedMaterials.filter((material) => material.refId === "product-bacteria").length,
    1,
  );
  assert.equal(
    scheduled.plannedMaterials.find((material) => material.refId === "product-bacteria").quantity,
    "5",
  );
  assert.equal(scheduled.plannedMaterials.some((material) => !material.refId), false);
  assert.equal(scheduled.estimateItems.some((line) => line.id === "unlinked-product"), true);

  const claimed = claimScheduledEstimateCompletion(scheduled, {
    completionReceiptId: "receipt-release",
  });
  const released = releaseScheduledEstimateCompletion(claimed.stop, {
    completionReceiptId: "receipt-release",
    reopenedAt: "2026-08-04T12:00:00.000Z",
  });
  assert.equal(released.stop.estimateFulfillment.state, "reopened");
  assert.equal(released.stop.estimateFulfillment.completionReceiptId, null);
  assert.equal(released.stop.estimateFulfillment.priorCompletionReceiptId, "receipt-release");

  const completedAgain = claimScheduledEstimateCompletion(released.stop, {
    completionReceiptId: "receipt-second",
  });
  assert.equal(completedAgain.alreadyClaimed, false);
  assert.equal(completedAgain.stop.estimateFulfillment.completionReceiptId, "receipt-second");
});
