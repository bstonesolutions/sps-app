import assert from "node:assert/strict";
import test from "node:test";
import { invoiceReviewHash } from "../invoiceReviewIdentity.js";
import { resolveConfirmedInvoiceReview } from "../invoiceReviewClient.js";

const original = { id: "iv1", qbId: "42", qbNeedsReview: true, status: "Sent", balance: 100, notes: "saved" };
const resolved = { ...original, qbNeedsReview: false, qbSyncStatus: "synced", status: "Paid", balance: 0 };
function setup() {
  const f = { identity: 1, rows: [structuredClone(original)], remote: [structuredClone(original)], requests: [], refreshes: 0, adoptions: [] };
  f.store = {
    captureIdentity: () => f.identity,
    isCurrentIdentity: value => value === f.identity,
    refresh: async () => { f.refreshes++; return { value: JSON.stringify(f.remote) }; },
    acceptInvoiceReviewResolution: async (receipt, identity, options) => {
      f.accepted = { receipt, identity, options };
      return { ok: true, invoice: receipt.invoice, parsedValue: [receipt.invoice] };
    },
  };
  f.args = {
    invoiceId: "iv1", options: { action: "retry-linked", quickBooksInvoice: { qbId: "42", total: 999 } }, store: f.store,
    readInvoices: () => f.rows,
    fetchReview: async body => { f.requests.push(body); return { ok: true, invoice: structuredClone(resolved), beforeInvoice: f.remote[0], beforeVersion: 1, afterVersion: 2 }; },
    adoptInvoices: (rows, options) => { f.adoptions.push({ rows, options }); f.rows = rows; },
    isResolved: invoice => !invoice.qbNeedsReview,
  };
  f.run = () => resolveConfirmedInvoiceReview(f.args);
  return f;
}

test("confirmed review sends identity and hash only and adopts the exact canonical result", async () => {
  const f = setup();
  assert.deepEqual(await f.run(), resolved);
  assert.deepEqual(f.requests[0], { mode: "resolve-invoice-review", invoiceId: "iv1", action: "retry-linked", quickBooksInvoiceId: "42", acknowledged: false, reviewedInvoiceHash: await invoiceReviewHash(original) });
  assert.deepEqual(f.accepted.options, { expectedInvoice: original });
  assert.deepEqual(f.adoptions[0].options, { confirmedInvoice: { before: original, after: resolved } });
});

test("local pending target remains the adoption fence while the confirmed server target supplies the hash", async () => {
  const f = setup(); f.rows = [{ ...original, notes: "pending local note" }];
  await f.run();
  assert.equal(f.requests[0].reviewedInvoiceHash, await invoiceReviewHash(original));
  assert.equal(f.accepted.options.expectedInvoice.notes, "pending local note");
  assert.equal(f.adoptions[0].options.confirmedInvoice.before.notes, "pending local note");
});

test("a lost response retries the original hash even when the server invoice subsequently changes", async () => {
  const f = setup(); const fetch = f.args.fetchReview; let first = true;
  f.args.fetchReview = async body => { if (first) { first = false; f.requests.push(body); throw new Error("Connection lost"); } return fetch(body); };
  await assert.rejects(f.run(), /Connection lost/);
  f.remote = [{ ...resolved, notes: "Newer employee edit" }];
  await f.run();
  assert.equal(f.refreshes, 1);
  assert.equal(f.requests[1].reviewedInvoiceHash, f.requests[0].reviewedInvoiceHash);
});

test("a definitive review rejection stays blocked until an explicit fresh inspection", async () => {
  for (const status of [400, 401, 403, 409]) {
    const f = setup(); f.args.options.inspectionKey = "inspection-1";
    const fetch = f.args.fetchReview;
    f.args.fetchReview = async body => {
      f.requests.push(body);
      throw Object.assign(new Error("The invoice changed on another device."), { status, code: "INVOICE_REVIEW_TARGET_CHANGED" });
    };
    await assert.rejects(f.run(), error => error.status === status && error.reviewRequiresInspection === true && /Check QuickBooks again/.test(error.message));
    f.remote = [{ ...original, notes: "New server revision" }];
    await assert.rejects(f.run(), error => error.status === status && error.code === "INVOICE_REVIEW_TARGET_CHANGED");
    assert.equal(f.requests.length, 1, "repeating the rejected choice must not make another request");
    assert.equal(f.refreshes, 1, "repeating the rejected choice must not authorize a new server revision");
    f.args.options.inspectionKey = "inspection-2";
    f.args.fetchReview = fetch;
    await f.run();
    assert.equal(f.refreshes, 2);
    assert.equal(f.requests[1].reviewedInvoiceHash, await invoiceReviewHash(f.remote[0]));
    assert.notEqual(f.requests[1].reviewedInvoiceHash, f.requests[0].reviewedInvoiceHash);
  }
});

test("an uncertain server failure retains the original hash for ordinary retry", async () => {
  const f = setup(); f.args.options.inspectionKey = "inspection-1";
  const fetch = f.args.fetchReview; let first = true;
  f.args.fetchReview = async body => {
    if (first) { first = false; f.requests.push(body); throw Object.assign(new Error("Confirmation unavailable"), { status: 503 }); }
    return fetch(body);
  };
  await assert.rejects(f.run(), error => error.status === 503);
  f.remote = [{ ...resolved, notes: "Later employee change" }];
  await f.run();
  assert.equal(f.refreshes, 1);
  assert.equal(f.requests[1].reviewedInvoiceHash, f.requests[0].reviewedInvoiceHash);
});

test("a newly displayed owner target prepares a fresh review instead of reusing another target hash", async () => {
  const f = setup(); const fetch = f.args.fetchReview;
  f.args.fetchReview = async () => { throw new Error("Connection lost"); };
  await assert.rejects(f.run());
  f.rows = [{ ...original, notes: "New review" }]; f.remote = structuredClone(f.rows); f.args.fetchReview = fetch;
  await f.run();
  assert.equal(f.refreshes, 2);
  assert.equal(f.requests[0].reviewedInvoiceHash, await invoiceReviewHash({ ...original, notes: "New review" }));
});

test("target edits during preparation prevent the request", async () => {
  const f = setup(); f.store.refresh = async () => { f.rows = [{ ...original, notes: "Typed meanwhile" }]; return { value: JSON.stringify(f.remote) }; };
  await assert.rejects(f.run(), error => error.targetChanged === true);
  assert.equal(f.requests.length, 0); assert.equal(f.adoptions.length, 0);
});

test("target edits after server confirmation remain visible and return a readable confirmed error", async () => {
  const f = setup(); const fetch = f.args.fetchReview;
  f.args.fetchReview = async body => { const receipt = await fetch(body); f.rows = [{ ...original, notes: "New local edit" }]; return receipt; };
  await assert.rejects(f.run(), error => error.serverConfirmed === true && error.targetChanged === true && error.invoice.id === "iv1");
  assert.equal(f.accepted, undefined); assert.equal(f.adoptions.length, 0);
  assert.equal(f.rows[0].notes, "New local edit");
});

test("account changes during the request cannot adopt its confirmation", async () => {
  const f = setup(); const fetch = f.args.fetchReview;
  f.args.fetchReview = async body => { const receipt = await fetch(body); f.identity++; return receipt; };
  await assert.rejects(f.run(), error => error.staleIdentity === true && error.serverConfirmed === true);
  assert.equal(f.accepted, undefined); assert.equal(f.adoptions.length, 0);
});

test("edits during store adoption cannot be replaced by the older confirmed result", async () => {
  const f = setup(); const accept = f.store.acceptInvoiceReviewResolution;
  f.store.acceptInvoiceReviewResolution = async (...args) => { const result = await accept(...args); f.rows = [{ ...original, notes: "Latest" }]; return result; };
  await assert.rejects(f.run(), error => error.serverConfirmed === true && error.targetChanged === true);
  assert.equal(f.adoptions.length, 0);
});

test("a saved choice with failed device cleanup preserves the canonical receipt for recovery", async () => {
  const f = setup(); f.store.acceptInvoiceReviewResolution = async () => ({ ok: false, serverConfirmed: true, error: new Error("Local storage unavailable") });
  await assert.rejects(f.run(), error => error.serverConfirmed === true && error.message === "Local storage unavailable" && error.invoice.id === "iv1");
  assert.equal(f.adoptions.length, 0);
});

test("a superseding invoice still requiring review is never reported resolved", async () => {
  const f = setup(); const newer = { ...original, notes: "Newer conflict" };
  f.store.acceptInvoiceReviewResolution = async () => ({ ok: true, superseded: true, invoice: newer, parsedValue: [newer] });
  await assert.rejects(f.run(), error => error.serverConfirmed === true && error.superseded === true);
  assert.deepEqual(f.rows[0], newer);
});

test("malformed or missing confirmed server target cannot send a resolution", async () => {
  for (const value of [null, "bad", "[]", JSON.stringify([original, original])]) {
    const f = setup(); f.store.refresh = async () => ({ value });
    await assert.rejects(f.run(), /could not be checked/);
    assert.equal(f.requests.length, 0);
  }
});
