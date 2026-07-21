import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.RESEND_API_KEY = "test-resend-key";
process.env.RESEND_FROM = "SPS <noreply@example.test>";

const { default: handler } = await import("../api/send-notification.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
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

function request(body) {
  return { method: "POST", query: {}, headers: { authorization: "Bearer staff-token" }, body };
}

function installFetch(member) {
  const calls = { resend: 0, resendBodies: [] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-user-1", email: "staff@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "staff-1", email: "staff@example.test", ...member }]) }]);
    }
    if (target === "https://api.resend.com/emails") {
      calls.resend += 1;
      calls.resendBodies.push(JSON.parse(options.body));
      return response({ id: "email-1" });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

const baseBody = {
  to: "client@example.test",
  subject: "Test email",
  message: "Hello",
  branding: { companyName: "Stone Property Solutions" },
};

test("an active staff login alone cannot use the generic business-email endpoint", async () => {
  const calls = installFetch({ role: "field", tabAccess: { schedule: "view", clients: "view", comms: "view" } });
  const res = makeRes();
  await handler(request(baseBody), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /team permissions/i);
  assert.equal(calls.resend, 0);
});

test("service-report email stays available to technicians and client-history editors", async (t) => {
  for (const [label, member] of [
    ["technician", { role: "field", tabAccess: { schedule: "edit", clients: "view", comms: "view" } }],
    ["history editor", { role: "field", tabAccess: { schedule: "view", clients: "edit", comms: "view" } }],
  ]) {
    await t.test(label, async () => {
      const calls = installFetch(member);
      const res = makeRes();
      await handler(request({ ...baseBody, report: { kind: "service", date: "2026-07-20", serviceType: "Monthly service" } }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.sent, true);
      assert.equal(calls.resend, 1);
    });
  }
});

test("email broadcasts require the explicit Comms broadcast grant", async () => {
  const deniedCalls = installFetch({ role: "field", tabAccess: { schedule: "view", clients: "view", comms: "view" } });
  const denied = makeRes();
  await handler(request({ ...baseBody, unsubscribe: { email: "office@example.test" } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(deniedCalls.resend, 0);

  const allowedCalls = installFetch({ role: "field", tabAccess: { schedule: "view", clients: "view", comms: "view" }, fine: { commsBroadcast: true } });
  const allowed = makeRes();
  await handler(request({ ...baseBody, unsubscribe: { email: "office@example.test" } }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.sent, true);
  assert.equal(allowedCalls.resend, 1);
});

test("the owner retains generic owner-alert and notification email access", async () => {
  const calls = installFetch({ role: "owner" });
  const res = makeRes();
  await handler(request(baseBody), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sent, true);
  assert.equal(calls.resend, 1);
});
