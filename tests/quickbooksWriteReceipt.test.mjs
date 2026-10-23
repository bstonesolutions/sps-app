import test from "node:test";
import assert from "node:assert/strict";
import { persistQuickBooksInvoiceWriteReceipt, confirmedQuickBooksWriteResponse } from "../api/_quickbooks-invoice-write-receipt.js";
import { buildQuickBooksInvoicePayload } from "../quickbooksDraftSync.js";

const clone = value => structuredClone(value);
const now = () => "2026-10-22T12:00:00Z";
const client = { id: "c1", qbId: "customer-1", name: "Customer One" };
const original = () => ({ id: "local-1", qbId: "qb-1", qbCustomerId: "customer-1", clientId: "c1", number: "2101",
  date: "10/20/2026", dueDate: "11/04/2026", status: "Sent", total: 100, balance: 100, taxRate: "0",
  qbSyncToken: "1", sourceStopId: "stop-1", notes: "Original note", source: "job",
  lineItems: [{ id: "line-1", qbLineId: "1", qbItemRef: { value: "8" }, desc: "Repair visit", qty: "1", unitPrice: "100", unitCost: 40, sourceStopId: "stop-1", kind: "service", taxable: false }] });
const raw = (overrides = {}) => ({ Id: "qb-1", CustomerRef: { value: "customer-1", name: "Customer One" }, DocNumber: "2101",
  TxnDate: "2026-10-20", DueDate: "2026-11-04", SyncToken: "2", TotalAmt: 100, Balance: 100,
  Line: [{ Id: "1", Description: "Repair visit", DetailType: "SalesItemLineDetail", Amount: 100,
    SalesItemLineDetail: { ItemRef: { value: "8", name: "Services" }, Qty: 1, UnitPrice: 100, TaxCodeRef: { value: "NON" } } }], ...overrides });
function storage(values = [original()]) {
  let snapshot = { exists: true, version: 5, value: clone(values) };
  const saves = [], resolutions = [];
  return {
    get snapshot() { return snapshot; }, saves, resolutions,
    set(value, version = snapshot.version + 1) { snapshot = { exists: true, version, value: clone(value) }; },
    readState: async key => key === "sps_clients" ? { exists: true, version: 1, value: [client] } : clone(snapshot),
    save: async (version, value, scope) => {
      saves.push({ version, value: clone(value), scope: clone(scope) });
      if (version !== snapshot.version) return { applied: false, outcome: "conflict" };
      const saved = value.map(row => scope.metadataCandidates?.[row.id] || scope.candidates?.[row.id]
        ? { ...row, qbWriteReview: { candidateId: "99", reason: scope.metadataCandidates?.[row.id] ? "concurrent-sps-metadata" : "unconfirmed-accounting-change" } } : row);
      snapshot = { exists: true, version: version + 1, value: clone(saved) };
      return { applied: true, outcome: "applied", currentVersion: snapshot.version, value: clone(saved) };
    },
    rpc: async (name, body) => {
      resolutions.push({ name, body });
      const target = snapshot.value.find(row => row.id === body.p_invoice_id);
      assert.deepEqual(body.p_expected_invoice, target);
      const resolved = { ...target }; delete resolved.qbWriteReview;
      snapshot = { exists: true, version: snapshot.version + 1, value: snapshot.value.map(row => row === target ? resolved : row) };
      return [{ applied: true, current_version: snapshot.version, invoice: resolved }];
    },
  };
}
const options = (source = original(), extra = {}) => ({ quickBooksInvoice: raw(), sourceInvoice: buildQuickBooksInvoicePayload(source, client, {}, { metadataBase: original() }),
  actorId: "owner-1", action: "quickbooks-update", realmId: "realm", ...extra });
const persist = (input, store, dependencies = {}) => persistQuickBooksInvoiceWriteReceipt(input, { ...store, now, ...dependencies });

test("a confirmed update adopts QB accounting while saving allowed editor metadata and exact actor receipt", async () => {
  const store = storage();
  const edited = original(); edited.notes = "New owner note"; edited.lineItems[0].unitCost = 55;
  const input = options(edited); input.sourceInvoice.spsMetadata.qbWriteReview = { candidateId: "spoof" };
  input.sourceInvoice.spsMetadata.total = 999; input.sourceInvoice.spsMetadata.qbId = "wrong";
  const receipt = await persist(input, store);
  const saved = receipt.invoices[0];
  assert.equal(saved.notes, "New owner note"); assert.equal(saved.lineItems[0].unitCost, 55);
  assert.equal(saved.total, 100); assert.equal(saved.qbId, "qb-1"); assert.equal(saved.qbWriteReview, undefined);
  assert.equal(saved.sourceStopId, "stop-1"); assert.equal(saved.lineItems[0].sourceStopId, "stop-1");
  assert.equal(receipt.actorId, "owner-1"); assert.equal(receipt.afterVersion, 6);
});

test("an accepted pending edit does not regenerate a proposal", async () => {
  const pending = { ...original(), locallyEdited: true, qbSyncStatus: "pending-push" };
  const store = storage([pending]);
  await persist(options(pending), store);
  assert.deepEqual(store.saves[0].scope.candidates, {});
  assert.equal(store.snapshot.value[0].qbWriteReview, undefined);
  assert.equal(store.snapshot.value[0].locallyEdited, false);
});

test("a concurrent pending financial edit is journaled while canonical accounting remains the written QB amount", async () => {
  const concurrent = original(); concurrent.locallyEdited = true; concurrent.lineItems[0].unitPrice = "250"; concurrent.total = 250;
  const store = storage([concurrent]);
  const receipt = await persist(options(), store);
  assert.equal(receipt.invoices[0].total, 100);
  assert.equal(store.saves[0].scope.candidates["local-1"].total, 250);
  assert.equal(receipt.invoices[0].qbWriteReview.candidateId, "99");
});

test("three-way metadata merge preserves unrelated office changes and journals only same-field conflicts", async () => {
  const current = original(); current.notes = "Office note"; current.lineItems[0].unitCost = 65;
  const store = storage([current]);
  const sameBase = await persist(options(), store);
  assert.equal(sameBase.invoices[0].notes, "Office note"); assert.equal(sameBase.invoices[0].lineItems[0].unitCost, 65);
  assert.deepEqual(store.saves[0].scope.metadataCandidates, {});
  const edited = original(); edited.notes = "Field note"; edited.lineItems[0].unitCost = 75;
  const conflicted = await persist(options(edited), store);
  assert.equal(conflicted.invoices[0].notes, "Office note"); assert.equal(conflicted.invoices[0].lineItems[0].unitCost, 65);
  const proposal = store.saves[1].scope.metadataCandidates["local-1"];
  assert.equal(proposal.proposed.notes, "Field note"); assert.equal(proposal.proposed.lineItems[0].unitCost, 75);
  assert.equal(proposal.proposed.total, 100); assert.equal(conflicted.invoices[0].qbWriteReview.reason, "concurrent-sps-metadata");
});

test("older callers without a metadata base cannot replace saved notes or costs", async () => {
  const store = storage();
  const edited = original(); edited.notes = "Unbased note"; edited.lineItems[0].unitCost = 2;
  const input = options(edited); delete input.sourceInvoice.spsMetadataBase;
  const receipt = await persist(input, store);
  assert.equal(receipt.invoices[0].notes, "Original note"); assert.equal(receipt.invoices[0].lineItems[0].unitCost, 40);
  assert.equal(store.saves[0].scope.metadataCandidates["local-1"].proposed.notes, "Unbased note");
});

test("billing-review creation inserts the rich trusted source before the later promotion finds its collision", async () => {
  const store = storage([]);
  const trusted = { ...original(), id: "review-1", qbId: undefined, billingReviewId: "review-1", sourceEstimateId: "estimate-1" };
  const result = await persist(options(trusted, { action: "quickbooks-create", trustedSource: trusted }), store);
  assert.equal(result.invoices[0].id, "review-1"); assert.equal(result.invoices[0].billingReviewId, "review-1");
  assert.equal(result.invoices[0].sourceEstimateId, "estimate-1"); assert.equal(result.invoices[0].lineItems[0].unitCost, 40);
  assert.equal(result.invoices[0].billingConfirmedAt, now());
});

test("CAS rebasing preserves another new invoice and a competing pending edit", async () => {
  const store = storage(); let attempts = 0;
  const save = async (...args) => {
    if (++attempts === 1) {
      const concurrent = original(); concurrent.locallyEdited = true; concurrent.lineItems[0].unitPrice = "300";
      store.set([concurrent, { id: "new-draft", total: 12 }]);
      return { applied: false, outcome: "conflict" };
    }
    return store.save(...args);
  };
  const receipt = await persist(options(), store, { save });
  assert.equal(receipt.attempts, 2); assert.equal(receipt.invoices[1].id, "new-draft");
  assert.equal(store.saves[0].scope.candidates["local-1"].lineItems[0].unitPrice, "300");
});

test("a lower QB revision cannot undo an already saved later update", async () => {
  const newer = { ...original(), qbSyncToken: "5", balance: 0, status: "Paid" };
  const store = storage([newer]);
  const receipt = await persist(options(), store);
  assert.equal(receipt.superseded, true); assert.equal(receipt.invoices[0].balance, 0); assert.equal(store.saves.length, 0);
});

test("only the exact selected proposal is resolved after canonical accounting is saved", async () => {
  const existing = { ...original(), qbWriteReview: { candidateId: "22" } };
  const store = storage([existing]);
  const receipt = await persist(options(existing, { candidateId: "22" }), store);
  assert.equal(store.resolutions.length, 1); assert.equal(store.resolutions[0].body.p_resolution, "applied-to-quickbooks");
  assert.equal(receipt.invoices[0].qbWriteReview, undefined); assert.equal(receipt.afterVersion, 7);
  const different = storage([{ ...original(), qbWriteReview: { candidateId: "23" } }]);
  const retained = await persist(options(original(), { candidateId: "22" }), different);
  assert.equal(different.resolutions.length, 0); assert.equal(retained.candidateResolutionPending, true);
  assert.equal(retained.invoices[0].qbWriteReview.candidateId, "23");
});

test("payment receipts update only confirmed QB accounting and retain a competing editor proposal", async () => {
  const pending = original(); pending.locallyEdited = true; pending.lineItems[0].unitPrice = "160";
  const store = storage([pending]);
  const receipt = await persist(options({}, { invoiceId: "local-1", action: "quickbooks-payment", quickBooksInvoice: raw({ Balance: 0 }) }), store);
  assert.equal(receipt.invoices[0].balance, 0); assert.equal(receipt.invoices[0].status, "Paid");
  assert.equal(store.saves[0].scope.candidates["local-1"].lineItems[0].unitPrice, "160");
});

test("post-write persistence errors produce a recovery warning rather than a failed QuickBooks result", async () => {
  const store = storage();
  const result = await confirmedQuickBooksWriteResponse(options(), { ...store, now, save: async () => { throw new Error("offline"); } });
  assert.equal(result.appSyncPending, true); assert.match(result.warning, /do not create or record it again/);
  assert.equal(result.invoiceRefresh, undefined);
  const invalid = await confirmedQuickBooksWriteResponse(options({}, { quickBooksInvoice: { ...raw(), Balance: undefined } }), { ...store, now });
  assert.equal(invalid.appSyncCode, "QB_WRITE_SNAPSHOT_INCOMPLETE");
  assert.equal(store.saves.length, 0);
});
