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
  assert.match(source, /aria-label="Mail search and compose"/);
  assert.match(source, /placeholder=\{folder === "inbox" \? "Search inbox" : "Search sent"\}/);
  assert.match(source, /label: "All channels"/);
  assert.match(source, /quiet touch/);
  assert.match(source, /!phone && <div[\s\S]*?\{folderBar\}/);
  assert.doesNotMatch(app, /function CommsMailBottomBar/);
  assert.doesNotMatch(source, /<CommsMailBottomBar/);
});
