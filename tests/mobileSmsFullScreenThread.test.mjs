import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const threadStart = app.indexOf("function MobileSmsThread");
const threadEnd = app.indexOf("function EmailInboxSection", threadStart);
const mobileThread = app.slice(threadStart, threadEnd > threadStart ? threadEnd : undefined);
const inboxStart = app.indexOf("function EmailInboxSection");
const inboxEnd = app.indexOf("function LogsScreen", inboxStart);
const inbox = app.slice(inboxStart, inboxEnd > inboxStart ? inboxEnd : undefined);

test("a phone SMS opens as a full-screen destination instead of the generic message modal", () => {
  assert.ok(threadStart >= 0, "the dedicated mobile SMS thread component should exist");
  assert.match(mobileThread, /createPortal\(/);
  assert.match(mobileThread, /data-sps-mobile-sms-thread/);
  assert.match(mobileThread, /position: "fixed", inset: 0/);
  assert.match(mobileThread, /document\.body/);

  assert.match(
    inbox,
    /openRow && !wide && isSmsRow\(openRow\)[\s\S]*?<MobileSmsThread/,
    "phone SMS should use MobileSmsThread"
  );
  assert.match(
    inbox,
    /openRow && !wide && !isSmsRow\(openRow\)[\s\S]*?<Modal/,
    "phone email can continue using the generic reader modal"
  );
  assert.doesNotMatch(
    inbox,
    /openRow && !wide && \(\s*<Modal title=\{isSmsRow\(openRow\)/,
    "the generic modal must not own both email and SMS"
  );
});

test("the full-screen thread has an iMessage-style header and explicit back action", () => {
  assert.match(mobileThread, /<header data-sps-thread-header/);
  assert.match(mobileThread, /onClick=\{onBack\} aria-label="Back to messages"/);
  assert.match(mobileThread, /<Icon name="back"/);
  assert.match(mobileThread, /<span>Messages<\/span>/);
  assert.match(mobileThread, /aria-label=\{`Open details for \$\{title\}`\}/);
  assert.match(mobileThread, /aria-label=\{`Call \$\{title\}`\}/);
  assert.match(mobileThread, /const contactMeta = \[visibleCategory, lineLabel, distinctSubtitle\]\.filter\(Boolean\)\.join\(" · "\)/);
  assert.doesNotMatch(mobileThread, /aria-label=\{`Organize as \$\{categoryLabel\}`\}/, "contact metadata should not occupy a second CRM-style header row");
});

test("the full-screen thread keeps its reply composer fixed and the history independently scrollable", () => {
  assert.match(mobileThread, /data-sps-mobile-sms-thread[\s\S]*?display: "flex", flexDirection: "column"/);
  assert.match(mobileThread, /<div ref=\{threadRef\}[\s\S]*?flex: "1 1 auto"[\s\S]*?overflow: "hidden"/);
  assert.match(mobileThread, /<footer data-sps-thread-composer[\s\S]*?flexShrink: 0[\s\S]*?\{composer\}[\s\S]*?<\/footer>/);

  assert.match(inbox, /<SmsConversationBody row=\{openRow\}[\s\S]*?fullScreen/);
  assert.match(inbox, /data-sps-sms-thread-history/);
  assert.match(inbox, /data-sps-message-bubble data-direction=\{outgoing \? "outgoing" : "incoming"\}/);
  assert.match(
    inbox,
    /composer=\{[\s\S]*?<textarea[\s\S]*?aria-label=\{`Text \$\{senderLabel\(openRow\)\}`\}[\s\S]*?value=\{replyText\}[\s\S]*?maxLength=\{1600\}[\s\S]*?Send text/,
    "SMS composer should be supplied directly to the full-screen shell"
  );
});

test("organization and categorization remain accessible from inside the full-screen thread", () => {
  assert.match(mobileThread, /onClick=\{onOrganize\} aria-label="Organize conversation"/);
  assert.match(
    inbox,
    /<MobileSmsThread[\s\S]*?onOrganize=\{\(\) => setManageRow\(openRow\)\}/,
    "the thread header should open the existing organization controls"
  );
  assert.match(inbox, /title=\{isSmsRow\(manageRow\) \? "Organize conversation" : "Manage email"\}/);
  assert.match(inbox, /\["lead", "bill", "client", "other"\]\.map/);
  assert.match(inbox, /action: "setThreadKind", id: row\.id, kind/);
});
