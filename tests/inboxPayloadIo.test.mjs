import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: inboxHandler } = await import("../api/inbox.js");

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

function installOwnerHarness(inboxResponse) {
  const databaseRequests = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "owner-auth-id", email: "owner@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target.includes("/rest/v1/sps_inbox?")) {
      databaseRequests.push(target);
      return response(inboxResponse);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return databaseRequests;
}

const COMPACT_FIELDS = [
  "id",
  "from_name",
  "from_email",
  "subject",
  "body_text",
  "message_id",
  "kind",
  "ai",
  "lead_id",
  "read",
  "replied",
  "channel",
  "from_phone",
  "source_type",
  "gmail_uid",
  "original_message_id",
  "created_at",
  "sms_direction",
  "sms_line",
  "sms_peer_phone",
  "quo_message_id",
  "quo_conversation_id",
  "quo_phone_number_id",
  "sms_status",
  "sms_media",
  "quo_contact_id",
  "sms_contact_name",
  "sms_contact_avatar_path",
  "sms_provider_created_at",
].join(",");

test("compact inbox lists exclude body_html while retaining list and SMS thread fields", async () => {
  const listRow = { id: "mail-1", subject: "Hello", body_text: "Preview", channel: "email" };
  const requests = installOwnerHarness([listRow]);
  const res = makeRes();

  await inboxHandler({
    method: "GET",
    query: { compact: "1", limit: "25", kind: "lead", unimported: "1" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, rows: [listRow] });
  assert.equal(requests.length, 1);
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get("select"), COMPACT_FIELDS);
  assert.equal(query.get("select").split(",").includes("body_html"), false);
  assert.equal(query.get("limit"), "25");
  assert.equal(query.get("order"), "created_at.desc");
  assert.equal(query.get("kind"), "eq.lead");
  assert.equal(query.get("lead_id"), "eq.");
});

test("legacy inbox lists keep their select-all response unless compact mode is requested", async () => {
  const legacyRow = { id: "mail-1", body_html: "<strong>Full email</strong>" };
  const requests = installOwnerHarness([legacyRow]);
  const res = makeRes();

  await inboxHandler({
    method: "GET",
    query: { limit: "10" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, rows: [legacyRow] });
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get("select"), "*");
});

test("single-message detail reads one full row including body_html", async () => {
  const detailRow = {
    id: "mail/id+1",
    subject: "Full message",
    body_text: "Plain text",
    body_html: "<p>Rich email</p>",
  };
  const requests = installOwnerHarness([detailRow]);
  const res = makeRes();

  await inboxHandler({
    method: "GET",
    query: { detail: detailRow.id },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, row: detailRow });
  const query = new URL(requests[0]).searchParams;
  assert.equal(query.get("select"), "*");
  assert.equal(query.get("id"), `eq.${detailRow.id}`);
  assert.equal(query.get("limit"), "1");
});

test("single-message detail returns a stable null row when the message no longer exists", async () => {
  installOwnerHarness([]);
  const res = makeRes();

  await inboxHandler({
    method: "GET",
    query: { detail: "missing-mail" },
    headers: { authorization: "Bearer owner-token" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, row: null });
});

test("the app uses compact recurring lists and hydrates only the opened email", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function EmailInboxSection(");
  const end = app.indexOf("function CommsActivity(", start);
  const inbox = app.slice(start, end > start ? end : undefined);

  assert.ok(start >= 0, "EmailInboxSection must exist");
  assert.match(inbox, /const listQuery = smsOnly \? "limit=200" : "limit=200&compact=1"/);
  assert.match(inbox, /\/api\/inbox\?detail=\$\{encodeURIComponent\(id\)\}/);
  assert.match(inbox, /const emailDetailCacheRef = useRef\(new Map\(\)\)/);
  assert.match(inbox, /while \(cache\.size > 6\)/);
});
