import { validateInventorySourceUrl, validateInventoryVendor } from "./inventorySource.js";

const cleanText = (value, maxLength = 240) => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ").slice(0, maxLength);
};

const cleanMoney = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,4})?$/u.test(text)) return "";
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? amount.toFixed(2) : "";
};

const safePublicUrl = (value) => {
  const result = validateInventorySourceUrl(value);
  return result.valid ? result.value : "";
};

// Treat the preview endpoint response as untrusted input. This shape is deliberately narrower
// than an inventory item and cannot introduce costs, stock, or client-facing fields.
export function normalizeInventorySourcePreview(payload = {}) {
  const root = payload && typeof payload === "object"
    ? (payload.product && typeof payload.product === "object"
      ? payload.product
      : payload.preview && typeof payload.preview === "object" ? payload.preview : payload)
    : {};
  const vendor = validateInventoryVendor(root.vendor);
  const variants = (Array.isArray(root.variants) ? root.variants : []).slice(0, 100).map((variant, index) => {
    const item = variant && typeof variant === "object" ? variant : {};
    return {
      id: cleanText(item.id, 160) || `variant-${index + 1}`,
      title: cleanText(item.title),
      sku: cleanText(item.sku, 160),
      price: cleanMoney(item.price),
      available: typeof item.available === "boolean" ? item.available : null,
    };
  }).filter((variant) => variant.title || variant.sku || variant.price);
  return {
    title: cleanText(root.title),
    vendor: vendor.valid ? vendor.value : "",
    canonicalUrl: safePublicUrl(root.canonicalUrl),
    imageUrl: safePublicUrl(root.imageUrl),
    currency: cleanText(root.currency, 8).toUpperCase(),
    variants,
  };
}

const RETAIL_FIELDS = new Set(["price", "retailPer", "retailPerOz"]);

// Build a draft patch only from choices the person explicitly selected. The destination allowlist
// means public price can never become cost, package cost, inventory, or report data.
export function inventorySourcePreviewApplyPatch({ preview, variantId = "", selected = {}, retailField = "" } = {}) {
  const safe = normalizeInventorySourcePreview(preview);
  const variant = safe.variants.find((item) => item.id === variantId) || safe.variants[0] || null;
  const patch = {};
  if (selected.name && safe.title) patch.name = safe.title;
  if (selected.vendor && safe.vendor) patch.vendor = safe.vendor;
  if (selected.sourceUrl && safe.canonicalUrl) patch.sourceUrl = safe.canonicalUrl;
  if (selected.sku && variant?.sku) patch.sku = variant.sku;
  if (selected.retail && variant?.price && RETAIL_FIELDS.has(retailField) && (!safe.currency || safe.currency === "USD")) {
    patch[retailField] = variant.price;
  }
  return patch;
}
