import test from "node:test";
import assert from "node:assert/strict";
import { stabilizeSmsConversationRows } from "../smsConversations.js";

const row = (overrides = {}) => ({
  id: "message",
  channel: "sms",
  sms_line: "main",
  sms_peer_phone: "+15550100101",
  ...overrides,
});

test("a compact refresh cannot erase a hydrated text contact", () => {
  const cache = new Map();
  const hydrated = stabilizeSmsConversationRows([
    row({ sms_contact_name: "Jordan Example", quo_contact_id: "CT-jordan" }),
  ], [], cache);
  const [refreshed] = stabilizeSmsConversationRows([
    row({ sms_peer_phone: "(555) 010-0101", from_name: "(555) 010-0101" }),
  ], hydrated, cache);

  assert.equal(refreshed.sms_contact_name, "Jordan Example");
  assert.equal(refreshed.quo_contact_id, "CT-jordan");
});

test("a new message anchor inherits the stable conversation identity", () => {
  const cache = new Map();
  stabilizeSmsConversationRows([
    row({ id: "old", sms_contact_name: "Jordan Example" }),
  ], [], cache);
  const [newest] = stabilizeSmsConversationRows([
    row({ id: "new", sms_peer_phone: "555-010-0101" }),
  ], [], cache);

  assert.equal(newest.sms_contact_name, "Jordan Example");
});

test("blank data cannot erase a known name, but a nonblank rename replaces it", () => {
  const cache = new Map();
  const known = stabilizeSmsConversationRows([
    row({ id: "one", sms_contact_name: "Jordan Old" }),
  ], [], cache);
  const blank = stabilizeSmsConversationRows([
    row({ id: "two", sms_contact_name: "" }),
  ], known, cache);
  const [renamed] = stabilizeSmsConversationRows([
    row({ id: "three", sms_contact_name: "Jordan New" }),
  ], blank, cache);

  assert.equal(blank[0].sms_contact_name, "Jordan Old");
  assert.equal(renamed.sms_contact_name, "Jordan New");
});

test("identity never crosses between the owner and staff business lines", () => {
  const cache = new Map();
  stabilizeSmsConversationRows([
    row({ sms_contact_name: "Owner Contact" }),
  ], [], cache);
  const [staffLine] = stabilizeSmsConversationRows([
    row({ id: "staff", sms_line: "automation" }),
  ], [], cache);

  assert.equal(staffLine.sms_contact_name, undefined);
});
