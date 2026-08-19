import test from "node:test";
import assert from "node:assert/strict";

import { deliverInvoiceThroughChannels, deliverSelectedInvoices } from "../invoiceBulkDelivery.js";

test("one channel failure does not block other selected channels", async () => {
  const calls = [];
  const result = await deliverInvoiceThroughChannels([
    { id: "sms", enabled: true, send: async () => { calls.push("sms"); return { ok: false, error: "No route" }; } },
    { id: "app", enabled: true, send: async () => { calls.push("app"); return { ok: true }; } },
    { id: "email", enabled: false, send: async () => { calls.push("email"); return { ok: true }; } },
  ]);
  assert.deepEqual(calls, ["sms", "app"]);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.succeeded, ["app"]);
  assert.equal(result.failed[0].channel, "sms");
});

test("Test Mode delivery is reported but never marks the invoice sent", async () => {
  let accepted = 0;
  const results = await deliverSelectedInvoices({
    invoices: [{ id: "one" }],
    buildChannels: async () => [{ id: "email", enabled: true, send: async () => ({ ok: true, held: true }) }],
    onAccepted: async () => { accepted += 1; },
  });
  assert.equal(accepted, 0);
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].protected.length, 1);
});

test("a failed invoice does not stop the next invoice", async () => {
  const accepted = [];
  const results = await deliverSelectedInvoices({
    invoices: [{ id: "bad" }, { id: "good" }],
    buildChannels: async (invoice) => [{
      id: "email",
      enabled: true,
      send: async () => invoice.id === "bad" ? { ok: false, error: "Rejected" } : { ok: true },
    }],
    onAccepted: async (invoice) => accepted.push(invoice.id),
  });
  assert.deepEqual(accepted, ["good"]);
  assert.equal(results[0].accepted, false);
  assert.equal(results[1].accepted, true);
});
