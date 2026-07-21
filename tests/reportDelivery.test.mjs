import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { automaticReportChannels, reportEmailUiResult } from "../reportDelivery.js";

test("completed visits send both enabled report channels", () => {
  assert.deepEqual(automaticReportChannels({
    scheduleCfg: { schedulerOn: true, postVisitOn: true },
    hasPhone: true,
    hasEmail: true,
    textAllowed: true,
    emailAllowed: true,
  }), { text: true, email: true });
});

test("automatic report delivery respects the master switch and report opt-out", () => {
  assert.deepEqual(automaticReportChannels({
    scheduleCfg: { schedulerOn: false, postVisitOn: true },
    hasPhone: true,
    hasEmail: true,
  }), { text: false, email: false });

  assert.deepEqual(automaticReportChannels({
    scheduleCfg: { schedulerOn: true, postVisitOn: true },
    hasPhone: true,
    hasEmail: true,
    reportOptOut: true,
  }), { text: false, email: false });
});

test("one unavailable or opted-out channel does not suppress the other", () => {
  assert.deepEqual(automaticReportChannels({
    scheduleCfg: { schedulerOn: true, postVisitOn: true },
    hasPhone: true,
    hasEmail: true,
    textAllowed: false,
    emailAllowed: true,
  }), { text: false, email: true });
});

test("a Test Mode hold is never presented as a successful email", () => {
  assert.deepEqual(reportEmailUiResult({ responseOk: true, held: true, reason: "No redirect email" }), {
    ok: false,
    sent: false,
    held: true,
    text: "Test Mode — report NOT sent. (No redirect email)",
  });
});

test("Resend acceptance is described as accepted, not delivered", () => {
  const result = reportEmailUiResult({
    responseOk: true,
    sent: true,
    recipient: "client@example.com",
    photoCount: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.match(result.text, /accepted for delivery/i);
  assert.doesNotMatch(result.text, /delivered/i);
  assert.match(result.text, /2 photos/);
});

test("Test Mode redirects state exactly where the accepted report went", () => {
  const result = reportEmailUiResult({
    responseOk: true,
    sent: true,
    testModeOn: true,
    liveClient: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.match(result.text, /test email/i);
  assert.match(result.text, /\[TEST\]/);
});

test("completion waits for one automatic delivery and the success screen cannot send duplicate texts", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const completionStart = app.indexOf("function CompleteStopModal");
  const completionEnd = app.indexOf("function StopChangeModal", completionStart);
  const completion = app.slice(completionStart, completionEnd);
  const finishedStart = app.indexOf("function FinishedReportModal");
  const finishedEnd = app.indexOf("function ClientHistory", finishedStart);
  const finished = app.slice(finishedStart, finishedEnd);

  assert.match(completion, /await Promise\.allSettled\(sends\)/);
  assert.match(completion, /const result = await sendServiceReportEmail/);
  assert.match(completion, /setReportPlan\(plan\)/);
  assert.match(completion, /appendClientLinks\(short, \{ target: "reports"/);
  assert.match(completion, /app: !!\(client\?\.id != null && commPref\(client, "app"\)/);
  assert.match(completion, /if \(plan\.app\) sends\.push\(sendPortalReport\(\)\)/);
  assert.match(completion, /This screen did not send another report/);
  assert.doesNotMatch(completion, />Text Report</);
  assert.doesNotMatch(completion, /Text this recap/);
  assert.doesNotMatch(completion, /textAiRecap|genRecap/);
  assert.match(completion, /Internal only — nothing here is sent to the client/);
  assert.match(completion, /const runWaterCheck = async/);
  assert.match(finished, /saved report resend/);
  assert.match(finished, /Email report/);
});
