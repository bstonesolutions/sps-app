import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const inboxStart = app.indexOf("function EmailInboxSection(");
const inboxEnd = app.indexOf("function CommsActivity(", inboxStart);
const inbox = app.slice(inboxStart, inboxEnd > inboxStart ? inboxEnd : undefined);
const messagesStart = app.indexOf("function useMessages(");
const messagesEnd = app.indexOf("function fmtMsgTime(", messagesStart);
const messages = app.slice(messagesStart, messagesEnd > messagesStart ? messagesEnd : undefined);

test("Comms Inbox refreshes on foreground, native resume, and received push", () => {
  assert.ok(inboxStart >= 0, "EmailInboxSection must exist");
  assert.match(inbox, /window\.setInterval\(refreshInboxWhenVisible,\s*60000\)/);
  assert.match(inbox, /document\.addEventListener\("visibilitychange",\s*refreshInboxWhenVisible\)/);
  assert.match(inbox, /App\.addListener\("appStateChange",[\s\S]*?state\?\.isActive[\s\S]*?quietRefresh\(\)/);
  assert.match(inbox, /window\.addEventListener\("sps-push-received",\s*refreshInboxAfterPush\)/);
  assert.match(inbox, /document\.visibilityState === "visible"/);
});

test("Comms Inbox serializes loads and fences stale or unmounted responses", () => {
  assert.match(inbox, /const inboxMountedRef = useRef\(false\)/);
  assert.match(inbox, /const inboxLoadRef = useRef\(\{ promise: null, controller: null, requestId: 0 \}\)/);
  assert.match(inbox, /if \(state\.promise && !replace\)[\s\S]*?return state\.promise/);
  assert.match(inbox, /inboxLoadRef\.current\.requestId === requestId/);
  assert.match(inbox, /inboxLoadRef\.current\.controller\?\.abort\(\)/);
  assert.match(inbox, /signal: controller\.signal, cache: "no-store"/);
  assert.match(inbox, /if \(!requestIsCurrent\(\)\) return \{ ok: false, skipped: "stale" \}/);
});

test("client chat clears old rows immediately and fences late thread responses", () => {
  assert.ok(messagesStart >= 0, "useMessages must exist");
  assert.match(messages, /const threadKey =/);
  assert.match(messages, /threadState\.key === threadKey \? threadState\.messages : \[\]/);
  assert.match(messages, /messageRequestRef = useRef\(\{ requestId: 0, controller: null \}\)/);
  assert.match(messages, /const controller = new AbortController\(\)/);
  assert.match(messages, /messageRequestRef\.current\.requestId === requestId/);
  assert.match(messages, /signal: controller\.signal/);
  assert.match(messages, /query\.abortSignal\(controller\.signal\)/);
  assert.match(messages, /if \(!requestIsCurrent\(\)\) return \{ ok: false, skipped: "stale" \}/);
  assert.match(messages, /setThreadState\(\(current\) => current\.key === threadKey \? current : \{ key: threadKey, messages: \[\] \}\)/);
  assert.match(messages, /messageRequestRef\.current\.controller\?\.abort\(\)/);
});

test("message polling is bounded and only refreshes while visible", () => {
  assert.match(messages, /if \(disposed \|\| document\.hidden\) return/);
  assert.match(messages, /const interval = setInterval\(refreshWhenVisible,\s*60000\)/);
  assert.match(messages, /document\.addEventListener\("visibilitychange",\s*onVisible\)/);
  assert.match(messages, /window\.addEventListener\("sps-push-received",\s*refreshWhenVisible\)/);
});
