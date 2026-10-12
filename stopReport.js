// Report edits carry one report's intent, never a replacement client collection.
export const STOP_REPORT_EDIT_FIELDS = [
  "type", "tech", "services", "products", "notes", "officeNotes", "readings",
  "readingStatus", "photos", "ph", "ammonia", "nitrite", "temp", "invoice",
  "quoted_price", "breakdown",
];
export const STOP_REPORT_RECOVERY_FIELDS = [
  ...STOP_REPORT_EDIT_FIELDS, "date", "assigneeId", "checklist",
];

export function stableReportJSON(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}

export async function buildReportEditRequest({ clientId, entry, updated, cryptoImpl = globalThis.crypto }) {
  if (clientId == null || !updated?.sid || !updated?.completionReceiptId) {
    throw new Error("This report is missing its saved identity. Reopen it from the schedule and try again.");
  }
  let expectedHash = null;
  if (entry) {
    if (!cryptoImpl?.subtle) throw new Error("This device cannot verify the saved report. Keep your edits open and try again.");
    const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(stableReportJSON(entry)));
    expectedHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  const changes = {};
  for (const key of entry ? STOP_REPORT_EDIT_FIELDS : STOP_REPORT_RECOVERY_FIELDS) {
    if (Object.hasOwn(updated, key) && (!entry || stableReportJSON(updated[key] ?? null) !== stableReportJSON(entry[key] ?? null))) {
      changes[key] = updated[key];
    }
  }
  return { clientId, sid: updated.sid, receiptId: updated.completionReceiptId, expectedHash, changes };
}

export async function requestStopReportEdit({ url, headers, body, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error || "Your report edit was not confirmed. Keep this window open and retry."), { code: data.code, status: response.status });
    if (String(data.receiptId) !== String(body.receiptId) || String(data.entry?.sid) !== String(body.sid)
      || String(data.entry?.completionReceiptId) !== String(body.receiptId)
      || !Object.entries(body.changes).every(([key, value]) => stableReportJSON(data.entry?.[key] ?? null) === stableReportJSON(value ?? null))) {
      throw new Error("The server did not confirm these exact report changes. Keep this window open and retry.");
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The report save timed out. Your edits are still here. Try saving again.");
    throw error;
  } finally { clearTimeout(timer); }
}
