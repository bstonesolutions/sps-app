import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

// These endpoints capture their server configuration when their modules load. Keep every test
// credential local to this worker and set it before importing either handler.
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.QUO_API_KEY = "test-quo-api-key";
process.env.QUO_PHONE_NUMBER = "+15550001111";
process.env.QUO_MAIN_PHONE_NUMBER = "+15550002222";
process.env.QUO_WEBHOOK_KEY = "test-webhook-key";
process.env.QUO_WEBHOOK_SECRET = Buffer.from("test-webhook-signing-secret", "utf8").toString("base64");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.APNS_KEY_ID;
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_PRIVATE_KEY;

const { default: sendSmsHandler } = await import("../api/send-sms.js");
const { default: smsIntakeHandler, inboundTextStaffKeys, pushLegNeedsRetry } = await import("../api/sms-intake.js");
const { memberHasCapability, requireOwner } = await import("../api/_staff-auth.js");

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

function outboundRequest(body, token = "staff-token") {
  return {
    method: "POST",
    query: {},
    headers: { authorization: `Bearer ${token}` },
    body,
  };
}

const automationStaff = () => ({
  id: "staff-1",
  email: "tech@example.test",
  role: "field",
  tabAccess: { schedule: "edit", comms: "edit" },
});

const inboxStaff = ({ main = false, automation = true } = {}) => ({
  ...automationStaff(),
  fine: { ...(automation ? { commsTextInbox: true } : {}), ...(main ? { commsMainLine: true } : {}) },
});

const broadcastOnlyStaff = () => ({
  id: "staff-broadcast",
  email: "tech@example.test",
  role: "field",
  tabAccess: { schedule: "view", comms: "view" },
  fine: { commsBroadcast: true },
});

const ownerStaff = () => ({
  id: "owner-1",
  email: "tech@example.test",
  role: "owner",
});

function installOutboundFetch({
  email = "tech@example.test",
  team = [{ id: "staff-1", email: "tech@example.test", role: "field", tabAccess: { schedule: "edit" } }],
  teamFailure = false,
  textSafety = { testMode: { on: false, mode: "redirect", phone: "", liveClientIds: [] } },
  textSafetyFailure = false,
  textSafetyClients = [{ id: "pilot-1", phone: "+15552345678" }],
  textSafetyClientsFailure = false,
  inboxRows = null,
  inboxFailure = false,
  historyFailure = false,
  receiptFailure = false,
  quoStatus = 200,
  quoThrows = false,
  quoDelayMs = 0,
} = {}) {
  let receiptValue;
  let receiptVersion = 0;
  const calls = { quo: 0, quoBodies: [], quoNumberChecks: 0, textSafetyChecks: 0, textSafetyClientChecks: 0, inboxLookups: 0, historyRows: [], receiptReads: 0, receiptWrites: 0 };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return response({ id: "auth-user-1", email });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      return teamFailure
        ? response({ error: "unavailable" }, { ok: false, status: 500 })
        : response([{ value: JSON.stringify(team) }]);
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_email")) {
      calls.textSafetyChecks += 1;
      return textSafetyFailure
        ? response({ error: "unavailable" }, { ok: false, status: 503 })
        : response([{ value: JSON.stringify(textSafety) }]);
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) {
      calls.textSafetyClientChecks += 1;
      return textSafetyClientsFailure
        ? response({ error: "unavailable" }, { ok: false, status: 503 })
        : response([{ value: JSON.stringify(textSafetyClients) }]);
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_sms_delivery_receipts")) {
      calls.receiptReads += 1;
      if (receiptFailure) return response({ error: "receipt store unavailable" }, { ok: false, status: 503 });
      return response(receiptVersion ? [{
        key: "sps_sms_delivery_receipts",
        value: JSON.stringify(receiptValue),
        version: receiptVersion,
        updated_at: "2026-07-20T14:00:00.000Z",
      }] : []);
    }
    if (target.endsWith("/rest/v1/rpc/sps_app_state_cas")) {
      calls.receiptWrites += 1;
      if (receiptFailure) return response({ error: "receipt store unavailable" }, { ok: false, status: 503 });
      const body = JSON.parse(options.body);
      if (Number(body.p_expected_version) !== receiptVersion) {
        return response([{ applied: false, outcome: "conflict", current_version: receiptVersion, changed_at: null }]);
      }
      receiptValue = JSON.parse(body.p_value);
      receiptVersion += 1;
      return response([{ applied: true, outcome: receiptVersion === 1 ? "inserted" : "updated", current_version: receiptVersion, changed_at: "2026-07-20T14:00:00.000Z" }]);
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=id,channel,from_phone,ai")) {
      calls.inboxLookups += 1;
      return inboxFailure
        ? response({ error: "unavailable" }, { ok: false, status: 503 })
        : response(inboxRows ?? []);
    }
    if (target.includes("/rest/v1/sps_inbox?on_conflict=id") && options.method === "POST") {
      const inserted = JSON.parse(options.body);
      calls.historyRows.push(...inserted);
      return historyFailure
        ? response({ message: "history unavailable" }, { ok: false, status: 503 })
        : response(inserted);
    }
    if (target === "https://api.quo.com/v1/messages") {
      calls.quo += 1;
      calls.quoBodies.push(JSON.parse(options.body));
      if (quoDelayMs) await new Promise(resolve => setTimeout(resolve, quoDelayMs));
      if (quoThrows) throw new Error("provider connection lost");
      return quoStatus >= 200 && quoStatus < 300
        ? response({ data: { id: `quo-message-${calls.quo}` } }, { status: quoStatus })
        : response({ code: "provider_error" }, { ok: false, status: quoStatus });
    }
    if (target === "https://api.quo.com/v1/phone-numbers") {
      calls.quoNumberChecks += 1;
      return response({ data: [
        { e164: "+15550001111", name: "SPS Automation" },
        { e164: "+15550002222", name: "SPS Main" },
        { e164: "+15559998888", name: "Unrelated workspace line" },
      ] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

const WEBHOOK_KEY = process.env.QUO_WEBHOOK_KEY;
const WEBHOOK_SECRET = process.env.QUO_WEBHOOK_SECRET;

function webhookSignature(raw, timestamp = Date.now()) {
  const ts = String(timestamp);
  const digest = crypto
    .createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "base64"))
    .update(`${ts}.${raw}`, "utf8")
    .digest("base64");
  return `hmac;1;${ts};${digest}`;
}

function webhookPayload(id, overrides = {}) {
  return {
    id,
    type: "message.received",
    data: {
      object: {
        id: `message-${id}`,
        direction: "incoming",
        from: "+15552345678",
        to: "+15550001111",
        body: "Can you service my pond this week?",
        ...overrides,
      },
    },
  };
}

function rawWebhookRequest(raw, options = {}) {
  const key = Object.prototype.hasOwnProperty.call(options, "key") ? options.key : WEBHOOK_KEY;
  const signature = Object.prototype.hasOwnProperty.call(options, "signature")
    ? options.signature
    : webhookSignature(raw);
  const req = Readable.from([Buffer.from(raw, "utf8")]);
  req.method = "POST";
  req.query = key === undefined ? {} : { key };
  req.headers = signature === undefined ? {} : { "openphone-signature": signature };
  return req;
}

async function invokeWebhook(payload, options = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const req = rawWebhookRequest(raw, options);
  const res = makeRes();
  await smsIntakeHandler(req, res);
  return { res, raw };
}

function installInboxFetch({ duplicate = false, duplicateAi = null, storageFailure = false, clientReadFailure = false, patchFailure = false } = {}) {
  let storedRow = duplicate ? { ai: duplicateAi || { quoLine: "automation" }, kind: "other" } : null;
  const calls = { inserts: 0, patches: 0, patchBodies: [], reads: 0, rows: [] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) {
      return clientReadFailure
        ? response({ error: "client state unavailable" }, { ok: false, status: 503 })
        : response([]);
    }
    if (target.includes("/rest/v1/sps_inbox?on_conflict=id")) {
      calls.inserts += 1;
      const insertedRows = JSON.parse(options.body);
      calls.rows.push(...insertedRows);
      if (!duplicate && !storageFailure) storedRow = insertedRows[0];
      return storageFailure
        ? response({ message: "database unavailable" }, { ok: false, status: 503 })
        : response(duplicate ? [] : insertedRows);
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=ai,kind") && !options.method) {
      calls.reads += 1;
      return response(storedRow ? [{ ai: storedRow.ai, kind: storedRow.kind }] : []);
    }
    if (target.includes("/rest/v1/sps_inbox?") && options.method === "PATCH") {
      calls.patches += 1;
      if (patchFailure) return response({ message: "database unavailable" }, { ok: false, status: 503 });
      const patch = JSON.parse(options.body);
      calls.patchBodies.push(patch);
      storedRow = { ...(storedRow || {}), ...patch };
      return response([{ ai: storedRow.ai, kind: storedRow.kind || "other" }]);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
  return calls;
}

test("outbound texting imports the isolated staff authorization bridge", async () => {
  const source = await readFile(new URL("../api/send-sms.js", import.meta.url), "utf8");
  assert.match(source, /from\s+["']\.\/_staff-auth\.js["']/);
  assert.doesNotMatch(source, /from\s+["']\.\/_auth\.js["']/);
});

test("legacy Messages or Reminders edit access still grants the folded Comms texting permission", () => {
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "view", messages: "edit" } }, "sendTexts"), true);
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "view", reminders: "edit" } }, "sendTexts"), true);
  assert.equal(memberHasCapability({ role: "field", tabAccess: { schedule: "view", messages: "view" } }, "sendTexts"), false);
});

test("the two text-line visibility capabilities are independent, private by default, and honor the Comms master switch", () => {
  assert.equal(memberHasCapability(automationStaff(), "commsTextInbox"), false);
  assert.equal(memberHasCapability(automationStaff(), "commsMainLine"), false);
  assert.equal(memberHasCapability(inboxStaff(), "commsTextInbox"), true);
  assert.equal(memberHasCapability(inboxStaff(), "commsMainLine"), false);
  assert.equal(memberHasCapability(inboxStaff({ main: true }), "commsMainLine"), true);
  assert.equal(memberHasCapability(inboxStaff({ main: true, automation: false }), "commsTextInbox"), false);
  assert.equal(memberHasCapability(inboxStaff({ main: true, automation: false }), "commsMainLine"), true);
  assert.equal(memberHasCapability({ ...inboxStaff({ main: true }), tabAccess: { schedule: "edit", comms: "hidden" } }, "commsTextInbox"), false);
  assert.equal(memberHasCapability({ ...inboxStaff({ main: true }), tabAccess: { schedule: "edit", comms: "hidden" } }, "commsMainLine"), false);
  assert.equal(memberHasCapability(ownerStaff(), "commsTextInbox"), true);
  assert.equal(memberHasCapability(ownerStaff(), "commsMainLine"), true);
});

test("inbound text push audiences honor the exact receiving line and active roster state", () => {
  const team = [
    { ...ownerStaff(), id: "owner-1" },
    { ...inboxStaff(), id: "automation-only" },
    { ...inboxStaff({ main: true, automation: false }), id: "main-only" },
    { ...inboxStaff({ main: true }), id: "both-lines" },
    { ...inboxStaff({ main: true }), id: "disabled", disabled: true },
    { ...inboxStaff({ main: true }), id: "not-active", active: false },
    { ...inboxStaff(), id: "inactive", status: "inactive" },
    { ...inboxStaff(), id: "hidden", tabAccess: { schedule: "edit", comms: "hidden" } },
    { ...inboxStaff(), id: "" },
  ];

  assert.deepEqual(inboundTextStaffKeys(team, "automation"), ["automation-only", "both-lines"]);
  assert.deepEqual(inboundTextStaffKeys(team, "main"), ["main-only", "both-lines"]);
  assert.deepEqual(inboundTextStaffKeys(team, "unknown"), []);
});

test("notification retries distinguish transient APNs failures from permanently pruned tokens", () => {
  assert.equal(pushLegNeedsRetry({ ok: false, sent: 0, failed: 2, pruned: 2 }), false);
  assert.equal(pushLegNeedsRetry({ ok: true, sent: 1, failed: 1, pruned: 0 }), true);
  assert.equal(pushLegNeedsRetry({ ok: false, error: "connect timeout" }), true);
  assert.equal(pushLegNeedsRetry({ ok: false, skipped: "apns not configured" }), false);
  assert.equal(pushLegNeedsRetry({ ok: false, results: [
    { ok: false, sent: 0, failed: 1, pruned: 1 },
    { ok: true, sent: 1, failed: 0, pruned: 0 },
  ] }), false);
});

test("the isolated staff bridge enforces owner-only automation previews", async () => {
  installOutboundFetch();
  const fieldRes = makeRes();
  const field = await requireOwner(outboundRequest({}), fieldRes, "previewing automations");
  assert.equal(field, null);
  assert.equal(fieldRes.statusCode, 403);

  installOutboundFetch({ team: [{ id: "owner-1", email: "tech@example.test", role: "owner" }] });
  const ownerRes = makeRes();
  const owner = await requireOwner(outboundRequest({}), ownerRes, "previewing automations");
  assert.equal(owner?.teamRole, "owner");
  assert.equal(ownerRes.statusCode, 200);
});

test("portal users and read-only staff cannot reach Quo", async (t) => {
  await t.test("portal account", async () => {
    const calls = installOutboundFetch({
      email: "client@example.test",
      team: [{ id: "owner-1", email: "owner@example.test", role: "owner" }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "555-234-5678", message: "Appointment reminder" }, "portal-token"), res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.quo, 0);
  });

  await t.test("read-only staff account", async () => {
    const calls = installOutboundFetch({
      team: [{
        id: "staff-1",
        email: "tech@example.test",
        role: "field",
        tabAccess: { schedule: "view", comms: "view" },
      }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "555-234-5678", message: "Appointment reminder" }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.quo, 0);
  });
});

test("team lookup failures return 503 without contacting Quo", async () => {
  const calls = installOutboundFetch({ teamFailure: true });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({ to: "555-234-5678", message: "Appointment reminder" }), res);

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /authorization is temporarily unavailable/i);
  assert.equal(calls.quo, 0);
});

test("authorized staff send normalized US numbers through the Quo business line", async () => {
  const calls = installOutboundFetch();
  const res = makeRes();
  await sendSmsHandler(outboundRequest({ to: "(555) 234-5678", message: "Appointment reminder", from: "+15559998888" }), res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, {
    accepted: true,
    sent: true,
    held: false,
    redirected: false,
    line: "automation",
    id: "quo-message-1",
    historyStored: true,
    historyId: "sms_out_quo-message-1",
    historyPendingWebhook: false,
  });
  assert.equal(calls.quo, 1);
  assert.deepEqual(calls.quoBodies[0], {
    content: "Appointment reminder",
    from: "+15550001111",
    to: ["+15552345678"],
  });
  assert.equal(calls.historyRows.length, 1);
  assert.equal(calls.historyRows[0].sms_direction, "outgoing");
  assert.equal(calls.historyRows[0].sms_line, "automation");
  assert.equal(calls.historyRows[0].sms_peer_phone, "+15552345678");
});

test("a Quo-accepted text stays successful when conversation-history storage is temporarily unavailable", async () => {
  const calls = installOutboundFetch({ historyFailure: true });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Accepted once" }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.historyStored, false);
  assert.equal(res.body.historyPendingWebhook, true);
  assert.equal(calls.quo, 1, "history failure must not invite a second provider send");
});

test("arrival confirmations claim one durable receipt before Quo and safely replay", async () => {
  const calls = installOutboundFetch({ quoDelayMs: 15 });
  const body = {
    to: "+15552345678",
    message: "Hi Jordan, your technician has arrived.",
    clientId: "client-1",
    messageType: "On site",
    idempotencyKey: "arrival:stop-1:sms",
  };
  const first = makeRes();
  const overlap = makeRes();
  await Promise.all([
    sendSmsHandler(outboundRequest(body), first),
    sendSmsHandler(outboundRequest(body), overlap),
  ]);

  assert.equal(calls.quo, 1, "overlapping arrival sheets must make one provider request");
  const responses = [first.body, overlap.body];
  assert.equal(responses.some((result) => result.accepted === true), true);
  // Depending on scheduling, the second invocation either sees the active claim (uncertain/in
  // progress) or arrives just after finalization and receives the durable accepted replay. Both
  // are safe outcomes; neither may invite or perform another provider send.
  const follower = responses.find((result) => result.uncertain === true)
    || responses.find((result) => result.replayed === true);
  assert.ok(follower, "the overlapping request must be blocked or replay the saved receipt");
  assert.equal(follower.retrySafe, false);

  const replay = makeRes();
  await sendSmsHandler(outboundRequest(body), replay);
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.body.accepted, true);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.id, "quo-message-1");
  assert.equal(calls.quo, 1, "an accepted replay must not call Quo again");

  const changed = makeRes();
  await sendSmsHandler(outboundRequest({ ...body, message: "Changed arrival copy" }), changed);
  assert.equal(changed.statusCode, 409);
  assert.match(changed.body.error, /different text details/i);
  assert.equal(calls.quo, 1);
});

test("ambiguous arrival delivery is terminal and never blindly retried", async () => {
  const calls = installOutboundFetch({ quoThrows: true });
  const body = {
    to: "+15552345678",
    message: "Hi Jordan, your technician has arrived.",
    clientId: "client-1",
    messageType: "On site",
    idempotencyKey: "arrival:stop-2:sms",
  };
  const first = makeRes();
  await sendSmsHandler(outboundRequest(body), first);
  assert.equal(first.statusCode, 502);
  assert.equal(first.body.uncertain, true);
  assert.equal(first.body.retrySafe, false);
  assert.equal(calls.quo, 1);

  const replay = makeRes();
  await sendSmsHandler(outboundRequest(body), replay);
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.body.uncertain, true);
  assert.equal(replay.body.replayed, true);
  assert.equal(calls.quo, 1);
});

test("arrival receipt storage failure stops before Quo", async () => {
  const calls = installOutboundFetch({ receiptFailure: true });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Hi Jordan, your technician has arrived.",
    clientId: "client-1",
    messageType: "On site",
    idempotencyKey: "arrival:stop-3:sms",
  }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /safety is temporarily unavailable/i);
  assert.equal(calls.quo, 0);
});

test("the server upgrades link-bearing field texts from already-installed app builds", async (t) => {
  await t.test("browser-only live tracking", async () => {
    const calls = installOutboundFetch();
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Hi Jordan, I'm on my way. Track my live location here: https://spsway.app/?track=private-token — See you soon!",
    }), res);
    assert.equal(res.statusCode, 202);
    const sent = calls.quoBodies[0].content;
    assert.match(sent, /Hi Jordan, I'm on my way\. See you soon!/);
    assert.match(sent, /Open in app: https:\/\/spsway\.app\/\?open=track/);
    assert.match(sent, /Browser: https:\/\/spsway\.app\/\?track=private-token/);
    assert.equal((sent.match(/private-token/g) || []).length, 1);
  });

  await t.test("browser-only completed report", async () => {
    const calls = installOutboundFetch();
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Your service report is ready; your invoice will follow. View your full report and photos here: https://spsway.app",
    }), res);
    const sent = calls.quoBodies[0].content;
    assert.match(sent, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
    assert.match(sent, /Browser: https:\/\/spsway\.app\/#open=reports/);
    assert.doesNotMatch(sent, /here:\s*$/m);
  });

  await t.test("old invoice custom scheme", async () => {
    const calls = installOutboundFetch();
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Invoice #123 is ready.\nPay in the app: spsway://invoices",
    }), res);
    const sent = calls.quoBodies[0].content;
    assert.doesNotMatch(sent, /spsway:\/\/invoices/);
    assert.match(sent, /Open in app: https:\/\/spsway\.app\/\?open=invoices/);
    assert.match(sent, /Browser: https:\/\/spsway\.app\/#open=invoices/);
  });
});

test("client link normalization fails cleanly and keeps Test Mode URLs intact", async (t) => {
  await t.test("an abnormally long SPS URL is rejected before Quo", async () => {
    const calls = installOutboundFetch();
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: `Track here: https://spsway.app/?track=${"x".repeat(900)}`,
    }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /link.*too long/i);
    assert.equal(calls.quo, 0);
  });

  await t.test("a long canonical message is refit before the Test Mode prefix", async () => {
    const calls = installOutboundFetch({
      textSafety: { testMode: { on: true, mode: "redirect", phone: "+15550009999", liveClientIds: [] } },
    });
    const res = makeRes();
    const footer = "View your full report and photos\nOpen in app: https://spsway.app/?open=reports\nBrowser: https://spsway.app/#open=reports";
    const body = "x".repeat(1600 - footer.length - 2);
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: `${body}\n\n${footer}`,
      messageType: "Service report",
    }), res);
    assert.equal(res.statusCode, 202);
    const sent = calls.quoBodies[0].content;
    assert.ok(sent.length <= 1600);
    assert.match(sent, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
    assert.match(sent, /Browser: https:\/\/spsway\.app\/#open=reports$/);
  });
});

test("an explicit Broadcast grant can use only the automation line for marked broadcasts", async (t) => {
  await t.test("the sender picker can inspect only the automation line", async () => {
    const calls = installOutboundFetch({ team: [broadcastOnlyStaff()] });
    const res = makeRes();
    await sendSmsHandler({ method: "GET", query: { details: "1" }, headers: { authorization: "Bearer staff-token" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.from, "+15550001111");
    assert.equal(res.body.directFrom, undefined);
    assert.deepEqual(res.body.numbers, [{ role: "automation", number: "+15550001111", label: "SPS Automation" }]);
    assert.equal(calls.quoNumberChecks, 1);
  });

  await t.test("marked broadcast succeeds from automation", async () => {
    const calls = installOutboundFetch({ team: [broadcastOnlyStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Seasonal service update",
      purpose: "broadcast",
      line: "automation",
    }), res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.line, "automation");
    assert.equal(calls.quoBodies[0].from, "+15550001111");
  });

  await t.test("the grant does not unlock ordinary direct texts", async () => {
    const calls = installOutboundFetch({ team: [broadcastOnlyStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Direct message" }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.quo, 0);
  });

  await t.test("the grant cannot select the owner's main line", async () => {
    const calls = installOutboundFetch({ team: [broadcastOnlyStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Must not send",
      purpose: "broadcast",
      line: "main",
    }), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /only the owner/i);
    assert.equal(calls.quo, 0);
  });

  await t.test("the grant does not unlock shared-inbox replies", async () => {
    const calls = installOutboundFetch({
      team: [broadcastOnlyStaff()],
      inboxRows: [{ id: "sms-auto", channel: "sms", from_phone: "+15552345678", ai: { quoLine: "automation" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Must not send",
      purpose: "broadcast",
      inboxId: "sms-auto",
    }), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /business text inbox/i);
    assert.equal(calls.inboxLookups, 0);
    assert.equal(calls.quo, 0);
  });
});

test("staff outbound stays on the automation line and the owner's main line is owner-send only", async (t) => {
  await t.test("ordinary staff can still send from automation", async () => {
    const calls = installOutboundFetch({ team: [automationStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "(555) 234-5678",
      message: "Staff update",
      line: "automation",
      from: "+15559998888",
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.line, "automation");
    assert.deepEqual(calls.quoBodies[0], {
      content: "Staff update",
      from: "+15550001111",
      to: ["+15552345678"],
    });
  });

  await t.test("ordinary staff cannot select the owner's main line", async () => {
    const calls = installOutboundFetch({ team: [automationStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "(555) 234-5678",
      message: "Must stay private",
      line: "main",
    }), res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /owner's work line/i);
    assert.equal(calls.quo, 0);
  });

  await t.test("main-line visibility never lets an explicitly granted staff member send from it", async () => {
    const calls = installOutboundFetch({ team: [inboxStaff({ main: true })] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "(555) 234-5678",
      message: "Must remain owner-only",
      line: "main",
      from: "+15559998888",
    }), res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /only the owner/i);
    assert.equal(calls.quo, 0);
  });

  await t.test("the owner can use the main line without fine-grained flags", async () => {
    const calls = installOutboundFetch({ team: [ownerStaff()] });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "(555) 234-5678",
      message: "Owner message",
      line: "main",
    }), res);

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.line, "main");
    assert.equal(calls.quoBodies[0].from, "+15550002222");
  });
});

test("unknown Quo line roles are rejected before contacting Quo", async () => {
  const calls = installOutboundFetch();
  const res = makeRes();
  await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "No", line: "other" }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /unknown business texting line/i);
  assert.equal(calls.quo, 0);
});

test("inbox replies use the verified line and recipient from the original inbound text", async (t) => {
  await t.test("ordinary staff cannot reply through the shared inbox", async () => {
    const calls = installOutboundFetch({
      team: [automationStaff()],
      inboxRows: [{ id: "sms-auto", channel: "sms", from_phone: "+15552345678", ai: { quoLine: "automation" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Must not send", inboxId: "sms-auto" }), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /business text inbox/i);
    assert.equal(calls.inboxLookups, 0);
    assert.equal(calls.quo, 0);
  });

  await t.test("only the owner can reply to a main-line inbound text", async () => {
    const calls = installOutboundFetch({
      team: [inboxStaff({ main: true })],
      inboxRows: [{ id: "sms-main", channel: "sms", from_phone: "+15552345678", ai: { quoLine: "main" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({
      to: "+15552345678",
      message: "Reply",
      inboxId: "sms-main",
      line: "automation",
      from: "+15559998888",
    }), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /only the owner/i);
    assert.equal(calls.inboxLookups, 1);
    assert.equal(calls.quo, 0);
  });

  await t.test("the owner reply uses the protected main sender even when metadata needs normalization", async () => {
    const calls = installOutboundFetch({
      team: [ownerStaff()],
      inboxRows: [{ id: "sms-main-normalized", channel: "sms", from_phone: "+15552345678", ai: { quoLine: " MAIN " } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Reply", inboxId: "sms-main-normalized" }), res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.line, "main");
    assert.equal(calls.quoBodies[0].from, "+15550002222");
  });

  await t.test("text-inbox access alone cannot reply from the owner's main line", async () => {
    const calls = installOutboundFetch({
      team: [inboxStaff()],
      inboxRows: [{ id: "sms-main", channel: "sms", from_phone: "+15552345678", ai: { quoLine: "main" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Must not send", inboxId: "sms-main" }), res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /only the owner/i);
    assert.equal(calls.inboxLookups, 1);
    assert.equal(calls.quo, 0);
  });

  await t.test("legacy inbound without metadata stays on automation", async () => {
    const calls = installOutboundFetch({
      team: [inboxStaff()],
      inboxRows: [{ id: "sms-old", channel: "sms", from_phone: "+15552345678", ai: { summary: "legacy" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Reply", inboxId: "sms-old", line: "main" }), res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.line, "automation");
    assert.equal(calls.quoBodies[0].from, "+15550001111");
  });

  await t.test("malformed or unknown line metadata fails closed", async () => {
    for (const [id, ai] of [
      ["sms-unknown", { quoLine: "unexpected" }],
      ["sms-malformed-string", "not-json"],
      ["sms-malformed-array", []],
    ]) {
      const calls = installOutboundFetch({
        team: [inboxStaff({ main: true })],
        inboxRows: [{ id, channel: "sms", from_phone: "+15552345678", ai }],
      });
      const res = makeRes();
      await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Must not send", inboxId: id }), res);
      assert.equal(res.statusCode, 503, id);
      assert.match(res.body.error, /original text line could not be verified/i);
      assert.equal(calls.quo, 0, id);
    }
  });

  await t.test("caller cannot reuse an inbox id for another recipient", async () => {
    const calls = installOutboundFetch({
      team: [ownerStaff()],
      inboxRows: [{ id: "sms-main", channel: "sms", from_phone: "+15552345678", ai: { quoLine: "main" } }],
    });
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15557654321", message: "Must not send", inboxId: "sms-main" }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /recipient does not match/i);
    assert.equal(calls.quo, 0);
  });

  await t.test("missing or unavailable inbox context fails closed", async () => {
    for (const options of [{ inboxRows: [] }, { inboxFailure: true }]) {
      const calls = installOutboundFetch({ ...options, team: [inboxStaff()] });
      const res = makeRes();
      await sendSmsHandler(outboundRequest({ to: "+15552345678", message: "Must not send", inboxId: "sms-missing" }), res);
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, /original text line could not be verified/i);
      assert.equal(calls.quo, 0);
    }
  });
});

test("outbound validation enforces E.164 and a 1 through 1600 character message", async () => {
  const calls = installOutboundFetch();

  for (const to of ["12345", "+01234567890", "not-a-phone"]) {
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to, message: "x" }), res);
    assert.equal(res.statusCode, 400, `expected ${to} to be rejected`);
  }
  for (const message of ["", "   ", "x".repeat(1601)]) {
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message }), res);
    assert.equal(res.statusCode, 400, `expected length ${message.length} to be rejected`);
  }

  for (const message of ["x", "x".repeat(1600)]) {
    const res = makeRes();
    await sendSmsHandler(outboundRequest({ to: "+15552345678", message }), res);
    assert.equal(res.statusCode, 202, `expected length ${message.length} to be accepted`);
  }
  assert.equal(calls.quo, 2);
});

test("server Test Mode holds non-pilot client texts without contacting Quo", async () => {
  const calls = installOutboundFetch({
    textSafety: {
      testMode: { on: true, mode: "hold", phone: "+15550009999", liveClientIds: ["pilot-1"] },
    },
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "This must not reach the client",
    clientId: "client-2",
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    accepted: false,
    sent: false,
    held: true,
    redirected: false,
    testMode: true,
    line: "automation",
  });
  assert.equal(calls.textSafetyChecks, 1);
  assert.equal(calls.quo, 0);
});

test("server Test Mode still allows an explicit text to the saved owner test phone", async () => {
  const calls = installOutboundFetch({
    textSafety: {
      testMode: { on: true, mode: "hold", phone: "(555) 000-9999", liveClientIds: [] },
    },
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15550009999",
    message: "Owner-only test",
  }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.held, false);
  assert.equal(res.body.redirected, false);
  assert.deepEqual(calls.quoBodies[0].to, ["+15550009999"]);
});

test("legacy installed clients that pre-redirect are stored under the intended customer", async () => {
  const calls = installOutboundFetch({
    textSafety: {
      testMode: { on: true, mode: "hold", phone: "+15550009999", liveClientIds: [] },
    },
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15550009999",
    message: "[TEST → (555) 010-0103] Hi David, your technician is on the way.",
  }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.redirected, false, "the older client already performed the redirect");
  assert.equal(calls.historyRows.length, 1);
  assert.equal(calls.historyRows[0].sms_peer_phone, "+15550100103");
  assert.equal(calls.historyRows[0].body_text, "Hi David, your technician is on the way.");
  assert.equal(calls.historyRows[0].sms_status, "test_redirected");
  assert.equal(calls.historyRows[0].quo_conversation_id, null);
});

test("server Test Mode redirects a non-pilot to the owner phone and caps the labeled message", async () => {
  const calls = installOutboundFetch({
    textSafety: {
      testMode: { on: true, mode: "redirect", phone: "+15550009999", liveClientIds: ["pilot-1"] },
    },
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "x".repeat(1600),
    clientId: "client-2",
    from: "+15558887777",
  }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.held, false);
  assert.equal(res.body.redirected, true);
  assert.equal(calls.quo, 1);
  assert.equal(calls.quoBodies[0].from, "+15550001111");
  assert.deepEqual(calls.quoBodies[0].to, ["+15550009999"]);
  assert.match(calls.quoBodies[0].content, /^\[TEST → \+15552345678\] /);
  assert.equal(calls.quoBodies[0].content.length, 1600);
  assert.equal(calls.historyRows[0].sms_peer_phone, "+15552345678");
  assert.equal(calls.historyRows[0].sms_status, "test_redirected");
});

test("server Test Mode sends a listed pilot client for real only when clientId is supplied", async () => {
  const textSafety = {
    testMode: { on: true, mode: "redirect", phone: "+15550009999", liveClientIds: ["pilot-1"] },
  };
  const calls = installOutboundFetch({ textSafety });
  const pilotRes = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Pilot appointment reminder",
    clientId: "pilot-1",
  }), pilotRes);

  assert.equal(pilotRes.statusCode, 202);
  assert.equal(pilotRes.body.redirected, false);
  assert.deepEqual(calls.quoBodies[0], {
    content: "Pilot appointment reminder",
    from: "+15550001111",
    to: ["+15552345678"],
  });

  const noClientIdRes = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Older caller without client context",
  }), noClientIdRes);
  assert.equal(noClientIdRes.statusCode, 202);
  assert.equal(noClientIdRes.body.redirected, true);
  assert.deepEqual(calls.quoBodies[1].to, ["+15550009999"]);
});

test("a Pilot LIVE id cannot be reused for a different recipient or a text opt-out", async () => {
  const textSafety = {
    testMode: { on: true, mode: "redirect", phone: "+15550009999", liveClientIds: ["pilot-1"] },
  };
  const mismatchedCalls = installOutboundFetch({ textSafety });
  const mismatchedRes = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15557654321",
    message: "Must not reach a different recipient",
    clientId: "pilot-1",
  }), mismatchedRes);

  assert.equal(mismatchedRes.statusCode, 202);
  assert.equal(mismatchedRes.body.redirected, true);
  assert.deepEqual(mismatchedCalls.quoBodies[0].to, ["+15550009999"]);

  const optedOutCalls = installOutboundFetch({
    textSafety,
    textSafetyClients: [{
      id: "pilot-1",
      phone: "+15552345678",
      notifyPrefs: { channels: { text: false } },
    }],
  });
  const optedOutRes = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Must respect the saved text preference",
    clientId: "pilot-1",
  }), optedOutRes);

  assert.equal(optedOutRes.statusCode, 202);
  assert.equal(optedOutRes.body.redirected, true);
  assert.deepEqual(optedOutCalls.quoBodies[0].to, ["+15550009999"]);
});

test("a Pilot LIVE client lookup failure fails closed", async () => {
  const calls = installOutboundFetch({
    textSafety: {
      testMode: { on: true, mode: "redirect", phone: "+15550009999", liveClientIds: ["pilot-1"] },
    },
    textSafetyClientsFailure: true,
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Pilot appointment reminder",
    clientId: "pilot-1",
  }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.held, true);
  assert.match(res.body.error, /no message was sent/i);
  assert.equal(calls.quo, 0);
});

test("text safety lookup failures fail closed without contacting Quo", async () => {
  const calls = installOutboundFetch({ textSafetyFailure: true });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Appointment reminder",
    clientId: "pilot-1",
  }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.accepted, false);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.held, true);
  assert.equal(res.body.redirected, false);
  assert.match(res.body.error, /no message was sent/i);
  assert.equal(calls.quo, 0);
});

test("a missing saved Test Mode state fails closed instead of defaulting live", async () => {
  const calls = installOutboundFetch({ textSafety: { testMode: {} } });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Must not default to live",
  }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.held, true);
  assert.match(res.body.error, /no message was sent/i);
  assert.equal(calls.quo, 0);
});

test("a legacy string false Test Mode value is normalized as off", async () => {
  const calls = installOutboundFetch({
    textSafety: { testMode: { on: "false", mode: "redirect", phone: "+15550009999", liveClientIds: [] } },
  });
  const res = makeRes();
  await sendSmsHandler(outboundRequest({
    to: "+15552345678",
    message: "Normal live send",
  }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.redirected, false);
  assert.deepEqual(calls.quoBodies[0].to, ["+15552345678"]);
});

test("public SMS health is compatibility-safe and ordinary staff details hide the owner's line", async () => {
  let anonymousFetches = 0;
  globalThis.fetch = async () => { anonymousFetches += 1; throw new Error("public health must not call upstream services"); };
  const publicRes = makeRes();
  await sendSmsHandler({ method: "GET", query: { check: "" }, headers: {} }, publicRes);
  assert.equal(publicRes.statusCode, 200);
  assert.deepEqual(publicRes.body, {
    ok: true,
    endpoint: "send-sms",
    configured: { quoKey: true, quoNumber: true },
  });
  assert.equal(anonymousFetches, 0);

  const calls = installOutboundFetch({ team: [automationStaff()] });
  const detailsRes = makeRes();
  await sendSmsHandler({ method: "GET", query: { check: "", details: "1" }, headers: { authorization: "Bearer staff-token" } }, detailsRes);
  assert.equal(detailsRes.statusCode, 200);
  assert.equal(detailsRes.body.from, "+15550001111");
  assert.equal(detailsRes.body.directFrom, undefined);
  assert.deepEqual(detailsRes.body.numbers, [
    { role: "automation", number: "+15550001111", label: "SPS Automation" },
  ]);
  assert.equal(detailsRes.body.configured.quoMainNumber, undefined);
  assert.equal(detailsRes.body.configured.upstreamReachable, true);
  assert.equal(detailsRes.body.configured.numberOnAccount, true);
  assert.equal(detailsRes.body.configured.mainNumberOnAccount, undefined);
  assert.equal(calls.quoNumberChecks, 1);
});

test("main-line details are returned only to the owner or an explicitly granted staff member", async (t) => {
  for (const [label, member] of [
    ["owner", ownerStaff()],
    ["delegated staff", inboxStaff({ main: true })],
  ]) {
    await t.test(label, async () => {
      const calls = installOutboundFetch({ team: [member] });
      const res = makeRes();
      await sendSmsHandler({ method: "GET", query: { details: "1" }, headers: { authorization: "Bearer staff-token" } }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.from, "+15550001111");
      assert.equal(res.body.directFrom, "+15550002222");
      assert.deepEqual(res.body.numbers, [
        { role: "automation", number: "+15550001111", label: "SPS Automation" },
        { role: "main", number: "+15550002222", label: "SPS Main" },
      ]);
      assert.equal(res.body.configured.quoMainNumber, true);
      assert.equal(res.body.configured.mainNumberOnAccount, true);
      assert.equal(calls.quoNumberChecks, 1);
    });
  }
});

test("portal accounts cannot enumerate the configured Quo line", async () => {
  const calls = installOutboundFetch({
    email: "client@example.test",
    team: [{ id: "owner-1", email: "owner@example.test", role: "owner" }],
  });
  const res = makeRes();
  await sendSmsHandler({ method: "GET", query: { details: "1" }, headers: { authorization: "Bearer portal-token" } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.quoNumberChecks, 0);
});

test("automations remain locked to the automation Quo number", async () => {
  for (const path of ["../api/cron-automations.js", "../api/lead-intake.js", "../api/transfer-nudge.js"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /email\.textingNumber|fromOverride/, `${path} must not honor a saved sender override`);
    assert.doesNotMatch(source, /QUO_MAIN_PHONE_NUMBER/, `${path} must not move an automation to the main work line`);
  }
});

test("human-written Comms actions explicitly choose their protected Quo routes", async () => {
  const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /openphone:\/\/dial\?/);
  assert.match(source, /new URLSearchParams\(\{[\s\S]*action:\s*["']call["']/);
  const pickerStart = source.indexOf("function QuoSenderPicker");
  const directStart = source.indexOf("function DirectQuoTextModal");
  const directEnd = source.indexOf("function effectiveClientPlan", directStart);
  assert.ok(pickerStart >= 0 && directStart > pickerStart);
  const pickerSource = source.slice(pickerStart, directStart);
  assert.match(pickerSource, /const canUseMain = !!perms\?\.isAdmin/);
  assert.doesNotMatch(pickerSource, /commsMainLine/, "main-line visibility must never add a staff sender identity");
  const directSource = source.slice(directStart, directEnd > directStart ? directEnd : directStart + 8000);
  assert.match(directSource, /perms\?\.isAdmin\s*\?\s*["']main["']\s*:\s*["']automation["']/);
  assert.match(directSource, /lineRole:\s*senderRole/);
  assert.match(directSource, /<QuoSenderPicker\s+value=\{senderRole\}/);
  assert.doesNotMatch(directSource, /commsMainLine/, "staff direct texts must stay on automation even with owner-inbox visibility");

  const replyStart = source.indexOf("const sendOpenRowReply = async");
  const replyEnd = source.indexOf("const [selMode", replyStart);
  assert.ok(replyStart >= 0 && replyEnd > replyStart);
  assert.match(source.slice(replyStart, replyEnd), /sendSms\(phone,\s*replyText\.trim\(\),\s*\{[\s\S]*?inboxId:\s*(?:row|replyAnchor)\.id/);

  const broadcastStart = source.indexOf("function BroadcastSection");
  const broadcastEnd = source.indexOf("function OwnerDigestSettings", broadcastStart);
  assert.ok(broadcastStart >= 0 && broadcastEnd > broadcastStart);
  const broadcastSource = source.slice(broadcastStart, broadcastEnd);
  assert.equal((broadcastSource.match(/lineRole:\s*senderRole/g) || []).length, 2, "live and test broadcasts must use the selected protected sender role");
  assert.equal((broadcastSource.match(/purpose:\s*["']broadcast["']/g) || []).length, 2, "live and test broadcasts must carry the explicit server authorization purpose");
  assert.match(broadcastSource, /perms\?\.isAdmin\s*\?\s*["']main["']\s*:\s*["']automation["']/);
  assert.match(broadcastSource, /<QuoSenderPicker\s+value=\{senderRole\}/);
  assert.doesNotMatch(broadcastSource, /commsMainLine/, "staff broadcasts must stay on automation even with owner-inbox visibility");
  assert.match(broadcastSource, /replies return to the same unified Comms inbox/i);
});

test("scheduled client texts fail closed when the saved Test Mode settings cannot be read", async () => {
  const source = await readFile(new URL("../api/cron-automations.js", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*requireOwner\s*\}\s*from\s*["']\.\/_staff-auth\.js["']/);
  assert.doesNotMatch(source, /import\s*\{\s*requireOwner\s*\}\s*from\s*["']\.\/_auth\.js["']/);
  assert.match(source, /sbGetRequiredObject\(["']sps_email["']\)/);
  assert.match(source, /!email\.testMode\s*\|\|\s*typeof email\.testMode !== ["']object["']/);
  assert.match(source, /savedTestModeOn !== true && savedTestModeOn !== false/);
  assert.match(source, /Text safety settings are temporarily unavailable\. No automated messages were sent\./);
  assert.match(source, /import\s*\{[^}]*ensureClientLinkChoices[^}]*\}\s*from\s*["']\.\.\/clientMessageLinks\.js["']/);
  assert.match(source, /due\s*=\s*due\.flatMap\([\s\S]*ensureClientLinkChoices\(message\.message,\s*\{\s*messageType:\s*message\.type\s*\}\)/);
  assert.match(source, /normalizationErrors\.push\(\{\s*type:\s*message\.type/);
  assert.match(source, /invalidLinks:\s*normalizationErrors\.length/);
  assert.match(source, /const errors = \[\.\.\.normalizationErrors\]/);
});

test("both On My Way screens honor the saved per-alert opt-out before any channel send", async () => {
  const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  assert.equal((source.match(/const onMyWayEnabled = client\?\.notifyPrefs\?\.onMyWay !== false;/g) || []).length, 2);
  assert.equal((source.match(/const canText = onMyWayEnabled && !!phone && commPref\(client, ["']text["']\);/g) || []).length, 2);
  assert.equal((source.match(/const canApp = onMyWayEnabled && !!\(client && client\.id != null && commPref\(client, ["']app["']\)\);/g) || []).length, 2);
});

test("inbound webhook requires both the URL key and a signed request", async (t) => {
  globalThis.fetch = async (url) => { throw new Error(`storage must not be reached: ${url}`); };
  const payload = webhookPayload("auth-check");
  const raw = JSON.stringify(payload);

  await t.test("missing URL key", async () => {
    const { res } = await invokeWebhook(raw, { key: undefined, signature: webhookSignature(raw) });
    assert.equal(res.statusCode, 401);
  });
  await t.test("missing signature", async () => {
    const { res } = await invokeWebhook(raw, { signature: undefined });
    assert.equal(res.statusCode, 401);
  });
  await t.test("bad signature", async () => {
    const { res } = await invokeWebhook(raw, { signature: `hmac;1;${Date.now()};ZmFrZQ==` });
    assert.equal(res.statusCode, 401);
  });
  await t.test("signature older than five minutes", async () => {
    const old = Date.now() - (6 * 60 * 1000);
    const { res } = await invokeWebhook(raw, { signature: webhookSignature(raw, old) });
    assert.equal(res.statusCode, 401);
  });
});

test("inbound health distinguishes server readiness from a recently observed signed reply", async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /sps_inbox\?select=id,channel,from_phone,created_at,ai/);
    return response([{ id: "sms_recent", channel: "sms", from_phone: "+15552345678", created_at: new Date().toISOString() }]);
  };
  const res = makeRes();
  await smsIntakeHandler({ method: "GET", query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.configured.ready, true);
  assert.equal(res.body.configured.mainConfigured, true);
  assert.equal(res.body.configured.mainLine, true);
  assert.equal(res.body.configured.duplicateLines, false);
  assert.equal(res.body.configured.observed, true);
  assert.deepEqual(res.body.configured.observedLines, { automation: true, main: false });
  assert.equal(res.body.configured.push, false);
  assert.ok(res.body.configured.lastInboundAt);
});

test("inbound health proves the automation and main Quo webhooks independently", async () => {
  const now = new Date().toISOString();
  globalThis.fetch = async (url) => {
    assert.match(String(url), /created_at=gte\./);
    return response([
      { id: "sms_main", channel: "sms", from_phone: "+15552345678", created_at: now, ai: { quoLine: "main" } },
      { id: "sms_automation", channel: "sms", from_phone: "+15552345679", created_at: now, ai: { quoLine: "automation" } },
    ]);
  };
  const res = makeRes();
  await smsIntakeHandler({ method: "GET", query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.configured.observedLines, { automation: true, main: true });
  assert.equal(res.body.configured.lastInboundByLine.main, now);
  assert.equal(res.body.configured.lastInboundByLine.automation, now);
});

test("inbound webhook accepts a valid signature among comma-separated candidates", async () => {
  const calls = installInboxFetch();
  const payload = webhookPayload("signature-list");
  const raw = JSON.stringify(payload);
  const timestamp = Date.now();
  const valid = webhookSignature(raw, timestamp);
  const invalid = `hmac;1;${timestamp};ZmFrZQ==`;
  const { res } = await invokeWebhook(raw, { signature: `${invalid}, ${valid}` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, true);
  assert.equal(calls.inserts, 1);
});

test("every durably stored inbound text attempts an owner push even when it is not a client or lead", async () => {
  const calls = installInboxFetch();
  const { res } = await invokeWebhook(webhookPayload("unknown-owner-push", {
    from: "+15558889999",
    body: "Just letting you know the gate is open.",
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, true);
  assert.equal(res.body.kind, "other");
  assert.equal(calls.inserts, 1);
  // This test worker intentionally has no APNs key. Seeing the helper's explicit result proves the
  // owner path was attempted; an unavailable push transport must not turn the stored webhook into 5xx.
  assert.equal(res.body.push?.owner?.ok, false);
  assert.match(res.body.push?.owner?.skipped || "", /apns not configured/i);
});

test("inbound texts preserve whether Quo received them on the automation or main line", async () => {
  const calls = installInboxFetch();
  const automation = await invokeWebhook(webhookPayload("automation-line", { to: "+15550001111" }));
  const main = await invokeWebhook(webhookPayload("main-line", { to: ["+15550002222"] }));

  assert.equal(automation.res.statusCode, 200);
  assert.equal(automation.res.body.line, "automation");
  assert.equal(main.res.statusCode, 200);
  assert.equal(main.res.body.line, "main");
  assert.equal(calls.rows[0].ai?.quoLine, "automation");
  assert.equal(calls.rows[1].ai?.quoLine, "main");
});

test("inbound webhook stores Quo's body field and supports the legacy text fallback", async () => {
  const calls = installInboxFetch();

  const bodyResult = await invokeWebhook(webhookPayload("body-field", { body: "Current Quo payload" }));
  assert.equal(bodyResult.res.statusCode, 200);
  assert.equal(bodyResult.res.body.stored, true);

  const textResult = await invokeWebhook(webhookPayload("text-fallback", { body: undefined, text: "Legacy payload", to: ["+15550001111"] }));
  assert.equal(textResult.res.statusCode, 200);
  assert.equal(textResult.res.body.stored, true);

  assert.equal(calls.inserts, 2);
  assert.equal(calls.rows[0].body_text, "Current Quo payload");
  assert.equal(calls.rows[0].subject, "Current Quo payload");
  assert.equal(calls.rows[1].body_text, "Legacy payload");
  assert.equal(calls.rows[1].subject, "Legacy payload");
});

test("inbound media is noted without retaining provider-hosted media URLs", async () => {
  const calls = installInboxFetch();
  const { res } = await invokeWebhook(webhookPayload("media-note", {
    body: "Please look at this photo",
    media: [{ url: "https://provider.example/private-customer-photo.jpg", type: "image/jpeg" }],
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.rows[0].body_text, "Please look at this photo [1 media attachment; secure copy pending]");
  assert.doesNotMatch(JSON.stringify(calls.rows[0]), /provider\.example/);
});

test("an inbound Test Mode echo between SPS-owned lines is not stored as a customer text", async () => {
  let storageCalls = 0;
  globalThis.fetch = async () => { storageCalls += 1; throw new Error("test echo must not reach storage"); };
  const { res } = await invokeWebhook(webhookPayload("test-echo", {
    from: "+15550001111",
    to: "+15550002222",
    body: "[TEST → (555) 010-0103] Hi David, your technician is on the way.",
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, "test redirect echo");
  assert.equal(storageCalls, 0);
});

test("message.delivered stores an outgoing row under the intended Test Mode peer", async () => {
  const calls = installInboxFetch();
  const payload = webhookPayload("delivered");
  payload.type = "message.delivered";
  payload.data.object = {
    id: "AC-delivered-1",
    direction: "outgoing",
    from: "+15550001111",
    to: "+15550002222",
    body: "[TEST → +1555010103] Hi David",
    status: "delivered",
    phoneNumberId: "PN-automation",
    conversationId: "CN-1",
    createdAt: "2026-07-21T15:00:00.000Z",
    media: [],
  };
  const { res } = await invokeWebhook(payload);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, true);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].id, "sms_out_AC-delivered-1");
  assert.equal(calls.rows[0].sms_direction, "outgoing");
  assert.equal(calls.rows[0].sms_line, "automation");
  assert.equal(calls.rows[0].sms_peer_phone, "+1555010103");
  assert.equal(calls.rows[0].body_text, "Hi David");
  assert.equal(calls.rows[0].sms_status, "test_redirected");
  assert.equal(calls.rows[0].quo_conversation_id, null, "test-device conversation id must not attach to the intended client");
});

test("contact.updated writes one phone-keyed cache row instead of rewriting message history", async () => {
  const calls = { contactWrites: 0, inboxWrites: 0, rows: [] };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/rest/v1/sps_sms_contacts?on_conflict=phone")) {
      calls.contactWrites += 1;
      calls.rows.push(...JSON.parse(options.body));
      return response([]);
    }
    if (target.includes("/rest/v1/sps_inbox")) calls.inboxWrites += 1;
    throw new Error(`Unexpected fetch: ${target}`);
  };
  const payload = webhookPayload("contact-updated");
  payload.type = "contact.updated";
  payload.data.object = {
    id: "CT-1",
    defaultFields: {
      firstName: "Jordan",
      lastName: "Hale",
      phoneNumbers: [{ value: "+15552345678" }],
    },
  };
  const { res } = await invokeWebhook(payload);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contactUpdated, true);
  assert.equal(calls.contactWrites, 1);
  assert.equal(calls.inboxWrites, 0);
  assert.deepEqual(calls.rows[0], {
    phone: "+15552345678",
    quo_contact_id: "CT-1",
    contact_name: "Jordan Hale",
    avatar_path: "",
    updated_at: calls.rows[0].updated_at,
  });
});

test("a fast client-list failure is stored as an explicit matching failure, not an empty lookup", async () => {
  const calls = installInboxFetch({ clientReadFailure: true });
  const { res } = await invokeWebhook(webhookPayload("client-read-failed"));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.inserts, 1);
  assert.equal(calls.rows[0].kind, "other");
  assert.match(calls.rows[0].ai?.summary || "", /client matching failed/i);
});

test("inbound webhook skips outgoing events before any storage access", async () => {
  let storageCalls = 0;
  globalThis.fetch = async () => { storageCalls += 1; throw new Error("must not store outgoing text"); };
  const { res } = await invokeWebhook(webhookPayload("outgoing", { direction: "outgoing" }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, "not incoming");
  assert.equal(storageCalls, 0);
});

test("inbound webhook ignores messages for another Quo line", async () => {
  let storageCalls = 0;
  globalThis.fetch = async () => { storageCalls += 1; throw new Error("must not store another line's text"); };
  const { res } = await invokeWebhook(webhookPayload("other-line", { to: "+15559998888" }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, "other business number");
  assert.equal(storageCalls, 0);
});

test("inbound webhook fails closed when the event type or destination is missing", async (t) => {
  await t.test("missing event type", async () => {
    let storageCalls = 0;
    globalThis.fetch = async () => { storageCalls += 1; throw new Error("must not store untyped event"); };
    const payload = webhookPayload("missing-type");
    delete payload.type;
    const { res } = await invokeWebhook(payload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, "missing event type");
    assert.equal(storageCalls, 0);
  });
  await t.test("missing destination", async () => {
    let storageCalls = 0;
    globalThis.fetch = async () => { storageCalls += 1; throw new Error("must not store event without destination"); };
    const { res } = await invokeWebhook(webhookPayload("missing-to", { to: undefined }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.skipped, "missing destination");
    assert.equal(storageCalls, 0);
  });
});

test("inbound webhook acknowledges an already-stored event without inserting it again", async () => {
  const calls = installInboxFetch({ duplicate: true });
  const { res } = await invokeWebhook(webhookPayload("duplicate"));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(calls.inserts, 1);
});

test("a stored inbound text records notification completion before acknowledging Quo", async () => {
  const calls = installInboxFetch();
  const { res } = await invokeWebhook(webhookPayload("delivery-ledger"));

  assert.equal(res.statusCode, 200);
  assert.equal(calls.rows[0].ai?._pushDelivery?.owner, "sending");
  assert.equal(calls.rows[0].ai?._pushDelivery?.staff, "sending");
  assert.equal(calls.patches, 1);
  assert.equal(calls.patchBodies[0].ai?._pushDelivery?.owner, "done");
  assert.equal(calls.patchBodies[0].ai?._pushDelivery?.staff, "done");
});

test("an unfinished duplicate resumes only its pending notification leg", async () => {
  const calls = installInboxFetch({
    duplicate: true,
    duplicateAi: {
      quoLine: "automation",
      _pushDelivery: {
        v: 1,
        owner: "retry",
        staff: "done",
        attempts: 1,
        lastAttemptAt: "2026-01-01T00:00:00.000Z",
        retryAfter: "2026-01-01T00:00:30.000Z",
      },
    },
  });
  const { res } = await invokeWebhook(webhookPayload("retry-owner"));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.notificationRetry, true);
  assert.match(res.body.push?.staff?.skipped || "", /already completed/i);
  assert.equal(calls.reads, 1);
  assert.equal(calls.patches, 2, "one atomic lease claim and one completion write");
  assert.equal(calls.patchBodies.at(-1).ai?._pushDelivery?.owner, "done");
  assert.equal(calls.patchBodies.at(-1).ai?._pushDelivery?.staff, "done");
});

test("an overlapping duplicate waits for the active notification lease instead of double-sending", async () => {
  const calls = installInboxFetch({
    duplicate: true,
    duplicateAi: {
      quoLine: "automation",
      _pushDelivery: {
        v: 1,
        owner: "sending",
        staff: "sending",
        attempts: 1,
        lastAttemptAt: new Date().toISOString(),
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  });
  const { res } = await invokeWebhook(webhookPayload("active-delivery-lease"));

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.notificationRetryPending, true);
  assert.equal(calls.reads, 1);
  assert.equal(calls.patches, 0);
});

test("notification ledger write failures stay 5xx so Quo can retry safely", async () => {
  const calls = installInboxFetch({ patchFailure: true });
  const { res } = await invokeWebhook(webhookPayload("delivery-patch-failure"));

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.stored, true);
  assert.equal(calls.patches, 1);
});

test("overlapping inbound deliveries atomically claim one row and run one winner", async () => {
  let claimed = false;
  let inserts = 0;
  let storedRow = null;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_clients")) return response([]);
    if (target.includes("/rest/v1/sps_inbox?on_conflict=id")) {
      inserts += 1;
      const rows = JSON.parse(options.body);
      if (claimed) return response([]);
      claimed = true;
      storedRow = rows[0];
      return response(rows);
    }
    if (target.includes("/rest/v1/sps_inbox?") && target.includes("select=ai,kind") && !options.method) {
      return response(storedRow ? [{ ai: storedRow.ai, kind: storedRow.kind }] : []);
    }
    if (target.includes("/rest/v1/sps_inbox?") && options.method === "PATCH") {
      storedRow = { ...(storedRow || {}), ...JSON.parse(options.body) };
      return response([{ ai: storedRow.ai, kind: storedRow.kind || "other" }]);
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };

  const payload = webhookPayload("overlap");
  const [first, second] = await Promise.all([invokeWebhook(payload), invokeWebhook(payload)]);
  const bodies = [first.res.body, second.res.body];
  assert.equal(inserts, 2);
  assert.equal(bodies.filter((b) => b.duplicate !== true).length, 1);
  assert.equal(bodies.filter((b) => b.duplicate === true).length, 1);
  assert.equal(bodies.filter((b) => b.push).length, 1);
});

test("inbound storage failures stay 5xx so Quo can retry", async () => {
  const calls = installInboxFetch({ storageFailure: true });
  const { res } = await invokeWebhook(webhookPayload("storage-failure"));

  assert.ok(res.statusCode >= 500 && res.statusCode <= 599);
  assert.equal(res.body.stored, false);
  assert.equal(calls.inserts, 1);
});

test("texting SQL is additive and leaves security policies untouched", async () => {
  const sql = await readFile(new URL("../SMS-INBOX-MIGRATION.sql", import.meta.url), "utf8");
  assert.match(sql, /alter\s+table\s+public\.sps_inbox/i);
  assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+channel\s+text\s+not\s+null\s+default\s+'email'/i);
  assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+from_phone\s+text\s+not\s+null\s+default\s+''/i);
  assert.doesNotMatch(sql, /\b(create|alter|drop)\s+policy\b|\bgrant\b|\brevoke\b|\bdrop\s+(table|column)\b/i);
});
