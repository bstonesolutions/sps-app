const MESSAGE_ID_LOCAL = /^[A-Za-z0-9._%+\-/=]+$/;
const MESSAGE_ID_DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

// Gmail's raw-search syntax is powerful. Only interpolate the common, generated Message-ID shape
// we expect from Gmail/Resend; unusual RFC forms safely fall back to envelope/date matching.
export function safeGmailMessageId(value) {
  const raw = String(value || "").trim();
  const unwrapped = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  if (!unwrapped || unwrapped.length > 300 || /[\s"'\\(){}\[\]<>:]/.test(unwrapped)) return "";
  const pieces = unwrapped.split("@");
  if (pieces.length !== 2 || !MESSAGE_ID_LOCAL.test(pieces[0]) || !MESSAGE_ID_DOMAIN.test(pieces[1])) return "";
  return unwrapped;
}

// IMAP SEARCH returns ascending UIDs. Recurring senders can have hundreds of identical subjects,
// so inspect the newest bounded window rather than silently dropping the current message.
export function newestGmailCandidateUids(values, limit = 60) {
  return (Array.isArray(values) ? values : [])
    .slice()
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, Math.max(0, limit));
}

const envelopeSender = (envelope) => String(envelope?.from?.[0]?.address || "").trim().toLowerCase();

// Fallback matching is deliberately strict: exact sender + exact subject + a close arrival time.
// Read/unread accepts only one candidate. Trash may choose the unique nearest candidate because the
// operation is user-confirmed and recoverable, but an exact tie still fails closed.
export function chooseGmailFallbackCandidate(row, candidates, { allowNearest = false, maxDeltaMs = 2 * 60 * 60 * 1000 } = {}) {
  const wantedSubject = String(row?.subject || "").trim();
  const wantedSender = String(row?.from_email || "").trim().toLowerCase();
  const wantedTime = Date.parse(String(row?.created_at || ""));
  if (!wantedSubject || !wantedSender || !Number.isFinite(wantedTime)) return { uid: null, reason: "not-matchable" };

  const exact = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => String(candidate?.envelope?.subject || "").trim() === wantedSubject && envelopeSender(candidate?.envelope) === wantedSender)
    .map(candidate => ({ uid: candidate.uid, delta: Math.abs(new Date(candidate.internalDate).getTime() - wantedTime) }))
    .filter(candidate => candidate.uid != null && Number.isFinite(candidate.delta) && candidate.delta <= maxDeltaMs)
    .sort((a, b) => a.delta - b.delta);

  if (exact.length === 1) return { uid: exact[0].uid, reason: "fallback-exact" };
  if (allowNearest && exact.length > 1 && exact[0].delta < exact[1].delta) return { uid: exact[0].uid, reason: "fallback-nearest" };
  return { uid: null, reason: exact.length ? "ambiguous-match" : "not-found" };
}
