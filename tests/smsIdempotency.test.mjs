import test from "node:test";
import assert from "node:assert/strict";
import {
  claimSmsReceiptValue,
  finalizeSmsReceiptValue,
  normalizeSmsIdempotencyKey,
  smsReceiptKey,
  smsRequestFingerprint,
} from "../api/_sms-idempotency.js";

const claimInput = {
  receiptKey: smsReceiptKey("arrival:stop-1:sms"),
  requestHash: smsRequestFingerprint({ line: "automation", from: "+15550001111", to: "+15550002222", clientId: "client-1", content: "We arrived" }),
  token: "claim-token-1",
  nowIso: "2026-07-20T14:00:00.000Z",
};

test("arrival idempotency keys are narrowly scoped", () => {
  assert.equal(normalizeSmsIdempotencyKey("arrival:route%201:sms", "On site"), "arrival:route%201:sms");
  assert.throws(() => normalizeSmsIdempotencyKey("arrival:route%201:sms", "On my way"), /scope/);
  assert.throws(() => normalizeSmsIdempotencyKey("broadcast:anything:sms", "On site"), /key/);
});

test("one claim wins and accepted replays cannot claim again", () => {
  const claimed = claimSmsReceiptValue(undefined, claimInput);
  assert.equal(claimed.changed, true);
  assert.equal(claimed.outcome, "claimed");

  const overlap = claimSmsReceiptValue(claimed.value, { ...claimInput, token: "claim-token-2" });
  assert.equal(overlap.changed, false);
  assert.equal(overlap.outcome, "sending");

  const accepted = finalizeSmsReceiptValue(claimed.value, {
    ...claimInput,
    state: "accepted",
    providerId: "quo-message-1",
    nowIso: "2026-07-20T14:00:01.000Z",
  });
  assert.equal(accepted.changed, true);
  assert.equal(accepted.receipt.providerId, "quo-message-1");
  const replay = claimSmsReceiptValue(accepted.value, { ...claimInput, token: "claim-token-3" });
  assert.equal(replay.changed, false);
  assert.equal(replay.outcome, "accepted");
});

test("changed request details conflict and ambiguous delivery stays terminal", () => {
  const claimed = claimSmsReceiptValue(undefined, claimInput);
  const mismatch = claimSmsReceiptValue(claimed.value, { ...claimInput, requestHash: "different", token: "claim-token-2" });
  assert.equal(mismatch.outcome, "mismatch");

  const uncertain = finalizeSmsReceiptValue(claimed.value, {
    ...claimInput,
    state: "uncertain",
    nowIso: "2026-07-20T14:00:01.000Z",
  });
  const replay = claimSmsReceiptValue(uncertain.value, { ...claimInput, token: "claim-token-3" });
  assert.equal(replay.outcome, "uncertain");
  assert.equal(replay.changed, false);
});

test("the durable ledger stores no raw stop, client, phone, or message", () => {
  const claimed = claimSmsReceiptValue(undefined, claimInput);
  const wire = JSON.stringify(claimed.value);
  for (const secret of ["stop-1", "client-1", "+15550001111", "+15550002222", "We arrived"]) {
    assert.equal(wire.includes(secret), false);
  }
  assert.match(wire, /requestHash/);
});

test("a malformed existing ledger fails closed instead of being reset", () => {
  assert.throws(() => claimSmsReceiptValue({ schema: 999, receipts: {} }, claimInput), /ledger_invalid/);
});
