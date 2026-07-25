import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

function componentSource(name, followingNames = []) {
  const start = app.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const ends = followingNames
    .map((next) => app.indexOf(`function ${next}`, start + 1))
    .filter((index) => index > start);
  const end = ends.length ? Math.min(...ends) : app.length;
  return app.slice(start, end);
}

function sharedShellName() {
  const match = app.match(/(?:function|const)\s+(Comms(?:Mobile)?DetailShell)\b/);
  return match?.[1] || "";
}

function assertUsesSharedShell(source, destination) {
  const name = sharedShellName();
  assert.ok(name, "a shared Comms mobile detail shell component must exist");
  assert.match(
    source,
    new RegExp(`<${name}\\b`),
    `${destination} must use the shared Comms mobile detail shell`
  );
}

test("Comms has one reusable full-screen phone destination shell", () => {
  const name = sharedShellName();
  assert.ok(
    name,
    "define CommsMobileDetailShell (or CommsDetailShell) instead of duplicating full-screen destination chrome"
  );

  const start = app.search(new RegExp(`(?:function|const)\\s+${name}\\b`));
  const shell = app.slice(start, start + 7000);
  assert.match(shell, /data-sps-comms-detail-shell/);
  assert.match(shell, /createPortal\(/);
  assert.match(shell, /position:\s*"fixed"[\s\S]{0,100}inset:\s*0/);
  assert.match(shell, /env\(safe-area-inset-top\)/);
  assert.match(shell, /useBackgroundScrollLock/);
  assert.match(shell, /document\.body/);
});

test("every row-driven phone Comms destination uses the shared shell", () => {
  const sms = componentSource("MobileSmsThread", ["EmailInboxSection"]);
  const chat = componentSource("MessagesScreen", ["invCardMarker"]);
  const leads = componentSource("LeadsScreen", ["MessagesScreen"]);
  const inbox = componentSource("EmailInboxSection", ["LogsScreen"]);
  const reminders = componentSource("RemindersScreen", ["BroadcastSection"]);
  const activity = componentSource("LogsScreen", ["CommsScreen"]);

  assertUsesSharedShell(sms, "SMS conversations");
  assertUsesSharedShell(chat, "client chats");
  assertUsesSharedShell(leads, "lead details");
  assertUsesSharedShell(inbox, "email details");
  assertUsesSharedShell(reminders, "reminder reviews");
  assertUsesSharedShell(activity, "activity details");
});

test("desktop and wide-screen Comms retain their existing pane behavior", () => {
  const chat = componentSource("MessagesScreen", ["invCardMarker"]);
  const leads = componentSource("LeadsScreen", ["MessagesScreen"]);
  const inbox = componentSource("EmailInboxSection", ["LogsScreen"]);

  assert.match(chat, /const twoPane\s*=/);
  assert.match(chat, /if\s*\(twoPane\)/);
  assert.match(chat, /gridTemplateColumns:\s*"340px 1fr"/);

  assert.match(leads, /const twoPane\s*=/);
  assert.match(leads, /\{twoPane\s*\?/);
  assert.match(leads, /gridTemplateColumns:\s*"minmax\(320px, 400px\) 1fr"/);

  assert.match(inbox, /const wide\s*=/);
  assert.match(inbox, /list\.length\s*>\s*0\s*&&\s*\(wide\s*\?/);
  assert.match(inbox, /\{readerInner\}/);
});

test("phone lead, email, and reminder details no longer use generic floating modals", () => {
  const leads = componentSource("LeadsScreen", ["MessagesScreen"]);
  const inbox = componentSource("EmailInboxSection", ["LogsScreen"]);
  const reminders = componentSource("RemindersScreen", ["BroadcastSection"]);

  assert.equal(
    /sel\s*&&\s*!twoPane[\s\S]{0,220}<Modal\b[^>]*title="Lead"/.test(leads),
    false,
    "phone lead details should be a full-screen destination"
  );
  assert.equal(
    /openRow\s*&&\s*!wide\s*&&\s*!isSmsRow\(openRow\)[\s\S]{0,240}<Modal\b/.test(inbox),
    false,
    "phone email details should be a full-screen destination"
  );
  assert.equal(
    /\{review\s*&&\s*\(\s*<Modal\b/.test(reminders),
    false,
    "phone reminder review must branch to the full-screen destination before any desktop modal"
  );
});

test("phone Sent mail opens in the shared shell while desktop keeps inline expansion", () => {
  const inbox = componentSource("EmailInboxSection", ["LogsScreen"]);

  assert.match(inbox, /kind="sent-email"/);
  assert.match(inbox, /backLabel="Sent"/);
  assert.match(inbox, /onBack=\{\(\)\s*=>\s*setOpenSent\(null\)\}/);
  assert.match(inbox, /const open\s*=\s*!phone\s*&&\s*String\(openSent\)\s*===\s*String\(r\.id\)/);
  assert.match(inbox, /setOpenSent\(phone\s*\?\s*r\.id\s*:\s*\(open\s*\?\s*null\s*:\s*r\.id\)\)/);
  assert.match(inbox, /whiteSpace:\s*open\s*\?\s*"normal"\s*:\s*"nowrap"/);
});
