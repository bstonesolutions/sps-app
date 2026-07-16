const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const sameId = (left, right) => left != null && right != null && String(left) === String(right);

export function buildCompletedReportIndex(clients = []) {
  const byReceipt = new Map();
  const bySid = new Map();
  for (const client of Array.isArray(clients) ? clients : []) {
    for (const entry of Array.isArray(client?.history) ? client.history : []) {
      if (!entry) continue;
      const match = { entry, client };
      const receiptId = String(entry.completionReceiptId || "");
      if (receiptId) byReceipt.set(receiptId, [...(byReceipt.get(receiptId) || []), match]);
      if (entry.sid != null && String(entry.sid) !== "") {
        const sid = String(entry.sid);
        bySid.set(sid, [...(bySid.get(sid) || []), match]);
      }
    }
  }
  return { byReceipt, bySid };
}

export function canRebuildCompletedReport(reason) {
  return reason === "missing-legacy-report" || reason === "missing-receipt-report";
}

// Resolve only identities that prove which saved history snapshot belongs to the stop.
// The caller can use `reason` for a repair UI without ever substituting planned schedule data
// or another client's notes/photos for the missing finished report.
export function resolveCompletedReport({
  stop,
  completed,
  index,
  scheduledClientId = null,
  ledgerKey = "__stopReversalReceipts",
} = {}) {
  if (!stop || stop.sid == null || String(stop.sid) === "") return { match: null, reason: "missing-stop-id" };
  const marker = completed?.[stop.sid];
  if (!marker) return { match: null, reason: "not-completed" };
  const byReceipt = index?.byReceipt || new Map();
  const bySid = index?.bySid || new Map();

  if (isRecord(marker)) {
    const receiptId = String(marker.receiptId || "");
    if (!receiptId) return { match: null, reason: "invalid-modern-marker" };
    const matches = byReceipt.get(receiptId) || [];
    const ledgerReceipt = completed?.[ledgerKey]?.[receiptId];
    const ownerId = ledgerReceipt?.clientId;
    if (matches.length === 1 && (ownerId == null || sameId(matches[0].client?.id, ownerId))) {
      return { match: { ...matches[0], reversalClientId: ownerId ?? matches[0].client?.id }, reason: "matched-receipt" };
    }
    if (ownerId != null) {
      const ownerMatches = matches.filter(({ client }) => sameId(client?.id, ownerId));
      if (ownerMatches.length === 1) return { match: { ...ownerMatches[0], reversalClientId: ownerId }, reason: "matched-receipt-owner" };
      if (ownerMatches.length > 1) return { match: null, reason: "duplicate-owner-reports" };
    }
    return { match: null, reason: matches.length ? "ambiguous-receipt" : "missing-receipt-report" };
  }

  if (marker !== true) return { match: null, reason: "invalid-legacy-marker" };
  const matches = bySid.get(String(stop.sid)) || [];
  if (scheduledClientId != null) {
    const ownerMatches = matches.filter(({ client }) => sameId(client?.id, scheduledClientId));
    if (ownerMatches.length === 1) {
      return { match: { ...ownerMatches[0], reversalClientId: ownerMatches[0].client?.id }, reason: "matched-legacy-owner" };
    }
    if (ownerMatches.length > 1) return { match: null, reason: "duplicate-owner-reports" };
    if (matches.length) return { match: null, reason: "legacy-report-wrong-client" };
  } else if (matches.length === 1) {
    return { match: { ...matches[0], reversalClientId: matches[0].client?.id }, reason: "matched-legacy" };
  }
  return { match: null, reason: matches.length ? "ambiguous-legacy-report" : "missing-legacy-report" };
}
