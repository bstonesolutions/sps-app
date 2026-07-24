const clean = (value) => String(value || "").trim();

const extensionFrom = (value) => {
  const withoutQuery = clean(value).split(/[?#]/, 1)[0];
  const match = withoutQuery.match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : "";
};

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const AUDIO_EXTENSIONS = new Set(["aac", "m4a", "mp3", "ogg", "wav"]);

export function smsMediaSource(item) {
  return typeof item === "string"
    ? clean(item)
    : clean(item?.signedUrl || item?.url || item?.href);
}

export function smsMediaMimeType(item) {
  return typeof item === "object" && item
    ? clean(item.mimeType || item.contentType || item.type).toLowerCase()
    : "";
}

export function smsMediaKind(item) {
  const mimeType = smsMediaMimeType(item);
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";

  const extension = extensionFrom(
    typeof item === "object" && item
      ? (item.path || item.filename || item.fileName || smsMediaSource(item))
      : smsMediaSource(item),
  );
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (extension === "pdf") return "pdf";
  return "file";
}

export function smsMediaSizeLabel(item) {
  const bytes = Number(typeof item === "object" && item ? item.size : 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function smsMediaLabel(item, index = 0) {
  const explicitName = typeof item === "object" && item
    ? clean(item.filename || item.fileName || item.name)
    : "";
  if (explicitName) return explicitName;

  const labels = {
    image: "Photo",
    video: "Video",
    audio: "Audio",
    pdf: "PDF document",
    file: "Attachment",
  };
  const label = labels[smsMediaKind(item)] || labels.file;
  return Number(index) > 0 ? `${label} ${Number(index) + 1}` : label;
}

// Inbound MMS rows retain this generated note as an audit fallback. Once the private media is
// available, omit only that exact trailing system note so a photo is not introduced twice.
export function smsVisibleBodyText(bodyText, loadedMediaCount = 0) {
  const text = clean(bodyText);
  if (!(Number(loadedMediaCount) > 0)) return text;
  return text
    .replace(/(?:^|\s)\[\d+\s+media attachment(?:s)?\]\s*$/i, "")
    .trim();
}
