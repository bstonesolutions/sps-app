import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const keyboardStart = app.indexOf("function useKeyboardInset");
const keyboardEnd = app.indexOf("function useGrowingTextarea", keyboardStart);
const keyboardHook = app.slice(keyboardStart, keyboardEnd);
const shellStart = app.indexOf("function CommsMobileDetailShell");
const shellEnd = app.indexOf("function CommsResponsiveDetail", shellStart);
const detailShell = app.slice(shellStart, shellEnd);
const smsConversationStart = app.indexOf("function SmsConversationBody");
const smsConversationEnd = app.indexOf("// Comms → Inbox", smsConversationStart);
const smsConversation = app.slice(smsConversationStart, smsConversationEnd);
const inboxStart = app.indexOf("function EmailInboxSection");
const inboxEnd = app.indexOf("function LogsScreen", inboxStart);
const inbox = app.slice(inboxStart, inboxEnd);

test("the iOS keyboard inset ignores caret-driven viewport scrolling", () => {
  assert.match(keyboardHook, /function useKeyboardInset\(active = true\)/);
  assert.match(keyboardHook, /stableKeyboardInset\(/);
  assert.match(keyboardHook, /requestAnimationFrame\(measure\)/);
  assert.match(keyboardHook, /vv\.addEventListener\("resize", scheduleMeasure\)/);
  assert.doesNotMatch(keyboardHook, /vv\.addEventListener\("scroll"/);
  assert.doesNotMatch(keyboardHook, /offsetTop/);
});

test("the mobile detail shell subscribes only when it owns a composer", () => {
  assert.match(detailShell, /useKeyboardInset\(Boolean\(footer\)\)/);
  assert.match(detailShell, /overflowAnchor: "none"/);
  assert.doesNotMatch(detailShell, /transition: "padding-bottom/);
});

test("the SMS composer grows after layout without forcing two layouts per key", () => {
  assert.match(inbox, /useGrowingTextarea\(replyComposerRef, replyText, 32, 92\)/);
  assert.match(inbox, /onChange=\{\(event\) => setReplyText\(event\.target\.value\)\}/);
  assert.match(inbox, /overflowY: "hidden", overflowAnchor: "none"/);
  assert.doesNotMatch(inbox, /event\.target\.style\.height = "auto"/);
  assert.doesNotMatch(inbox, /event\.target\.scrollHeight/);
});

test("SMS composer keystrokes cannot remount or force-scroll the conversation history", () => {
  assert.ok(smsConversationStart >= 0, "SMS conversation history component should exist");
  assert.ok(smsConversationStart < inboxStart, "SMS conversation history must have a stable module-level component type");
  assert.doesNotMatch(inbox, /const SmsConversationBody\s*=/);

  const callSites = inbox.match(/<SmsConversationBody[^>]*\/>/g) || [];
  assert.equal(callSites.length, 3, "all three conversation views should use the stable history component");
  for (const callSite of callSites) {
    assert.match(callSite, /T=\{T\}/);
    assert.match(callSite, /senderLabel=\{senderLabel\}/);
    assert.match(callSite, /fmtWhen=\{fmtWhen\}/);
    assert.match(callSite, /fmtMailboxWhen=\{fmtMailboxWhen\}/);
  }

  assert.match(smsConversation, /\[row\?\._smsConversationKey, row\?\._messageCount\]/);
  assert.doesNotMatch(smsConversation, /replyText|setReplyText/);
});
