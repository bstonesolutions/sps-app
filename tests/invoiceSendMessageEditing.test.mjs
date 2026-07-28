import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const loadInvoiceSendStep = async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function InvoiceSendStep");
  const end = app.indexOf("function InvoiceEditor", start);
  assert.ok(start >= 0 && end > start, "InvoiceSendStep should remain a focused component");
  return app.slice(start, end);
};

test("all three invoice delivery channels expose controlled per-send message drafts", async () => {
  const source = await loadInvoiceSendStep();

  assert.match(source, /const \[smsMsg, setSmsMsg\]\s*=\s*useState/);
  assert.match(source, /value=\{smsMsg\}[\s\S]*?onChange=\{[^}]*setSmsMsg/);

  assert.match(source, /const \[chatMsg, setChatMsg\]\s*=\s*useState/);
  assert.match(source, /value=\{chatMsg\}[\s\S]*?onChange=\{[^}]*setChatMsg/);

  assert.match(source, /const \[emailSubject, setEmailSubject\]\s*=\s*useState/);
  assert.match(source, /value=\{emailSubject\}[\s\S]*?onChange=\{[^}]*setEmailSubject/);
  assert.match(source, /const \[emailIntro, setEmailIntro\]\s*=\s*useState/);
  assert.match(source, /value=\{emailIntro\}[\s\S]*?onChange=\{[^}]*setEmailIntro/);
});

test("invoice delivery sends the edited drafts instead of rebuilding the defaults", async () => {
  const source = await loadInvoiceSendStep();

  assert.match(source, /sendSms\(phone,\s*outgoingSms/);
  assert.match(source, /body:\s*chatMsg/);
  assert.match(source, /emailSubject:\s*emailSubject/);
  assert.match(source, /emailIntro:\s*emailIntro/);
});

test("typing does not remount the active invoice message field", async () => {
  const source = await loadInvoiceSendStep();

  // A component type declared inside InvoiceSendStep receives a new function identity on every
  // keystroke. React consequently unmounts its textarea and focus is lost after the first
  // character. Channel rows must use a stable top-level component or an ordinary render helper.
  assert.doesNotMatch(source, /const Row\s*=\s*\(/);
  assert.doesNotMatch(source, /<Row\b/);
});

test("invoice message fields remain usable when the iOS keyboard changes the viewport", async () => {
  const source = await loadInvoiceSendStep();

  // The delivery form must live in the modal's own scroll surface and its fields should
  // explicitly request visibility on focus. This protects the editor from being trapped
  // beneath the iOS keyboard without coupling the test to a particular visual layout.
  assert.match(source, /data-invoice-send-editor/);
  assert.match(source, /onFocus=\{keepFocusedControlVisible\}/);
});
