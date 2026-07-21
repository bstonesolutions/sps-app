import test from "node:test";
import assert from "node:assert/strict";
import {
  copyQuoMediaToPrivateStorage,
  legacySmsInboxRow,
  parseTestRedirect,
  quoContactMetadata,
  signPrivateSmsMedia,
  smsHistorySchemaMissing,
} from "../api/_sms-history.js";

const response = (body, {
  ok = true,
  status = 200,
  contentType = "application/json",
  headers = {},
} = {}) => new Response(body, { status, headers: { "content-type": contentType, ...headers } });

test("Test Mode echoes recover the intended peer and strip only the routing prefix", () => {
  assert.deepEqual(parseTestRedirect("[TEST → (555) 010-0103] Hi David"), {
    intendedPeer: "+15550100103",
    content: "Hi David",
    prefix: "[TEST → (555) 010-0103] ",
  });
  assert.equal(parseTestRedirect("Ordinary customer text"), null);
  assert.equal(parseTestRedirect("[TEST → invalid] should not reroute"), null);
});

test("legacy fallback removes every not-yet-installed conversation column", () => {
  const modern = {
    id: "sms-1",
    channel: "sms",
    body_text: "hello",
    ai: { quoLine: "main" },
    sms_direction: "incoming",
    sms_line: "main",
    sms_peer_phone: "+15551234567",
    quo_message_id: "AC-1",
    sms_media: [{ bucket: "sms-media", path: "messages/AC-1/1.jpg" }],
  };
  assert.deepEqual(legacySmsInboxRow(modern), {
    id: "sms-1",
    channel: "sms",
    body_text: "hello",
    ai: { quoLine: "main" },
  });
  assert.equal(smsHistorySchemaMissing('Could not find the "sms_direction" column of "sps_inbox" in the schema cache'), true);
});

test("Quo contact metadata accepts phone fields but never exposes a picture URL", () => {
  const contact = quoContactMetadata({
    id: "CT-1",
    firstName: "Jordan",
    lastName: "Hale",
    pictureUrl: "https://provider.example/jordan.jpg",
    fields: [
      { type: "phone-number", value: "(555) 123-4567" },
      { type: "email", value: "jordan@example.test" },
    ],
  });
  assert.deepEqual(contact.phones, ["+15551234567"]);
  assert.equal(contact.name, "Jordan Hale");
  assert.equal(contact.pictureUrl, "https://provider.example/jordan.jpg");
});

test("provider MMS bytes are copied to a private object and returned without provider URLs", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://provider.example/photo.jpg") {
      return response(Buffer.from("private-image"), { contentType: "image/jpeg" });
    }
    assert.match(String(url), /\/storage\/v1\/object\/sms-media\/messages\/AC-1\//);
    assert.equal(options.headers["x-upsert"], "false");
    assert.equal(Buffer.from(options.body).toString(), "private-image");
    return response(JSON.stringify({ Key: "stored" }), { status: 200 });
  };

  const stored = await copyQuoMediaToPrivateStorage({
    media: [{ url: "https://provider.example/photo.jpg", type: "image/jpeg" }],
    messageId: "AC-1",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    fetchImpl,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].bucket, "sms-media");
  assert.match(stored[0].path, /^messages\/AC-1\/1-[a-f0-9]{16}\.jpg$/);
  assert.doesNotMatch(JSON.stringify(stored), /provider\.example/);
  assert.equal(calls.length, 2);
});

test("MMS copying rejects private targets and revalidates every redirect", async () => {
  let fetchCalls = 0;
  const privateResult = await copyQuoMediaToPrivateStorage({
    media: [{ url: "https://127.0.0.1/metadata", type: "image/jpeg" }],
    messageId: "AC-private",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not fetch private IP"); },
  });
  assert.deepEqual(privateResult, []);
  assert.equal(fetchCalls, 0);

  const redirectResult = await copyQuoMediaToPrivateStorage({
    media: [{ url: "https://provider.example/photo.jpg", type: "image/jpeg" }],
    messageId: "AC-redirect",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    resolveHost: async (host) => host === "provider.example"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }],
    fetchImpl: async () => response("", { status: 302, headers: { location: "https://metadata.internal.example/latest" } }),
  });
  assert.deepEqual(redirectResult, []);
});

test("MMS copying enforces one total payload budget across attachments", async () => {
  let uploads = 0;
  const stored = await copyQuoMediaToPrivateStorage({
    media: [
      { url: "https://provider.example/one.jpg", type: "image/jpeg" },
      { url: "https://provider.example/two.jpg", type: "image/jpeg" },
    ],
    messageId: "AC-budget",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    maxBytes: 10,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url) => {
      if (String(url).includes("provider.example")) {
        return response(Buffer.from("12345678"), { contentType: "image/jpeg", headers: { "content-length": "8" } });
      }
      uploads += 1;
      return response("{}", { status: 200 });
    },
  });
  assert.equal(stored.length, 1);
  assert.equal(uploads, 1);
  assert.equal(stored[0].size, 8);
});

test("MMS body reads remain inside the provider timeout after headers arrive", async () => {
  const started = Date.now();
  const stored = await copyQuoMediaToPrivateStorage({
    media: [{ url: "https://provider.example/stalled.jpg", type: "image/jpeg" }],
    messageId: "AC-stalled-body",
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    timeoutMs: 100,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      body: {
        getReader() {
          return {
            read: () => new Promise((resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
            cancel: async () => {},
          };
        },
      },
    }),
  });
  assert.deepEqual(stored, []);
  assert.ok(Date.now() - started < 700, "stalled body should be aborted by the provider deadline");
});

test("private media signing returns a short-lived URL only for the sms-media bucket", async () => {
  const signed = await signPrivateSmsMedia([
    { bucket: "sms-media", path: "messages/AC-1/1.jpg", mimeType: "image/jpeg" },
    { bucket: "public", path: "anything.jpg" },
  ], {
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
    fetchImpl: async (url) => {
      assert.match(String(url), /\/storage\/v1\/object\/sign\/sms-media\/messages\/AC-1\/1\.jpg$/);
      return response(JSON.stringify({ signedURL: "/object/sign/sms-media/token" }));
    },
  });
  assert.equal(signed.length, 1);
  assert.equal(signed[0].url, "https://supabase.test/storage/v1/object/sign/sms-media/token");
  assert.equal(signed[0].expiresIn, 300);
});
