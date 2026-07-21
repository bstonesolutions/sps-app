import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: handler } = await import("../api/staff-location.js");
const { isFreshLiveLocation } = await import("../api/live-track.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
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

const request = (body) => ({ method: "POST", headers: { authorization: "Bearer staff-session" }, body });

function installAuthFetch(onLocation) {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "auth-tech", email: "tech@example.test" });
    if (target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "tech-1", email: "tech@example.test", role: "field", active: true }]) }]);
    }
    if (target.includes("/rest/v1/staff_locations?")) return onLocation(target, options);
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

test("authenticated deactivation proves the exact staff row is inactive", async () => {
  let updateBody = null;
  installAuthFetch(async (_target, options) => {
    assert.equal(options.method, "PATCH");
    updateBody = JSON.parse(options.body);
    return response([{ staff_id: "tech-1", is_active: false }]);
  });
  const res = makeRes();
  await handler(request({ action: "deactivate", staffId: "tech-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, inactive: true, updated: 1 });
  assert.equal(updateBody.is_active, false);
});

test("a staff member cannot deactivate another technician", async () => {
  let locationCalls = 0;
  installAuthFetch(async () => { locationCalls += 1; return response([]); });
  const res = makeRes();
  await handler(request({ action: "deactivate", staffId: "other-tech" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(locationCalls, 0);
});

test("a zero-row update is not success while the privileged read still sees an active row", async () => {
  let calls = 0;
  installAuthFetch(async (_target, options) => {
    calls += 1;
    return options.method === "PATCH"
      ? response([])
      : response([{ staff_id: "tech-1", is_active: true }]);
  });
  const res = makeRes();
  await handler(request({ action: "deactivate", staffId: "tech-1" }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(calls, 2);
  assert.match(res.body.error, /still active/i);
});

test("an absent row is a verified inactive state", async () => {
  installAuthFetch(async (_target, options) => response(options.method === "PATCH" ? [] : []));
  const res = makeRes();
  await handler(request({ action: "deactivate", staffId: "tech-1" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, inactive: true, absent: true });
});

test("the public live-location lease rejects stale and future client timestamps", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const base = { lat: 40, lng: -75, is_active: true };
  assert.equal(isFreshLiveLocation({ ...base, updated_at: "2026-07-21T11:59:30.000Z" }, now), true);
  assert.equal(isFreshLiveLocation({ ...base, updated_at: "2026-07-21T11:58:29.000Z" }, now), false);
  assert.equal(isFreshLiveLocation({ ...base, updated_at: "2026-07-21T12:00:01.000Z" }, now), false);
});
