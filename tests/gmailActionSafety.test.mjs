import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { chooseGmailFallbackCandidate, newestGmailCandidateUids, safeGmailMessageId } from "../gmailActionSafety.js";

test("Gmail raw searches accept ordinary Message-IDs and reject query syntax", () => {
  assert.equal(safeGmailMessageId("<abc.123+mail@example.com>"), "abc.123+mail@example.com");
  assert.equal(safeGmailMessageId("abc-123/part=2@example.co.uk"), "abc-123/part=2@example.co.uk");
  assert.equal(safeGmailMessageId('abc@example.com" OR from:owner@example.com'), "");
  assert.equal(safeGmailMessageId("abc@example.com another:value"), "");
  assert.equal(safeGmailMessageId("missing-at.example.com"), "");
});

test("read-state fallback requires one exact nearby sender and subject", () => {
  const row = { from_email: "person@example.com", subject: "Service request", created_at: "2026-07-14T15:00:00.000Z" };
  const candidate = (uid, when) => ({ uid, internalDate: when, envelope: { subject: "Service request", from: [{ address: "person@example.com" }] } });

  assert.deepEqual(chooseGmailFallbackCandidate(row, [candidate(7, "2026-07-14T15:02:00.000Z")]), { uid: 7, reason: "fallback-exact" });
  assert.equal(chooseGmailFallbackCandidate(row, [candidate(7, "2026-07-14T15:02:00.000Z"), candidate(8, "2026-07-14T15:03:00.000Z")]).uid, null);
  assert.equal(chooseGmailFallbackCandidate(row, [candidate(7, "2026-07-14T19:30:00.000Z")]).uid, null);
  assert.equal(chooseGmailFallbackCandidate(row, [{ ...candidate(7, "2026-07-14T15:02:00.000Z"), envelope: { subject: "Different", from: [{ address: "person@example.com" }] } }]).uid, null);
});

test("recoverable trash fallback may choose only the unique nearest candidate", () => {
  const row = { from_email: "person@example.com", subject: "Invoice", created_at: "2026-07-14T15:00:00.000Z" };
  const candidate = (uid, when) => ({ uid, internalDate: when, envelope: { subject: "Invoice", from: [{ address: "person@example.com" }] } });
  const chosen = chooseGmailFallbackCandidate(row, [candidate(3, "2026-07-14T15:05:00.000Z"), candidate(4, "2026-07-14T15:40:00.000Z")], { allowNearest: true });
  assert.equal(chosen.uid, 3);

  const tied = chooseGmailFallbackCandidate(row, [candidate(3, "2026-07-14T14:55:00.000Z"), candidate(4, "2026-07-14T15:05:00.000Z")], { allowNearest: true });
  assert.equal(tied.uid, null);
});

test("recurring sender fallback inspects the newest bounded Gmail matches", () => {
  const uids = Array.from({ length: 100 }, (_, index) => index + 1);
  const newest = newestGmailCandidateUids(uids, 60);
  assert.equal(newest.length, 60);
  assert.equal(newest[0], 100);
  assert.equal(newest.at(-1), 41);
  assert.deepEqual(uids.slice(0, 3), [1, 2, 3], "the IMAP result must not be mutated");
});

test("inbox read state is Gmail-first and delete retries recognize Gmail Trash", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const inboxStart = app.indexOf("function EmailInboxSection");
  const markStart = app.indexOf("const markRead =", inboxStart);
  const markEnd = app.indexOf("// Reclassify an email", markStart);
  const markSource = app.slice(markStart, markEnd);
  assert.match(markSource, /const smsKeys = new Set/);
  assert.match(markSource, /const emailIds = ids\.filter/);
  assert.ok(markSource.indexOf("await gmailAction(read") < markSource.indexOf('fetch(`${PROD_URL}/api/inbox`'), "Gmail must confirm before SPS persists email read state");
  assert.match(markSource, /markUnread" : "markRead"/);
  assert.match(markSource, /Do not show the new state until the remote systems confirm it/);

  const endpoint = await readFile(new URL("../api/gmail-action.js", import.meta.url), "utf8");
  assert.match(endpoint, /reason: "lookup-error"/);
  assert.match(endpoint, /connectionTimeout: 10000/);
  assert.match(endpoint, /greetingTimeout: 8000/);
  assert.match(endpoint, /socketTimeout: 12000/);
  assert.match(endpoint, /getMailboxLock\(trash\)/);
  assert.match(endpoint, /if \(!emailIds\.length\) return res\.status\(200\)/);
  assert.match(endpoint, /fetchOne\(match\.uid, \{ flags: true \}/);
  assert.match(endpoint, /if \(!applied\) \{ skipped\.push\(\{ id, reason: "op-error" \}\); continue; \}/);
  assert.match(endpoint, /changes\.push\(\{ id, changed: true, previousRead \}\)/);
  assert.match(markSource, /gmail\.changes\.get\(String\(id\)\)\?\.changed === true/);
});
