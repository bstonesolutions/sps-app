// Pure reconciliation for an SPS invoice that already has a QuickBooks twin.
//
// QuickBooks owns the customer-facing accounting snapshot after a successful pull:
// lines, tax, totals, dates, and status. SPS still owns its internal links and costing
// metadata. Keeping that boundary here prevents a pull from losing estimate/visit
// provenance while also preventing stale SPS lines from disagreeing with QuickBooks.

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const clone = (value) => {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }
  return value;
};

const normalizedText = (value) => String(value == null ? "" : value)
  .trim()
  .replace(/\s+/g, " ")
  .toLowerCase();

const normalizedNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : normalizedText(value);
};

const canonicalText = (value) => String(value == null ? "" : value)
  .trim()
  .replace(/\s+/g, " ");

const canonicalOptionalNumber = (value, fallback = "") => {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : canonicalText(value);
};

const refValue = (value) => {
  if (value && typeof value === "object") return normalizedText(value.value ?? value.id ?? value.name);
  return normalizedText(value);
};

const qbLineId = (line) => normalizedText(
  line?.qbLineId
  ?? line?.quickBooksLineId
  ?? line?.quickbooksLineId
  ?? line?.quickbooks_line_id
);

const qbItemRef = (line) => refValue(
  line?.qbItemRef
  ?? line?.quickBooksItemRef
  ?? line?.quickbooksItemRef
  ?? line?.itemRef
  ?? line?.ItemRef
);

const lineDescription = (line) => normalizedText(line?.desc ?? line?.description ?? line?.name);

const customerLineSignature = (line) => [
  lineDescription(line),
  normalizedNumber(line?.qty ?? 1),
  normalizedNumber(line?.unitPrice ?? line?.price ?? line?.rate ?? 0),
  line?.taxable === true ? "taxable" : "non-taxable",
].join("|");

const SPS_LINE_METADATA_FIELDS = [
  "unitCost",
  "costKnown",
  "knownUnitCost",
  "refId",
  "bundleItems",
  "sourceEstimateLineId",
  "sourceVisitLineId",
];

const QUICKBOOKS_AUTHORITY_FIELDS = [
  "number",
  "clientName",
  "date",
  "issueDate",
  "dueDate",
  "sentDate",
  "paidDate",
  "status",
  "taxRate",
  "taxAmount",
  "discountType",
  "discount",
  "subTotal",
  "subtotal",
  "total",
  "balance",
  "items",
  "lines",
  "qbEmailStatus",
  "qbDeliveryType",
  "partial",
  "lateFeeAppliedAt",
  "qbHasUnsupportedLines",
  "qbUnsupportedLineTypes",
];

const QUICKBOOKS_IDENTITY_FIELDS = [
  "qbId",
  "qbCustomerId",
  "qbSyncToken",
  "qbLastUpdatedTime",
  "qbContentFingerprint",
  "qbContentHash",
  "qbTaxCodeRef",
];

const PENDING_SYNC_STATUSES = new Set([
  "conflict",
  "dirty",
  "local-edits",
  "pending",
  "pending-push",
  "pending_push",
  "create-outcome-unknown",
]);

/**
 * Return a stable, browser-safe signature of the customer-facing accounting
 * intent sent when SPS creates a QuickBooks invoice.
 *
 * This is intentionally a canonical JSON string rather than a random id or
 * timestamp. If the create response is lost, SPS can compare the original
 * attempt with the invoice currently on screen before accepting an idempotent
 * QuickBooks replay as authoritative.
 */
export function quickBooksInvoiceIntentSignature(invoice) {
  const source = invoice && typeof invoice === "object" && !Array.isArray(invoice)
    ? invoice
    : {};
  const sourceLines = Array.isArray(source.lineItems)
    ? source.lineItems
    : (Array.isArray(source.items) ? source.items : []);

  const signature = {
    version: 1,
    customer: {
      qbCustomerId: canonicalText(source.qbCustomerId),
      name: canonicalText(source.clientName),
      email: canonicalText(source.clientEmail).toLowerCase(),
      phone: canonicalText(source.clientPhone),
      street: canonicalText(source.clientStreet || source.clientAddress),
      city: canonicalText(source.clientCity),
      state: canonicalText(source.clientState),
      zip: canonicalText(source.clientZip),
    },
    invoice: {
      number: canonicalText(source.number),
      date: canonicalText(source.date),
      dueDate: canonicalText(source.dueDate),
      taxRate: canonicalOptionalNumber(source.taxRate),
      discountType: canonicalText(source.invoiceDiscountType).toLowerCase(),
      discount: canonicalOptionalNumber(source.invoiceDiscount),
      allowCard: typeof source.allowCard === "boolean" ? source.allowCard : null,
      allowACH: typeof source.allowACH === "boolean" ? source.allowACH : null,
    },
    lines: sourceLines.map((line) => {
      const qty = canonicalOptionalNumber(line?.qty, "1");
      const unitPrice = canonicalOptionalNumber(line?.unitPrice ?? line?.rate, "0");
      const calculatedAmount = Number(qty) * Number(unitPrice);
      return {
        description: canonicalText(line?.description ?? line?.desc ?? line?.name),
        qty,
        unitPrice,
        amount: canonicalOptionalNumber(
          line?.amount,
          Number.isFinite(calculatedAmount) ? String(calculatedAmount) : "",
        ),
        taxable: line?.taxable === true,
        kind: canonicalText(line?.kind).toLowerCase(),
        qbItemRef: refValue(
          line?.qbItemRef
          ?? line?.quickBooksItemRef
          ?? line?.quickbooksItemRef
          ?? line?.itemRef
          ?? line?.ItemRef,
        ),
      };
    }),
  };

  return JSON.stringify(signature);
}

export function hasPendingLocalInvoiceEdits(invoice) {
  if (!invoice || typeof invoice !== "object") return false;
  if (
    invoice.locallyEdited === true
    || invoice.qbPendingLocalEdits === true
    || invoice.qbLocalChangesPending === true
  ) return true;
  return PENDING_SYNC_STATUSES.has(normalizedText(invoice.qbSyncStatus));
}

const quickBooksSyncFailureCode = (error, explicitCode = "") => {
  const supplied = canonicalText(explicitCode).toUpperCase();
  if (supplied) return supplied;
  const source = error && typeof error === "object"
    ? `${error.code || ""} ${error.error || ""} ${error.message || ""}`
    : String(error || "");
  if (/create.?outcome.?unknown|may have created/i.test(source)) return "QB_CREATE_OUTCOME_UNKNOWN";
  if (/duplicate document number|docnumber=.*already/i.test(source)) return "QB_DUPLICATE_DOCUMENT_NUMBER";
  if (/not connected|session expired|token expired|refresh_failed|401/i.test(source)) return "QB_AUTH_EXPIRED";
  if (/network|failed to fetch|could not reach|socket|timed? ?out|econn/i.test(source)) return "QB_NETWORK_ERROR";
  if (/changed in quickbooks|sync required|conflict/i.test(source)) return "QB_CONFLICT";
  return "QB_SYNC_FAILED";
};

/**
 * Preserve a failed QuickBooks attempt on the SPS record so the review queue
 * can explain what failed and offer a deliberate retry. This function performs
 * no network or storage writes and never drops invoice content.
 */
export function applyQuickBooksInvoiceSyncFailure(localInvoice, options = {}) {
  if (!localInvoice || typeof localInvoice !== "object" || Array.isArray(localInvoice)) {
    throw new TypeError("A local SPS invoice is required.");
  }
  const source = options.error ?? options.message ?? "";
  const message = canonicalText(
    source && typeof source === "object"
      ? (source.error || source.message || "")
      : source,
  ) || "QuickBooks sync failed.";
  const attemptedAt = canonicalText(options.attemptedAt) || new Date().toISOString();

  return {
    ...clone(localInvoice),
    qbNeedsReview: true,
    qbSyncError: message.slice(0, 500),
    qbSyncErrorCode: quickBooksSyncFailureCode(source, options.code),
    qbSyncAttemptedAt: attemptedAt,
  };
}

function findLineMatch(remoteLine, remoteIndex, localLines, claimed, remoteCount) {
  const available = localLines
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => !claimed.has(index));

  const remoteLineId = qbLineId(remoteLine);
  if (remoteLineId) {
    const byLineId = available.find(({ line }) => qbLineId(line) === remoteLineId);
    if (byLineId) return byLineId;
  }

  // A QuickBooks ItemRef is useful when the line price or description was edited in QB.
  // Only use an ambiguous reference when the description disambiguates repeated items.
  const remoteItemRef = qbItemRef(remoteLine);
  if (remoteItemRef) {
    const byItemRef = available.filter(({ line }) => qbItemRef(line) === remoteItemRef);
    if (byItemRef.length === 1) return byItemRef[0];
    const remoteDescription = lineDescription(remoteLine);
    const byItemAndDescription = byItemRef.filter(({ line }) => lineDescription(line) === remoteDescription);
    if (byItemAndDescription.length === 1) return byItemAndDescription[0];
  }

  const signature = customerLineSignature(remoteLine);
  const bySignature = available.filter(({ line }) => customerLineSignature(line) === signature);
  if (bySignature.length === 1) return bySignature[0];

  // Description matching preserves SPS cost data when a price/quantity changes in QB.
  // Require uniqueness so two identical service lines never inherit one another's costs.
  const description = lineDescription(remoteLine);
  if (description) {
    const byDescription = available.filter(({ line }) => lineDescription(line) === description);
    if (byDescription.length === 1) return byDescription[0];
  }

  // Legacy records predate stored QB line ids. A positional match is safe only when
  // neither side added or removed a line in this pull.
  if (remoteCount === localLines.length && !claimed.has(remoteIndex) && localLines[remoteIndex]) {
    return { line: localLines[remoteIndex], index: remoteIndex };
  }

  return null;
}

function lineFromQuickBooks(remoteLine, localLine, fallbackId) {
  const next = clone(remoteLine || {});
  // Cost and catalog fields are SPS-only, even if an upstream payload accidentally
  // contains similarly named properties.
  for (const field of SPS_LINE_METADATA_FIELDS) delete next[field];

  const localItemRef = qbItemRef(localLine);
  const remoteItemRef = qbItemRef(remoteLine);
  const itemChanged = !!(
    localLine
    && qbLineId(localLine)
    && qbLineId(remoteLine)
    && qbLineId(localLine) === qbLineId(remoteLine)
    && localItemRef
    && remoteItemRef
    && localItemRef !== remoteItemRef
  );

  if (localLine) {
    // Keep the app's stable line id while retaining the real QB identifiers copied above.
    if (own(localLine, "id")) next.id = localLine.id;
    if (!itemChanged) {
      for (const field of SPS_LINE_METADATA_FIELDS) {
        if (own(localLine, field)) next[field] = clone(localLine[field]);
      }
    }
  } else {
    // QuickBooks does not carry SPS cost/catalog data. Never make a new QB-only line
    // look profitable by treating an absent cost as zero.
    next.id = next.id || fallbackId;
  }
  if (!own(next, "unitCost")) next.unitCost = "";
  if (!own(next, "costKnown")) next.costKnown = false;

  return next;
}

function reconciledLines(localInvoice, quickBooksInvoice) {
  const localLines = Array.isArray(localInvoice?.lineItems) ? localInvoice.lineItems : [];
  const remoteLines = quickBooksInvoice.lineItems;
  const claimed = new Set();

  return remoteLines.map((remoteLine, remoteIndex) => {
    const match = findLineMatch(remoteLine, remoteIndex, localLines, claimed, remoteLines.length);
    if (match) claimed.add(match.index);
    const fallbackId = [
      "qbl",
      quickBooksInvoice.qbId || localInvoice?.qbId || "invoice",
      qbLineId(remoteLine) || remoteIndex,
    ].join("_");
    return lineFromQuickBooks(remoteLine, match?.line, fallbackId);
  });
}

function pendingQuickBooksSnapshot(quickBooksInvoice) {
  const snapshot = {};
  for (const field of [...QUICKBOOKS_IDENTITY_FIELDS, ...QUICKBOOKS_AUTHORITY_FIELDS]) {
    if (own(quickBooksInvoice, field)) snapshot[field] = clone(quickBooksInvoice[field]);
  }
  snapshot.lineItems = quickBooksInvoice.lineItems.map((line, index) => lineFromQuickBooks(
    line,
    null,
    ["qbl", quickBooksInvoice.qbId || "invoice", qbLineId(line) || index].join("_"),
  ));
  if (own(quickBooksInvoice, "paymentLink")) snapshot.paymentLink = quickBooksInvoice.paymentLink;
  return snapshot;
}

/**
 * Reconcile a local SPS invoice with the latest normalized QuickBooks invoice.
 *
 * The function does not mutate either input. A local invoice explicitly marked dirty
 * is fenced instead of overwritten; callers can present qbPendingRemoteInvoice for
 * review and deliberately choose which version to keep.
 */
export function reconcileQuickBooksInvoice(localInvoice, quickBooksInvoice) {
  if (!localInvoice || typeof localInvoice !== "object" || Array.isArray(localInvoice)) {
    throw new TypeError("A local SPS invoice is required.");
  }
  if (!quickBooksInvoice || typeof quickBooksInvoice !== "object" || Array.isArray(quickBooksInvoice)) {
    throw new TypeError("A QuickBooks invoice snapshot is required.");
  }
  if (!Array.isArray(quickBooksInvoice.lineItems)) {
    throw new TypeError("The QuickBooks invoice snapshot must include lineItems.");
  }
  if (
    localInvoice.qbId != null
    && quickBooksInvoice.qbId != null
    && String(localInvoice.qbId) !== String(quickBooksInvoice.qbId)
  ) {
    throw new Error("Cannot reconcile invoices with different QuickBooks ids.");
  }

  if (hasPendingLocalInvoiceEdits(localInvoice)) {
    const next = clone(localInvoice);
    next.qbSyncStatus = "conflict";
    next.qbNeedsReview = true;
    next.qbRemoteChangesPending = true;
    next.qbSyncConflict = {
      type: "quickbooks-remote-update",
      reason: "pending-local-edits",
      qbId: quickBooksInvoice.qbId ?? localInvoice.qbId ?? null,
      qbSyncToken: quickBooksInvoice.qbSyncToken ?? null,
      qbLastUpdatedTime: quickBooksInvoice.qbLastUpdatedTime ?? null,
    };
    next.qbPendingRemoteInvoice = pendingQuickBooksSnapshot(quickBooksInvoice);
    return next;
  }

  const next = clone(localInvoice);
  for (const field of [...QUICKBOOKS_IDENTITY_FIELDS, ...QUICKBOOKS_AUTHORITY_FIELDS]) {
    if (own(quickBooksInvoice, field)) next[field] = clone(quickBooksInvoice[field]);
  }
  // QuickBooks does not know when SPS delivered an invoice by text, portal, or
  // the app's branded email. An unsent QB snapshot must not demote that local
  // delivery history back to Draft.
  const quickBooksKnowsDelivery = (
    quickBooksInvoice.qbEmailStatus === "EmailSent"
    || !!quickBooksInvoice.sentDate
  );
  if (
    !quickBooksKnowsDelivery
    && quickBooksInvoice.status === "Draft"
    && ["Sent", "Overdue"].includes(localInvoice.status)
  ) {
    next.status = localInvoice.status;
    if (own(localInvoice, "sentDate")) next.sentDate = clone(localInvoice.sentDate);
  }
  next.lineItems = reconciledLines(localInvoice, quickBooksInvoice);

  // A locally generated payment link remains valid and can include SPS-specific routing.
  // Fall back to QuickBooks' link only when the local record never had one.
  if (!localInvoice.paymentLink && own(quickBooksInvoice, "paymentLink")) {
    next.paymentLink = quickBooksInvoice.paymentLink;
  }

  next.qbSyncStatus = "synced";
  next.qbAuthoritative = true;
  if (quickBooksInvoice.qbContentFingerprint) {
    next.qbBaseContentFingerprint = quickBooksInvoice.qbContentFingerprint;
  }
  next.locallyEdited = false;
  delete next.qbNeedsReview;
  delete next.qbRemoteChangesPending;
  delete next.qbSyncConflict;
  delete next.qbPendingRemoteInvoice;
  delete next.qbPendingLocalEdits;
  delete next.qbLocalChangesPending;
  delete next.qbCreateOutcomeUnknown;
  delete next.qbCreateIntentSignature;
  delete next.qbCreateRequestId;
  delete next.qbSyncError;
  delete next.qbSyncErrorCode;
  delete next.qbSyncAttemptedAt;

  return next;
}

/**
 * Apply the canonical QuickBooks snapshot returned by a successful create or
 * update. This closes the gap where SPS previously marked an old local total as
 * authoritative until the next manual pull.
 */
export function applyQuickBooksInvoiceSaveResult(localInvoice, result) {
  if (!localInvoice || typeof localInvoice !== "object" || Array.isArray(localInvoice)) {
    throw new TypeError("A local SPS invoice is required.");
  }
  const response = result && typeof result === "object" ? result : {};
  const settledLocal = clone(localInvoice);
  settledLocal.qbId = response.qbId || settledLocal.qbId || null;
  settledLocal.paymentLink = response.paymentLink || settledLocal.paymentLink || "";
  settledLocal.qbPushed = true;
  settledLocal.locallyEdited = false;
  settledLocal.qbPendingLocalEdits = false;
  settledLocal.qbLocalChangesPending = false;
  settledLocal.qbNeedsReview = false;
  settledLocal.qbSyncStatus = "needs-refresh";
  // A fingerprint without the accompanying accounting snapshot is not enough
  // to trust old local totals.
  settledLocal.qbAuthoritative = false;
  delete settledLocal.qbSyncConflict;
  delete settledLocal.qbPendingRemoteInvoice;
  delete settledLocal.qbCreateOutcomeUnknown;
  delete settledLocal.qbCreateIntentSignature;
  delete settledLocal.qbCreateRequestId;
  delete settledLocal.qbSyncError;
  delete settledLocal.qbSyncErrorCode;
  delete settledLocal.qbSyncAttemptedAt;

  if (!response.invoice || !Array.isArray(response.invoice.lineItems)) {
    if (response.qbContentFingerprint) {
      settledLocal.qbContentFingerprint = response.qbContentFingerprint;
      settledLocal.qbBaseContentFingerprint = response.qbContentFingerprint;
    }
    return settledLocal;
  }

  const remote = clone(response.invoice);
  remote.qbId = response.qbId || remote.qbId || settledLocal.qbId;
  remote.paymentLink = response.paymentLink || remote.paymentLink || settledLocal.paymentLink;
  if (response.qbContentFingerprint) {
    remote.qbContentFingerprint = response.qbContentFingerprint;
  }
  const reconciled = reconcileQuickBooksInvoice(settledLocal, remote);
  reconciled.paymentLink = response.paymentLink || reconciled.paymentLink || "";
  reconciled.qbPushed = true;
  return reconciled;
}
