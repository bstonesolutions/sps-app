import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyCompletionFailure } from "../completionOutbox.js";

process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key";
const { default: complete } = await import("../api/stop-completion.js");
const { default: edit } = await import("../api/stop-report.js");
const { verifyUser } = await import("../api/_auth.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
const request = { method: "POST", headers: { authorization: "Bearer fixture-user-token" }, body: {} };
const routes = [["completion", complete], ["report edit", edit]];

async function invoke(handler, req = request) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(req, res);
  return res;
}

test("both stop routes keep identity-service outages retryable without reading or changing business data", async () => {
  const failures = [
    ...[408, 425, 429, 500, 503].map(status => [String(status), async () => response({ error: "temporary identity service failure" }, status)]),
    ["network", async () => { throw new TypeError("fetch failed"); }],
    ["truncated user response", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } })],
    ["invalid user response", async () => response({})],
  ];
  for (const [routeName, handler] of routes) {
    for (const [failureName, fail] of failures) {
      const calls = [];
      globalThis.fetch = async url => {
        calls.push(String(url));
        assert.match(String(url), /\/auth\/v1\/user$/, "no team or stop data may be touched without verified identity");
        return fail();
      };
      const result = await invoke(handler);
      assert.equal(result.statusCode, 503, `${routeName}: ${failureName}`);
      assert.match(result.body.error, /authorization is temporarily unavailable/i);
      assert.equal(calls.length, 1);
      assert.equal(classifyCompletionFailure({ status: result.statusCode }).retryable, true);
      assert.equal(classifyCompletionFailure({ status: result.statusCode }).needsReview, false);
    }
  }
});

test("both stop routes still reject missing expired revoked and invalid tokens with 401", async () => {
  for (const [routeName, handler] of routes) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("missing token must not call the identity service"); };
    assert.equal((await invoke(handler, { ...request, headers: {} })).statusCode, 401, routeName);
    assert.equal(calls, 0);
    for (const [status, code] of [[400, "bad_jwt"], [401, "jwt_expired"], [401, "session_not_found"], [403, "user_banned"]]) {
      globalThis.fetch = async url => {
        assert.match(String(url), /\/auth\/v1\/user$/);
        return response({ code, message: "Rejected token" }, status);
      };
      const result = await invoke(handler);
      assert.equal(result.statusCode, 401, `${routeName}: ${code}`);
      assert.match(result.body.error, /sign in again/i);
    }
  }
});

test("valid identity does not bypass active-staff and capability 403 decisions", async () => {
  for (const [routeName, handler] of routes) {
    for (const team of [[], [{ id: "fixture", email: "fixture@example.invalid", role: "field", tabAccess: { schedule: "view", clients: "view" } }]]) {
      const calls = [];
      globalThis.fetch = async url => {
        const href = String(url); calls.push(href);
        if (href.endsWith("/auth/v1/user")) return response({ id: "fixture", email: "fixture@example.invalid" });
        assert.match(href, /key=eq\.sps_team/);
        return response([{ value: JSON.stringify(team) }]);
      };
      assert.equal((await invoke(handler)).statusCode, 403, routeName);
      assert.equal(calls.length, 2);
    }
  }
});

test("direct verifyUser callers retain null on unavailable auth unless they opt in", async () => {
  for (const fail of [async () => response({}, 503), async () => { throw new TypeError("fetch failed"); }]) {
    globalThis.fetch = fail;
    assert.equal(await verifyUser(request), null);
    await assert.rejects(verifyUser(request, { distinguishUnavailable: true }), error => error.code === "AUTH_USER_UNAVAILABLE");
  }
  globalThis.fetch = async () => response({ id: "fixture", email: "fixture@example.invalid" });
  assert.equal((await verifyUser(request, { distinguishUnavailable: true })).id, "fixture");
});
