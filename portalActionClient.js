export class PortalActionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PortalActionError";
    this.status = options.status || 0;
    this.code = options.code || "PORTAL_ACTION_FAILED";
  }
}

export async function rejectPortalPreviewAction() {
  throw new PortalActionError("Staff preview only — nothing was sent or saved.", {
    code: "PORTAL_PREVIEW_ONLY",
  });
}

// A portal-data GET may finish after a newer GET or after a confirmed mutation. Keep a tiny
// monotonic fence so those stale responses cannot replace the confirmed client-side receipt.
export function createPortalDataFence() {
  let requestSequence = 0;
  let mutationEpoch = 0;
  return {
    beginRequest() {
      return { sequence: ++requestSequence, mutationEpoch };
    },
    canApply(ticket) {
      return !!ticket && ticket.sequence === requestSequence && ticket.mutationEpoch === mutationEpoch;
    },
    confirmMutation() {
      mutationEpoch += 1;
      requestSequence += 1;
    },
  };
}

export function portalVisitReference(visit) {
  if (!visit || typeof visit !== "object") return null;
  const candidates = [
    ["completionReceiptId", visit.completionReceiptId],
    ["sid", visit.sid],
    ["visitId", visit.id],
  ];
  for (const [field, rawValue] of candidates) {
    if (!["string", "number"].includes(typeof rawValue)) continue;
    const value = String(rawValue).trim();
    if (value) return { field, value };
  }
  const date = String(visit.date || "").trim();
  return date ? { field: "visitDate", value: date } : null;
}

export function portalVisitMatchesReference(visit, reference) {
  if (!visit || !reference || typeof reference !== "object") return false;
  const field = reference.field;
  const sourceField = field === "visitId" ? "id" : field;
  if (!["completionReceiptId", "sid", "visitId", "visitDate"].includes(field)) return false;
  const visitValue = field === "visitDate" ? visit.date : visit[sourceField];
  return ["string", "number"].includes(typeof visitValue) && String(visitValue).trim() === String(reference.value || "").trim();
}

// Before a client interacts, the rating prompt may follow a newly-arrived latest visit. The first
// star tap freezes both the displayed visit and its stable server reference so a later portal-data
// poll cannot redirect feedback to a different completion while the client is still typing.
export function retainPortalRatingVisit(selection, latestVisit, clientId) {
  if (selection && selection.visit && selection.visitRef) return selection;
  const visitRef = portalVisitReference(latestVisit);
  if (!latestVisit || !visitRef) return null;
  return { clientId, visit: latestVisit, visitRef };
}

// Portal mutations are confirmed writes, not fire-and-forget notifications. Resolve only when
// Vercel returns both a successful HTTP status and the endpoint's explicit `{ ok: true }` receipt.
export async function requestPortalAction({ endpoint, action, payload, getHeaders, fetchImpl = globalThis.fetch }) {
  if (!endpoint || !action || typeof fetchImpl !== "function") {
    throw new PortalActionError("Could not send that change. Please try again.");
  }

  let response;
  try {
    const headers = typeof getHeaders === "function"
      ? await getHeaders({ "Content-Type": "application/json" })
      : { "Content-Type": "application/json" };
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, payload }),
    });
  } catch (_) {
    throw new PortalActionError("Could not reach the server. Check your connection and try again.", {
      code: "PORTAL_ACTION_UNREACHABLE",
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data || data.ok !== true) {
    throw new PortalActionError(
      (data && typeof data.error === "string" && data.error.trim())
        ? data.error.trim()
        : "Could not save that change. Please try again.",
      { status: response.status }
    );
  }
  return data;
}
