import test from "node:test";
import assert from "node:assert/strict";
import {
  groupSmsConversations,
  inboxRowMessageIds,
  mergeInboxConversationRows,
  parseSmsTestRedirect,
} from "../smsConversations.js";

test("groups one peer into one conversation while keeping business lines separate", () => {
  const rows = [
    { id: "a", channel: "sms", from_phone: "+1 555 010 0101", body_text: "First", created_at: "2026-07-21T10:00:00Z", read: true, ai: { quoLine: "main" } },
    { id: "b", channel: "sms", from_phone: "5550100101", body_text: "Second", created_at: "2026-07-21T10:05:00Z", read: false, ai: { quoLine: "main" } },
    { id: "c", channel: "sms", from_phone: "5550100101", body_text: "Automation copy", created_at: "2026-07-21T10:06:00Z", read: false, ai: { quoLine: "automation" } },
  ];
  const groups = groupSmsConversations(rows, [{ id: "client-1", name: "Alex Morgan", phone: "(555) 010-0101" }]);
  assert.equal(groups.length, 2);
  const main = groups.find((group) => group.sms_line === "main");
  assert.equal(main.from_name, "Alex Morgan");
  assert.equal(main._messageCount, 2);
  assert.equal(main._unreadCount, 1);
  assert.deepEqual(inboxRowMessageIds(main), ["a", "b"]);
});

test("turns legacy Test Mode echoes into outgoing messages for the intended customer", () => {
  assert.deepEqual(parseSmsTestRedirect("[TEST → (555) 010-0103] Hi David"), { phone: "5550100103", body: "Hi David" });
  const [thread] = groupSmsConversations([
    { id: "echo", channel: "sms", from_phone: "5550100102", body_text: "[TEST → 5550100103] Hi David", created_at: "2026-07-21T10:00:00Z", read: false, ai: { quoLine: "automation" } },
  ], [{ id: "david", name: "David Example", phone: "555-010-0103" }]);
  assert.equal(thread.from_phone, "5550100103");
  assert.equal(thread.from_name, "David Example");
  assert.equal(thread._smsMessages[0].sms_direction, "outgoing");
  assert.equal(thread._smsMessages[0].body_text, "Hi David");
  assert.equal(thread._unreadCount, 0);
  assert.match(thread.subject, /^You:/);
});

test("attributes a legacy Test Mode echo to the sending business line", () => {
  const [thread] = groupSmsConversations([
    { id: "echo", channel: "sms", from_phone: "5550100102", body_text: "[TEST → 5550100103] On my way", created_at: "2026-07-21T10:00:00Z", ai: { quoLine: "main" } },
  ], [], { automation: "+15550100102", main: "+15550100101" });
  assert.equal(thread.sms_line, "automation");
});

test("does not merge different Test Mode customers through the redirect phone conversation id", () => {
  const groups = groupSmsConversations([
    { id: "one", channel: "sms", body_text: "Text one", from_phone: "5550100103", sms_peer_phone: "5550100103", sms_line: "automation", sms_direction: "outgoing", sms_status: "test_redirected", quo_conversation_id: "redirect-thread", created_at: "2026-07-21T10:00:00Z" },
    { id: "two", channel: "sms", body_text: "Text two", from_phone: "5550100104", sms_peer_phone: "5550100104", sms_line: "automation", sms_direction: "outgoing", sms_status: "test_redirected", quo_conversation_id: "redirect-thread", created_at: "2026-07-21T10:01:00Z" },
  ]);
  assert.equal(groups.length, 2);
});

test("does not collapse different people through a reused Quo conversation id", () => {
  const merged = mergeInboxConversationRows([
    { id: "mail", channel: "email", created_at: "2026-07-21T09:00:00Z" },
    { id: "one", channel: "sms", quo_conversation_id: "CN-1", from_phone: "5550100101", body_text: "One", created_at: "2026-07-21T10:00:00Z" },
    { id: "two", channel: "sms", quo_conversation_id: "CN-1", from_phone: "9999999999", body_text: "Two", created_at: "2026-07-21T11:00:00Z" },
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.filter((row) => row.channel === "sms").map((row) => row._messageCount), [1, 1]);
  assert.equal(merged[2].id, "mail");
});

test("keeps legacy phone-only history in the same thread after Quo metadata arrives", () => {
  const groups = groupSmsConversations([
    { id: "legacy", channel: "sms", from_phone: "5550100101", body_text: "Before metadata", created_at: "2026-07-21T09:00:00Z" },
    { id: "incoming", channel: "sms", quo_conversation_id: "CN-1", from_phone: "5550100101", sms_peer_phone: "5550100101", body_text: "After metadata", created_at: "2026-07-21T10:00:00Z" },
    { id: "reply", channel: "sms", quo_conversation_id: "CN-1", from_phone: "5550100101", sms_peer_phone: "5550100101", sms_direction: "outgoing", body_text: "Reply", created_at: "2026-07-21T10:05:00Z" },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]._messageCount, 3);
  assert.deepEqual(groups[0]._smsMessages.map((message) => message.id), ["legacy", "incoming", "reply"]);
});

test("keeps one phone thread when Quo replaces its provider conversation id", () => {
  const groups = groupSmsConversations([
    { id: "before", channel: "sms", quo_conversation_id: "CN-OLD", from_phone: "5550100101", body_text: "Before", created_at: "2026-07-21T10:00:00Z" },
    { id: "after", channel: "sms", quo_conversation_id: "CN-NEW", from_phone: "+1 (555) 010-0101", body_text: "After", created_at: "2026-07-21T11:00:00Z" },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]._messageCount, 2);
});

test("uses a Quo conversation id only when a legacy row has no phone", () => {
  const groups = groupSmsConversations([
    { id: "one", channel: "sms", quo_conversation_id: "CN-1", body_text: "One", created_at: "2026-07-21T10:00:00Z" },
    { id: "two", channel: "sms", quo_conversation_id: "CN-1", body_text: "Two", created_at: "2026-07-21T11:00:00Z" },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]._messageCount, 2);
});

test("a persisted lead link survives a newer ordinary text in the same conversation", () => {
  const [thread] = groupSmsConversations([
    { id: "lead-source", channel: "sms", from_phone: "5550100101", kind: "lead", lead_id: "lead-1", body_text: "Can I get a quote?", created_at: "2026-07-21T10:00:00Z" },
    { id: "latest", channel: "sms", from_phone: "5550100101", kind: "other", lead_id: "", body_text: "Thanks", created_at: "2026-07-21T11:00:00Z" },
  ]);

  assert.equal(thread.kind, "lead");
  assert.equal(thread.lead_id, "lead-1");
  assert.equal(thread.id, "latest");
});

test("saved conversation metadata wins over per-message triage on every new reply", () => {
  const [thread] = groupSmsConversations([
    { id: "before", channel: "sms", from_phone: "5550100101", kind: "other", body_text: "Earlier", created_at: "2026-07-21T10:00:00Z" },
    { id: "latest", channel: "sms", from_phone: "5550100101", kind: "client", body_text: "Newest", created_at: "2026-07-21T11:00:00Z" },
  ], [], {}, {
    "automation|phone:5550100101": { kind: "bill", leadId: "", updatedAt: "2026-07-21T10:30:00Z" },
  });

  assert.equal(thread.kind, "bill");
  assert.equal(thread._smsThreadMetadata.kind, "bill");
});

test("an older cached Quo identity beats a newer phone-only webhook row", () => {
  const [thread] = groupSmsConversations([
    {
      id: "named",
      channel: "sms",
      from_phone: "5550100101",
      from_name: "(555) 010-0101",
      sms_contact_name: "Jordan Example",
      sms_contact_avatar_url: "https://signed.example/avatar",
      quo_contact_id: "CT-contact",
      body_text: "Earlier",
      created_at: "2026-07-21T10:00:00Z",
    },
    {
      id: "latest",
      channel: "sms",
      from_phone: "5550100101",
      from_name: "+1 (555) 010-0101",
      body_text: "Newest",
      created_at: "2026-07-21T11:00:00Z",
    },
  ]);

  assert.equal(thread.from_name, "Jordan Example");
  assert.equal(thread._contactPhoto, "https://signed.example/avatar");
  assert.equal(thread._contactId, "CT-contact");
});

test("phone-shaped from_name is not presented as a contact name", () => {
  const [thread] = groupSmsConversations([
    {
      id: "phone-only",
      channel: "sms",
      from_phone: "5550100101",
      from_name: "(555) 010-0101",
      body_text: "Hello",
      created_at: "2026-07-21T10:00:00Z",
    },
  ]);

  assert.equal(thread.from_name, "");
  assert.equal(thread.from_phone, "5550100101");
});
