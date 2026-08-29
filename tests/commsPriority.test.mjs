import test from "node:test";
import assert from "node:assert/strict";
import { mergeInboxConversationRows } from "../smsConversations.js";
import {
  actionableCommsReason,
  selectActionableCommsRows,
  summarizeActionableCommsRows,
} from "../commsPriority.js";

test("one unanswered text conversation counts once even when it contains several unread messages", () => {
  const rows = mergeInboxConversationRows([
    {
      id: "sms-1",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100101",
      sms_direction: "incoming",
      body_text: "First message",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
    {
      id: "sms-2",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100101",
      sms_direction: "incoming",
      body_text: "Second message",
      created_at: "2026-08-29T12:01:00Z",
      read: false,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(actionableCommsReason(rows[0]), "text");
  assert.deepEqual(summarizeActionableCommsRows(rows), {
    total: 1,
    texts: 1,
    leads: 0,
    bills: 0,
    clients: 0,
    failures: 0,
  });
});

test("a later outgoing reply resolves a text conversation without deleting its history", () => {
  const rows = mergeInboxConversationRows([
    {
      id: "sms-incoming",
      channel: "sms",
      sms_line: "automation",
      sms_peer_phone: "+15550100102",
      sms_direction: "incoming",
      body_text: "Can you call me?",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
    {
      id: "sms-reply",
      channel: "sms",
      sms_line: "automation",
      sms_peer_phone: "+15550100102",
      sms_direction: "outgoing",
      body_text: "Yes, I will call shortly.",
      created_at: "2026-08-29T12:02:00Z",
      read: true,
    },
  ]);

  assert.equal(rows[0]._messageCount, 2);
  assert.equal(actionableCommsReason(rows[0]), "");
  assert.deepEqual(selectActionableCommsRows(rows), []);
});

test("test redirects stay out of the actionable queue", () => {
  const rows = mergeInboxConversationRows([
    {
      id: "test-redirect",
      channel: "sms",
      from_phone: "+15550100999",
      body_text: "[TEST → (555) 010-0103] On my way",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
  ]);

  assert.equal(rows[0]._isTestRedirect, true);
  assert.equal(actionableCommsReason(rows[0]), "");
});

test("routine acknowledgements remain in history without inflating the attention count", () => {
  const rows = mergeInboxConversationRows([
    {
      id: "thanks",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100109",
      sms_direction: "incoming",
      body_text: "Thanks!",
      created_at: "2026-08-29T12:00:00Z",
      read: false,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(actionableCommsReason(rows[0]), "");
  assert.deepEqual(selectActionableCommsRows(rows), []);
});

test("short decisions and gratitude followed by a problem still require attention", () => {
  const makeConversation = (id, body, minute) => mergeInboxConversationRows([{
    id,
    channel: "sms",
    sms_line: "main",
    sms_peer_phone: `+155501001${minute}`,
    sms_direction: "incoming",
    body_text: body,
    created_at: `2026-08-29T12:${minute}:00Z`,
    read: false,
  }])[0];

  const rows = [
    makeConversation("yes", "Yes", "10"),
    makeConversation("no", "No", "11"),
    makeConversation("complaint", "Thanks for the visit, but the pump is still leaking.", "12"),
    makeConversation("resolved", "Well thank you. Much better now. 😄", "13"),
  ];

  assert.deepEqual(rows.map(actionableCommsReason), ["text", "text", "text", ""]);
});

test("email attention includes unconverted leads and bills needing action, not routine confirmations", () => {
  const rows = [
    { id: "lead", channel: "email", kind: "lead", lead_id: "", read: true },
    { id: "converted-lead", channel: "email", kind: "lead", lead_id: "lead-1", read: false },
    { id: "bill", channel: "email", kind: "bill", subject: "Invoice reminder: payment due tomorrow", read: false },
    { id: "bill-ready", channel: "email", kind: "bill", subject: "Your bill is ready", read: false },
    { id: "bill-structured", channel: "email", kind: "bill", subject: "Practical Garden Ponds", ai: { bill: { amount: "$412.19", dueDate: "2026-09-10" } }, read: false },
    { id: "bill-not-paid", channel: "email", kind: "bill", subject: "Invoice not paid", read: false },
    { id: "routine-bill", channel: "email", kind: "bill", subject: "Payroll confirmed for this week", read: false },
    { id: "read-bill", channel: "email", kind: "bill", subject: "Payment overdue", read: true },
    { id: "client", channel: "email", kind: "client", read: false },
    { id: "other", channel: "email", kind: "other", read: false },
  ];

  assert.deepEqual(rows.map(actionableCommsReason), ["lead", "", "bill", "bill", "bill", "bill", "", "", "client", ""]);
  assert.deepEqual(selectActionableCommsRows(rows).map((row) => row.id), ["lead", "bill", "bill-ready", "bill-structured", "bill-not-paid", "client"]);
  assert.deepEqual(summarizeActionableCommsRows(rows), {
    total: 6,
    texts: 0,
    leads: 1,
    bills: 4,
    clients: 1,
    failures: 0,
  });
});

test("delivery failures remain actionable even when the failed message was outgoing", () => {
  const rows = mergeInboxConversationRows([
    {
      id: "failed-sms",
      channel: "sms",
      sms_line: "main",
      sms_peer_phone: "+15550100104",
      sms_direction: "outgoing",
      sms_status: "delivery_failed",
      body_text: "Your report is ready",
      created_at: "2026-08-29T12:00:00Z",
      read: true,
    },
  ]);

  assert.equal(actionableCommsReason(rows[0]), "failure");
  assert.equal(summarizeActionableCommsRows(rows).failures, 1);
});
