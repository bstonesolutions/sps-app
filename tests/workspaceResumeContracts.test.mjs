import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

function sliceBetween(startText, endText) {
  const start = app.indexOf(startText);
  assert.ok(start >= 0, `missing ${startText}`);
  const end = app.indexOf(endText, start + startText.length);
  assert.ok(end > start, `missing ${endText} after ${startText}`);
  return app.slice(start, end);
}

test("manual and long-idle sync refresh data without reloading the workspace", () => {
  const sync = sliceBetween("const refreshWorkspaceInPlace =", "// Register global sync hooks");
  assert.match(sync, /store\.flush\(\)/);
  assert.match(sync, /store\.refreshChanged|store\.refresh\(/);
  assert.match(sync, /sps-manual-refresh/);
  assert.doesNotMatch(sync, /location\.reload|reloadAfterDrain/);

  const idle = sliceBetween("// A long background stay should refresh shared data", "const [dbError");
  assert.match(idle, /softRefreshRef\.current/);
  assert.doesNotMatch(idle, /location\.reload|reloadAfterDrain/);
});

test("Comms keeps account-scoped destinations, drafts, filters, and section scroll", () => {
  const leads = sliceBetween("function LeadsScreen", "function MessagesScreen");
  const messages = sliceBetween("function MessagesScreen", "function invCardMarker");
  const chat = sliceBetween("function ChatThread", "function StaffChat");
  const broadcast = sliceBetween("function BroadcastSection", "function OwnerDigestSettings");
  const inbox = sliceBetween("function EmailInboxSection", "function LogsScreen");
  const comms = sliceBetween("function CommsScreen", "function InventoryItemModal");

  assert.match(leads, /manualForm:\s*form/);
  assert.match(leads, /adding,\s*manualForm/);
  assert.match(messages, /selectedClientId/);
  assert.match(messages, /showNewMsg/);
  assert.match(chat, /chatDrafts/);
  assert.match(broadcast, /comms:\s*\{\s*broadcast:/);
  assert.match(inbox, /compose:\s*\{/);
  assert.match(inbox, /replyDrafts/);
  assert.match(comms, /commsSections/);
});

test("SMS reply drafts use the stable conversation key rather than the latest message id", () => {
  const inbox = sliceBetween("function EmailInboxSection", "function LogsScreen");
  assert.match(inbox, /openReplyWorkspaceKey\s*=\s*workspaceKeyForInboxRow\(openRow\)/);
  assert.match(inbox, /sms:\$\{row\._smsConversationKey\}/);
  assert.match(inbox, /replyDraftKeyLoaded\s*!==\s*openReplyWorkspaceKey/);
  assert.doesNotMatch(
    inbox,
    /setReplyText\(""\);\s*setReplyHtml\(""\);\s*setReplyMsg\(""\);\s*\n\s*\},\s*\[openRow\s*&&\s*openRow\.id\]/
  );
});

test("phone Sent mail and new-chat flows are real full-screen destinations", () => {
  const inbox = sliceBetween("function EmailInboxSection", "function LogsScreen");
  const messages = sliceBetween("function MessagesScreen", "function invCardMarker");

  assert.match(inbox, /kind="sent-email"/);
  assert.match(inbox, /backLabel="Sent"/);
  assert.match(inbox, /onBack=\{\(\)\s*=>\s*setOpenSent\(null\)\}/);
  assert.match(inbox, /const open\s*=\s*!phone\s*&&\s*String\(openSent\)\s*===\s*String\(r\.id\)/);

  assert.match(messages, /kind="new-chat"/);
  assert.match(messages, /title="New message"/);
});

test("client detail tab changes are reported to the account workspace", () => {
  const detail = sliceBetween("function ClientDetail", "function PhotoPicker");
  assert.match(detail, /onTabChange/);
  assert.match(detail, /if\s*\(onTabChange\)\s*onTabChange\(t\)/);
  assert.match(app, /<ClientDetail[^>]*initialTab=\{clientOpenTab\}[^>]*onTabChange=\{setClientOpenTab\}/);
});
