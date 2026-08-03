export const INVENTORY_VENDOR_MAX_LENGTH = 120;
export const INVENTORY_SOURCE_URL_MAX_LENGTH = 2048;

const DISALLOWED_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const ANY_URL_CONTROLS = /[\u0000-\u001F\u007F]/u;

const optionalString = (value) => {
  if (value == null) return { valid: true, value: "" };
  if (typeof value !== "string") return { valid: false, value: "" };
  return { valid: true, value };
};

export function validateInventoryVendor(value) {
  const text = optionalString(value);
  if (!text.valid) {
    return { valid: false, value: "", error: "Supplier name must be text." };
  }
  if (DISALLOWED_TEXT_CONTROLS.test(text.value)) {
    return { valid: false, value: "", error: "Supplier name contains unsupported characters." };
  }

  const normalized = text.value.trim().replace(/\s+/gu, " ");
  if (normalized.length > INVENTORY_VENDOR_MAX_LENGTH) {
    return {
      valid: false,
      value: normalized,
      error: `Supplier name must be ${INVENTORY_VENDOR_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { valid: true, value: normalized, error: "" };
}

export function validateInventorySourceUrl(value) {
  const text = optionalString(value);
  if (!text.valid) {
    return { valid: false, value: "", hostname: "", isSecure: false, error: "Supplier link must be text." };
  }

  const normalized = text.value.trim();
  if (!normalized) return { valid: true, value: "", hostname: "", isSecure: false, error: "" };
  if (normalized.length > INVENTORY_SOURCE_URL_MAX_LENGTH) {
    return {
      valid: false,
      value: "",
      hostname: "",
      isSecure: false,
      error: `Supplier link must be ${INVENTORY_SOURCE_URL_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (ANY_URL_CONTROLS.test(normalized)) {
    return { valid: false, value: "", hostname: "", isSecure: false, error: "Supplier link contains unsupported characters." };
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { valid: false, value: "", hostname: "", isSecure: false, error: "Enter a full http:// or https:// supplier link." };
  }

  if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname) {
    return { valid: false, value: "", hostname: "", isSecure: false, error: "Only http:// and https:// supplier links are allowed." };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, value: "", hostname: "", isSecure: false, error: "Supplier links cannot contain sign-in credentials." };
  }

  return {
    valid: true,
    value: parsed.href,
    hostname: parsed.hostname.toLowerCase(),
    isSecure: parsed.protocol === "https:",
    error: "",
  };
}

export function inventorySourceMetadata(item = {}) {
  const vendor = validateInventoryVendor(item?.vendor);
  const source = validateInventorySourceUrl(item?.sourceUrl);
  return {
    valid: vendor.valid && source.valid,
    vendor: vendor.value,
    sourceUrl: source.value,
    hostname: source.hostname,
    isSecure: source.isSecure,
    errors: {
      vendor: vendor.error,
      sourceUrl: source.error,
    },
  };
}

export function safeInventorySourceUrl(value) {
  const result = validateInventorySourceUrl(value);
  return result.valid ? result.value : "";
}
