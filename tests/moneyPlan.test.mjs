import test from "node:test";
import assert from "node:assert/strict";

const {
  providerFailureMeta, chooseProfitBasis, classifyPlanStatus, planMessage, planSignature, shouldSuppressUnchangedPlan,
  recipientSignature, deliverySignature, claimMoneyPlanDeliveries, finalizeMoneyPlanDeliveries,
} = await import("../api/transfer-nudge.js");

const et = { ym: "2026-07", y: 2026, m: 7, day: 17 };
const basePlan = {
  et,
  bank: { status: "current", income: 8400, expense: 5100, profit: 3300, currentCount: 24, lastDate: "2026-07-17" },
  planned: { configured: true, income: 12000, expense: 6900, profit: 5100 },
  taxes: 400,
  taxesPlanned: false,
  payroll: { remaining: 600, runsLeft: 1, next: "7/24", amount: 600 },
  debtRemaining: 150,
  goalsMonthly: 100,
  total: 1250,
  config: { tax: true, payroll: true, debt: true, goals: true },
};

const assertSingleSms = (message) => {
  assert.ok(message.length <= 160, `SMS is ${message.length} characters: ${message}`);
  assert.match(message, /^[\x20-\x7E]+$/, "SMS must stay GSM/ASCII-safe");
};

test("provider failures retry only a definitive rate-limit rejection", () => {
  assert.deepEqual(providerFailureMeta(429), { retryable: true });
  assert.deepEqual(providerFailureMeta(500), { uncertain: true });
  assert.deepEqual(providerFailureMeta(503), { uncertain: true });
  assert.deepEqual(providerFailureMeta(400), { retryable: false });
});

test("money plan uses planned profit when a connected bank has no current activity", () => {
  assert.deepEqual(chooseProfitBasis({ status: "no_current_activity", currentCount: 0, profit: 0 }, 5100), { profit: 5100, planned: true });
  assert.deepEqual(chooseProfitBasis({ status: "current", currentCount: 8, profit: -900 }, 5100), { profit: 0, planned: false });
});

test("actionable money plan is a reserve target and cannot prompt a duplicate transfer", () => {
  const message = planMessage({ ...basePlan, status: "actionable" });
  assert.match(message, /reserve target \$1,250/i);
  assert.match(message, /tax \$400/);
  assert.match(message, /do not transfer twice/i);
  assert.doesNotMatch(message, /move it/i);
  assertSingleSms(message);
});

test("zero plan never claims unconfigured categories are covered", () => {
  const message = planMessage({
    ...basePlan,
    status: "setup",
    bank: { status: "no_current_activity", income: 0, expense: 0, profit: 0, currentCount: 0 },
    taxes: 0, payroll: { remaining: 0 }, debtRemaining: 0, goalsMonthly: 0, total: 0,
    config: { tax: true, payroll: false, debt: false, goals: false },
  });
  assert.match(message, /needs setup/i);
  assert.doesNotMatch(message, /taxes, payroll, debts, and goals are covered|Nice/i);
  assertSingleSms(message);
});

test("negative cash flow text includes the evidence and a next action", () => {
  const message = planMessage({
    ...basePlan,
    status: "negative_cashflow", total: 0, taxes: 0,
    payroll: { remaining: 0 }, debtRemaining: 0, goalsMonthly: 0,
    bank: { status: "current", income: 3100, expense: 4250, profit: -1150, currentCount: 18 },
  });
  assert.match(message, /in \$3,100, out \$4,250, net -\$1,150/i);
  assert.match(message, /review cash and bills/i);
  assertSingleSms(message);
});

test("negative actual cash flow outranks outstanding commitments", () => {
  const bank = { status: "current", income: 3100, expense: 4250, profit: -1150, currentCount: 18 };
  const status = classifyPlanStatus({
    bank, total: 900, commitments: 900, plannedProfit: 5100,
    plannedConfigured: true, configuredObligations: true, verifiedCovered: false,
  });
  assert.equal(status, "cash_shortfall");
  const message = planMessage({
    ...basePlan, status, bank, taxes: 0, total: 900, commitments: 900,
    payroll: { remaining: 600 }, debtRemaining: 200, goalsMonthly: 100,
  });
  assert.match(message, /net -\$1,150/i);
  assert.match(message, /payroll \$600, debt \$200, goals \$100/i);
  assert.match(message, /check cash first/i);
  assert.doesNotMatch(message, /reserve target \$900/i);
  assertSingleSms(message);
});

test("unavailable plan recommends no money action", () => {
  const message = planMessage({ ...basePlan, status: "unavailable", total: 0 });
  assert.match(message, /data could not load/i);
  assert.match(message, /No money action is recommended/i);
  assert.doesNotMatch(message, /refresh Bank Sync/i);
  assertSingleSms(message);
});

test("planned fallback identifies why live bank figures were not used", () => {
  for (const [bankStatus, expected] of [
    ["unavailable", /Bank Sync is unavailable/i],
    ["not_connected", /Bank Sync is not connected/i],
    ["no_current_activity", /No current bank activity/i],
  ]) {
    const message = planMessage({
      ...basePlan, status: "planned_target", taxesPlanned: true,
      bank: { status: bankStatus }, payroll: { remaining: 0 }, debtRemaining: 0,
      goalsMonthly: 0, commitments: 0, taxes: 1600, total: 1600,
    });
    assert.match(message, expected);
    assert.match(message, /Planned (?:reserve )?target \$1,600/i);
    assert.match(message, /before moving money/i);
    assertSingleSms(message);
  }
});

test("tight planned and actual-zero states remain useful and single-segment", () => {
  const actualStatus = classifyPlanStatus({
    bank: { status: "current", profit: 2200, currentCount: 12 }, total: 0, commitments: 0,
    plannedProfit: 5100, plannedConfigured: true, configuredObligations: false, verifiedCovered: false,
  });
  assert.equal(actualStatus, "no_reserve_actual");
  const actual = planMessage({
    ...basePlan, status: actualStatus, total: 0, taxes: 0, commitments: 0,
    payroll: { remaining: 0 }, debtRemaining: 0, goalsMonthly: 0,
  });
  assert.match(actual, /Jul MTD in \$8,400, out \$5,100, net \$3,300/i);
  assert.doesNotMatch(actual, /Budget: in \$12,000/i);
  assertSingleSms(actual);

  const plannedStatus = classifyPlanStatus({
    bank: { status: "no_current_activity", profit: 0, currentCount: 0 }, total: 900, commitments: 900,
    plannedProfit: -500, plannedConfigured: true, configuredObligations: true, verifiedCovered: false,
  });
  assert.equal(plannedStatus, "planned_shortfall");
  const planned = planMessage({
    ...basePlan, status: plannedStatus, total: 900, commitments: 900, taxes: 0,
    planned: { configured: true, income: 5000, expense: 5500, profit: -500 },
    payroll: { remaining: 600 }, debtRemaining: 200, goalsMonthly: 100,
  });
  assert.match(planned, /budgeted net -\$500/i);
  assert.match(planned, /targets total \$900/i);
  assert.match(planned, /check available cash/i);
  assertSingleSms(planned);
});

test("positive but insufficient actual and planned profit trigger a cash warning", () => {
  const actualBank = { status: "current", profit: 500, currentCount: 12 };
  assert.equal(classifyPlanStatus({
    bank: actualBank, total: 2400, commitments: 2200, plannedProfit: 5100,
    plannedConfigured: true, configuredObligations: true, verifiedCovered: false,
  }), "cash_tight");
  const actual = planMessage({
    ...basePlan, status: "cash_tight", total: 2400, commitments: 2200, taxes: 200,
    bank: { ...actualBank, income: 5000, expense: 4500 },
    payroll: { remaining: 1800 }, debtRemaining: 300, goalsMonthly: 100,
  });
  assert.match(actual, /MTD net \$500/i);
  assert.match(actual, /targets total \$2,400/i);
  assert.match(actual, /check available cash/i);
  assertSingleSms(actual);

  const plannedBank = { status: "no_current_activity", profit: 0, currentCount: 0 };
  assert.equal(classifyPlanStatus({
    bank: plannedBank, total: 2400, commitments: 2200, plannedProfit: 500,
    plannedConfigured: true, configuredObligations: true, verifiedCovered: false,
  }), "planned_shortfall");
  const planned = planMessage({
    ...basePlan, status: "planned_shortfall", total: 2400, commitments: 2200, taxes: 200,
    planned: { configured: true, income: 5000, expense: 4500, profit: 500 },
    payroll: { remaining: 1800 }, debtRemaining: 300, goalsMonthly: 100,
  });
  assert.match(planned, /budgeted net \$500/i);
  assert.match(planned, /targets total \$2,400/i);
  assert.match(planned, /check (?:available )?cash/i);
  assertSingleSms(planned);
});

test("verified-covered and planned-zero states stay specific and single-segment", () => {
  const covered = planMessage({ ...basePlan, status: "covered", total: 0 });
  const plannedZero = planMessage({
    ...basePlan, status: "no_reserve", total: 0, taxes: 0, taxesPlanned: true,
    payroll: { remaining: 0 }, debtRemaining: 0, goalsMonthly: 0,
  });
  assert.match(covered, /recorded debt and goal targets are covered/i);
  assert.match(covered, /Tax reserves are not tracked as paid/i);
  assert.match(plannedZero, /Budget: in \$12,000, out \$6,900, net \$5,100/i);
  assertSingleSms(covered);
  assertSingleSms(plannedZero);
});

test("unchanged monthly plan is suppressed until its rounded substance changes", () => {
  const plan = { ...basePlan, status: "actionable" };
  const signature = planSignature(plan);
  assert.equal(shouldSuppressUnchangedPlan({ month: "2026-07", signature }, plan), true);
  assert.equal(shouldSuppressUnchangedPlan({ month: "2026-06", signature }, plan), false);
  assert.equal(shouldSuppressUnchangedPlan({ month: "2026-07", signature }, { ...plan, taxes: 525, total: 1375 }), false);
});

test("dedupe signature follows exact visible text rather than hidden bank activity", () => {
  const plan = { ...basePlan, status: "actionable" };
  const netNeutralChange = {
    ...plan,
    bank: { ...plan.bank, income: plan.bank.income + 500, expense: plan.bank.expense + 500, currentCount: plan.bank.currentCount + 2 },
  };
  assert.equal(planMessage(plan), planMessage(netNeutralChange));
  assert.equal(planSignature(plan), planSignature(netNeutralChange));
});

test("delivery signature is channel- and recipient-aware without storing the recipient", () => {
  const secret = "test-secret";
  const smsA = deliverySignature(basePlan, "sms", "+1 (484) 555-0100", planMessage(basePlan), secret);
  const smsSame = deliverySignature(basePlan, "sms", "484-555-0100", planMessage(basePlan), secret);
  const smsB = deliverySignature(basePlan, "sms", "484-555-0101", planMessage(basePlan), secret);
  const email = deliverySignature(basePlan, "email", "owner@example.com", planMessage(basePlan), secret);
  assert.equal(smsA, smsSame);
  assert.notEqual(smsA, smsB);
  assert.notEqual(smsA, email);
  assert.doesNotMatch(smsA, /484|555|0100/);
  assert.equal(
    recipientSignature("sms", "+1 (484) 555-0100", secret),
    recipientSignature("sms", "484-555-0100", secret),
  );
});

test("atomic claims prevent overlapping cron invocations from owning the same delivery", () => {
  const jobA = { channel: "sms", key: "delivery-a", token: "claim-a" };
  const first = claimMoneyPlanDeliveries({}, [jobA], {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.equal(first.changed, true);
  assert.deepEqual(first.claimed, ["sms"]);

  const jobB = { ...jobA, token: "claim-b" };
  const second = claimMoneyPlanDeliveries(first.value, [jobB], {
    nowIso: "2026-07-17T12:00:01.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.claimed, []);
  assert.equal(second.value.deliveries["delivery-a"].token, "claim-a");
});

test("partial channel failure retries only the failed channel", () => {
  const jobs = [
    { channel: "sms", key: "sms-key", token: "batch:sms" },
    { channel: "email", key: "email-key", token: "batch:email" },
  ];
  const claimed = claimMoneyPlanDeliveries({}, jobs, {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  const finalized = finalizeMoneyPlanDeliveries(claimed.value, jobs, {
    sms: { ok: true }, email: { ok: false, retryable: true },
  }, {
    nowIso: "2026-07-17T12:00:10.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a", status: "planned_target",
  });
  assert.equal(finalized.value.deliveries["sms-key"].state, "sent");
  assert.equal(finalized.value.deliveries["email-key"].state, "failed");

  const retryJobs = jobs.map((job) => ({ ...job, token: `retry:${job.channel}` }));
  const retried = claimMoneyPlanDeliveries(finalized.value, retryJobs, {
    nowIso: "2026-07-17T13:00:11.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.equal(retried.changed, true);
  assert.deepEqual(retried.claimed, ["email"]);
  assert.equal(retried.value.deliveries["sms-key"].state, "sent");
});

test("a changed recipient gets a new claim while legacy same-day sends remain protected", () => {
  const oldJob = { channel: "sms", key: "recipient-old", token: "old-token", recipientKey: "old-recipient" };
  const oldClaim = claimMoneyPlanDeliveries({}, [oldJob], {
    nowIso: "2026-07-16T12:00:00.000Z", sendDate: "07/16/2026", month: "2026-07", planSignature: "plan-a",
  });
  const oldSent = finalizeMoneyPlanDeliveries(oldClaim.value, [oldJob], { sms: { ok: true } }, {
    nowIso: "2026-07-16T12:00:05.000Z", sendDate: "07/16/2026", month: "2026-07", planSignature: "plan-a", status: "planned_target",
  });
  const newJob = { channel: "sms", key: "recipient-new", token: "new-token", recipientKey: "new-recipient" };
  const changedRecipient = claimMoneyPlanDeliveries(oldSent.value, [newJob], {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.deepEqual(changedRecipient.claimed, ["sms"]);

  const legacy = claimMoneyPlanDeliveries({ sent: "07/17/2026" }, [newJob], {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.equal(legacy.changed, false);
  assert.deepEqual(legacy.claimed, []);
});

test("a changed target cannot send twice to the same recipient on one scheduled day", () => {
  const firstJob = { channel: "sms", key: "message-one", token: "one", recipientKey: "same-recipient" };
  const firstClaim = claimMoneyPlanDeliveries({}, [firstJob], {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-one",
  });
  const firstSent = finalizeMoneyPlanDeliveries(firstClaim.value, [firstJob], { sms: { ok: true } }, {
    nowIso: "2026-07-17T12:00:05.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-one", status: "planned_target",
  });
  const updatedJob = { channel: "sms", key: "message-two", token: "two", recipientKey: "same-recipient" };
  const duplicateDay = claimMoneyPlanDeliveries(firstSent.value, [updatedJob], {
    nowIso: "2026-07-17T15:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-two",
  });
  assert.equal(duplicateDay.changed, false);
  assert.deepEqual(duplicateDay.claimed, []);
});

test("an ambiguous provider result is never retried automatically", () => {
  const job = { channel: "sms", key: "ambiguous", token: "first", recipientKey: "recipient" };
  const claimed = claimMoneyPlanDeliveries({}, [job], {
    nowIso: "2026-07-17T12:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a",
  });
  const finalized = finalizeMoneyPlanDeliveries(claimed.value, [job], { sms: { ok: false, uncertain: true } }, {
    nowIso: "2026-07-17T12:00:30.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-a", status: "planned_target",
  });
  assert.equal(finalized.value.deliveries.ambiguous.state, "uncertain");
  const retry = claimMoneyPlanDeliveries(finalized.value, [{ ...job, token: "second" }], {
    nowIso: "2026-07-18T12:00:00.000Z", sendDate: "07/18/2026", month: "2026-07", planSignature: "plan-a",
  });
  assert.equal(retry.changed, false);

  const changedPayload = claimMoneyPlanDeliveries(finalized.value, [{
    channel: "sms", key: "ambiguous-new-payload", token: "third", recipientKey: "recipient",
  }], {
    nowIso: "2026-07-17T15:00:00.000Z", sendDate: "07/17/2026", month: "2026-07", planSignature: "plan-b",
  });
  assert.equal(changedPayload.changed, false);
  assert.deepEqual(changedPayload.claimed, []);
});
