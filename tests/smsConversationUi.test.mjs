import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const conversationStart = app.indexOf("function SmsConversationBody");
const conversationEnd = app.indexOf("// Comms → Inbox", conversationStart);
const smsConversationBody = app.slice(conversationStart, conversationEnd);
const start = app.indexOf("function EmailInboxSection");
const end = app.indexOf("function LogsScreen", start);
const inbox = app.slice(start, end > start ? end : undefined);
const swipeStart = app.indexOf("function InboxSwipeRow");
const swipeEnd = app.indexOf("function InboxActionSheet", swipeStart);
const swipe = app.slice(swipeStart, swipeEnd);
const previewStart = app.indexOf("function InboxPressPreview");
const previewEnd = app.indexOf("function EmailInboxSection", previewStart);
const pressPreview = app.slice(previewStart, previewEnd);
const mobileRowsStart = inbox.indexOf("const mobileRows");
const mobileRowsEnd = inbox.indexOf("const pinnedRail", mobileRowsStart);
const phoneRows = inbox.slice(mobileRowsStart, mobileRowsEnd);

test("texts render as chronological conversations with a ready reply composer", () => {
  assert.match(inbox, /mergeInboxConversationRows\(inboxRows, clients, quoLines, smsThreadMeta\)/);
  assert.match(smsConversationBody, /function SmsConversationBody/);
  assert.match(smsConversationBody, /messages\.map\(\(message, index\)/);
  assert.match(smsConversationBody, /alignSelf: outgoing \? "flex-end" : "flex-start"/);
  assert.match(inbox, /const openReplyWorkspaceKey = workspaceKeyForInboxRow\(openRow\)/);
  assert.match(inbox, /setReplying\(!!smsCanReply \|\| \(!!savedDraft\.replying && openRow\?\.channel !== "sms"\)\)/);
  assert.match(inbox, /openRow\.channel !== "sms" && <Btn variant="outline" sm onClick=\{toggleReply\}/);
  assert.match(inbox, /<textarea[\s\S]*?value=\{replyText\}[\s\S]*?maxLength=\{1600\}/);
  assert.match(inbox, /sendSms\(phone, replyText\.trim\(\), \{ clientId, preserveRecipient: true,[\s\S]*?inboxId: replyAnchor\.id/);
  assert.match(inbox, /openRow\.channel === "sms" \? "Send text" : "Send reply"/);
  assert.match(inbox, /Sends through Quo from the same/);
});

test("Test Mode clearly allows only a server-verifiable existing-thread reply to go live", () => {
  assert.match(app, /const existingThreadReply = !!\(meta\?\.preserveRecipient && meta\?\.inboxId\);/);
  assert.match(app, /const testProtected = TEST_MODE\.on && !explicitTest && !existingThreadReply && !clientIsLive/);
  assert.match(inbox, /const inboundReplyAnchor = \(row\) =>/);
  assert.match(inbox, /const openThreadReplyIsLive = !!inboundReplyAnchor\(openRow\)\?\.id;/);
  assert.match(inbox, /const replyAnchor = inboundReplyAnchor\(row\);/);
  assert.match(inbox, /This existing-thread reply sends live\. Test Mode still protects automatic and new outbound messages\./);
  assert.match(inbox, /This reply sends live\. Automatic and new outbound messages remain in Test Mode\./);
  assert.match(app, /A reply you send inside an existing text thread still goes live\./);
  assert.match(app, /Replies inside existing text threads go live from the same business line\./);
});

test("SMS list and thread omit email-triage chrome", () => {
  assert.match(inbox, /!isSmsRow\(r\) && badge\(r\.kind\)/);
  assert.match(inbox, /const channelLabel = sms[\s\S]*?"My line"[\s\S]*?"Staff line"[\s\S]*?: \(kind\.label && kind\.label !== "Other" \? kind\.label : "Email"\)/);
  assert.match(inbox, /!isSmsRow\(openRow\) && openRow\.ai && openRow\.ai\.summary/);
  assert.match(inbox, /!smsOnly && !isSmsRow\(openRow\) && <div style=\{\{ display: "flex", gap: 8/);
  assert.match(inbox, /!smsOnly && isSmsRow\(openRow\)[\s\S]*?>Organize<\/Btn>/);
  assert.match(inbox, /title=\{isSmsRow\(manageRow\) \? "Organize conversation" : "Manage email"\}/);
  assert.match(inbox, /\["lead", "bill", "client", "other"\]\.map/);
  assert.match(inbox, /action: "setThreadKind", id: row\.id, kind/);
  assert.match(inbox, /smsLeadSourceId/);
  assert.match(inbox, /"Select conversation"/);
});

test("phone rows use compact conversation chrome while retaining swipe actions", () => {
  assert.match(inbox, /const mobileRows = mobileList\.map/);
  assert.doesNotMatch(phoneRows, /showChannelMarker/);
  assert.match(phoneRows, /<Icon name=\{sms \? "message" : "mail"\}/);
  assert.match(phoneRows, /data-sps-conversation-row data-channel=\{sms \? "sms" : "email"\}/);
  assert.match(phoneRows, /\{messagePreview \|\| \(sms \? "Text message" : "\(no subject\)"\)\}[\s\S]*?\{channelLabel\}/, "the actual message should precede secondary channel metadata");
  assert.match(phoneRows, /fmtMailboxWhen\(r\.created_at\)/);
  assert.match(phoneRows, /<Icon name="chevronR"/);
  assert.match(phoneRows, /onToggleRead=\{\(\) => \{ markRead\(inboxRowMessageIds\(r\), !r\.read\); \}\}/);
  assert.match(phoneRows, /onDelete=\{smsOnly \? undefined : \(\) => \{ deleteEmails\(inboxRowMessageIds\(r\), \{ ask: false \}\); \}\}/);
});

test("SMS accents use the SPS brand palette instead of purple", () => {
  assert.match(inbox, /const smsTone = T\.primary/);
  assert.match(inbox, /const tone = sms \? smsTone : emailTone/);
  assert.match(phoneRows, /const channelTone = sms \? smsTone : emailTone/);
  assert.doesNotMatch(inbox, /#7c3aed/i);
});

test("touch-and-hold previews without opening or marking read", () => {
  assert.match(swipe, /previewTimerRef/);
  assert.match(swipe, /window\.setTimeout\(\(\) => \{[\s\S]*?onPreview\(\);[\s\S]*?\}, 450\)/);
  assert.match(swipe, /onContextMenu=\{\(e\) => \{ if \(!disabled && onPreview\)/);
  assert.match(phoneRows, /onPreview=\{\(\) => \{ setOpenSwipeId\(null\); setPreviewRow\(r\); \}\}/);
  const previewHandler = phoneRows.match(/onPreview=\{\(\) => \{([^}]*)\}\}/)?.[1] || "";
  assert.doesNotMatch(previewHandler, /markRead/);
  assert.match(pressPreview, /role="dialog" aria-modal="true"/);
  assert.match(inbox, /onOpen=\{\(\) => \{ const row = previewRow; setPreviewRow\(null\); openMessage\(row\); \}\}/);
});

test("SMS pins are server-backed and render in a separate phone rail", () => {
  assert.match(inbox, /\/api\/sms-inbox\?threadPrefs=1/);
  assert.match(inbox, /action: "setPinned", anchorId: row\.id, pinned: !!pinned/);
  assert.match(inbox, /const pinnedRows = showPinnedRail/);
  assert.match(inbox, /<section aria-label="Pinned conversations"/);
  assert.match(inbox, /<InboxPinnedConversation[\s\S]*?onOpen=\{\(\) => openMessage\(row\)\}[\s\S]*?onPreview=\{\(\) => setPreviewRow\(row\)\}/);
  assert.doesNotMatch(inbox, /localStorage\.(?:getItem|setItem)\([^)]*pin/i);
});

test("phone inbox keeps search and compose above the bottom navigation", () => {
  assert.match(inbox, /phone && !selMode && createPortal\(/);
  assert.match(inbox, /aria-label="Search messages and compose"/);
  assert.match(inbox, /bottom: "var\(--sps-floating-action-bottom/);
  assert.match(inbox, /<CommsSearchField[\s\S]*?touch pill/);
  assert.match(inbox, /paddingBottom: phone \? \(selMode \? 76 : 88\)/);
});

test("visible SMS identities are privately hydrated in one bounded request", () => {
  assert.match(inbox, /const smsIdentityLoadedRef = useRef\(new Map\(\)\)/);
  assert.match(inbox, /ids\.forEach\(id => query\.append\("identityFor", id\)\)/);
  assert.match(inbox, /sms_contact_name: identity\.name/);
  assert.match(inbox, /sms_contact_avatar_url: identity\.avatarUrl/);
  assert.match(inbox, /\.slice\(0, 50\)/);
});

test("an open SMS thread refreshes when its private signed media finishes loading", () => {
  assert.match(inbox, /\[rows, clients, smsThreadMeta, smsThreadPrefs, smsMediaById\]/);
  assert.match(inbox, /sms_media: media\?\.sms_media \|\| row\.sms_media \|\| \[\]/);
});

test("owner inbox advances a bounded Quo contact backfill and refreshes only on changes", () => {
  assert.match(inbox, /const quoContactSyncStartedRef = useRef\(false\)/);
  assert.match(inbox, /fetch\(`\$\{PROD_URL\}\/api\/quo-contact-sync`/);
  assert.match(inbox, /maxContacts: 50/);
  assert.match(inbox, /maxPages: 1/);
  assert.match(inbox, /if \(Number\(body\.changed \|\| 0\) > 0\)/);
  assert.match(inbox, /smsIdentityLoadedRef\.current\.clear\(\)/);
  assert.match(inbox, /await load\(\{ background: true \}\)/);
});
