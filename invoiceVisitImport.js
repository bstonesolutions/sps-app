const text = (value) => String(value == null ? "" : value).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const number = (value) => {
  const parsed = Number.parseFloat(text(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const decimal = (value) => String(Math.round((number(value) + Number.EPSILON) * 1e10) / 1e10);
const safeIdPart = (value) => text(value)
  .replace(/[^a-zA-Z0-9_-]+/g, "_")
  .replace(/^_+|_+$/g, "") || "visit";

// A small deterministic hash keeps legacy history entries stable even when they predate
// completion receipts and scheduled-stop IDs. It is only an identity key, never a secret.
const stableHash = (value) => {
  let hash = 2166136261;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const visitFingerprint = (visit, clientId) => [
  text(clientId),
  text(visit?.date),
  text(visit?.type),
  text(visit?.tech),
  text(visit?.notes),
  text(visit?.invoice),
].join("|");

const normalizedLineText = (value) => text(value).replace(/\s+/g, " ").toLowerCase();
const normalizedLineNumber = (value) => decimal(value || 0);

const hasRecordedVisitSource = (invoice) => !!(
  text(invoice?.sourceStopId)
  || list(invoice?.sourceStopIds).some(value => text(value))
  || text(invoice?.sourceCompletionReceiptId)
  || list(invoice?.sourceCompletionReceiptIds).some(value => text(value))
  || list(invoice?.lineItems).some(line => (
    text(line?.sourceStopId)
    || list(line?.sourceStopIds).some(value => text(value))
    || text(line?.sourceCompletionReceiptId)
    || list(line?.sourceCompletionReceiptIds).some(value => text(value))
  ))
);

export function completedVisitSource(visit, { clientId = "" } = {}) {
  const sourceCompletionReceiptId = text(visit?.completionReceiptId || visit?.receiptId);
  const explicitStopId = text(visit?.sid || visit?.stopId || visit?.visitId);
  const fallback = sourceCompletionReceiptId
    ? `receipt_${safeIdPart(sourceCompletionReceiptId)}`
    : `history_${stableHash(visitFingerprint(visit, clientId))}`;
  const sourceStopId = explicitStopId || fallback;
  const key = sourceCompletionReceiptId
    ? `receipt:${sourceCompletionReceiptId}`
    : `stop:${sourceStopId}`;
  return { key, sourceStopId, sourceCompletionReceiptId };
}

const lineSourceValues = (line, singular, plural) => [
  text(line?.[singular]),
  ...list(line?.[plural]).map(text),
].filter(Boolean);

export function invoiceContainsCompletedVisit(invoice, visit, { clientId = "" } = {}) {
  const source = completedVisitSource(visit, { clientId });
  const stopIds = new Set([
    text(invoice?.sourceStopId),
    ...list(invoice?.sourceStopIds).map(text),
  ].filter(Boolean));
  const receiptIds = new Set([
    text(invoice?.sourceCompletionReceiptId),
    ...list(invoice?.sourceCompletionReceiptIds).map(text),
  ].filter(Boolean));

  list(invoice?.lineItems).forEach((line) => {
    lineSourceValues(line, "sourceStopId", "sourceStopIds").forEach((id) => stopIds.add(id));
    lineSourceValues(line, "sourceCompletionReceiptId", "sourceCompletionReceiptIds").forEach((id) => receiptIds.add(id));
  });

  return stopIds.has(source.sourceStopId)
    || (!!source.sourceCompletionReceiptId && receiptIds.has(source.sourceCompletionReceiptId));
}

export function invoiceCompletedVisitSources(invoice) {
  const stopIds = new Set([
    text(invoice?.sourceStopId),
    ...list(invoice?.sourceStopIds).map(text),
  ].filter(Boolean));
  const receiptIds = new Set([
    text(invoice?.sourceCompletionReceiptId),
    ...list(invoice?.sourceCompletionReceiptIds).map(text),
  ].filter(Boolean));
  const clientIds = new Set([
    text(invoice?.sourceVisitClientId),
    ...list(invoice?.sourceVisitClientIds).map(text),
  ].filter(Boolean));

  list(invoice?.lineItems).forEach((line) => {
    lineSourceValues(line, "sourceStopId", "sourceStopIds").forEach((id) => stopIds.add(id));
    lineSourceValues(line, "sourceCompletionReceiptId", "sourceCompletionReceiptIds").forEach((id) => receiptIds.add(id));
  });

  return {
    sourceStopIds: [...stopIds],
    sourceCompletionReceiptIds: [...receiptIds],
    sourceVisitClientIds: [...clientIds],
    hasSources: stopIds.size > 0 || receiptIds.size > 0,
  };
}

// Before provenance was introduced, "From a visit" replaced the whole invoice with
// this exact ordered set of lines. This serializer intentionally mirrors that old path.
// It is used only as a conservative duplicate fence, never to silently backfill data.
const legacyCompletedVisitLines = (visit) => {
  const lines = [];
  list(visit?.services).forEach((rawService) => {
    const service = typeof rawService === "string" ? { name: rawService } : (rawService || {});
    lines.push({
      desc: text(service.name),
      qty: "1",
      unitPrice: typeof rawService === "string" ? "" : text(service.price),
      unitCost: "",
      taxable: false,
      kind: "service",
    });
  });
  list(visit?.partsUsed).forEach((part) => {
    if (!part || part.bill === false) return;
    lines.push({
      desc: text(part.name),
      qty: decimal(part.qty || 1),
      unitPrice: text(part.retailPer || part.costPer),
      unitCost: text(part.costPer || 0),
      taxable: true,
      kind: "part",
    });
  });
  list(visit?.productsPurchased).forEach((product) => {
    if (!product || product.bill === false) return;
    lines.push({
      desc: text(product.name),
      qty: decimal(product.qty || 1),
      unitPrice: text(product.price || product.retail),
      unitCost: text(product.cost || 0),
      taxable: true,
      kind: "product",
    });
  });
  return lines;
};

const legacyLineMatches = (line, expected) => {
  const actualKind = normalizedLineText(line?.kind);
  const kindMatches = expected.kind === "service"
    ? (!actualKind || actualKind === "service" || actualKind === "custom")
    : actualKind === expected.kind;
  return normalizedLineText(line?.desc ?? line?.description ?? line?.name) === normalizedLineText(expected.desc)
    && normalizedLineNumber(line?.qty ?? 1) === normalizedLineNumber(expected.qty)
    && normalizedLineNumber(line?.unitPrice ?? line?.price ?? line?.rate) === normalizedLineNumber(expected.unitPrice)
    && (expected.kind === "service"
      || normalizedLineNumber(line?.unitCost ?? line?.cost) === normalizedLineNumber(expected.unitCost))
    && (line?.taxable === true) === expected.taxable
    && kindMatches;
};

export function legacyCompletedVisitInvoiceMatch(invoice, visit, { clientId = "" } = {}) {
  if (!invoice || hasRecordedVisitSource(invoice)) return false;
  if (!text(clientId) || text(invoice.clientId) !== text(clientId)) return false;
  const expectedLines = legacyCompletedVisitLines(visit);
  const actualLines = list(invoice.lineItems);
  if (!expectedLines.length || expectedLines.length !== actualLines.length) return false;
  return expectedLines.every((expected, index) => legacyLineMatches(actualLines[index], expected));
}

export function completedVisitInvoiceLink(visit, invoices, { clientId = "", currentInvoiceId = "", visits = [] } = {}) {
  const matching = list(invoices).find((invoice) => invoiceContainsCompletedVisit(invoice, visit, { clientId }));
  if (matching) {
    return {
      invoiceId: matching.id,
      invoiceNumber: text(matching.number),
      current: !!currentInvoiceId && text(matching.id) === text(currentInvoiceId),
    };
  }

  // Old imports carried no source ids. Only recognize an exact old-serializer match,
  // and report ambiguity rather than guessing when routine visits repeat.
  const legacyInvoices = list(invoices).filter((invoice) => legacyCompletedVisitInvoiceMatch(invoice, visit, { clientId }));
  if (!legacyInvoices.length) return null;
  const legacyInvoice = legacyInvoices[0];
  const matchingVisits = list(visits).filter((candidate) => (
    legacyCompletedVisitInvoiceMatch(legacyInvoice, candidate, { clientId })
  ));
  const ambiguous = legacyInvoices.length !== 1 || matchingVisits.length !== 1;
  return {
    invoiceId: legacyInvoice.id,
    invoiceNumber: text(legacyInvoice.number),
    current: !!currentInvoiceId && text(legacyInvoice.id) === text(currentInvoiceId),
    legacy: true,
    ambiguous,
  };
}

export function completedVisitInvoiceSaveConflict(candidateInvoice, invoices, visits, { clientId = "" } = {}) {
  const candidateId = text(candidateInvoice?.id);
  const candidateClientId = text(candidateInvoice?.clientId ?? clientId);
  const sources = invoiceCompletedVisitSources(candidateInvoice);
  if (!sources.hasSources) return null;

  if (sources.sourceVisitClientIds.some(sourceClientId => sourceClientId !== candidateClientId)) {
    return {
      code: "visit-client-mismatch",
      message: "Completed visits belong to a different client. Remove those visit lines before changing the invoice client.",
    };
  }

  // A short-lived version of the multi-visit importer recorded stop/receipt ids before it
  // recorded the owning client. Do not let those invoices become a client-change loophole.
  // The only safe automatic upgrade is when every recorded source can still be resolved in
  // the selected client's own completed history; otherwise require the visit lines to be
  // removed and imported again under the correct client.
  if (!sources.sourceVisitClientIds.length) {
    const visitSources = list(visits).map(visit => completedVisitSource(visit, { clientId: candidateClientId }));
    const knownStopIds = new Set(visitSources.map(source => source.sourceStopId).filter(Boolean));
    const knownReceiptIds = new Set(visitSources.map(source => source.sourceCompletionReceiptId).filter(Boolean));
    const unresolvedStopId = sources.sourceStopIds.find(id => !knownStopIds.has(id));
    const unresolvedReceiptId = sources.sourceCompletionReceiptIds.find(id => !knownReceiptIds.has(id));
    if (unresolvedStopId || unresolvedReceiptId) {
      return {
        code: "visit-client-unverified",
        sourceStopId: unresolvedStopId || "",
        sourceCompletionReceiptId: unresolvedReceiptId || "",
        message: "SPS cannot verify that the attached visits belong to this client. Remove those visit lines and import them again before saving.",
      };
    }
  }

  const otherInvoices = list(invoices).filter((invoice) => text(invoice?.id) !== candidateId);
  const candidateStopIds = new Set(sources.sourceStopIds);
  const candidateReceiptIds = new Set(sources.sourceCompletionReceiptIds);
  for (const otherInvoice of otherInvoices) {
    const otherSources = invoiceCompletedVisitSources(otherInvoice);
    const sharedStopId = otherSources.sourceStopIds.find(id => candidateStopIds.has(id));
    const sharedReceiptId = otherSources.sourceCompletionReceiptIds.find(id => candidateReceiptIds.has(id));
    if (sharedStopId || sharedReceiptId) {
      return {
        code: "visit-already-linked",
        invoiceId: otherInvoice.id,
        invoiceNumber: text(otherInvoice.number),
        sourceStopId: sharedStopId || "",
        sourceCompletionReceiptId: sharedReceiptId || "",
        message: `A selected visit is already linked to invoice ${text(otherInvoice.number) || text(otherInvoice.id) || "another invoice"}.`,
      };
    }
  }

  const matchingVisits = list(visits).filter((visit) => {
    const source = completedVisitSource(visit, { clientId: candidateClientId });
    return candidateStopIds.has(source.sourceStopId)
      || (!!source.sourceCompletionReceiptId && candidateReceiptIds.has(source.sourceCompletionReceiptId));
  });
  for (const visit of matchingVisits) {
    const link = completedVisitInvoiceLink(visit, otherInvoices, {
      clientId: candidateClientId,
      currentInvoiceId: candidateId,
      visits,
    });
    if (link) {
      return {
        code: link.legacy ? "possible-legacy-visit-link" : "visit-already-linked",
        ...link,
        message: link.legacy
          ? `This visit appears to be represented by legacy invoice ${link.invoiceNumber || link.invoiceId || "another invoice"}. Review that invoice before billing the visit again.`
          : `A selected visit is already linked to invoice ${link.invoiceNumber || link.invoiceId || "another invoice"}.`,
      };
    }
  }
  return null;
}

export function reserveCompletedVisitInvoice(candidateInvoice, invoices, visits, { clientId = "" } = {}) {
  const currentInvoices = list(invoices);
  const conflict = completedVisitInvoiceSaveConflict(candidateInvoice, currentInvoices, visits, { clientId });
  if (conflict) return { ok: false, conflict, invoices: currentInvoices };

  const sources = invoiceCompletedVisitSources(candidateInvoice);
  if (!sources.hasSources) {
    return { ok: true, invoices: currentInvoices, reservedInvoice: candidateInvoice, changed: false };
  }

  const candidateClientId = text(candidateInvoice?.clientId ?? clientId);
  const sourceVisitClientIds = sources.sourceVisitClientIds.length
    ? sources.sourceVisitClientIds
    : (candidateClientId ? [candidateClientId] : []);
  const normalizedCandidate = {
    ...candidateInvoice,
    sourceVisitClientIds,
    ...(sourceVisitClientIds.length === 1 ? { sourceVisitClientId: sourceVisitClientIds[0] } : {}),
  };
  const candidateId = text(candidateInvoice?.id);
  const index = currentInvoices.findIndex(invoice => text(invoice?.id) === candidateId);
  if (index < 0) {
    return {
      ok: true,
      invoices: [normalizedCandidate, ...currentInvoices],
      reservedInvoice: normalizedCandidate,
      changed: true,
    };
  }

  // Existing accounting fields may have changed since this editor opened. Reserve only
  // the visit identities on that latest record; the normal invoice save still owns edits.
  const latest = currentInvoices[index];
  const latestSources = invoiceCompletedVisitSources(latest);
  const reservedInvoice = {
    ...latest,
    sourceStopIds: [...new Set([...latestSources.sourceStopIds, ...sources.sourceStopIds])],
    sourceCompletionReceiptIds: [...new Set([
      ...latestSources.sourceCompletionReceiptIds,
      ...sources.sourceCompletionReceiptIds,
    ])],
    sourceVisitClientIds: [...new Set([
      ...latestSources.sourceVisitClientIds,
      ...sourceVisitClientIds,
    ])],
  };
  if (reservedInvoice.sourceVisitClientIds.length === 1) {
    reservedInvoice.sourceVisitClientId = reservedInvoice.sourceVisitClientIds[0];
  }
  return {
    ok: true,
    invoices: currentInvoices.map((invoice, itemIndex) => itemIndex === index ? reservedInvoice : invoice),
    reservedInvoice,
    changed: JSON.stringify(reservedInvoice) !== JSON.stringify(latest),
  };
}

export function removeInvoiceLineAndPruneCompletedVisitSources(invoice, lineId) {
  const base = invoice && typeof invoice === "object" ? invoice : {};
  const lines = list(base.lineItems);
  const removedLine = lines.find(line => text(line?.id) === text(lineId));
  const nextLines = lines.filter(line => text(line?.id) !== text(lineId));
  if (!removedLine) return { ...base, lineItems: nextLines };

  const removedStopIds = new Set(lineSourceValues(removedLine, "sourceStopId", "sourceStopIds"));
  const removedReceiptIds = new Set(lineSourceValues(
    removedLine,
    "sourceCompletionReceiptId",
    "sourceCompletionReceiptIds",
  ));

  // Older completion drafts kept visit provenance only on the invoice. QuickBooks
  // reconciliation could therefore leave the service row untagged even though the
  // invoice still carried one stop/receipt lock. Treat removal of the final explicit
  // service row as unlinking that one legacy visit. Never infer this from description
  // text, and never clear a multi-visit invoice or an unrelated product/custom row.
  if (!removedStopIds.size && !removedReceiptIds.size) {
    const baseSources = invoiceCompletedVisitSources(base);
    const removedKind = text(removedLine?.kind).trim().toLowerCase();
    const remainingHasService = nextLines.some(line => text(line?.kind).trim().toLowerCase() === "service");
    const remainingHasLineSources = nextLines.some(line => (
      lineSourceValues(line, "sourceStopId", "sourceStopIds").length
      || lineSourceValues(line, "sourceCompletionReceiptId", "sourceCompletionReceiptIds").length
    ));
    const removesSingleLegacyVisit = (
      removedKind === "service"
      && baseSources.sourceStopIds.length === 1
      && baseSources.sourceCompletionReceiptIds.length <= 1
      && !remainingHasService
      && !remainingHasLineSources
    );

    if (!removesSingleLegacyVisit) return { ...base, lineItems: nextLines };
    return {
      ...base,
      lineItems: nextLines,
      sourceStopId: undefined,
      sourceStopIds: [],
      sourceCompletionReceiptId: undefined,
      sourceCompletionReceiptIds: [],
      sourceVisitClientId: undefined,
      sourceVisitClientIds: [],
    };
  }

  const remainingStopIds = new Set();
  const remainingReceiptIds = new Set();
  nextLines.forEach((line) => {
    lineSourceValues(line, "sourceStopId", "sourceStopIds").forEach(id => remainingStopIds.add(id));
    lineSourceValues(line, "sourceCompletionReceiptId", "sourceCompletionReceiptIds").forEach(id => remainingReceiptIds.add(id));
  });

  const next = {
    ...base,
    lineItems: nextLines,
    sourceStopIds: list(base.sourceStopIds).map(text).filter(id => (
      !removedStopIds.has(id) || remainingStopIds.has(id)
    )),
    sourceCompletionReceiptIds: list(base.sourceCompletionReceiptIds).map(text).filter(id => (
      !removedReceiptIds.has(id) || remainingReceiptIds.has(id)
    )),
  };
  if (removedStopIds.has(text(next.sourceStopId)) && !remainingStopIds.has(text(next.sourceStopId))) {
    next.sourceStopId = undefined;
  }
  if (
    removedReceiptIds.has(text(next.sourceCompletionReceiptId))
    && !remainingReceiptIds.has(text(next.sourceCompletionReceiptId))
  ) {
    next.sourceCompletionReceiptId = undefined;
  }
  if (!invoiceCompletedVisitSources(next).hasSources) {
    next.sourceVisitClientId = undefined;
    next.sourceVisitClientIds = [];
  }
  return next;
}

const lineBase = (source) => ({
  sourceStopId: source.sourceStopId,
  ...(source.sourceCompletionReceiptId ? { sourceCompletionReceiptId: source.sourceCompletionReceiptId } : {}),
});

export function completedVisitLineItems(visit, { clientId = "" } = {}) {
  const source = completedVisitSource(visit, { clientId });
  const idRoot = `il_visit_${safeIdPart(source.sourceStopId)}`;
  const lines = [];

  list(visit?.services).forEach((rawService, index) => {
    const service = typeof rawService === "string" ? { name: rawService } : (rawService || {});
    const desc = text(service.name || service.desc || service.description || visit?.type) || "Service visit";
    const costKnown = hasOwn(service, "cost") || hasOwn(service, "unitCost");
    lines.push({
      id: `${idRoot}_service_${safeIdPart(service.id || service.refId || index + 1)}`,
      desc,
      qty: decimal(service.qty || 1),
      unitPrice: hasOwn(service, "price") || hasOwn(service, "unitPrice")
        ? decimal(service.price ?? service.unitPrice)
        : "",
      unitCost: costKnown ? decimal(service.cost ?? service.unitCost) : "",
      costKnown,
      taxable: false,
      kind: "service",
      ...(service.id != null || service.refId != null ? { refId: service.refId ?? service.id } : {}),
      ...lineBase(source),
    });
  });

  list(visit?.partsUsed).forEach((part, index) => {
    if (!part || part.bill === false) return;
    const qty = number(part.qty) || 1;
    const costKnown = hasOwn(part, "costPer") || hasOwn(part, "cost");
    const unitCost = hasOwn(part, "costPer") ? number(part.costPer) : number(part.cost) / qty;
    const unitPrice = number(part.retailPer) || number(part.retail) / qty;
    lines.push({
      id: `${idRoot}_part_${safeIdPart(part.id || index + 1)}`,
      desc: text(part.name) || "Part",
      qty: decimal(qty),
      unitPrice: unitPrice ? decimal(unitPrice) : "",
      unitCost: costKnown ? decimal(unitCost) : "",
      costKnown,
      taxable: part.taxable !== false,
      kind: "part",
      ...(part.id != null ? { refId: part.id } : {}),
      ...(text(part.unit) ? { unit: text(part.unit) } : {}),
      ...lineBase(source),
    });
  });

  list(visit?.productsPurchased).forEach((product, index) => {
    if (!product || product.bill === false) return;
    const qty = number(product.qty) || 1;
    const costKnown = hasOwn(product, "cost") || hasOwn(product, "costTotal");
    const unitCost = hasOwn(product, "cost") ? number(product.cost) : number(product.costTotal) / qty;
    const unitPrice = number(product.price) || number(product.retail) / qty;
    lines.push({
      id: `${idRoot}_product_${safeIdPart(product.id || index + 1)}`,
      desc: text(product.name) || "Product",
      qty: decimal(qty),
      unitPrice: unitPrice ? decimal(unitPrice) : "",
      unitCost: costKnown ? decimal(unitCost) : "",
      costKnown,
      taxable: product.taxable !== false,
      kind: "product",
      ...(product.id != null ? { refId: product.id } : {}),
      ...(text(product.unit) ? { unit: text(product.unit) } : {}),
      ...lineBase(source),
    });
  });

  return lines;
}

export function completedVisitBillableTotal(visit, options) {
  return completedVisitLineItems(visit, options).reduce((sum, line) => (
    sum + number(line.qty) * number(line.unitPrice)
  ), 0);
}

export function appendCompletedVisitsToInvoice(invoice, visits, { clientId = "" } = {}) {
  const base = invoice && typeof invoice === "object" ? invoice : {};
  const existingLineItems = list(base.lineItems);
  const accepted = [];
  const skipped = [];
  const working = { ...base, lineItems: [...existingLineItems] };

  list(visits).forEach((visit) => {
    const source = completedVisitSource(visit, { clientId });
    if (invoiceContainsCompletedVisit(working, visit, { clientId })) {
      skipped.push(source.key);
      return;
    }
    const nextLines = completedVisitLineItems(visit, { clientId });
    if (!nextLines.length) {
      skipped.push(source.key);
      return;
    }
    working.lineItems.push(...nextLines);
    working.sourceStopIds = [...new Set([...list(working.sourceStopIds).map(text), source.sourceStopId].filter(Boolean))];
    working.sourceVisitClientIds = [...new Set([
      ...list(working.sourceVisitClientIds).map(text),
      text(clientId),
    ].filter(Boolean))];
    if (working.sourceVisitClientIds.length === 1) working.sourceVisitClientId = working.sourceVisitClientIds[0];
    if (source.sourceCompletionReceiptId) {
      working.sourceCompletionReceiptIds = [...new Set([
        ...list(working.sourceCompletionReceiptIds).map(text),
        source.sourceCompletionReceiptId,
      ].filter(Boolean))];
    }
    accepted.push(source.key);
  });

  return {
    invoice: working,
    lineItems: working.lineItems,
    sourceStopIds: list(working.sourceStopIds),
    sourceCompletionReceiptIds: list(working.sourceCompletionReceiptIds),
    sourceVisitClientIds: list(working.sourceVisitClientIds),
    addedVisitKeys: accepted,
    skippedVisitKeys: skipped,
    addedLineCount: working.lineItems.length - existingLineItems.length,
  };
}
