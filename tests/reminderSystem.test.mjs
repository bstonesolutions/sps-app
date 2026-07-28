import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { reminderSystemEnabled } from "../reminderSystem.js";

test("the reminders master switch fails closed and only accepts boolean true", () => {
  assert.equal(reminderSystemEnabled(), false);
  assert.equal(reminderSystemEnabled({}), false);
  assert.equal(reminderSystemEnabled({ remindersMasterOn: false }), false);
  assert.equal(reminderSystemEnabled({ remindersMasterOn: "true" }), false);
  assert.equal(reminderSystemEnabled({ remindersMasterOn: 1 }), false);
  assert.equal(reminderSystemEnabled({ remindersMasterOn: true }), true);
});

test("all three reminder queue builders use the shared master switch", async () => {
  const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const appointment = source.match(/function buildReminderQueue[\s\S]*?\n}\n\n\/\/ ── Payment reminders/);
  const payment = source.match(/function buildInvoiceReminderQueue[\s\S]*?\n}\n\n\/\/ Seasonal reminders/);
  const seasonal = source.match(/function buildSeasonalQueue[\s\S]*?\n}\n\n\/\/ Total stock/);

  assert.match(appointment?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.match(appointment?.[0] || "", /!cfg\.remindersOn/);
  assert.match(payment?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.match(payment?.[0] || "", /!cfg\.paymentNudgeOn/);
  assert.match(seasonal?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.doesNotMatch(seasonal?.[0] || "", /!cfg\.remindersOn/);
});

test("the server cron gates appointment, payment, and seasonal collectors but leaves win-back independent", async () => {
  const source = await readFile(new URL("../api/cron-automations.js", import.meta.url), "utf8");
  const appointment = source.match(/function collectAppointments[\s\S]*?\n}\nfunction collectSeasonal/);
  const seasonal = source.match(/function collectSeasonal[\s\S]*?\n}\nfunction collectPaymentNudges/);
  const payment = source.match(/function collectPaymentNudges[\s\S]*?\n}\nfunction collectWinBack/);
  const winBack = source.match(/function collectWinBack[\s\S]*?\n}\n\n\/\/ ── handler/);

  assert.match(appointment?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.match(seasonal?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.doesNotMatch(seasonal?.[0] || "", /!cfg\.remindersOn/);
  assert.match(payment?.[0] || "", /reminderSystemEnabled\(cfg\)/);
  assert.doesNotMatch(winBack?.[0] || "", /reminderSystemEnabled\(cfg\)/);
});

test("the Reminders settings keep a dedicated preserved-state master switch", async () => {
  const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(source, /remindersMasterOn:\s*false/);
  assert.match(source, /setCfg\("remindersMasterOn", v\)/);
  assert.match(source, /Your setup stays saved for when you turn this back on/);
  assert.match(source, /Reports, invoices, normal texts, On My Way messages, and other app features are unaffected/);
});

test("a cross-device pause closes stale reminder review state and blocks a stale send", async () => {
  const source = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const screen = source.match(/function RemindersScreen[\s\S]*?\n}\n\n\/\/ ── Comms hub/);
  const body = screen?.[0] || "";
  const pauseGuard = body.indexOf("if (!remindersEnabled)");
  const sendCall = body.indexOf("await sendSms");

  assert.ok(pauseGuard >= 0, "RemindersScreen should guard the stale review when paused");
  assert.ok(sendCall > pauseGuard, "the pause guard must run before sendSms");
  assert.match(body, /if \(!remindersEnabled && review\)[\s\S]*?setReview\(null\)/);
});
