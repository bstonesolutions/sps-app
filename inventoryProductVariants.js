import { normalizeInventorySourcePreview } from "./inventorySourcePreviewClient.js";

const clean = (value, maxLength = 240) => String(value ?? "")
  .trim()
  .replace(/\s+/gu, " ")
  .slice(0, maxLength);

const lower = (value) => clean(value).toLocaleLowerCase();

// This deliberately stays synchronous and platform-independent. Product IDs are stored in
// completed-stop receipts, estimates, invoices, and inventory movements, so a supplier refresh
// must always produce the same child ID for the same family and supplier variant.
const stableHash = (value) => {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export function inventoryProductFamilyId(item = {}) {
  return clean(item?.productFamilyId, 180) || clean(item?.id, 180);
}

// Concise UI-facing aliases. The longer names above remain explicit for lower-level callers.
export const productFamilyIdentity = inventoryProductFamilyId;

export function inventoryProductFamilyName(item = {}) {
  return clean(item?.familyName) || clean(item?.name) || "Unnamed product";
}

export function inventoryProductVariantLabel(item = {}) {
  return clean(item?.variantLabel);
}

export function inventoryProductDisplayName(item = {}) {
  const familyName = inventoryProductFamilyName(item);
  const variantLabel = inventoryProductVariantLabel(item);
  if (!variantLabel || lower(familyName) === lower(variantLabel)) return familyName;
  if (lower(item?.name) === lower(`${familyName} · ${variantLabel}`)) return clean(item.name);
  return `${familyName} · ${variantLabel}`;
}

export const productVariantDisplayName = inventoryProductDisplayName;

export function inventoryVariantChildId({ familyId = "", sourceVariantId = "", sku = "", title = "", index = 0 } = {}) {
  const safeFamilyId = clean(familyId, 180) || "product-family";
  const variantIdentity = clean(sourceVariantId, 180)
    || clean(sku, 180)
    || clean(title, 240)
    || `option-${Number(index) + 1}`;
  return `pv_${stableHash(`${safeFamilyId}\u0000${variantIdentity}`)}`;
}

const searchableProduct = (item, familyName) => [
  familyName,
  item?.name,
  item?.variantLabel,
  item?.sku,
  item?.category,
  item?.vendor,
].map(lower).join(" ");

// Existing records without family metadata remain singleton families. Variant children are only
// grouped for display and selection; the original child objects and IDs are returned unchanged.
export function groupInventoryProductFamilies(products = [], query = "") {
  const needle = lower(query);
  const groups = new Map();

  for (const product of Array.isArray(products) ? products.filter(Boolean) : []) {
    const familyId = inventoryProductFamilyId(product);
    if (!familyId) continue;
    const familyName = inventoryProductFamilyName(product);
    const matches = !needle || searchableProduct(product, familyName).includes(needle);
    const existing = groups.get(familyId) || {
      id: familyId,
      familyId,
      name: familyName,
      familyName,
      products: [],
      variants: [],
      isVariantFamily: false,
      matches: false,
    };
    existing.products.push(product);
    existing.variants.push(product);
    existing.matches ||= matches;
    existing.isVariantFamily ||= !!inventoryProductVariantLabel(product);
    groups.set(familyId, existing);
  }

  return [...groups.values()]
    .filter((family) => family.matches)
    .map(({ matches: _matches, ...family }) => ({
      ...family,
      isVariantFamily: family.isVariantFamily || family.products.length > 1,
    }));
}

export const groupProductFamilies = groupInventoryProductFamilies;

const matchExistingVariant = ({ products, familyId, sourceVariantId, sku, variantLabel }) => {
  const familyProducts = products.filter((item) => inventoryProductFamilyId(item) === familyId);
  return familyProducts.find((item) => clean(item?.sourceVariantId, 180) === sourceVariantId)
    || (sku ? familyProducts.find((item) => lower(item?.sku) === lower(sku)) : null)
    || (variantLabel ? familyProducts.find((item) => lower(item?.variantLabel) === lower(variantLabel)) : null)
    || null;
};

const commonTemplateFields = (template = {}) => {
  const {
    id: _id,
    name: _name,
    productFamilyId: _productFamilyId,
    familyName: _familyName,
    variantLabel: _variantLabel,
    sourceVariantId: _sourceVariantId,
    sku: _sku,
    cost: _cost,
    price: _price,
    stockByLoc: _stockByLoc,
    sourceAvailable: _sourceAvailable,
    ...shared
  } = template || {};
  return shared;
};

// Importing supplier options creates normal flat product records. That keeps all existing stop,
// estimate, invoice, and reversal code working while the UI can present the children under one
// family. Public supplier price may update retail; it is never copied into cost.
export function upsertSupplierVariantProducts({
  preview,
  products = [],
  template = {},
  variantIds = [],
  preferredVariantId = "",
} = {}) {
  const safePreview = normalizeInventorySourcePreview(preview);
  const currentProducts = Array.isArray(products) ? products.filter(Boolean) : [];
  const requestedIds = new Set((Array.isArray(variantIds) ? variantIds : []).map((id) => clean(id, 180)).filter(Boolean));
  const variants = safePreview.variants.filter((variant) => !requestedIds.size || requestedIds.has(variant.id));
  const existingTemplate = currentProducts.find((item) => clean(item?.id, 180) === clean(template?.id, 180)) || null;
  const familyName = clean(template?.familyName)
    || (existingTemplate ? inventoryProductFamilyName(existingTemplate) : "")
    || safePreview.title
    || clean(template?.name)
    || "Unnamed product";
  const inferredFamily = existingTemplate && inventoryProductFamilyId(existingTemplate);
  const familyId = clean(template?.productFamilyId, 180)
    || inferredFamily
    || (clean(template?.id, 180) || `pf_${stableHash(`${safePreview.canonicalUrl}\u0000${familyName}`)}`);
  const shared = commonTemplateFields(template);
  const imported = [];
  const usedProductIds = new Set();
  const templateCanSeedOneVariant = !clean(template?.sourceVariantId, 180)
    && !clean(template?.variantLabel);
  const preferredSourceId = clean(preferredVariantId, 180) || clean(template?.sourceVariantId, 180);
  const templateMatchIndex = variants.findIndex((variant) => (
    preferredSourceId === variant.id
    || (!!variant.sku && lower(template?.sku) === lower(variant.sku))
    || (!!variant.title && lower(template?.variantLabel) === lower(variant.title))
  ));

  variants.forEach((variant, index) => {
    let existing = matchExistingVariant({
      products: currentProducts,
      familyId,
      sourceVariantId: variant.id,
      sku: variant.sku,
      variantLabel: variant.title,
    });

    // Converting one legacy flat product into a family keeps that product's ID, cost, and stock
    // on exactly one child. Sibling options start with no stock or cost instead of multiplying it.
    if (!existing && templateCanSeedOneVariant && index === templateMatchIndex && !usedProductIds.has(template.id)) {
      existing = template;
    }

    const id = clean(existing?.id, 180) || inventoryVariantChildId({
      familyId,
      sourceVariantId: variant.id,
      sku: variant.sku,
      title: variant.title,
      index,
    });
    usedProductIds.add(id);
    const variantLabel = variant.title || variant.sku || `Option ${index + 1}`;
    const retailPrice = (!safePreview.currency || safePreview.currency === "USD") && variant.price
      ? variant.price
      : clean(existing?.price);
    const product = {
      ...shared,
      ...(existing || {}),
      id,
      name: inventoryProductDisplayName({ familyName, variantLabel }),
      productFamilyId: familyId,
      familyName,
      variantLabel,
      sourceVariantId: variant.id,
      sku: variant.sku || clean(existing?.sku, 180),
      price: retailPrice,
      // Supplier/retailer entered by the team wins over a public manufacturer's Shopify vendor.
      vendor: clean(existing?.vendor) || clean(template?.vendor),
      brand: clean(existing?.brand) || clean(template?.brand) || safePreview.vendor,
      sourceUrl: safePreview.canonicalUrl || clean(existing?.sourceUrl) || clean(template?.sourceUrl),
      sourceAvailable: variant.available,
      cost: existing ? (existing.cost ?? "") : "",
      stockByLoc: existing && existing.stockByLoc && typeof existing.stockByLoc === "object"
        ? { ...existing.stockByLoc }
        : {},
    };
    imported.push(product);
  });

  const importedById = new Map(imported.map((item) => [String(item.id), item]));
  const importedSourceIds = new Set(imported.map((item) => String(item.sourceVariantId)));
  const retained = currentProducts.filter((item) => {
    if (importedById.has(String(item.id))) return false;
    if (inventoryProductFamilyId(item) !== familyId) return true;
    return !importedSourceIds.has(String(item.sourceVariantId || ""));
  });

  return {
    familyId,
    familyName,
    imported,
    importedIds: imported.map((item) => item.id),
    products: [...retained, ...imported],
  };
}

export function importSupplierProductVariants({ preview, draft = {}, products = [], variantIds = [], preferredVariantId = "" } = {}) {
  return upsertSupplierVariantProducts({ preview, template: draft, products, variantIds, preferredVariantId });
}
