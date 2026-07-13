import test from "node:test";
import assert from "node:assert/strict";

import {
  STOP_BALANCE_OWNER_KEY,
  STOP_REVERSAL_LEDGER_KEY,
  applyStopCompletion,
  isNonnegativeMoneyString,
  normalizeCompletionInvoice,
  reverseStopCompletion,
  validateStopReceipt,
} from "../stopCompletion.js";

const baseClients = () => [{ id: "c1", name: "Client", balance: "$25", history: [{ sid: "old", notes: "Earlier" }] }];
const baseCatalog = () => ({
  locations: [{ id: "truck", name: "Truck" }, { id: "shed", name: "Shed" }],
  treatments: [{ id: "t1", name: "Treatment", unit: "oz", stockByLoc: { truck: 3, shed: 10 }, inventoryOz: "13" }],
  parts: [{ id: "pt1", name: "Part", unit: "pieces", stockByLoc: { truck: 2, shed: 4 }, inventoryOz: "6" }],
  products: [{ id: "p1", name: "Product", unit: "bottles", stockByLoc: { truck: 1, shed: 3 }, inventoryOz: "4" }],
});
const entry = (sid = "s1", invoice = "$80") => ({
  sid,
  invoice,
  notes: "Completed",
  usageLoc: "truck",
  treatmentsUsed: [{ id: "t1", name: "Treatment", unit: "oz", oz: 8, locId: "truck" }],
  partsUsed: [{ id: "pt1", name: "Part", unit: "pieces", qty: 1, locId: "truck" }],
  productsPurchased: [{ id: "p1", name: "Product", unit: "bottles", qty: 2, locId: "truck" }],
});

function complete({ clients = baseClients(), catalog = baseCatalog(), completed = {}, sid = "s1", receiptId = "receipt-1", idempotencyKey = `attempt-${receiptId}`, invoice = "$80" } = {}) {
  return applyStopCompletion({
    clients,
    catalog,
    completed,
    clientId: "c1",
    entry: entry(sid, invoice),
    sid,
    receiptId,
    idempotencyKey,
    completedAt: "2026-07-12T12:00:00.000Z",
  });
}

test("completion records exact per-location deductions and reversal adds only those deltas", () => {
  const clients = baseClients();
  const catalog = baseCatalog();
  const completed = complete({ clients, catalog });

  assert.equal(completed.ok, true);
  assert.deepEqual(completed.catalog.treatments[0].stockByLoc, { truck: 0, shed: 5 });
  assert.deepEqual(completed.receipt.inventory.find((line) => line.section === "treatments").deductions, [
    { locationId: "truck", amount: 3 },
    { locationId: "shed", amount: 5 },
  ]);

  // Another inventory event after completion must survive the reversal. Shed used two more;
  // truck gained four. Reversal adds 3 + 5 instead of overwriting either current cell.
  const currentCatalog = structuredClone(completed.catalog);
  currentCatalog.treatments[0].stockByLoc = { truck: 4, shed: 3 };
  currentCatalog.treatments[0].inventoryOz = "7";
  const reversed = reverseStopCompletion({
    clients: completed.clients,
    catalog: currentCatalog,
    completed: completed.completed,
    clientId: "c1",
    sid: "s1",
  });

  assert.equal(reversed.ok, true);
  assert.deepEqual(reversed.catalog.treatments[0].stockByLoc, { truck: 7, shed: 8 });
  assert.equal(reversed.catalog.treatments[0].inventoryOz, "15");
  assert.deepEqual(reversed.inventoryRestored.filter((line) => line.section === "treatments").map(({ locationId, amount }) => ({ locationId, amount })), [
    { locationId: "truck", amount: 3 },
    { locationId: "shed", amount: 5 },
  ]);
});

test("receipt-based reversal removes only its history entry and restores the prior balance", () => {
  const completed = complete();
  const receiptId = completed.completed.s1.receiptId;
  assert.equal(completed.clients[0].balance, "$80");
  assert.equal(completed.clients[0][STOP_BALANCE_OWNER_KEY], receiptId);
  assert.equal(completed.clients[0].history[0].completionReceiptId, receiptId);

  const reversed = reverseStopCompletion({
    clients: completed.clients,
    catalog: completed.catalog,
    completed: completed.completed,
    clientId: "c1",
    sid: "s1",
  });

  assert.equal(reversed.ok, true);
  assert.equal(reversed.clients[0].balance, "$25");
  assert.equal(STOP_BALANCE_OWNER_KEY in reversed.clients[0], false);
  assert.deepEqual(reversed.clients[0].history, [{ sid: "old", notes: "Earlier" }]);
  assert.equal(reversed.completed.s1, undefined);
  assert.equal(reversed.completed[STOP_REVERSAL_LEDGER_KEY], undefined);
});

test("completion and reversal are idempotent", () => {
  const first = complete();
  const duplicate = complete({ clients: first.clients, catalog: first.catalog, completed: first.completed });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadyCompleted, true);
  assert.equal(duplicate.sameRequest, true);
  assert.equal(duplicate.clients[0].history.length, 2);
  assert.deepEqual(duplicate.catalog, first.catalog);

  const firstReverse = reverseStopCompletion({
    clients: first.clients,
    catalog: first.catalog,
    completed: first.completed,
    clientId: "c1",
    sid: "s1",
  });
  const duplicateReverse = reverseStopCompletion({
    clients: firstReverse.clients,
    catalog: firstReverse.catalog,
    completed: firstReverse.completed,
    clientId: "c1",
    sid: "s1",
  });
  assert.equal(duplicateReverse.ok, true);
  assert.equal(duplicateReverse.alreadyReversed, true);
  assert.deepEqual(duplicateReverse.clients, firstReverse.clients);
  assert.deepEqual(duplicateReverse.catalog, firstReverse.catalog);
});

test("a competing completion is rejected while an identical retry is recognized", () => {
  const first = complete({ receiptId: "receipt-first", idempotencyKey: "attempt-device-one" });
  const retry = complete({
    clients: first.clients,
    catalog: first.catalog,
    completed: first.completed,
    receiptId: "unused-retry-receipt",
    idempotencyKey: "attempt-device-one",
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyCompleted, true);
  assert.equal(retry.sameRequest, true);

  const losingClients = structuredClone(first.clients);
  const competing = complete({
    clients: losingClients,
    catalog: first.catalog,
    completed: first.completed,
    receiptId: "receipt-second",
    idempotencyKey: "attempt-device-two",
  });
  assert.equal(competing.ok, false);
  assert.equal(competing.code, "completion-already-owned");
  assert.deepEqual(losingClients, first.clients, "the losing report/draft input remains untouched");
});

test("completion rejects missing, duplicated, or ambiguous positive inventory usage", () => {
  const common = {
    clients: baseClients(),
    catalog: baseCatalog(),
    completed: {},
    clientId: "c1",
    sid: "s1",
    receiptId: "receipt-validation",
    idempotencyKey: "attempt-validation",
    completedAt: "2026-07-12T12:00:00.000Z",
  };
  const missing = applyStopCompletion({ ...common, entry: { invoice: "$20.00", treatmentsUsed: [{ id: "missing", name: "Missing", oz: 1 }] } });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "inventory-item-missing");

  const duplicateUsage = applyStopCompletion({ ...common, entry: { invoice: "$20.00", treatmentsUsed: [{ id: "t1", oz: 1 }, { id: "t1", oz: 2 }] } });
  assert.equal(duplicateUsage.ok, false);
  assert.equal(duplicateUsage.code, "inventory-usage-duplicate");

  const duplicateCatalog = baseCatalog();
  duplicateCatalog.treatments.push(structuredClone(duplicateCatalog.treatments[0]));
  const ambiguous = applyStopCompletion({ ...common, catalog: duplicateCatalog, entry: { invoice: "$20.00", treatmentsUsed: [{ id: "t1", oz: 1 }] } });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "inventory-item-ambiguous");
});

test("completion fails closed when a client ID is duplicated", () => {
  const clients = baseClients();
  clients.push(structuredClone(clients[0]));
  const result = complete({ clients });
  assert.equal(result.ok, false);
  assert.equal(result.code, "client-id-ambiguous");
});

test("out-of-order reversals do not restore an inactive visit's balance", () => {
  const first = complete({ sid: "s1", receiptId: "receipt-1", invoice: "$80" });
  const second = complete({
    clients: first.clients,
    catalog: first.catalog,
    completed: first.completed,
    sid: "s2",
    receiptId: "receipt-2",
    invoice: "$120",
  });
  assert.equal(second.clients[0].balance, "$120");

  const reverseOlder = reverseStopCompletion({
    clients: second.clients,
    catalog: second.catalog,
    completed: second.completed,
    clientId: "c1",
    sid: "s1",
  });
  assert.equal(reverseOlder.clients[0].balance, "$120");
  assert.equal(reverseOlder.clients[0][STOP_BALANCE_OWNER_KEY], "receipt-2");
  assert.deepEqual(Object.keys(reverseOlder.completed[STOP_REVERSAL_LEDGER_KEY]), ["receipt-2"]);
  assert.deepEqual(reverseOlder.completed[STOP_REVERSAL_LEDGER_KEY]["receipt-2"].balance.before, {
    hadOwn: true,
    value: "$25",
    ownerReceiptId: null,
  });

  const reverseNewer = reverseStopCompletion({
    clients: reverseOlder.clients,
    catalog: reverseOlder.catalog,
    completed: reverseOlder.completed,
    clientId: "c1",
    sid: "s2",
  });
  assert.equal(reverseNewer.clients[0].balance, "$25");
  assert.equal(STOP_BALANCE_OWNER_KEY in reverseNewer.clients[0], false);
  assert.equal(reverseNewer.completed[STOP_REVERSAL_LEDGER_KEY], undefined);
});

test("sequential completion/reversal keeps the receipt ledger bounded to active stops", () => {
  let clients = baseClients(), catalog = baseCatalog(), completed = {};
  for (let index = 0; index < 5; index += 1) {
    const sid = `seq-${index}`;
    const applied = complete({ clients, catalog, completed, sid, receiptId: `receipt-seq-${index}`, idempotencyKey: `attempt-seq-${index}` });
    assert.equal(applied.ok, true);
    assert.equal(Object.keys(applied.completed[STOP_REVERSAL_LEDGER_KEY]).length, 1);
    const reversed = reverseStopCompletion({ clients: applied.clients, catalog: applied.catalog, completed: applied.completed, clientId: "c1", sid });
    assert.equal(reversed.ok, true);
    assert.equal(reversed.completed[STOP_REVERSAL_LEDGER_KEY], undefined);
    clients = reversed.clients; catalog = reversed.catalog; completed = reversed.completed;
  }
  assert.equal(clients[0].balance, "$25");
});

test("a later manual balance edit wins over a reversal", () => {
  const completed = complete();
  const clients = structuredClone(completed.clients);
  clients[0].balance = "$999";

  const reversed = reverseStopCompletion({
    clients,
    catalog: completed.catalog,
    completed: completed.completed,
    clientId: "c1",
    sid: "s1",
  });

  assert.equal(reversed.clients[0].balance, "$999");
  assert.equal(STOP_BALANCE_OWNER_KEY in reversed.clients[0], false);
});

test("legacy numeric or comma-formatted prior balances are preserved exactly", () => {
  for (const priorBalance of [1250.5, "$1,250.50"]) {
    const clients = baseClients();
    clients[0].balance = priorBalance;
    const applied = complete({ clients, receiptId: `receipt-${String(priorBalance)}`, idempotencyKey: `attempt-${String(priorBalance)}` });
    assert.equal(applied.ok, true);
    const reversed = reverseStopCompletion({ clients: applied.clients, catalog: applied.catalog, completed: applied.completed, clientId: "c1", sid: "s1" });
    assert.equal(reversed.ok, true);
    assert.deepEqual(reversed.clients[0].balance, priorBalance);
  }
});

test("legacy boolean completions never guess inventory or balance", () => {
  const clients = baseClients();
  clients[0].history.unshift({ sid: "legacy", notes: "Old completion" });
  const catalog = baseCatalog();
  const completed = { legacy: true };

  const blocked = reverseStopCompletion({ clients, catalog, completed, clientId: "c1", sid: "legacy" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "legacy-completion");
  assert.deepEqual(clients[0].balance, "$25");
  assert.deepEqual(catalog, baseCatalog());

  const explicit = reverseStopCompletion({ clients, catalog, completed, clientId: "c1", sid: "legacy", allowLegacy: true });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.degraded, true);
  assert.equal(explicit.clients[0].balance, "$25");
  assert.deepEqual(explicit.catalog, catalog);
  assert.deepEqual(explicit.clients[0].history, [{ sid: "old", notes: "Earlier" }]);
  assert.equal(explicit.completed.legacy, undefined);
});

test("a missing receipt or deleted inventory item blocks the entire reversal", () => {
  const completed = complete();
  const missingReceipt = structuredClone(completed.completed);
  delete missingReceipt[STOP_REVERSAL_LEDGER_KEY][completed.completed.s1.receiptId];
  const receiptBlocked = reverseStopCompletion({
    clients: completed.clients,
    catalog: completed.catalog,
    completed: missingReceipt,
    clientId: "c1",
    sid: "s1",
  });
  assert.equal(receiptBlocked.ok, false);
  assert.equal(receiptBlocked.code, "reversal-receipt-missing");

  const catalogMissingItem = structuredClone(completed.catalog);
  catalogMissingItem.treatments = [];
  const inventoryBlocked = reverseStopCompletion({
    clients: completed.clients,
    catalog: catalogMissingItem,
    completed: completed.completed,
    clientId: "c1",
    sid: "s1",
  });
  assert.equal(inventoryBlocked.ok, false);
  assert.equal(inventoryBlocked.code, "inventory-item-missing");
  assert.equal(completed.completed.s1.receiptId, "receipt-1");
});

test("reversal requires exactly one matching history receipt", () => {
  const completed = complete();
  const missing = structuredClone(completed.clients);
  missing[0].history = missing[0].history.filter((item) => item.completionReceiptId !== "receipt-1");
  const missingResult = reverseStopCompletion({ clients: missing, catalog: completed.catalog, completed: completed.completed, clientId: "c1", sid: "s1" });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.code, "history-receipt-count-invalid");

  const duplicate = structuredClone(completed.clients);
  duplicate[0].history.unshift(structuredClone(duplicate[0].history[0]));
  const duplicateResult = reverseStopCompletion({ clients: duplicate, catalog: completed.catalog, completed: completed.completed, clientId: "c1", sid: "s1" });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.code, "history-receipt-count-invalid");
});

test("reversal blocks when a recorded stock location or stock cell is missing", () => {
  const completed = complete();
  const noLocation = structuredClone(completed.catalog);
  noLocation.locations = noLocation.locations.filter((location) => location.id !== "truck");
  const locationResult = reverseStopCompletion({ clients: completed.clients, catalog: noLocation, completed: completed.completed, clientId: "c1", sid: "s1" });
  assert.equal(locationResult.ok, false);
  assert.equal(locationResult.code, "inventory-location-missing");

  const noCell = structuredClone(completed.catalog);
  delete noCell.treatments[0].stockByLoc.truck;
  const cellResult = reverseStopCompletion({ clients: completed.clients, catalog: noCell, completed: completed.completed, clientId: "c1", sid: "s1" });
  assert.equal(cellResult.ok, false);
  assert.equal(cellResult.code, "inventory-location-missing");

  const duplicateItem = structuredClone(completed.catalog);
  duplicateItem.treatments.push(structuredClone(duplicateItem.treatments[0]));
  const duplicateResult = reverseStopCompletion({ clients: completed.clients, catalog: duplicateItem, completed: completed.completed, clientId: "c1", sid: "s1" });
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.code, "inventory-item-ambiguous");
});

test("receipt schema and dollar values are strict", () => {
  assert.equal(normalizeCompletionInvoice("12."), "$12.00");
  assert.equal(normalizeCompletionInvoice("12.345"), "$12.35");
  assert.equal(normalizeCompletionInvoice("0.00"), "$0");
  assert.equal(normalizeCompletionInvoice("."), null);
  assert.equal(isNonnegativeMoneyString("$0"), true);
  assert.equal(isNonnegativeMoneyString("$12.34"), true);
  for (const invalid of ["-$1", "$-1", "$1.234", "$1e3", "$Infinity", "12.00", "$", "$ 1"]) {
    assert.equal(isNonnegativeMoneyString(invalid), false, invalid);
  }
  const invalidCompletion = complete({ invoice: "-$5" });
  assert.equal(invalidCompletion.ok, false);
  assert.equal(invalidCompletion.code, "invalid-invoice");

  const completed = complete();
  const receipt = completed.completed[STOP_REVERSAL_LEDGER_KEY]["receipt-1"];
  assert.equal(validateStopReceipt(receipt).ok, true);
  const malformed = structuredClone(receipt);
  malformed.inventory[0].deductions = [];
  assert.equal(validateStopReceipt(malformed).ok, false);
  const corruptState = structuredClone(completed.completed);
  corruptState[STOP_REVERSAL_LEDGER_KEY]["receipt-1"] = malformed;
  const blocked = reverseStopCompletion({ clients: completed.clients, catalog: completed.catalog, completed: corruptState, clientId: "c1", sid: "s1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "reversal-receipt-missing");
});

test("an unprovable balance predecessor chain fails closed", () => {
  const first = complete({ sid: "s1", receiptId: "receipt-parent", idempotencyKey: "attempt-parent", invoice: "$80" });
  const second = complete({ clients: first.clients, catalog: first.catalog, completed: first.completed, sid: "s2", receiptId: "receipt-child", idempotencyKey: "attempt-child", invoice: "$120" });
  const corrupt = structuredClone(second.completed);
  delete corrupt[STOP_REVERSAL_LEDGER_KEY]["receipt-parent"];

  const blocked = reverseStopCompletion({ clients: second.clients, catalog: second.catalog, completed: corrupt, clientId: "c1", sid: "s2" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "balance-chain-unprovable");
  assert.equal(second.clients[0].balance, "$120");

  const thirdAttempt = complete({
    clients: second.clients,
    catalog: second.catalog,
    completed: corrupt,
    sid: "s3",
    receiptId: "receipt-third",
    idempotencyKey: "attempt-third",
    invoice: "$140",
  });
  assert.equal(thirdAttempt.ok, false);
  assert.equal(thirdAttempt.code, "balance-chain-unprovable");
});

test("pure completion helpers do not mutate their inputs", () => {
  const clients = baseClients();
  const catalog = baseCatalog();
  const completed = {};
  const before = structuredClone({ clients, catalog, completed });

  const result = complete({ clients, catalog, completed });
  assert.equal(result.ok, true);
  assert.deepEqual({ clients, catalog, completed }, before);

  const completedBeforeReverse = structuredClone(result);
  const reversed = reverseStopCompletion({
    clients: result.clients,
    catalog: result.catalog,
    completed: result.completed,
    clientId: "c1",
    sid: "s1",
  });
  assert.equal(reversed.ok, true);
  assert.deepEqual(result, completedBeforeReverse);
});
