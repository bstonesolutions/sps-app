import { parseSmsTestRedirect } from "./smsConversations.js";

const FAILURE_PATTERN = /(?:^|[_\s-])(fail(?:ed|ure)?|error|undeliver(?:ed|able)?|reject(?:ed|ion)?|bounce(?:d)?)(?:$|[_\s-])/i;
const LOW_SIGNAL_SMS_PATTERN = /^(?:k|ok(?:ay)?|cool|great|perfect|awesome|sounds good|got it|all good|no worries|thanks?(?:\s+(?:you|so much))?|thank you(?:\s+so much)?)[.!\s\u{1F300}-\u{1FAFF}]*$/iu;
const RESOLVED_GRATITUDE_PATTERN = /^(?:well\s+)?thank(?:s| you)[.!]?\s+(?:all set|all good|much better|perfect|sounds good|that works|we(?:'re| are) good)(?:\s+now)?[.!\s\u{1F300}-\u{1FAFF}]*$/iu;
const BILL_ACTION_PATTERN = /\b(?:action required|amount due|balance due|bill (?:attached|due|ready)|card (?:declined|expired)|charge (?:declined|failed)|invoice (?:attached|due|ready)|new (?:bill|invoice|payment request)|not paid|overdue|past due|payment (?:declined|due|failed|required)|payment request|renewal (?:due|failed)|requires? (?:attention|payment)|unpaid|due (?:by|in|on|soon|today|tomorrow))\b/i;
const BILL_ROUTINE_PATTERN = /\b(?:confirmation|confirmed|order confirmed|paid|payment (?:confirmed|processed|received|scheduled)|payroll confirmed|plan confirmation|receipt|successfully processed)\b/i;

function normalized(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function rowFailed(row) {
  if (!row || typeof row !== "object") return false;
  if (row.ok === false || row.delivery_failed === true || row.failed === true) return true;
  const statuses = [
    row.sms_status,
    row.delivery_status,
    row.status,
    row.ai?.smsStatus,
    row.ai?.deliveryStatus,
  ];
  return statuses.some((status) => FAILURE_PATTERN.test(normalized(status)));
}

function isSmsRow(row) {
  return normalized(row?.channel) === "sms" || row?._smsConversation === true;
}

function isTestRedirect(row) {
  if (row?._isTestRedirect === true || row?.ai?.testRedirected === true) return true;
  if (parseSmsTestRedirect(row?.body_text)) return true;
  return normalized(row?.sms_status).includes("test_redirect");
}

function latestSmsDirection(row) {
  const direction = normalized(row?._lastDirection || row?.sms_direction || row?._smsDirection || row?.direction);
  return ["outgoing", "sent", "delivered"].includes(direction) ? "outgoing" : "incoming";
}

function latestSmsBody(row) {
  const messages = Array.isArray(row?._smsMessages) ? row._smsMessages : [];
  const latest = messages.length ? messages[messages.length - 1] : row;
  return String(latest?.body_text || row?.body_text || "").trim();
}

function isLowSignalSms(row) {
  const body = latestSmsBody(row);
  if (!body) return true;
  if (LOW_SIGNAL_SMS_PATTERN.test(body)) return true;
  // A clearly resolved gratitude reply belongs in history. Gratitude followed by a complaint or
  // request remains actionable, as do short yes/no answers that may authorize work.
  if (RESOLVED_GRATITUDE_PATTERN.test(body)) return true;
  return false;
}

function billNeedsAction(row) {
  const text = [row?.subject, row?.body_text, row?.ai?.summary].map(value => String(value || "")).join(" ");
  if (!text.trim()) return false;
  const explicitProblem = /(?:action required|declined|failed|not paid|overdue|past due|unpaid)/i.test(text);
  if (BILL_ROUTINE_PATTERN.test(text) && !explicitProblem) return false;
  const bill = row?.ai?.bill && typeof row.ai.bill === "object" ? row.ai.bill : {};
  const hasStructuredBill = [bill.amount, bill.dueDate].some(value => String(value || "").trim());
  if (hasStructuredBill || BILL_ACTION_PATTERN.test(text)) return true;
  return /\b(?:bill|invoice|statement)\b/i.test(String(row?.subject || ""));
}

/**
 * Return the one business reason a grouped inbox row still needs attention.
 *
 * The caller must group raw SMS messages first. That makes an unanswered conversation one work
 * item instead of one badge for every message while leaving the underlying history untouched.
 */
export function actionableCommsReason(row) {
  if (!row || typeof row !== "object") return "";

  if (isSmsRow(row)) {
    // Test Mode echoes are outgoing audit history, not customer work. A genuine delivery failure
    // remains visible even when the failed message was outgoing.
    if (isTestRedirect(row)) return "";
    if (rowFailed(row)) return "failure";
    return latestSmsDirection(row) === "incoming" && !isLowSignalSms(row) ? "text" : "";
  }

  if (rowFailed(row)) return "failure";

  const kind = normalized(row.kind);
  const linkedLead = String(row.lead_id == null ? "" : row.lead_id).trim();
  if (kind === "lead" && !linkedLead) return "lead";
  if (row.read === true) return "";
  if (kind === "bill" && billNeedsAction(row)) return "bill";
  if (kind === "client") return "client";
  return "";
}

export function selectActionableCommsRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !!actionableCommsReason(row));
}

export function summarizeActionableCommsRows(rows) {
  const counts = {
    total: 0,
    texts: 0,
    leads: 0,
    bills: 0,
    clients: 0,
    failures: 0,
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const reason = actionableCommsReason(row);
    if (!reason) continue;
    counts.total += 1;
    if (reason === "text") counts.texts += 1;
    else if (reason === "lead") counts.leads += 1;
    else if (reason === "bill") counts.bills += 1;
    else if (reason === "client") counts.clients += 1;
    else if (reason === "failure") counts.failures += 1;
  }

  return counts;
}
