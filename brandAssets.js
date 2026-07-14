export const DEFAULT_APP_LOGO_PATH = "/icon-192.png";
export const DEFAULT_APP_LOGO_URL = "https://spsway.app/icon-192.png";

export function brandLogoSource(branding, { absolute = false, publicUrl = "https://spsway.app" } = {}) {
  const raw = typeof (branding && branding.logoImage) === "string" ? branding.logoImage.trim() : "";
  const source = raw || DEFAULT_APP_LOGO_PATH;
  if (/^data:image\//i.test(source) || /^https?:\/\//i.test(source)) return source;
  if (/^\//.test(source)) return absolute ? `${String(publicUrl || "https://spsway.app").replace(/\/+$/, "")}${source}` : source;
  return absolute ? DEFAULT_APP_LOGO_URL : DEFAULT_APP_LOGO_PATH;
}
