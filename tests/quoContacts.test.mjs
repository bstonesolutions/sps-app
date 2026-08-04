import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.QUO_API_KEY = "test-quo-api-key";

const {
  QUO_CONTACT_SYNC_LIMITS,
  lookupCachedQuoContactForPhone,
  lookupAndCacheQuoContactForPhone,
  quoContactIdsFromMessage,
  syncQuoContacts,
} = await import("../api/_quo-contacts.js");
const { default: quoContactSyncHandler } = await import("../api/quo-contact-sync.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get() { return null; } },
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

function request(method, body = {}, token = "owner-token") {
  return {
    method,
    query: {},
    headers: { authorization: `Bearer ${token}` },
    body,
  };
}

test("message contactIds are deduplicated, validated, and hard-bounded", () => {
  assert.deepEqual(quoContactIdsFromMessage({
    contactIds: ["CT-one", "CT-one", "bad/id", "CT-two", "CT-three", "CT-four"],
    contactId: "CT-legacy",
  }), ["CT-one", "CT-two", "CT-three"]);
  assert.equal(QUO_CONTACT_SYNC_LIMITS.maxMessageLookups, 3);
});

test("an exact E.164 cache lookup returns the private Quo identity without calling Quo", async () => {
  let requested = "";
  const result = await lookupCachedQuoContactForPhone({
    phone: "(555) 234-5678",
    supabaseUrl: "https://supabase.test",
    serviceKey: "secret-service-key",
    fetchImpl: async (url) => {
      requested = String(url);
      return response([{
        phone: "+15552345678",
        quo_contact_id: "CT-cached",
        contact_name: "Jordan Hale",
        avatar_path: "contacts/private-avatar.jpg",
      }]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.metadata.name, "Jordan Hale");
  assert.equal(result.metadata.id, "CT-cached");
  assert.equal(result.avatarPath, "contacts/private-avatar.jpg");
  assert.match(requested, /sps_sms_contacts/);
  assert.match(requested, /phone=in\./);
  assert.doesNotMatch(JSON.stringify(result), /secret-service-key/);
});

test("exact contact lookup caches only the contact whose E.164 phone matches the message peer", async () => {
  const calls = { provider: [], cacheReads: 0, cacheWrites: [] };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://api.quo.com/v1/contacts/CT-exact") {
      calls.provider.push({ target, authorization: options.headers.Authorization });
      return response({
        data: {
          id: "CT-exact",
          defaultFields: {
            firstName: "Jordan",
            lastName: "Hale",
            phoneNumbers: [{ value: "+15552345678" }],
          },
        },
      });
    }
    if (target.includes("/rest/v1/sps_sms_contacts?select=")) {
      calls.cacheReads += 1;
      return response([]);
    }
    if (target.includes("/rest/v1/sps_sms_contacts?on_conflict=phone")) {
      calls.cacheWrites.push(...JSON.parse(options.body));
      return response({});
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const result = await lookupAndCacheQuoContactForPhone({
    contactIds: ["CT-exact"],
    phone: "+15552345678",
    apiKey: "secret-provider-key",
    supabaseUrl: "https://supabase.test",
    serviceKey: "secret-service-key",
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.metadata.name, "Jordan Hale");
  assert.equal(calls.provider[0].authorization, "secret-provider-key");
  assert.equal(calls.cacheReads, 1);
  assert.deepEqual(calls.cacheWrites.map(({ updated_at, ...row }) => row), [{
    phone: "+15552345678",
    quo_contact_id: "CT-exact",
    contact_name: "Jordan Hale",
    avatar_path: "",
  }]);
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-key|secret-service-key/);
});

test("contact backfill paginates within hard limits and writes only changed identities", async () => {
  const writes = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://api.quo.com/v1/contacts?maxResults=3") {
      return response({
        data: [
          {
            id: "CT-unchanged",
            defaultFields: {
              firstName: "Same",
              lastName: "Name",
              phoneNumbers: [{ value: "+15550000001" }],
            },
          },
          {
            id: "CT-changed",
            defaultFields: {
              firstName: "New",
              lastName: "Name",
              phoneNumbers: [{ value: "+15550000002" }],
            },
          },
        ],
        nextPageToken: "page-two",
      });
    }
    if (target === "https://api.quo.com/v1/contacts?maxResults=1&pageToken=page-two") {
      return response({
        data: [{
          id: "CT-third",
          defaultFields: {
            company: "Third Company",
            phoneNumbers: [{ value: "+15550000003" }],
          },
        }],
        nextPageToken: null,
      });
    }
    if (target.includes("/rest/v1/sps_sms_contacts?select=")) {
      return response([
        {
          phone: "+15550000001",
          quo_contact_id: "CT-unchanged",
          contact_name: "Same Name",
          avatar_path: "",
        },
        {
          phone: "+15550000002",
          quo_contact_id: "CT-changed",
          contact_name: "Old Name",
          avatar_path: "",
        },
      ]);
    }
    if (target.includes("/rest/v1/sps_sms_contacts?on_conflict=phone")) {
      writes.push(...JSON.parse(options.body));
      return response({});
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const result = await syncQuoContacts({
    apiKey: "provider-key",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    fetchImpl,
    maxContacts: 3,
    maxPages: 2,
    maxAvatars: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.equal(result.scanned, 3);
  assert.equal(result.cached, 3);
  assert.equal(result.changed, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(writes.map(({ updated_at, ...row }) => row), [
    {
      phone: "+15550000002",
      quo_contact_id: "CT-changed",
      contact_name: "New Name",
      avatar_path: "",
    },
    {
      phone: "+15550000003",
      quo_contact_id: "CT-third",
      contact_name: "Third Company",
      avatar_path: "",
    },
  ]);
});

test("owner-only sync endpoint returns counts without exposing contact data or credentials", async () => {
  const calls = { provider: 0, cacheWrites: 0 };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "owner-auth-id", email: "owner@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target === "https://api.quo.com/v1/contacts?maxResults=1") {
      calls.provider += 1;
      return response({
        data: [{
          id: "CT-private",
          defaultFields: {
            firstName: "Private",
            lastName: "Contact",
            phoneNumbers: [{ value: "+15550000009" }],
          },
        }],
        nextPageToken: null,
      });
    }
    if (target.includes("/rest/v1/sps_sms_contacts?select=")) return response([]);
    if (target.includes("/rest/v1/sps_sms_contacts?on_conflict=phone")) {
      calls.cacheWrites += 1;
      return response({});
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const res = makeRes();
  await quoContactSyncHandler(request("POST", { maxContacts: 1, maxPages: 1, includeAvatars: false }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.changed, 1);
  assert.equal(calls.provider, 1);
  assert.equal(calls.cacheWrites, 1);
  assert.deepEqual(Object.keys(res.body).sort(), [
    "ambiguousPhones",
    "avatarsStored",
    "cached",
    "changed",
    "complete",
    "named",
    "nextPageToken",
    "ok",
    "pages",
    "scanned",
    "skipped",
  ]);
  assert.doesNotMatch(JSON.stringify(res.body), /Private Contact|5550000009|CT-private|test-quo-api-key|test-service-key/);
});

test("contact sync endpoint denies nonowners before any Quo or cache access", async () => {
  let privilegedCalls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response({ id: "staff-auth-id", email: "staff@example.test" });
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "staff-1", email: "staff@example.test", role: "field" }]) }]);
    }
    privilegedCalls += 1;
    throw new Error(`Privileged fetch must not run: ${target}`);
  };
  const res = makeRes();
  await quoContactSyncHandler(request("POST", { maxContacts: 200, maxPages: 4 }, "staff-token"), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /owner access/i);
  assert.equal(privilegedCalls, 0);
});
