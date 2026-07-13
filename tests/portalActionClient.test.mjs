import test from "node:test";
import assert from "node:assert/strict";

import {
  createPortalDataFence,
  PortalActionError,
  portalVisitMatchesReference,
  portalVisitReference,
  rejectPortalPreviewAction,
  requestPortalAction,
  retainPortalRatingVisit,
} from "../portalActionClient.js";

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
});

test("portal action resolves only after the server returns an explicit receipt", async () => {
  let request = null;
  const result = await requestPortalAction({
    endpoint: "https://example.test/api/portal-action",
    action: "savePrefs",
    payload: { notifyPrefsPatch: { invoiceReady: false } },
    getHeaders: async (extra) => ({ ...extra, Authorization: "Bearer test" }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({ ok: true, notifyPrefs: { invoiceReady: false } });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(request.options.body), {
    action: "savePrefs",
    payload: { notifyPrefsPatch: { invoiceReady: false } },
  });
});

test("portal action rejects a non-success HTTP response with the server message", async () => {
  await assert.rejects(
    requestPortalAction({
      endpoint: "https://example.test/api/portal-action",
      action: "approveEstimate",
      payload: { id: "est-1" },
      fetchImpl: async () => response({ ok: false, error: "Estimate not found." }, { ok: false, status: 404 }),
    }),
    (error) => error instanceof PortalActionError && error.status === 404 && error.message === "Estimate not found."
  );
});

test("portal action rejects a malformed success response instead of assuming success", async () => {
  await assert.rejects(
    requestPortalAction({
      endpoint: "https://example.test/api/portal-action",
      action: "rateVisit",
      payload: { visitDate: "2026-07-12", rating: 5 },
      fetchImpl: async () => response({}),
    }),
    /Could not save that change/
  );
});

test("portal action turns network failures into a retryable user-facing error", async () => {
  await assert.rejects(
    requestPortalAction({
      endpoint: "https://example.test/api/portal-action",
      action: "officeAlert",
      payload: {},
      fetchImpl: async () => { throw new Error("offline"); },
    }),
    (error) => error instanceof PortalActionError && error.code === "PORTAL_ACTION_UNREACHABLE"
  );
});

test("staff preview actions reject instead of claiming a server-confirmed send", async () => {
  await assert.rejects(
    rejectPortalPreviewAction(),
    (error) => error instanceof PortalActionError &&
      error.code === "PORTAL_PREVIEW_ONLY" &&
      /nothing was sent or saved/i.test(error.message)
  );
});

test("portal-data fence rejects overlapping and pre-mutation stale responses", () => {
  const fence = createPortalDataFence();
  const first = fence.beginRequest();
  const second = fence.beginRequest();
  assert.equal(fence.canApply(first), false);
  assert.equal(fence.canApply(second), true);

  const beforeMutation = fence.beginRequest();
  fence.confirmMutation();
  assert.equal(fence.canApply(beforeMutation), false);
  assert.equal(fence.canApply(fence.beginRequest()), true);
});

test("portal visit references prefer completion identity and match only that visit", () => {
  const visit = { id: "legacy-id", sid: "stop-2", completionReceiptId: "receipt-2", date: "7/12/2026" };
  const reference = portalVisitReference(visit);
  assert.deepEqual(reference, { field: "completionReceiptId", value: "receipt-2" });
  assert.equal(portalVisitMatchesReference(visit, reference), true);
  assert.equal(portalVisitMatchesReference({ ...visit, completionReceiptId: "receipt-1" }, reference), false);
  assert.deepEqual(portalVisitReference({ date: "7/12/2026" }), { field: "visitDate", value: "7/12/2026" });
});

test("rating selection follows the latest visit before interaction and freezes afterward", () => {
  const morning = { sid: "stop-morning", date: "7/12/2026", type: "Morning Visit" };
  const afternoon = { sid: "stop-afternoon", date: "7/12/2026", type: "Afternoon Visit" };

  const beforeInteraction = retainPortalRatingVisit(null, morning, "client-1");
  assert.equal(retainPortalRatingVisit(null, afternoon, "client-1").visit, afternoon);

  const afterInteraction = retainPortalRatingVisit(beforeInteraction, afternoon, "client-1");
  assert.equal(afterInteraction, beforeInteraction);
  assert.equal(afterInteraction.visit, morning);
  assert.deepEqual(afterInteraction.visitRef, { field: "sid", value: "stop-morning" });
  assert.equal(afterInteraction.clientId, "client-1");
});
