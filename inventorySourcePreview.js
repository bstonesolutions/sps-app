const PRACTICAL_GARDEN_PONDS_HOSTS = new Set([
  "practicalgardenponds.com",
  "www.practicalgardenponds.com",
]);
const PRACTICAL_GARDEN_PONDS_IMAGE_HOSTS = new Set([
  ...PRACTICAL_GARDEN_PONDS_HOSTS,
  "cdn.shopify.com",
]);

export const INVENTORY_SOURCE_PREVIEW_URL_MAX_LENGTH = 2048;

const invalidSource = (code, error) => ({
  valid: false,
  code,
  error,
  handle: "",
  canonicalUrl: "",
  apiUrl: "",
});

// This validator is deliberately narrower than the supplier-link validator used by the UI.
// A saved supplier link may point anywhere the owner shops, but the server must never fetch an
// arbitrary address. For this first adapter, only a public Practical Garden Ponds Shopify product
// path can become an outbound request, and the request URL is constructed here rather than copied.
export function practicalGardenPondsPreviewSource(value) {
  if (typeof value !== "string") {
    return invalidSource("invalid_source_url", "Enter a Practical Garden Ponds product link.");
  }

  const input = value.trim();
  if (!input || input.length > INVENTORY_SOURCE_PREVIEW_URL_MAX_LENGTH || /[\u0000-\u001F\u007F]/u.test(input)) {
    return invalidSource("invalid_source_url", "Enter a valid Practical Garden Ponds product link.");
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return invalidSource("invalid_source_url", "Enter a full Practical Garden Ponds product link.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !PRACTICAL_GARDEN_PONDS_HOSTS.has(hostname)) {
    return invalidSource("source_not_allowed", "Only public Practical Garden Ponds product links are supported.");
  }
  if (parsed.username || parsed.password || parsed.port) {
    return invalidSource("source_not_allowed", "The supplier link cannot include credentials or a custom port.");
  }

  const match = parsed.pathname.match(/^\/products\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/?$/iu);
  if (!match) {
    return invalidSource("invalid_product_path", "Use a Practical Garden Ponds product page, not a search, cart, or account link.");
  }

  const handle = match[1].toLowerCase();
  const origin = `https://${hostname}`;
  return {
    valid: true,
    code: "",
    error: "",
    handle,
    canonicalUrl: `${origin}/products/${handle}`,
    apiUrl: `${origin}/products/${handle}.js`,
  };
}

const cleanText = (value, maxLength) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, maxLength);

const publicPrice = (value) => {
  const cents = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(cents) || cents < 0) return null;
  return Math.round(cents) / 100;
};

const safeImageUrl = (value, baseUrl) => {
  const candidate = typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? value.src || value.url
      : "";
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate, baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:"
      && PRACTICAL_GARDEN_PONDS_IMAGE_HOSTS.has(hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.port
      ? parsed.href
      : "";
  } catch {
    return "";
  }
};

export function normalizePracticalGardenPondsProduct(payload, source) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !source?.valid) return null;
  const title = cleanText(payload.title, 240);
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  if (!title || variants.length === 0 || variants.length > 250) return null;

  const normalizedVariants = variants.map((variant) => {
    if (!variant || typeof variant !== "object") return null;
    const id = cleanText(variant.id, 80);
    const price = publicPrice(variant.price);
    if (!id || price == null) return null;
    return {
      id,
      title: cleanText(variant.title, 180) || "Default",
      sku: cleanText(variant.sku, 120),
      price,
      available: variant.available === true,
    };
  });
  if (normalizedVariants.some((variant) => variant == null)) return null;

  const imageValue = payload.featured_image || (Array.isArray(payload.images) ? payload.images[0] : "");
  return {
    title,
    vendor: cleanText(payload.vendor, 160),
    canonicalUrl: source.canonicalUrl,
    imageUrl: safeImageUrl(imageValue, source.canonicalUrl),
    currency: "USD",
    variants: normalizedVariants,
  };
}
