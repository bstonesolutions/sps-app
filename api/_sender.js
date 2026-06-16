// api/_sender.js  (underscore-prefixed → helper, not an HTTP route)
// Shared "sending identity" resolver. The app may pass a custom from name/address;
// we only honor it when its domain is VERIFIED in Resend (i.e. matches the env
// RESEND_FROM domain), so a bad/unverified address can never silently break sending
// — it falls back to the configured default instead.
const ENV_FROM = process.env.RESEND_FROM || "Stone Property Solutions <noreply@stonepropertysolutions.com>";
export const VERIFIED_DOMAIN = ((ENV_FROM.match(/@([^>\s]+)/) || [])[1] || "stonepropertysolutions.com").toLowerCase();

// Returns a Resend "from" header string. Honors body.fromName/body.fromAddress only
// when the address is on the verified domain; otherwise returns the fallback (env default).
export function resolveFrom(body, fallback) {
  const fb = fallback || ENV_FROM;
  const name = String((body && body.fromName) || "").trim();
  const addr = String((body && body.fromAddress) || "").trim();
  if (addr && addr.includes("@")) {
    const domain = addr.split("@").pop().toLowerCase();
    if (domain === VERIFIED_DOMAIN) return name ? `${name} <${addr}>` : addr;
  }
  return fb;
}
