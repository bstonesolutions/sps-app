import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.CLIENT_CREATE_TIMEOUT_MS = "250";
const { default: handler, config } = await import("../api/client-create.js");
const { memberHasCapability } = await import("../api/_staff-auth.js");
const { canonicalizeNewClientProfile, stableClientCreateJSON } = await import("../clientCreateProfile.js");
const originalFetch = globalThis.fetch;
const originalError = console.error;
afterEach(() => { globalThis.fetch = originalFetch; console.error = originalError; });

const ID = "client-12345678-1234-4234-8234-123456789abc";
const OWNER = { email: "staff@example.com", role: "owner" };
const OPERATOR = { email: "staff@example.com", role: "custom", tabAccess: { clients: "edit", invoices: "view" } };
const clone = value => structuredClone(value);
const response = (body, ok = true, status = 200) => ({ ok, status, async json() { return body; } });
const profile = extra => ({ id: ID, name: "  New Client  ", phone: "555-0100", address: "1 Service Road", history: [], equipment: [], balance: "$0.00", ...extra });
const req = (client = profile()) => ({ method: "POST", headers: { authorization: "Bearer staff-token" }, body: { client } });
const mockResponse = () => ({
  statusCode: 200, body: null, headers: {},
  setHeader(key, value) { this.headers[key] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
});
const stallUntilAbort = options => new Promise((_, reject) => {
  options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
});
async function invoke(request = req()) {
  const keepAlive = setInterval(() => {}, 1000);
  try { const res = mockResponse(); await handler(request, res); return res; }
  finally { clearInterval(keepAlive); }
}

function fixture({ team = [OWNER], onRpc, authResponse, teamResponse } = {}) {
  const state = { clients: [{ id: "old", name: "Existing client", history: [{ photos: [{ src: "data:image/jpeg;base64," + "a".repeat(5_000_000) }] }] }], version: 4 };
  const registry = new Map();
  const calls = [];
  const apply = body => {
    assert.equal(body.p_request_id, body.p_client.id);
    const previous = registry.get(body.p_request_id);
    const client = state.clients.find(row => row.id === body.p_request_id);
    if (previous) {
      if (previous !== stableClientCreateJSON(body.p_client)) return response({ code: "22023", message: "client_create_request_mismatch" }, false, 400);
      if (!client) return response({ code: "22023", message: "client_create_saved_client_missing" }, false, 400);
      const { history, equipment, balance, ...projection } = client;
      return response({ applied: false, replayed: true, outcome: "replayed", client_projection: true,
        client: clone(projection), before_version: state.version, current_version: state.version, request_id: body.p_request_id });
    }
    if (client) return response({ code: "22023", message: "client_create_identity_exists" }, false, 400);
    const before = state.version;
    state.clients.push(clone(body.p_client));
    registry.set(body.p_request_id, stableClientCreateJSON(body.p_client));
    state.version += 1;
    return response({ applied: true, replayed: false, outcome: "created", client_projection: false,
      client: clone(body.p_client), before_version: before, current_version: state.version, request_id: body.p_request_id });
  };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) return authResponse || response({ id: "auth-one", email: "staff@example.com" });
    if (href.includes("key=eq.sps_team")) return teamResponse || response([{ value: JSON.stringify(team) }]);
    assert.match(href, /\/rest\/v1\/rpc\/sps_client_create$/, "creation must not fetch the roster or contact a client");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ["p_allow_billing", "p_client", "p_request_id"]);
    assert.ok(Buffer.byteLength(options.body, "utf8") < 40_000);
    calls.push(body);
    const intercepted = await onRpc?.({ body, options, calls, state, registry, apply });
    return intercepted ?? apply(body);
  };
  return { state, calls, registry };
}

test("client creation permission matches owner, tab access and legacy client-editor roles", () => {
  const cases = [
    [{ role: "owner", tabAccess: { clients: "hidden" } }, true],
    [{ role: "custom", tabAccess: { clients: "edit" } }, true],
    [{ role: "full", tabAccess: { clients: "view" } }, false],
    [{ role: "full", tabAccess: { clients: "hidden" }, perms: { canEditClients: true } }, false],
    [{ role: "lead" }, true], [{ role: "full" }, true],
    [{ role: "custom", perms: { canEditClients: true } }, true],
    [{ role: "field", perms: { canEditClients: true } }, false],
    [{ role: "custom", perms: { canEditClients: false } }, false],
    [{ role: "viewer" }, false],
  ];
  for (const [member, expected] of cases) assert.equal(memberHasCapability(member, "editClients"), expected, JSON.stringify(member));
  assert.equal(config.maxDuration, 60);
});

test("missing login, client accounts, inactive staff and read-only staff cannot call creation RPC", async () => {
  const missing = fixture();
  const noAuth = req(); noAuth.headers = {};
  assert.equal((await invoke(noAuth)).statusCode, 401);
  assert.equal(missing.calls.length, 0);
  for (const team of [[], [{ ...OWNER, active: false }], [{ ...OWNER, email: "somebody@example.com" }], [{ ...OPERATOR, tabAccess: { clients: "view" } }]]) {
    const f = fixture({ team });
    assert.equal((await invoke()).statusCode, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("unavailable auth or team state fails closed before any client mutation", async () => {
  console.error = () => {};
  for (const options of [{ authResponse: response({}, false, 503) }, { teamResponse: response({}, false, 503) }]) {
    const f = fixture(options);
    assert.equal((await invoke()).statusCode, 503);
    assert.equal(f.calls.length, 0);
  }
});

test("new contact creation sends and returns only a compact profile while other client history stays untouched", async () => {
  const f = fixture({ team: [OPERATOR] });
  const older = clone(f.state.clients[0]);
  const res = await invoke(req(profile({
    division: "Leaf", serviceLeaf: true, leafType: "Fall service", leafSize: "1 acre",
    plans: { Leaf: "Essential" }, preferredDay: "Monday", preferredDayOverride: true,
    monthlyRate: "", planRates: { Leaf: "0" }, autoInvoice: "Off",
  })));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.client.name, "New Client");
  assert.equal(res.body.client.id, ID);
  assert.equal(res.body.client.status, "Active");
  assert.equal(res.body.client.balance, "$0.00");
  assert.deepEqual(res.body.client.history, []);
  assert.equal(res.body.beforeVersion, 4);
  assert.equal(res.body.afterVersion, 5);
  assert.equal(res.body.requestId, ID);
  assert.equal(res.body.replayed, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(f.calls[0].p_allow_billing, false);
  assert.ok(Buffer.byteLength(JSON.stringify(res.body), "utf8") < 1500);
  assert.deepEqual(f.state.clients[0], older);
  assert.equal(f.state.clients.length, 2);
});

test("owners and accounting staff can set rates and automatic invoices with creation", async () => {
  for (const member of [OWNER, { ...OPERATOR, tabAccess: { clients: "edit", invoices: "edit" }, fine: { invoiceCreate: true } }]) {
    const f = fixture({ team: [member] });
    const res = await invoke(req(profile({ monthlyRate: "225.50", planRates: { Pond: "225.50" }, autoInvoice: "Monthly" })));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(f.calls[0].p_allow_billing, true);
    assert.equal(res.body.client.autoInvoice, "Monthly");
  }
});

test("client edit access alone cannot assign money or turn on automatic billing", async () => {
  for (const finance of [{ monthlyRate: "175" }, { planRates: { Pond: 150 } }, { autoInvoice: "Weekly" }]) {
    const f = fixture({ team: [OPERATOR] });
    const res = await invoke(req(profile(finance)));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "client-create-billing-forbidden");
    assert.equal(f.calls.length, 0);
  }
});

test("protected reports, balances, prepaid coverage, QB identities and arbitrary profile fields are rejected", async () => {
  for (const extra of [
    { history: [{ completionReceiptId: "forged" }] }, { equipment: [{ name: "Imported equipment" }] },
    { balance: "$99" }, { maintenanceBilling: { mode: "prepaid" } }, { qbCustomerId: "1" },
    { qbId: "1" }, { authUid: "another-account" }, { role: "owner" }, { createdAt: 1 },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    const f = fixture();
    assert.equal((await invoke(req(profile(extra)))).statusCode, 400, JSON.stringify(extra));
    assert.equal(f.calls.length, 0);
  }
  assert.equal({}.polluted, undefined);
});

test("malformed names, IDs, service fields, map values and rates fail before the RPC", async () => {
  for (const extra of [
    { name: " " }, { name: {} }, { name: "x".repeat(201) }, { id: 123 }, { id: "legacy-123" },
    { id: ID.toUpperCase() }, { address: "x".repeat(2001) }, { servicePond: "true" },
    { plans: [] }, { plans: { Pond: {} } }, { plans: { ["x".repeat(51)]: "Essential" } },
    { plans: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`d${i}`, ""])) },
    { planRates: { Pond: -1 } }, { monthlyRate: "1e3" }, { monthlyRate: "1.2.3" },
    { monthlyRate: Infinity }, { monthlyRate: 1_000_000_001 }, { autoInvoice: "On" },
    { plans: JSON.parse('{"__proto__":"Essential"}') },
  ]) {
    const f = fixture();
    assert.equal((await invoke(req(profile(extra)))).statusCode, 400, JSON.stringify(extra));
    assert.equal(f.calls.length, 0);
  }
});

test("oversized new profiles are rejected, not accidentally uploaded with historical media", async () => {
  const f = fixture();
  const res = await invoke(req(profile({ history: [{ photo: "x".repeat(33_000) }] })));
  assert.equal(res.statusCode, 413);
  assert.equal(f.calls.length, 0);
});

test("replaying the exact creation uses one identity and leaves later profile/report edits intact", async () => {
  const f = fixture();
  const first = await invoke();
  assert.equal(first.statusCode, 200);
  f.state.clients[1].name = "New name from another device";
  f.state.clients[1].history = [{ notes: "New visit", photos: [{ src: "x".repeat(5_000_000) }] }];
  f.state.version += 1;
  const before = clone(f.state.clients[1]);
  const replay = await invoke();
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.clientProjection, true);
  assert.equal(replay.body.client.name, "New name from another device");
  assert.equal(Object.hasOwn(replay.body.client, "history"), false);
  assert.equal(replay.body.beforeVersion, 6);
  assert.equal(replay.body.afterVersion, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(replay.body), "utf8") < 1000);
  assert.deepEqual(f.state.clients[1], before);
  assert.equal(f.state.clients.length, 2);
});

test("same identity with changed input cannot overwrite an earlier committed request", async () => {
  console.error = () => {};
  const f = fixture();
  await invoke();
  const changed = await invoke(req(profile({ phone: "555-0199" })));
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.body.code, "client-create-request-mismatch");
  assert.equal(f.state.clients[1].phone, "555-0100");
  assert.equal(f.state.clients.length, 2);
});

test("unregistered existing identity returns conflict rather than replacing its profile", async () => {
  console.error = () => {};
  const f = fixture();
  f.state.clients.push({ id: ID, name: "Unrelated existing client" });
  const res = await invoke();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "client-create-identity-exists");
  assert.equal(f.state.clients[1].name, "Unrelated existing client");
});

test("a lost committed response is confirmed by one bounded identical replay", async () => {
  const f = fixture({ onRpc({ body, options, calls, apply }) {
    if (calls.length === 1) { apply(body); return stallUntilAbort(options); }
  } });
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.replayed, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.state.clients.length, 2);
});

test("persistent timeouts stop after two attempts and preserve an uncertain-save response", async () => {
  const logs = [];
  console.error = (...args) => logs.push(args);
  const f = fixture({ onRpc({ options }) { return stallUntilAbort(options); } });
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.commitState, "unconfirmed");
  assert.equal(res.body.retryable, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.state.clients.length, 1);
  assert.equal(JSON.parse(logs[0][1]).attempts, 2);
  assert.equal(JSON.stringify(logs).includes("555-0100"), false);
  assert.equal(JSON.stringify(logs).includes("test-service-key"), false);
});

test("missing SQL service is reported without claiming a completed or queued client", async () => {
  console.error = () => {};
  const f = fixture({ onRpc() { return response({ code: "PGRST202", message: "schema cache" }, false, 404); } });
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "client-create-unavailable");
  assert.equal(res.body.commitState, "not-started");
  assert.equal(f.calls.length, 1);
});

test("SQL validation, permission and profile recovery errors have distinct actionable responses", async () => {
  console.error = () => {};
  const cases = [
    ["client_create_protected_field", 400, "client-create-profile-invalid"],
    ["client_create_name_invalid", 400, "client-create-profile-invalid"],
    ["client_create_billing_forbidden", 403, "client-create-billing-forbidden"],
    ["client_create_profile_too_large", 413, "client-create-profile-too-large"],
    ["client_create_saved_client_missing", 409, "client-create-saved-client-missing"],
    ["client_create_service_only", 503, "client-create-unavailable"],
    ["client_create_roster_missing", 503, "client-create-save-unconfirmed"],
    ["client_create_roster_invalid", 503, "client-create-save-unconfirmed"],
    ["client_create_version_invalid", 503, "client-create-save-unconfirmed"],
    ["client_create_confirmation_invalid", 503, "client-create-save-unconfirmed"],
  ];
  for (const [sqlError, expectedStatus, expectedCode] of cases) {
    const f = fixture({ onRpc() { return response({ code: "22023", message: sqlError }, false, 400); } });
    const res = await invoke();
    assert.equal(res.statusCode, expectedStatus, sqlError);
    assert.equal(res.body.code, expectedCode, sqlError);
    assert.equal(f.calls.length, 1, sqlError);
    assert.equal(f.state.clients.length, 1);
  }
});

test("an earlier saved client missing from the roster reports recovery rather than creating a duplicate", async () => {
  console.error = () => {};
  const f = fixture();
  await invoke();
  f.state.clients.pop();
  const res = await invoke();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "client-create-saved-client-missing");
  assert.equal(f.state.clients.length, 1);
  assert.match(res.body.error, /profile needs recovery/);
});

test("a claimed successful RPC cannot certify the wrong identity, missing contact fields or invalid version", async () => {
  console.error = () => {};
  for (const mutate of [
    row => ({ ...row, client: { ...row.client, id: "other" } }),
    row => ({ ...row, client: { ...row.client, phone: "different" } }),
    row => ({ ...row, current_version: row.before_version }),
    row => ({ ...row, request_id: "other" }),
    row => ({ ...row, client: { id: ID, name: "New Client" } }),
  ]) {
    const f = fixture({ onRpc({ body }) {
      return response(mutate({ applied: true, replayed: false, outcome: "created", client: body.p_client, before_version: 4, current_version: 5, request_id: ID }));
    } });
    const res = await invoke();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.commitState, "unconfirmed");
    assert.equal(f.calls.length, 2);
  }
});

test("shared canonicalization normalizes only deliberate defaults and remains stable across key order", () => {
  const p = canonicalizeNewClientProfile({ id: ID, name: " Client ", status: "", balance: 0, plans: { Pool: "", Pond: "Essential" }, monthlyRate: ".5" });
  assert.equal(p.name, "Client");
  assert.equal(p.status, "Active");
  assert.equal(p.balance, "$0.00");
  assert.equal(p.monthlyRate, ".5");
  assert.deepEqual(p.history, []);
  assert.deepEqual(p.equipment, []);
  assert.equal(stableClientCreateJSON(p), stableClientCreateJSON(Object.fromEntries(Object.entries(p).reverse())));
});

test("method and request envelope errors never reach creation", async () => {
  const f = fixture();
  assert.equal((await invoke({ method: "OPTIONS", headers: {} })).statusCode, 204);
  assert.equal((await invoke({ method: "GET", headers: {} })).statusCode, 405);
  const request = req(); request.body.requestId = "mismatch";
  assert.equal((await invoke(request)).statusCode, 400);
  assert.equal(f.calls.length, 0);
});
