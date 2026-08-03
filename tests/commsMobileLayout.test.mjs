import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mobile inbox uses a compact mailbox dropdown with inline search and compose", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function EmailInboxSection");
  const end = app.indexOf("function LogsScreen", start);
  const source = app.slice(start, end);

  assert.match(source, /aria-label="Choose mailbox and inbox filters"/);
  assert.match(source, /aria-label="Mailbox and inbox views"/);
  assert.match(source, /aria-label="Search messages and compose"/);
  assert.match(source, /placeholder=\{folder === "inbox" \? "Search messages" : "Search sent"\}/);
  assert.match(source, /label: "All channels"/);
  assert.match(source, /<CommsIconAction icon="edit" label="Compose a new email"[\s\S]*?active/);
  assert.match(source, /!phone && <div[\s\S]*?\{!smsOnly && folderBar\}/);
  assert.match(source, /const inboxEndpoint = smsOnly \? "\/api\/sms-inbox" : "\/api\/inbox"/);
  assert.match(source, /!smsOnly && phoneMenuOption\(\{ key: "mailbox-sent"/);
  assert.doesNotMatch(app, /function CommsMailBottomBar/);
  assert.doesNotMatch(source, /<CommsMailBottomBar/);
});

test("theme rgba borders retain their base transparency instead of becoming black", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const helperSource = app.match(/const hexA = \(color, a\) => \{[\s\S]*?\n\};/)?.[0];
  assert.ok(helperSource, "the shared translucent-color helper must remain available");
  const colorWithAlpha = Function(`"use strict"; ${helperSource}; return hexA;`)();

  assert.equal(colorWithAlpha("rgba(0,0,0,0.08)", 0.8), "rgba(0, 0, 0, 0.064)");
  assert.equal(colorWithAlpha("#c51f2d", 0.1), "rgba(197, 31, 45, 0.1)");
  assert.equal(colorWithAlpha("not-a-color", 0.8), "rgba(0, 0, 0, 0)");

  const commsStart = app.indexOf("// ── Shared Comms presentation");
  const commsEnd = app.indexOf("function InventoryScreen", commsStart);
  assert.ok(commsStart >= 0 && commsEnd > commsStart, "the Comms source range must be locatable");
  assert.doesNotMatch(app.slice(commsStart, commsEnd), /hexA\(T\.border/);
});

test("pointer taps do not leave boxed focus rings on the Comms navigator", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CommsSectionNavigator");
  const end = app.indexOf("function CommsEmptyState", start);
  const source = app.slice(start, end);

  assert.match(source, /event\.detail > 0\) event\.currentTarget\.blur\(\)/);
  assert.match(source, /\[data-comms-section\]:focus-visible/);
  assert.match(source, /box-shadow: inset 0 -3px 0 \$\{T\.primary\}/);
  assert.match(source, /outline: 2px solid \$\{T\.primary\}/);
});
