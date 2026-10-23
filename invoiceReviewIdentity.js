// The reviewed invoice is the canonical stored record, without table-only
// enrichments. Browser and server hash this identical key-sorted JSON.
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function stableInvoiceReviewJSON(invoice) {
  return JSON.stringify(canonical(invoice));
}

// Excluding only the checksum itself avoids a recursive checksum while still
// protecting every invoice field and the original reviewed-request identity.
export function stableInvoiceReviewResultJSON(invoice) {
  if (!object(invoice?.qbReviewResolution)) return stableInvoiceReviewJSON(invoice);
  const resolution = { ...invoice.qbReviewResolution };
  delete resolution.confirmedResultHash;
  return stableInvoiceReviewJSON({ ...invoice, qbReviewResolution: resolution });
}

export async function invoiceReviewHash(invoice, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new Error("This device could not verify the invoice review. Reopen the app and try again.");
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(stableInvoiceReviewJSON(invoice)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
