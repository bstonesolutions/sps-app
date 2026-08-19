import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../api/send-invoice.js", import.meta.url), "utf8");

test("invoice email delivery requires the server-side invoiceSend capability", () => {
  assert.match(source, /import\s*\{\s*requireCapability\s*\}\s*from\s*["']\.\/_staff-auth\.js["']/);
  assert.match(
    source,
    /requireCapability\(req,\s*res,\s*["']invoiceSend["'],\s*["']sending invoices["']\)/,
  );
  assert.doesNotMatch(source, /requireUser\(req,\s*res\)/);
});
