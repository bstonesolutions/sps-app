// Focused inbox actions affect SPS only. The caller provides its authorized inbox
// endpoint, so this module cannot reach Gmail, Quo, or change an existing lead.
export async function cleanupSpsInbox({ ids, action, read = true, request }) {
  if (!["delete", "markRead"].includes(action)) throw new Error("Unsupported inbox action");
  const requested = [...new Set((ids || []).filter(id => id != null && String(id)).map(String))];
  const confirmed = new Set();
  for (let start = 0; start < requested.length; start += 200) {
    const chunk = requested.slice(start, start + 200);
    try {
      const { response, receipt } = await request({ action, ids: chunk, ...(action === "markRead" ? { read } : {}) });
      if (action === "delete") {
        // A partial delete receipt can confirm only the exact IDs it names.
        const returned = new Set((Array.isArray(receipt.deletedIds) ? receipt.deletedIds : []).map(String));
        chunk.filter(id => returned.has(id)).forEach(id => confirmed.add(id));
      } else if (response.ok && receipt.ok === true) {
        chunk.forEach(id => confirmed.add(id));
      }
    } catch (_) { /* Keep unconfirmed rows available for review and retry. */ }
  }
  return { ok: confirmed.size === requested.length, confirmedIds: [...confirmed], failedIds: requested.filter(id => !confirmed.has(id)) };
}

export function reconcileInboxRemoval(current, requestedRows, result) {
  const confirmed = new Set(result.confirmedIds);
  const failed = new Set(result.failedIds);
  const byId = new Map((current || []).filter(row => !confirmed.has(String(row.id))).map(row => [String(row.id), row]));
  // A foreground refresh may have suppressed pending deletes. Restore every
  // unconfirmed row without replacing fresher metadata or new incoming messages.
  for (const row of requestedRows || []) {
    if (failed.has(String(row.id)) && !byId.has(String(row.id))) byId.set(String(row.id), row);
  }
  return [...byId.values()].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

export function mergeInboxDetail(fresh, detail) {
  return detail ? { ...detail, ...fresh, body_html: detail.body_html } : fresh;
}
