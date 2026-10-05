import assert from "node:assert/strict";
import test from "node:test";

import {
  findInvoiceDeletionReferences,
  invoiceDeletionBlockedMessage,
  unlinkInvoiceDeletionReferences,
} from "../invoiceDeletionGuard.js";

test("invoice deletion is blocked by direct estimate and scheduled-stop links", () => {
  const invoice = { id: "invoice-7", number: "INV-7" };
  const references = findInvoiceDeletionReferences(
    invoice,
    [{ id: "estimate-1", linkedInvoiceId: "invoice-7" }],
    [{ date: "07/30/2026", stops: [{ sid: "stop-1", linkedInvoiceId: "invoice-7" }] }],
  );

  assert.equal(references.blocked, true);
  assert.deepEqual(references.estimates.map((estimate) => estimate.id), ["estimate-1"]);
  assert.deepEqual(references.stops.map((stop) => stop.sid), ["stop-1"]);
  assert.match(invoiceDeletionBlockedMessage(invoice, references), /1 estimate and 1 scheduled stop/);
});

test("legacy estimate-derived invoices remain protected when only source links survive", () => {
  const invoice = {
    id: "iv_est_estimate-42",
    number: "INV-1042",
    sourceEstimateId: "estimate-42",
    status: "Draft",
  };
  const references = findInvoiceDeletionReferences(
    invoice,
    [{ id: "estimate-42" }],
    [{ date: "07/31/2026", stops: [{ sid: "stop-42", sourceEstimateId: "estimate-42" }] }],
  );

  assert.equal(references.blocked, true);
  assert.equal(references.estimates[0].id, "estimate-42");
  assert.equal(references.stops[0].sid, "stop-42");
});

test("an unreferenced invoice can be deleted", () => {
  const references = findInvoiceDeletionReferences(
    { id: "invoice-free", number: "INV-99" },
    [{ id: "estimate-other", linkedInvoiceId: "invoice-other" }],
    [{ date: "08/01/2026", stops: [{ sid: "stop-other", linkedInvoiceId: "invoice-other" }] }],
  );

  assert.equal(references.blocked, false);
  assert.deepEqual(references.estimates, []);
  assert.deepEqual(references.stops, []);
});

test("explicit unlinking preserves jobs, estimates, source provenance, and unrelated invoice links", () => {
  const invoice = { id: "invoice-7", sourceEstimateId: "estimate-1" };
  const estimates = [{ id: "estimate-1", linkedInvoiceId: "invoice-7", status: "Accepted" }, { id: "estimate-2", linkedInvoiceId: "keep-invoice" }];
  const schedule = [{ date: "10/05/2026", stops: [{ sid: "stop-1", sourceEstimateId: "estimate-1", linkedInvoiceId: "invoice-7", completed: true }, { sid: "stop-2", linkedInvoiceId: "keep-invoice" }] }, { sid: "flat-stop", linkedInvoiceId: "invoice-7" }];
  const result = unlinkInvoiceDeletionReferences(invoice, estimates, schedule);
  assert.equal(result.changed, true);
  assert.deepEqual(result.estimates, [{ id: "estimate-1", status: "Accepted" }, estimates[1]]);
  assert.deepEqual(result.schedule[0].stops[0], { sid: "stop-1", sourceEstimateId: "estimate-1", completed: true });
  assert.deepEqual(result.schedule[1], { sid: "flat-stop" });
  assert.equal(result.schedule[0].stops[1], schedule[0].stops[1]);
  assert.equal(estimates[0].linkedInvoiceId, "invoice-7", "inputs stay intact");
  assert.equal(schedule[0].stops[0].linkedInvoiceId, "invoice-7");
});
