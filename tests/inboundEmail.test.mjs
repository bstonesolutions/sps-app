import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The endpoint and its helpers capture server configuration when imported, so set isolated test
// credentials first. APNs stays disabled; an unexpected push attempt is still visible in the
// response as an `out.push` value without opening a network connection.
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.INBOUND_WEBHOOK_SECRET = "test-inbound-secret";
process.env.INBOUND_ALLOWED_TO = "inbox";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
delete process.env.APNS_KEY_ID;
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_PRIVATE_KEY;

const { default: inboundEmailHandler } = await import("../api/inbound-email.js");
const { shouldDeferToLiveForward, GMAIL_LIVE_FORWARD_GRACE_MS } = await import("../emailIntakeSafety.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function request(emailId) {
  return {
    method: "POST",
    query: { key: process.env.INBOUND_WEBHOOK_SECRET },
    body: { type: "email.received", data: { email_id: emailId } },
  };
}

function resendEmail(overrides = {}) {
  return {
    from: "Pat Prospect <pat@example.test>",
    to: ["inbox@in.spsway.app"],
    subject: "Pool cleaning estimate",
    text: "Could you provide an estimate to clean our pool?",
    message_id: "<shared-message@example.test>",
    ...overrides,
  };
}

function installFetch({
  claimWon,
  classificationPatchFails = false,
  clientsValue = [],
  clientRowExists = true,
  from = "Pat Prospect <pat@example.test>",
  messageId = "<shared-message@example.test>",
} = {}) {
  const calls = {
    ai: 0,
    budgetReads: 0,
    claims: 0,
    claimHeaders: [],
    claimRows: [],
    classificationPatches: 0,
    classificationPatchTargets: [],
  };

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (target.startsWith("https://api.resend.com/emails/receiving/")) {
      return response(resendEmail({ from, message_id: messageId }));
    }

    if (target.includes("/rest/v1/sps_inbox?on_conflict=id") && method === "POST") {
      calls.claims += 1;
      calls.claimHeaders.push(options.headers || {});
      const rows = JSON.parse(options.body);
      calls.claimRows.push(...rows);
      return response(claimWon ? rows : []);
    }

    if (target.includes("/rest/v1/sps_inbox?") && method === "PATCH") {
      calls.classificationPatches += 1;
      calls.classificationPatchTargets.push(target);
      if (classificationPatchFails) {
        return response({ error: "classification write unavailable" }, { ok: false, status: 503 });
      }
      const id = new URL(target).searchParams.get("id")?.replace(/^eq\./, "") || "";
      return response([{ id, ...JSON.parse(options.body) }]);
    }

    // Both preflight duplicate probes intentionally miss so the atomic INSERT is the deciding
    // operation. That is the race boundary these tests protect.
    if (target.includes("/rest/v1/sps_inbox?") && method === "GET") {
      return response([]);
    }

    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) {
      return response(clientRowExists
        ? [{ key: "sps_clients", value: JSON.stringify(clientsValue), version: 1, updated_at: null }]
        : []);
    }

    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_email")) {
      return response([{ key: "sps_email", value: "{}", version: 1, updated_at: null }]);
    }

    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_inbound_ai_budget")) {
      calls.budgetReads += 1;
      return response([]);
    }

    if (target.endsWith("/rest/v1/rpc/sps_app_state_cas") && method === "POST") {
      return response({ applied: true, outcome: "inserted", current_version: 1 });
    }

    if (target === "https://api.anthropic.com/v1/messages") {
      calls.ai += 1;
      const triage = {
        kind: "lead",
        confidence: 0.99,
        intent: "new_business",
        automated: false,
        evidence: "provide an estimate",
        summary: "A prospect is requesting a pool-cleaning estimate.",
        lead: { name: "Pat Prospect", email: "pat@example.test", service: "Pool cleaning" },
      };
      return response({ content: [{ type: "text", text: JSON.stringify(triage) }] });
    }

    throw new Error(`Unexpected fetch: ${method} ${target}`);
  };

  return calls;
}

test("only the winner of the atomic Inbox claim may spend AI budget or triage", async () => {
  const calls = installFetch({ claimWon: false });
  const res = makeRes();

  await inboundEmailHandler(request("resend-race-loser"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, duplicate: true });
  assert.equal(calls.claims, 1);
  assert.equal(calls.claimRows[0].kind, "other");
  assert.match(String(calls.claimHeaders[0].Prefer), /resolution=ignore-duplicates/);
  assert.match(String(calls.claimHeaders[0].Prefer), /return=representation/);
  assert.equal(calls.budgetReads, 0);
  assert.equal(calls.ai, 0);
  assert.equal(calls.classificationPatches, 0);
  const expectedId = `mail_${crypto.createHash("sha256").update("shared-message@example.test").digest("hex").slice(0, 32)}`;
  assert.equal(calls.claimRows[0].id, expectedId);
});

test("a failed classification PATCH keeps the durable email as Other and suppresses push", async () => {
  const calls = installFetch({ claimWon: true, classificationPatchFails: true });
  const res = makeRes();

  await inboundEmailHandler(request("resend-patch-failure"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stored, true);
  assert.equal(res.body.kind, "other");
  assert.equal(res.body.triaged, false);
  assert.equal(Object.hasOwn(res.body, "push"), false);
  assert.equal(calls.claims, 1);
  assert.equal(calls.budgetReads, 1);
  assert.equal(calls.ai, 1);
  assert.equal(calls.classificationPatches, 1);
  assert.match(calls.classificationPatchTargets[0], /[?&]kind=eq\.other(?:&|$)/);
  assert.match(calls.classificationPatchTargets[0], /[?&]lead_id=eq\.(?:&|$)/);
});

test("missing or malformed client state cannot enable AI lead creation", async (t) => {
  await t.test("missing client row", async () => {
    const calls = installFetch({ claimWon: true, clientRowExists: false, messageId: "<missing-clients@example.test>" });
    const res = makeRes();
    await inboundEmailHandler(request("resend-missing-clients"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.kind, "other");
    assert.equal(calls.budgetReads, 0);
    assert.equal(calls.ai, 0);
  });

  await t.test("malformed client row", async () => {
    const calls = installFetch({ claimWon: true, clientsValue: { corrupt: true }, messageId: "<bad-clients@example.test>" });
    const res = makeRes();
    await inboundEmailHandler(request("resend-bad-clients"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.kind, "other");
    assert.equal(calls.budgetReads, 0);
    assert.equal(calls.ai, 0);
  });
});

test("a shared client email is held for review instead of attached arbitrarily", async () => {
  const shared = "shared@example.test";
  const calls = installFetch({
    claimWon: true,
    from: `Shared Address <${shared}>`,
    messageId: "<shared-client@example.test>",
    clientsValue: [
      { id: "client-1", name: "First", email: shared },
      { id: "client-2", name: "Second", email: shared },
    ],
  });
  const res = makeRes();
  await inboundEmailHandler(request("resend-shared-client"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.kind, "other");
  assert.equal(calls.ai, 0);
  assert.equal(calls.claimRows[0].ai.clientId, undefined);
  assert.match(calls.claimRows[0].ai.summary, /more than one client/i);
});

test("Gmail history import leaves recent mail for the live unread/notification path", () => {
  const now = Date.parse("2026-07-13T16:00:00.000Z");
  assert.equal(shouldDeferToLiveForward(new Date(now - 2 * 60 * 1000), now), true);
  assert.equal(shouldDeferToLiveForward(new Date(now - GMAIL_LIVE_FORWARD_GRACE_MS - 1), now), false);
  assert.equal(shouldDeferToLiveForward("not-a-date", now), false);
});
