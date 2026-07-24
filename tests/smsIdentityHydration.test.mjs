import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: smsInboxHandler } = await import("../api/sms-inbox.js");

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

const owner = { id: "owner-member", email: "owner@example.test", role: "owner" };
const delegate = {
  id: "staff-member",
  email: "owner@example.test",
  role: "field",
  tabAccess: { comms: "edit" },
  fine: { commsTextInbox: true },
};

function idsFromUrl(target) {
  const raw = new URL(target).searchParams.get("id") || "";
  const match = /^in\.\((.*)\)$/.exec(raw);
  return match ? match[1].split(",").map(decodeURIComponent) : [];
}

function installHarness({ member = owner } = {}) {
  const rows = [
    {
      id: "sms-auto",
      channel: "sms",
      ai: { quoLine: "automation" },
      sms_line: "automation",
      from_phone: "+15550100101",
      sms_peer_phone: "+15550100101",
      body_text: "Hello",
      quo_contact_id: null,
      sms_contact_name: null,
      sms_contact_avatar_path: null,
    },
    {
      id: "sms-main",
      channel: "sms",
      ai: { quoLine: "main" },
      sms_line: "main",
      from_phone: "+15550100102",
      sms_peer_phone: "+15550100102",
      body_text: "Private line",
      quo_contact_id: null,
      sms_contact_name: null,
      sms_contact_avatar_path: null,
    },
  ];
  const calls = { contactReads: 0, signs: 0 };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "auth-user-1", email: "owner@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([member]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("sms_contact_avatar_path")) {
      const wanted = new Set(idsFromUrl(target));
      return response(rows.filter((row) => wanted.has(row.id)));
    }
    if (target.includes("/rest/v1/sps_sms_contacts?")) {
      calls.contactReads += 1;
      return response([{
        phone: "+15550100101",
        quo_contact_id: "CT-jordan",
        contact_name: "Jordan Example",
        avatar_path: "contacts/CT-jordan/avatar.jpg",
      }]);
    }
    if (target.includes("/storage/v1/object/sign/sms-media/contacts/CT-jordan/avatar.jpg")) {
      calls.signs += 1;
      return response({ signedURL: "/object/sign/sms-media/private-avatar-token" });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

test("authorized visible text anchors hydrate Quo names and short-lived private avatars in one batch", async () => {
  const calls = installHarness();
  const res = makeRes();
  await smsInboxHandler({
    method: "GET",
    query: { identityFor: ["sms-auto", "sms-main"] },
    body: {},
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.identities["sms-auto"], {
    name: "Jordan Example",
    contactId: "CT-jordan",
    avatarUrl: "https://supabase.test/storage/v1/object/sign/sms-media/private-avatar-token",
  });
  assert.deepEqual(res.body.identities["sms-main"], {
    name: "",
    contactId: "",
    avatarUrl: "",
  });
  assert.equal(calls.contactReads, 1);
  assert.equal(calls.signs, 1);
  assert.doesNotMatch(JSON.stringify(res.body), /contacts\/CT-jordan\/avatar\.jpg/);
});

test("identity hydration fails closed before contact or Storage reads for an unauthorized line", async () => {
  const calls = installHarness({ member: delegate });
  const res = makeRes();
  await smsInboxHandler({
    method: "GET",
    query: { identityFor: ["sms-main"] },
    body: {},
    headers: { authorization: "Bearer staff-token" },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /unavailable with your current permissions/i);
  assert.equal(calls.contactReads, 0);
  assert.equal(calls.signs, 0);
});
