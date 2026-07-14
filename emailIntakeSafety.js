// Shared timing rule for history imports versus the live email webhook. Recent messages stay on
// the live path so they remain unread and can produce the one real-time lead/bill notification.
export const GMAIL_LIVE_FORWARD_GRACE_MS = 15 * 60 * 1000;

export function shouldDeferToLiveForward(value, now = Date.now()) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return false;
  const age = Number(now) - time;
  return age >= -5 * 60 * 1000 && age < GMAIL_LIVE_FORWARD_GRACE_MS;
}
