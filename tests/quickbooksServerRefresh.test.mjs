import test from "node:test";
import assert from "node:assert/strict";
import { mergeQuickBooksInvoiceRefresh, persistQuickBooksInvoiceRefresh } from "../api/_quickbooks-invoice-refresh.js";

const startedAt = "2026-10-22T14:00:00.000Z";
const fetchedAt = "2026-10-22T14:01:00.000Z";
const clone = value => JSON.parse(JSON.stringify(value));
const clients = [{ id: "client-1", qbId: "customer-1", name: "Client One", email: "one@example.com" }];
const remote = (id = "1", overrides = {}) => ({
  qbId: id, qbCustomerId: "customer-1", clientName: "Client One", number: `200${id}`,
  date: "2026-10-01", dueDate: "2026-10-15", status: "Paid", total: 200, balance: 0,
  qbSyncToken: "2", qbLastUpdatedTime: "2026-10-21T14:00:00Z", qbContentFingerprint: `fingerprint-${id}`,
  lineItems: [{ qbLineId: "1", desc: "October service", qty: 1, unitPrice: 200 }], ...overrides,
});
const linked = (id = "1", overrides = {}) => ({
  ...remote(id, { status: "Sent", balance: 200, qbSyncToken: "1", qbLastUpdatedTime: "2026-10-20T14:00:00Z" }),
  id: `local-${id}`, clientId: "client-1", source: "job", sourceStopId: `stop-${id}`, ...overrides,
});
const payload = (invoices = [remote()], overrides = {}) => ({
  invoices, customers: [{ qbId: "customer-1", name: "Client One", email: "one@example.com" }], realmId: "company-1",
  startedAt, reconciliation: { fetchedAt, pagination: { invoices: { complete: true } } }, ...overrides,
});
const state = (value, version = 10) => ({ exists: true, value: clone(value), version });

function storage(invoices = [linked()], options = {}) {
  let ledger = state(invoices), reads = [], writes = [];
  return {
    get ledger() { return ledger; }, get reads() { return reads; }, get writes() { return writes; },
    setLedger(value, version) { ledger = state(value, version); },
    readState: async key => {
      reads.push(key);
      if (key === "sps_clients") return state(options.clients ?? clients, 4);
      assert.equal(key, "sps_invoices");
      return clone(ledger);
    },
    compareAndSet: async (key, expected, value, scope = {}) => {
      writes.push({ key, expected, value: clone(value), scope: clone(scope) });
      assert.equal(key, "sps_invoices");
      if (expected !== ledger.version) return { applied: false, outcome: "conflict", currentVersion: ledger.version };
      const saved = value.map(invoice => Object.hasOwn(scope.candidates || {}, invoice.id)
        ? { ...invoice, qbWriteReview: { state: "pending", invoiceId: invoice.id } } : invoice);
      if (JSON.stringify(ledger.value) === JSON.stringify(saved)) return { applied: true, outcome: "unchanged", currentVersion: ledger.version, value: clone(ledger.value) };
      ledger = state(saved, expected + 1);
      return { applied: true, outcome: "applied", currentVersion: ledger.version, value: clone(ledger.value) };
    },
  };
}
const persist = (body, store, extra = {}) => persistQuickBooksInvoiceRefresh(body, {
  actorId: "owner-1", readState: store.readState, compareAndSet: store.compareAndSet, ...extra,
});

test("pending work is separated from canonical accounting while other paid invoices and new imports refresh", () => {
  const pending = linked("1", { locallyEdited: true, total: 250, balance: 250, notes: "Keep this edit" });
  const clean = linked("2", { sourceEstimateId: "estimate-1", paymentLink: "/pay/local-2", lineItems: [
    { id: "local-line", qbLineId: "1", desc: "October service", qty: 1, unitPrice: 200, unitCost: 45, sourceStopId: "stop-2" },
  ] });
  const draft = { id: "review-1", status: "Review", sourceStopId: "new-stop", total: 70 };
  const input = [pending, clean, draft];
  const original = clone(input);
  const result = mergeQuickBooksInvoiceRefresh(input, clients, payload([remote("1"), remote("2"), remote("3")]));
  const [a, b, c, added] = result.invoices;
  assert.equal(a.total, 200);
  assert.equal(a.notes, "Keep this edit");
  assert.equal(a.qbNeedsReview, undefined);
  assert.equal(a.balance, 0);
  assert.deepEqual(result.candidates[a.id], pending);
  assert.equal(result.authority[a.id].total, 200);
  assert.equal(result.authority[a.id].locallyEdited, false);
  assert.equal(b.status, "Paid"); assert.equal(b.balance, 0);
  assert.equal(b.sourceEstimateId, "estimate-1"); assert.equal(b.paymentLink, "/pay/local-2");
  assert.equal(b.lineItems[0].unitCost, 45); assert.equal(b.lineItems[0].sourceStopId, "stop-2");
  assert.deepEqual(c, draft);
  assert.equal(added.id, "qb_3"); assert.equal(added.clientId, "client-1");
  assert.deepEqual(input, original);
  assert.equal(result.counts.imported, 1); assert.equal(result.counts.review, 1);
});

test("client identity mapping is conservative and does not mutate the roster", () => {
  const roster = [
    { id: "exact", qbId: "q1", name: "Known" },
    { id: "named", name: "Fallback", email: "fallback@example.com" },
    { id: "other", name: "Other", email: "other@example.com" },
    { id: "wrong", qbId: "other-qb", name: "Same name" },
    { id: "duplicate-a", qbId: "duplicate", name: "Duplicate A" },
    { id: "duplicate-b", qbId: "duplicate", name: "Duplicate B" },
  ];
  const customers = [
    { qbId: "q1", name: "Different label" },
    { qbId: "q2", name: "Fallback", email: "fallback@example.com" },
    { qbId: "q3", name: "Fallback", email: "other@example.com" },
    { qbId: "q4", name: "Same name" },
    { qbId: "duplicate", name: "Duplicate A" },
  ];
  const copy = clone(roster);
  const result = mergeQuickBooksInvoiceRefresh([], roster, payload(customers.map((c, i) => remote(String(i), { qbCustomerId: c.qbId })), { customers }));
  assert.deepEqual(result.invoices.map(invoice => invoice.clientId), ["exact", "named", null, null, null]);
  assert.deepEqual(roster, copy);
});

test("a changed QB customer clears a stale client association without inventing a replacement", () => {
  const result = mergeQuickBooksInvoiceRefresh([linked()], clients, payload([remote("1", { qbCustomerId: "unknown", clientName: "Unmatched" })]));
  assert.equal(result.invoices[0].clientId, null);
  assert.equal(result.invoices[0].qbCustomerId, "unknown");
});

test("only complete QB queries mark missing records and concurrent creates stay intact", () => {
  const old = linked("1");
  const recent = linked("2", { qbLastUpdatedTime: "2026-10-22T14:00:30Z" });
  const unlinked = { id: "draft", number: "", lineItems: [] };
  const result = mergeQuickBooksInvoiceRefresh([old, recent, unlinked], clients, payload([]));
  assert.equal(result.invoices[0].qbSyncStatus, "missing-remote");
  assert.equal(result.invoices[0].qbMissingSince, fetchedAt);
  assert.deepEqual(result.diagnostics[old.id], { expected: old, patch: { qbNeedsReview: true, qbSyncStatus: "missing-remote", qbMissingSince: fetchedAt } });
  assert.equal(result.authority[old.id], undefined, "missing accounting is never newly certified");
  assert.deepEqual(result.invoices[1], recent);
  assert.deepEqual(result.invoices[2], unlinked);
  const incomplete = payload([], { reconciliation: { fetchedAt, pagination: { invoices: { complete: false } } } });
  assert.deepEqual(mergeQuickBooksInvoiceRefresh([old], clients, incomplete).invoices, [old]);
});

test("a slower query cannot regress a newer confirmed QB revision", () => {
  const newer = linked("1", { qbSyncToken: "4", balance: 0, status: "Paid" });
  const result = mergeQuickBooksInvoiceRefresh([newer], clients, payload([remote("1", { status: "Sent", balance: 200, qbSyncToken: "3" })]));
  assert.deepEqual(result.invoices, [newer]); assert.equal(result.counts.preservedNewer, 1);
  const newerTime = linked("1", { qbLastUpdatedTime: "2026-10-22T13:59:00Z", qbSyncToken: undefined });
  assert.deepEqual(mergeQuickBooksInvoiceRefresh([newerTime], clients, payload()).invoices, [newerTime]);
});

test("duplicate local QB links stay visible for review without importing a third copy", () => {
  const imported = linked("1", { id: "qb_1", source: "quickbooks" });
  const job = linked("1");
  const result = mergeQuickBooksInvoiceRefresh([imported, job], clients, payload());
  assert.equal(result.invoices.length, 2);
  assert.equal(result.invoices[0].qbSyncStatus, "duplicate-local-qb-id");
  assert.equal(result.invoices[0].qbDuplicateOfId, "local-1");
  assert.equal(result.invoices[1].balance, 0); assert.equal(result.counts.imported, 0);
  assert.deepEqual(result.diagnostics.qb_1.expected, imported);
  assert.equal(result.authority.qb_1, undefined);
});

test("an existing server authority owner wins over source ordering for duplicate links", async () => {
  const imported = linked("1", { id: "qb_1", source: "quickbooks" });
  const pendingJob = linked("1", { locallyEdited: true, total: 250 });
  const store = storage([pendingJob, imported]);
  let ownersRead = 0;
  const receipt = await persist(payload(), store, { readAuthorityOwners: async () => {
    ownersRead++; return [{ invoice_id: "qb_1", qb_id: "1" }];
  } });
  assert.equal(ownersRead, 1);
  assert.equal(receipt.invoices[0].qbDuplicateOfId, "qb_1");
  assert.equal(receipt.invoices[0].total, 250, "diagnostics do not certify or discard pending content");
  assert.equal(receipt.invoices[1].balance, 0);
  assert.equal(store.writes[0].scope.authority["local-1"], undefined);
  assert.deepEqual(store.writes[0].scope.diagnostics["local-1"].expected, pendingJob);
  assert.equal(store.writes[0].scope.authority.qb_1.qbId, "1");
});

test("missing diagnostic scope reaches canonical persistence without an authority candidate", async () => {
  const store = storage();
  await persist(payload([]), store);
  assert.equal(store.writes[0].scope.authority["local-1"], undefined);
  assert.equal(store.writes[0].scope.diagnostics["local-1"].patch.qbSyncStatus, "missing-remote");
});

test("a missing canonical owner fails before a refresh can reassign a duplicate QB identity", async () => {
  const store = storage([linked("1", { id: "alias-1" }), linked("1", { id: "alias-2" })]);
  await assert.rejects(persist(payload(), store, { readAuthorityOwners: async () => [{ invoice_id: "missing-owner", qb_id: "1" }] }),
    { code: "QB_REFRESH_IDENTITY_CONFLICT", status: 409 });
  assert.equal(store.writes.length, 0);
});

test("server refresh saves only the invoice row and returns the confirmed full ledger", async () => {
  const store = storage();
  const receipt = await persist(payload([remote(), remote("2")]), store);
  assert.deepEqual(store.reads, ["sps_clients", "sps_invoices", "sps_invoices"]);
  assert.equal(store.writes.length, 1); assert.equal(store.writes[0].key, "sps_invoices");
  assert.equal(store.writes[0].scope.action, "quickbooks-refresh");
  assert.equal(store.writes[0].scope.authority["local-1"].balance, 0);
  assert.equal(receipt.beforeVersion, 10); assert.equal(receipt.afterVersion, 11);
  assert.equal(receipt.actorId, "owner-1");
  assert.equal(receipt.complete, true); assert.equal(receipt.quickBooksComplete, true);
  assert.equal(receipt.changed, true); assert.deepEqual(receipt.invoices, store.ledger.value);
});

test("an identical refresh still registers fresh authority without creating another version", async () => {
  const store = storage();
  await persist(payload(), store);
  const again = await persist(payload(), store);
  assert.equal(again.changed, false); assert.equal(again.beforeVersion, 11); assert.equal(again.afterVersion, 11);
  assert.equal(store.writes.length, 2);
});

test("CAS contention rebases the whole plan preserving another employee's new draft and pending edit", async () => {
  const store = storage([linked("1"), linked("2")]);
  let attempts = 0;
  const compareAndSet = async (key, version, values, scope) => {
    if (++attempts === 1) {
      store.setLedger([linked("1", { locallyEdited: true, total: 450 }), linked("2"), { id: "new-draft", total: 60 }], 11);
      return { applied: false, outcome: "conflict", currentVersion: 11 };
    }
    return store.compareAndSet(key, version, values, scope);
  };
  const receipt = await persist(payload([remote("1"), remote("2")]), store, { compareAndSet });
  assert.equal(receipt.attempts, 2); assert.equal(receipt.beforeVersion, 11); assert.equal(receipt.afterVersion, 12);
  assert.equal(receipt.invoices[0].total, 200); assert.equal(receipt.invoices[0].qbWriteReview.state, "pending");
  assert.equal(store.writes[0].scope.candidates["local-1"].total, 450);
  assert.equal(receipt.invoices[1].balance, 0); assert.equal(receipt.invoices[2].id, "new-draft");
});

test("a later concurrent save returns its exact newer full snapshot instead of overstating the plan", async () => {
  const store = storage();
  const compareAndSet = async (...args) => {
    const saved = await store.compareAndSet(...args);
    store.setLedger([...store.ledger.value, { id: "later-draft", total: 18 }], 12);
    return saved;
  };
  const receipt = await persist(payload(), store, { compareAndSet });
  assert.equal(receipt.afterVersion, 12); assert.equal(receipt.superseded, true);
  assert.equal(receipt.invoices.at(-1).id, "later-draft");
});

test("an unconfirmed save or changed same-version readback never reports success", async () => {
  for (const mode of ["version", "readback", "not-applied"]) {
    const store = storage();
    const compareAndSet = async (...args) => {
      if (mode === "not-applied") return { applied: false, outcome: "invalid" };
      const saved = await store.compareAndSet(...args);
      if (mode === "version") return { ...saved, currentVersion: 99 };
      store.setLedger([linked()], 11);
      return saved;
    };
    await assert.rejects(persist(payload(), store, { compareAndSet }), { code: "QB_REFRESH_SAVE_UNCONFIRMED" });
  }
});

test("contention is bounded and the failed plan never overwrites later data", async () => {
  const store = storage();
  let attempts = 0;
  await assert.rejects(persist(payload(), store, { maxAttempts: 2, compareAndSet: async () => {
    attempts++; return { applied: false, outcome: "conflict" };
  } }), { code: "QB_REFRESH_CONTENTION", status: 409 });
  assert.equal(attempts, 2); assert.equal(store.ledger.version, 10);
});

test("malformed snapshots and missing actor fail without a write", async () => {
  for (const body of [null, payload([remote(), remote()]), payload([remote("1", { total: NaN })]), payload([remote("1", { lineItems: null })])]) {
    const store = storage();
    await assert.rejects(persist(body, store), { code: "QB_REFRESH_PAYLOAD_INVALID" });
    assert.equal(store.writes.length, 0);
  }
  const store = storage();
  await assert.rejects(persist(payload(), store, { actorId: "" }), { code: "QB_REFRESH_UNAUTHORIZED", status: 401 });
  assert.equal(store.reads.length, 0);
  assert.throws(() => mergeQuickBooksInvoiceRefresh([], clients, payload(), { startedAt: "2026-10-23T00:00:00Z" }), { code: "QB_REFRESH_TIME_INVALID" });
});

test("malformed shared rows and an import identity collision fail closed", async () => {
  const store = storage([linked(), linked()]);
  await assert.rejects(persist(payload(), store), { code: "QB_REFRESH_STATE_INVALID" });
  assert.equal(store.writes.length, 0);
  assert.throws(() => mergeQuickBooksInvoiceRefresh([{ id: "qb_1", source: "review" }], clients, payload()), { code: "QB_REFRESH_IDENTITY_CONFLICT" });
});

test("a 1092-invoice refresh uses one CAS and three state reads", async () => {
  const store = storage([]);
  const receipt = await persist(payload(Array.from({ length: 1092 }, (_, i) => remote(String(i)))), store);
  assert.equal(receipt.invoices.length, 1092); assert.equal(receipt.counts.imported, 1092);
  assert.equal(store.writes.length, 1); assert.equal(store.reads.length, 3);
});
