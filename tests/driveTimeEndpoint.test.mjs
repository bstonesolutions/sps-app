import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-maps-key";

const { default: driveTimeHandler } = await import("../api/drive-time.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return body; },
});

function mockResponse() {
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

function authenticatedFetch(providerBody, providerStatus = 200) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "tech@example.com", role: "field", active: true }]) }]);
    if (href.startsWith("https://maps.googleapis.com/maps/api/directions/json")) return response(providerBody, providerStatus >= 200 && providerStatus < 300, providerStatus);
    throw new Error(`Unexpected fetch: ${href}`);
  };
}

const request = (body) => ({ method: "POST", headers: { authorization: "Bearer staff-token" }, body });

test("staff route returns traffic-aware minutes and literal distance", async () => {
  let providerUrl = "";
  globalThis.fetch = async (url, options) => {
    providerUrl = String(url).startsWith("https://maps.googleapis.com/") ? String(url) : providerUrl;
    return authenticatedFetch({
      status: "OK",
      routes: [{ legs: [{ duration: { value: 900 }, duration_in_traffic: { value: 1260 }, distance: { value: 19312.128 } }] }],
    })(url, options);
  };
  const res = mockResponse();
  await driveTimeHandler(request({ origin: { lat: 40, lng: -75 }, destination: "100 Main St, Example, PA" }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, minutes: 21, distanceMiles: 12, trafficAware: true });
  assert.match(providerUrl, /departure_time=now/);
  assert.match(providerUrl, /traffic_model=best_guess/);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("invalid coordinates are rejected before calling the provider", async () => {
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "tech@example.com", role: "field" }]) }]);
    providerCalls += 1;
    throw new Error("Provider must not be called");
  };
  const res = mockResponse();
  await driveTimeHandler(request({ origin: { lat: 140, lng: -75 }, destination: "100 Main St" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_origin");
  assert.equal(providerCalls, 0);
});

test("provider denial is sanitized and observable without leaking its message", async () => {
  globalThis.fetch = authenticatedFetch({ status: "REQUEST_DENIED", error_message: "sensitive provider detail" });
  const res = mockResponse();
  await driveTimeHandler(request({ origin: { lat: 40, lng: -75 }, destination: "100 Main St" }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, "route_provider_denied");
  assert.doesNotMatch(JSON.stringify(res.body), /sensitive provider detail/);
});

test("an aborted provider response body is reported as a timeout", async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "auth-1", email: "tech@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "tech@example.com", role: "field", active: true }]) }]);
    if (href.startsWith("https://maps.googleapis.com/maps/api/directions/json")) {
      return {
        ok: true,
        status: 200,
        async json() {
          const error = new Error("aborted while reading");
          error.name = "AbortError";
          throw error;
        },
      };
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  const res = mockResponse();
  await driveTimeHandler(request({ origin: { lat: 40, lng: -75 }, destination: "100 Main St" }), res);
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, "route_timeout");
});

test("portal users cannot use the staff route proxy", async () => {
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return response({ id: "portal-1", email: "client@example.com" });
    if (href.includes("key=eq.sps_team")) return response([{ value: JSON.stringify([{ email: "tech@example.com", role: "field" }]) }]);
    providerCalls += 1;
    throw new Error("Provider must not be called");
  };
  const res = mockResponse();
  await driveTimeHandler(request({ origin: { lat: 40, lng: -75 }, destination: "100 Main St" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(providerCalls, 0);
});
