import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash, webcrypto } from "node:crypto";
import { invoiceReviewHash, stableInvoiceReviewJSON, stableInvoiceReviewResultJSON } from "../invoiceReviewIdentity.js";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.API_AUTH_ENFORCED = "true";
process.env.QB_API_BASE = "https://quickbooks.test";
const { resolveInvoiceReviewOnServer, validateInvoiceReviewResolutionRequest } = await import("../api/_invoice-review-resolution.js");
const { default: syncHandler } = await import("../api/quickbooks/sync.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const copy = value => structuredClone(value);
const local = extra => ({ id: "local-1", qbId: "101", number: "2001", clientId: "client-1", clientName: "Generic Client", qbCustomerId: "10",
  total: 90, balance: 90, status: "Draft", locallyEdited: true, qbSyncStatus: "conflict", qbNeedsReview: true,
  sourceStopId: "stop-1", notes: "Keep this internal note", lineItems: [{ id: "local-line", qbLineId: "1", desc: "Service", qty: "1", unitPrice: "90", unitCost: "30", costKnown: true }], ...extra });
const remote = extra => ({ Id: "101", SyncToken: "4", DocNumber: "2001", TotalAmt: 110, Balance: 25,
  CustomerRef: { value: "10", name: "Generic Client" }, TxnDate: "2026-10-20", DueDate: "2026-11-04", EmailStatus: "EmailSent",
  Line: [{ Id: "1", DetailType: "SalesItemLineDetail", Amount: 110, Description: "Service", SalesItemLineDetail: { Qty: 1, UnitPrice: 110, ItemRef: { value: "8", name: "Services" }, TaxCodeRef: { value: "NON" } } }], ...extra });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => copy(body), text: async () => JSON.stringify(body) });
const hash = invoice => createHash("sha256").update(stableInvoiceReviewJSON(invoice)).digest("hex");
const request = (extra, reviewedInvoice = local()) => ({ mode: "resolve-invoice-review", invoiceId: "local-1", action: "retry-linked", reviewedInvoiceHash: hash(reviewedInvoice), ...extra });
function fixture({ invoice = local(), others = [], clients = [], raw = remote(), fetchImpl, patch } = {}) {
  let state = { exists: true, value: [copy(invoice), ...copy(others)], version: 5 };
  const calls = [], patches = [];
  const dependencies = { actorId: "owner-1", base: "https://quickbooks.test/v3/company/realm-1", headers: { Authorization: "Bearer test" },
    now: () => "2026-10-22T20:00:00.000Z", readInvoiceState: async key => { if (key === "sps_clients") return { exists: true, value: copy(clients), version: 2 }; assert.equal(key, "sps_invoices"); return copy(state); },
    fetchImpl: async (url, options) => { calls.push({ url, options }); assert.equal(options.method, undefined, "QuickBooks is read-only"); return fetchImpl ? fetchImpl(url, options) : response({ Invoice: raw }); },
    patchInvoice: async value => {
      patches.push(copy(value));
      if (patch) return patch(value, state, patches.length);
      const before = state.version;
      const current = state.value.find(row => row.id === value.invoiceId);
      const unchanged = isDeepStrictEqual(current, value.invoice);
      if (!unchanged) { state.value = state.value.map(row => row === current ? copy(value.invoice) : row); state.version += 1; }
      return { applied: !unchanged, outcome: unchanged ? "unchanged" : "applied", invoice: copy(value.invoice), before_invoice: copy(current), before_version: before, current_version: state.version };
    } };
  return { dependencies, calls, patches, get state() { return state; } };
}

test("server choice ignores browser accounting data and replaces only the verified invoice", async () => {
  const unrelated = { id: "other", total: 900, notes: "Other device work" };
  const f = fixture({ others: [unrelated] });
  const receipt = await resolveInvoiceReviewOnServer(request({ invoice: { total: 1 }, quickBooksInvoice: { total: 2 } }), f.dependencies);
  assert.equal(receipt.ok, true); assert.equal(receipt.invoice.total, 110); assert.equal(receipt.invoice.balance, 25);
  assert.equal(receipt.invoice.status, "Sent"); assert.equal(receipt.invoice.qbNeedsReview, undefined);
  assert.equal(receipt.invoice.locallyEdited, false); assert.equal(receipt.invoice.sourceStopId, "stop-1");
  assert.equal(receipt.invoice.notes, "Keep this internal note"); assert.equal(receipt.invoice.lineItems[0].unitCost, "30");
  assert.deepEqual(receipt.beforeInvoice, local()); assert.equal(receipt.beforeVersion, 5); assert.equal(receipt.afterVersion, 6);
  assert.deepEqual(f.state.value[1], unrelated); assert.equal(f.calls.length, 1);
});

test("repeating a confirmed choice has no additional write or new invoice identity", async () => {
  const f = fixture();
  const first = await resolveInvoiceReviewOnServer(request(), f.dependencies);
  const again = await resolveInvoiceReviewOnServer(request(), f.dependencies);
  assert.deepEqual(again.invoice, first.invoice); assert.equal(again.replayed, true);
  assert.equal(again.beforeVersion, 6); assert.equal(again.afterVersion, 6); assert.equal(f.state.value.length, 1);
});

test("browser and server hash the exact canonical invoice consistently", async () => {
  const invoice = { z: null, a: { c: "Café", b: false }, lineItems: [{ z: 1, a: 2 }, "unknown", 4] };
  const reordered = { lineItems: [{ a: 2, z: 1 }, "unknown", 4], a: { b: false, c: "Café" }, z: null };
  assert.equal(await invoiceReviewHash(invoice, webcrypto), hash(reordered));
  assert.notEqual(hash(invoice), hash({ ...invoice, lineItems: [...invoice.lineItems].reverse() }));
  const result = { ...invoice, qbReviewResolution: { reviewedInvoiceHash: hash(invoice), confirmedResultHash: "ignored" } };
  assert.equal(stableInvoiceReviewResultJSON(result), stableInvoiceReviewResultJSON({ ...result, qbReviewResolution: { ...result.qbReviewResolution, confirmedResultHash: "different" } }));
  assert.notEqual(stableInvoiceReviewResultJSON(result), stableInvoiceReviewResultJSON({ ...result, z: false }));
  for (const reviewedInvoiceHash of [undefined, "", "0", "A".repeat(64)]) {
    assert.throws(() => validateInvoiceReviewResolutionRequest(request({ reviewedInvoiceHash })), { code: "INVOICE_REVIEW_INVALID" });
  }
});

test("an invoice edited after opening review is rejected before any QB read", async () => {
  const f = fixture(); f.state.value[0].notes = "A newer employee edit";
  await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "INVOICE_REVIEW_TARGET_CHANGED" });
  assert.equal(f.calls.length, 0); assert.equal(f.patches.length, 0); assert.equal(f.state.value[0].notes, "A newer employee edit");
});

test("a timeout after commit can replay only the exact original confirmed result", async () => {
  for (const laterEmployeeEdit of [false, true]) {
    const f = fixture(); const originalPatch = f.dependencies.patchInvoice;
    f.dependencies.patchInvoice = async value => {
      await originalPatch(value);
      throw Object.assign(Error("Response lost after commit"), { code: "INVOICE_REVIEW_SAVE_UNCONFIRMED" });
    };
    const originalRequest = request();
    await assert.rejects(resolveInvoiceReviewOnServer(originalRequest, f.dependencies), { code: "INVOICE_REVIEW_SAVE_UNCONFIRMED" });
    const confirmedInvoice = copy(f.state.value[0]);
    assert.equal(confirmedInvoice.qbReviewResolution.reviewedInvoiceHash, originalRequest.reviewedInvoiceHash);
    assert.equal(confirmedInvoice.qbReviewResolution.confirmedResultHash, createHash("sha256").update(stableInvoiceReviewResultJSON(confirmedInvoice)).digest("hex"));
    f.dependencies.patchInvoice = originalPatch;
    if (laterEmployeeEdit) {
      f.state.value[0].lineItems[0].unitPrice = 125; f.state.value[0].total = 125; f.state.version += 1;
      await assert.rejects(resolveInvoiceReviewOnServer(originalRequest, f.dependencies), { code: "INVOICE_REVIEW_TARGET_CHANGED" });
      assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 1); assert.equal(f.state.value[0].total, 125);
    } else {
      const replay = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
      assert.equal(replay.replayed, true); assert.equal(replay.beforeVersion, 6); assert.equal(replay.afterVersion, 6);
      assert.deepEqual(replay.beforeInvoice, confirmedInvoice); assert.deepEqual(replay.invoice, confirmedInvoice);
    }
  }
});

test("timeout replay refuses changed QuickBooks facts until a fresh explicit review", async () => {
  let currentRemote = remote();
  const f = fixture({ fetchImpl: () => response({ Invoice: currentRemote }) });
  const originalRequest = request(); await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  currentRemote = remote({ SyncToken: "5", Balance: 0 });
  await assert.rejects(resolveInvoiceReviewOnServer(originalRequest, f.dependencies), { code: "INVOICE_REVIEW_REMOTE_CHANGED" });
  assert.equal(f.patches.length, 1); assert.equal(f.state.value[0].balance, 25);
  const result = await resolveInvoiceReviewOnServer(request({}, f.state.value[0]), f.dependencies);
  assert.equal(result.invoice.balance, 0); assert.equal(result.afterVersion, 7);
});

test("an original source hash cannot be replayed for a different owner choice", async () => {
  const f = fixture(); await resolveInvoiceReviewOnServer(request(), f.dependencies);
  for (const extra of [{ action: "match-remote" }, { quickBooksInvoiceId: "101" }]) {
    await assert.rejects(resolveInvoiceReviewOnServer(request(extra), f.dependencies), { code: "INVOICE_REVIEW_TARGET_CHANGED" });
  }
  assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 1);
});

test("same-invoice contention preserves the new edit and requires another owner review", async () => {
  const f = fixture({ patch: (value, state, attempt) => {
    if (attempt === 1) { state.value[0].notes = "New internal note"; state.version += 1; return { applied: false, outcome: "target_changed" }; }
    return { applied: true, outcome: "applied", invoice: value.invoice, before_invoice: value.beforeInvoice, before_version: state.version, current_version: state.version + 1 };
  } });
  await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "INVOICE_REVIEW_TARGET_CHANGED" });
  assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 1);
  assert.equal(f.state.value[0].notes, "New internal note"); assert.equal(f.state.value[0].total, 90);
});

test("target contention is never silently retried over newer work", async () => {
  const f = fixture({ patch: () => ({ applied: false, outcome: "target_changed" }) });
  await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "INVOICE_REVIEW_TARGET_CHANGED" });
  assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 1); assert.equal(f.state.version, 5);
});

test("missing and duplicate SPS identities fail before QuickBooks requests", async () => {
  for (const mutation of [state => { state.value = []; }, state => { state.value.push(copy(state.value[0])); }]) {
    const f = fixture(); mutation(f.state);
    await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "INVOICE_REVIEW_IDENTITY_INVALID" });
    assert.equal(f.calls.length, 0); assert.equal(f.patches.length, 0);
  }
});

test("replacement lookup requires a unique customer number and total match", async () => {
  const invoice = local({ qbSyncStatus: "missing-remote", locallyEdited: false });
  const replacement = remote({ Id: "202", TotalAmt: 90, Balance: 0 });
  const f = fixture({ invoice, fetchImpl: url => url.includes("/invoice/") ? response({ Fault: { Error: [{ code: "610" }] } }, 400)
    : response({ QueryResponse: { Invoice: [replacement] } }) });
  const receipt = await resolveInvoiceReviewOnServer(request({ action: "match-remote", quickBooksInvoiceId: "202" }, invoice), f.dependencies);
  assert.equal(receipt.invoice.qbId, "202"); assert.equal(receipt.invoice.qbFormerId, "101");
  assert.equal(receipt.invoice.id, "local-1"); assert.equal(receipt.invoice.status, "Paid");
  assert.match(new URL(f.calls[1].url).searchParams.get("query"), /DocNumber = '2001'/);
});

test("a confirmed replacement link can replay the original request without creating a second resolution", async () => {
  const invoice = local({ qbSyncStatus: "missing-remote", locallyEdited: false });
  const replacement = remote({ Id: "202", TotalAmt: 90, Balance: 0 });
  const f = fixture({ invoice, fetchImpl: url => url.includes("/invoice/101?") ? response({}, 404)
    : url.includes("/invoice/202?") ? response({ Invoice: replacement })
      : response({ QueryResponse: { Invoice: [replacement] } }) });
  const originalRequest = request({ action: "match-remote", quickBooksInvoiceId: "202" }, invoice);
  const first = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  const replay = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  assert.deepEqual(replay.invoice, first.invoice); assert.equal(replay.replayed, true); assert.equal(replay.afterVersion, 6);
  assert.equal(replay.invoice.qbReviewResolution.action, "match-remote");
});

test("replacement matching reads saved client identity and derives unlinked line totals without changing the CAS source", async () => {
  const invoice = local({ qbId: null, total: undefined, clientName: undefined, qbCustomerId: undefined,
    qbSyncStatus: "missing-remote", locallyEdited: false,
    lineItems: [{ desc: "Service", qty: 2, unitPrice: 100, discountType: "pct", discount: 10, taxable: true }],
    discountType: "amt", discount: 10, taxRate: 6 });
  const matchingRemote = remote({ Id: "202", TotalAmt: 180.2, Balance: 180.2 });
  const f = fixture({ invoice, clients: [{ id: "client-1", name: "Generic Client", qbId: "10" }],
    fetchImpl: () => response({ QueryResponse: { Invoice: [matchingRemote] } }) });
  const result = await resolveInvoiceReviewOnServer(request({ action: "match-remote", quickBooksInvoiceId: "202" }, invoice), f.dependencies);
  assert.deepEqual(result.beforeInvoice, invoice); assert.deepEqual(f.patches[0].beforeInvoice, invoice);
  assert.equal(result.invoice.qbId, "202"); assert.equal(result.invoice.total, 180.2); assert.equal(result.invoice.clientId, "client-1");
  assert.equal(result.invoice.qbReviewResolution.reviewedInvoiceHash, hash(invoice));
});

test("an incomplete authoritative QB amount is never reconstructed to select a replacement", async () => {
  const invoice = local({ total: undefined, locallyEdited: false, qbSyncStatus: "missing-remote" });
  const f = fixture({ invoice, fetchImpl: () => response({}, 404) });
  await assert.rejects(resolveInvoiceReviewOnServer(request({ action: "match-remote" }, invoice), f.dependencies), { code: "QB_REVIEW_TOTAL_UNKNOWN" });
  assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 0);
});

test("edited replacement matching uses current line charges instead of stale cached QB total", async () => {
  const invoice = local({ total: 90, qbSyncStatus: "missing-remote", qbAuthoritative: true, source: "quickbooks", qbPushed: true, qbSyncToken: "3",
    lineItems: [{ id: "local-line", qbLineId: "1", desc: "Service", qty: 2, unitPrice: 100, discountType: "pct", discount: 10, taxable: true }],
    discountType: "amt", discount: 10, taxRate: 6 });
  const replacement = remote({ Id: "202", TotalAmt: 180.2, Balance: 180.2 });
  const f = fixture({ invoice, fetchImpl: url => url.includes("/invoice/") ? response({}, 404)
    : response({ QueryResponse: { Invoice: [replacement, remote({ Id: "wrong-old-total", TotalAmt: 90, Balance: 90 })] } }) });
  const result = await resolveInvoiceReviewOnServer(request({ action: "match-remote", quickBooksInvoiceId: "202" }, invoice), f.dependencies);
  assert.equal(result.invoice.qbId, "202"); assert.equal(result.invoice.total, 180.2);
  assert.deepEqual(result.beforeInvoice, invoice); assert.equal(result.invoice.qbReviewResolution.reviewedInvoiceHash, hash(invoice));
});

test("ambiguous unsafe and incomplete replacement results are never persisted", async () => {
  for (const candidates of [
    [remote({ Id: "202", TotalAmt: 91 })],
    [remote({ Id: "202", TotalAmt: 90 }), remote({ Id: "203", TotalAmt: 90 })],
    [remote({ Id: "202", TotalAmt: 90, CustomerRef: { value: "other" } })],
  ]) {
    const f = fixture({ fetchImpl: url => url.includes("/invoice/") ? response({}, 404) : response({ QueryResponse: { Invoice: candidates } }) });
    await assert.rejects(resolveInvoiceReviewOnServer(request({ action: "match-remote" }), f.dependencies), { code: "QB_REVIEW_MATCH_UNSAFE" });
    assert.equal(f.patches.length, 0);
  }
  const f = fixture({ fetchImpl: url => url.includes("/invoice/") ? response({}, 404) : response({ QueryResponse: { Invoice: Array.from({ length: 1000 }, (_, i) => remote({ Id: `${i}` })) } }) });
  await assert.rejects(resolveInvoiceReviewOnServer(request({ action: "match-remote" }), f.dependencies), { code: "QB_REVIEW_SEARCH_INCOMPLETE" });
  assert.equal(f.patches.length, 0);
});

test("SPS-only requires explicit acknowledgement and confirmed absence with no safe replacement", async () => {
  assert.throws(() => validateInvoiceReviewResolutionRequest(request({ action: "keep-sps-only" })), { code: "QB_REVIEW_ACK_REQUIRED" });
  const f = fixture({ invoice: local({ qbSyncStatus: "missing-remote", locallyEdited: false }),
    fetchImpl: url => url.includes("/invoice/") ? response({}, 404) : response({ QueryResponse: {} }) });
  const originalRequest = request({ action: "keep-sps-only", acknowledged: true }, f.state.value[0]);
  const result = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  assert.equal(result.invoice.qbId, null); assert.equal(result.invoice.qbFormerId, "101");
  assert.equal(result.invoice.qbSyncStatus, "sps-only"); assert.equal(result.invoice.total, 90);
  assert.equal(f.calls.length, 2);
  const again = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  assert.equal(again.replayed, true); assert.equal(again.afterVersion, 6);
});

test("SPS-only replay preserves edited amount matching after clearing its local edit flag", async () => {
  const invoice = local({ total: 90, qbSyncStatus: "missing-remote", qbAuthoritative: true,
    lineItems: [{ desc: "Changed service", qty: 1, unitPrice: 100 }] });
  const f = fixture({ invoice, fetchImpl: url => url.includes("/invoice/") ? response({}, 404)
    : response({ QueryResponse: { Invoice: [remote({ Id: "unmatched-old-amount", TotalAmt: 90, Balance: 90 })] } }) });
  const originalRequest = request({ action: "keep-sps-only", acknowledged: true }, invoice);
  const first = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  const again = await resolveInvoiceReviewOnServer(originalRequest, f.dependencies);
  assert.equal(again.replayed, true); assert.deepEqual(again.invoice, first.invoice); assert.equal(again.afterVersion, 6);
});

test("SPS-only cannot detach a live QB invoice or conceal an exact replacement", async () => {
  const existing = fixture();
  await assert.rejects(resolveInvoiceReviewOnServer(request({ action: "keep-sps-only", acknowledged: true }), existing.dependencies), { code: "QB_REVIEW_STILL_LINKED" });
  assert.equal(existing.patches.length, 0);
  const replacement = fixture({ invoice: local({ qbSyncStatus: "missing-remote" }),
    fetchImpl: url => url.includes("/invoice/") ? response({}, 404) : response({ QueryResponse: { Invoice: [remote({ Id: "202", TotalAmt: 90 })] } }) });
  await assert.rejects(resolveInvoiceReviewOnServer(request({ action: "keep-sps-only", acknowledged: true }, replacement.state.value[0]), replacement.dependencies), { code: "QB_REVIEW_MATCH_EXISTS" });
  assert.equal(replacement.patches.length, 0);
});

test("invalid or unreadable QB responses never become a missing or paid invoice", async () => {
  for (const fetchImpl of [
    async () => ({ ok: true, status: 200, json: async () => { throw Error("bad JSON"); } }),
    async () => response({ Invoice: remote({ Balance: undefined }) }),
    async () => response({ Invoice: remote({ Id: "wrong-id" }) }),
    async () => response({ Invoice: remote({ Line: undefined }) }),
  ]) {
    const f = fixture({ fetchImpl });
    await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "QB_REVIEW_RESPONSE_INVALID" });
    assert.equal(f.patches.length, 0);
  }
});

test("a linked QB id cannot be claimed by two local invoice records", async () => {
  const f = fixture({ others: [{ id: "duplicate", qbId: "101" }] });
  await assert.rejects(resolveInvoiceReviewOnServer(request(), f.dependencies), { code: "QB_REVIEW_DUPLICATE_LINK" });
  assert.equal(f.patches.length, 0);
});

test("unconfirmed SQL receipts do not return success", async () => {
  for (const patch of [
    () => ({ applied: true, outcome: "applied", before_version: 5, current_version: 6, invoice: { id: "wrong" } }),
    value => ({ applied: true, outcome: "applied", before_version: 5, current_version: 5, invoice: value.invoice, before_invoice: value.beforeInvoice }),
    () => ({ applied: false, outcome: "duplicate_quickbooks_id" }),
  ]) await assert.rejects(resolveInvoiceReviewOnServer(request(), fixture({ patch }).dependencies));
});

const resMock = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() {} });
test("HTTP mutation rejects unauthenticated callers before reading QuickBooks", async () => {
  let calls = 0; globalThis.fetch = async () => { calls += 1; throw Error("unexpected"); };
  const res = resMock(); await syncHandler({ method: "POST", headers: {}, body: request() }, res);
  assert.equal(res.statusCode, 401); assert.equal(calls, 0);
});

test("HTTP mutation enforces invoiceCreate capability and never inherits legacy read authorization", async () => {
  for (const member of [{ role: "field" }, { role: "full", tabAccess: { invoices: "view" } }, { role: "full", tabAccess: { invoices: "edit" }, fine: { invoiceCreate: false } }]) {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).endsWith("/auth/v1/user")) return response({ id: "staff-1", email: "staff@example.test" });
      if (String(url).includes("key=eq.sps_team")) return response([{ value: [{ id: "staff-1", email: "staff@example.test", ...member }] }]);
      throw Error("unexpected protected request");
    };
    const res = resMock(); await syncHandler({ method: "POST", headers: { authorization: "Bearer staff" }, body: request() }, res);
    assert.equal(res.statusCode, 403, JSON.stringify(res.body)); assert.equal(calls.length, 2);
  }
});

test("HTTP resolution uses only current server data and the narrow service RPC", async () => {
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/auth/v1/user")) return response({ id: "owner-1", email: "owner@example.test" });
    if (href.includes("key=eq.sps_team")) return response([{ value: [{ id: "owner-1", email: "owner@example.test", role: "owner" }] }]);
    if (href.includes("/qb_tokens?")) return response([{ access_token: "test", realm_id: "realm-1", expires_at: "2099-01-01T00:00:00Z" }]);
    if (href.includes("key=eq.sps_invoices")) return response([{ key: "sps_invoices", value: JSON.stringify([local()]), version: 7 }]);
    if (href.includes("quickbooks.test")) { assert.equal(options.method, undefined); return response({ Invoice: remote() }); }
    if (href.endsWith("/rpc/sps_invoice_review_patch")) {
      const body = JSON.parse(options.body); writes.push(body);
      return response([{ applied: true, outcome: "applied", before_version: 7, current_version: 8, invoice: body.p_invoice, before_invoice: body.p_expected_invoice }]);
    }
    throw Error(`Unexpected request ${href}`);
  };
  const res = resMock(); await syncHandler({ method: "POST", headers: { authorization: "Bearer owner" }, body: request({ invoice: { total: 1 } }) }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); assert.equal(res.body.ok, true); assert.equal(writes.length, 1);
  assert.equal(writes[0].p_actor_id, "owner-1"); assert.equal(res.body.invoice.total, 110); assert.equal(res.body.beforeVersion, 7);
});
