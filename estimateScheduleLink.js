import {
  estimateLineAmount,
  estimateLineHasKnownCost,
  estimateLineIsTaxable,
  estimateLineQuantity,
  estimateLineUnitPrice,
  estimateNumberValue,
} from "./estimateMath.js";

export const ESTIMATE_SCHEDULE_LINK_VERSION = 2;

const text = (value) => String(value == null ? "" : value).trim();
const safeIdPart = (value) => text(value)
  .replace(/[^a-zA-Z0-9_-]+/g, "_")
  .replace(/^_+|_+$/g, "");
const copy = (value) => {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const schedulableStatuses = new Set(["approved", "accepted"]);
const inventoryKinds = new Set(["product", "treatment", "part"]);
const plannedInventoryConfigs = {
  treatment: { section: "treatments", entryKey: "treatmentsUsed", amountKey: "oz" },
  part: { section: "parts", entryKey: "partsUsed", amountKey: "qty" },
  product: { section: "products", entryKey: "productsPurchased", amountKey: "qty" },
};

const sameId = (left, right) => String(left) === String(right);
const quantity = (value) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 1e10) / 1e10;
  return Math.abs(rounded) < 1e-10 ? 0 : rounded;
};
const estimateIntegrityError = (code, message, itemName = "") => Object.assign(
  new Error(message),
  { code, itemName },
);

function estimateId(estimate) {
  return text(estimate?.id);
}

function scheduledDayLabel(date) {
  const [month, day, year] = text(date).split("/").map(Number);
  if (!month || !day || !year) return text(date);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "long" });
}

function usableEstimateLines(estimate) {
  return (Array.isArray(estimate?.items) ? estimate.items : []).filter((line) => (
    [line?.price, line?.unitPrice, line?.amount]
      .some((value) => value != null && text(value) !== "")
  ));
}

function estimateLineSnapshot(line, index, estimate) {
  const qty = estimateLineQuantity(line);
  const unitPrice = estimateLineUnitPrice(line);
  const lineTotal = estimateLineAmount(line);
  const costKnown = estimateLineHasKnownCost(line);
  return {
    id: line?.id || `estimate-line-${index + 1}`,
    description: text(line?.desc ?? line?.description) || "Estimate item",
    kind: text(line?.kind).toLowerCase() || "custom",
    ...(text(line?.chargeType) ? { chargeType: text(line.chargeType).toLowerCase() } : {}),
    ...(text(line?.chargeLabel) ? { chargeLabel: text(line.chargeLabel) } : {}),
    refId: line?.refId ?? null,
    quantity: String(qty),
    unit: text(line?.unit) || "each",
    unitPrice: String(unitPrice),
    lineTotal: String(lineTotal),
    unitCost: costKnown ? String(estimateNumberValue(line?.unitCost ?? line?.cost)) : "",
    costKnown,
    taxable: estimateLineIsTaxable(line, estimate),
    ...(text(line?.bundleNote) ? { bundleNote: text(line.bundleNote) } : {}),
    ...(Array.isArray(line?.bundleItems)
      ? { bundleItems: line.bundleItems.map((item) => ({ ...copy(item) })) }
      : {}),
  };
}

function backfillTaxableSnapshots(lines, estimate, sourceLines, sourceIdField) {
  const list = Array.isArray(lines) ? lines : [];
  const sourceById = new Map(sourceLines.map((line) => [text(line?.id), line]));
  let changed = false;
  const value = list.map((line, index) => {
    if (typeof line?.taxable === "boolean") return line;
    const sourceId = text(line?.[sourceIdField]);
    const sourceLine = sourceById.get(sourceId) || sourceLines[index] || line;
    changed = true;
    return { ...line, taxable: estimateLineIsTaxable(sourceLine, estimate) };
  });
  return { value, changed };
}

function plannedMaterialFromLine(snapshot, suffix = "") {
  return {
    id: `planned_${safeIdPart(snapshot.id)}${suffix}`,
    kind: snapshot.kind,
    refId: snapshot.refId,
    name: snapshot.description,
    quantity: snapshot.quantity,
    unit: snapshot.unit,
    sourceEstimateLineId: snapshot.id,
    catalogLinked: snapshot.refId != null && text(snapshot.refId) !== "",
    inventoryDisposition: "consume-on-completion",
    billingDisposition: "included-in-estimate",
    plannedOnly: true,
  };
}

function plannedMaterialsFromLines(lines) {
  const materials = [];
  lines.forEach((line) => {
    if (inventoryKinds.has(line.kind)) {
      if (line.refId != null && text(line.refId)) materials.push(plannedMaterialFromLine(line));
      return;
    }
    if (line.kind !== "bundle") return;
    (line.bundleItems || []).forEach((item, index) => {
      const parentQty = estimateNumberValue(line.quantity);
      const childQty = estimateNumberValue(item?.qty ?? item?.quantity ?? 1);
      const quantity = parentQty * childQty;
      if (!(quantity > 0)) return;
      const kind = inventoryKinds.has(text(item?.kind).toLowerCase())
        ? text(item.kind).toLowerCase()
        : "part";
      if (item?.refId == null || !text(item.refId)) return;
      materials.push(plannedMaterialFromLine({
        id: line.id,
        kind,
        refId: item?.refId ?? null,
        description: text(item?.name) || line.description,
        quantity: String(quantity),
        unit: text(item?.unit) || "pieces",
      }, `_${safeIdPart(item?.refId || index + 1)}`));
    });
  });
  const byCatalogItem = new Map();
  materials.forEach((material) => {
    const key = `${material.kind}:${text(material.refId)}`;
    const prior = byCatalogItem.get(key);
    if (!prior) {
      byCatalogItem.set(key, material);
      return;
    }
    byCatalogItem.set(key, {
      ...prior,
      quantity: String(estimateNumberValue(prior.quantity) + estimateNumberValue(material.quantity)),
      sourceEstimateLineIds: [
        ...(prior.sourceEstimateLineIds || [prior.sourceEstimateLineId]),
        material.sourceEstimateLineId,
      ].filter(Boolean),
    });
  });
  return [...byCatalogItem.values()];
}

// The scheduled stop is the durable inventory plan for an approved estimate. Completion must not
// trust the browser to echo these lines back: a stale screen, removed form line, or renamed catalog
// item would otherwise let the stop finish without consuming the material that was sold.
export function prepareScheduledEstimateCompletionEntry(stop, entry, catalog) {
  if (!stop || text(stop.source) !== "estimate" || !text(stop.sourceEstimateId)) {
    return { entry, requirements: [] };
  }
  if (!Array.isArray(stop.plannedMaterials)) {
    throw estimateIntegrityError(
      "estimate-materials-invalid",
      "This estimate stop has no reliable material plan. Reopen the estimate and schedule it again before completing the work.",
    );
  }

  const grouped = new Map();
  for (const material of stop.plannedMaterials) {
    const kind = text(material?.kind).toLowerCase();
    const config = plannedInventoryConfigs[kind];
    const refId = text(material?.refId);
    const amount = quantity(material?.quantity);
    const itemName = text(material?.name) || "Estimate material";
    if (!config || !refId || !(amount > 0)) {
      throw estimateIntegrityError(
        "estimate-materials-invalid",
        `${itemName} is not linked to a valid catalog item and quantity. Repair the estimate before completing the stop.`,
        itemName,
      );
    }
    const key = `${config.section}:${refId}`;
    const prior = grouped.get(key);
    grouped.set(key, prior
      ? { ...prior, amount: quantity(prior.amount + amount) }
      : { ...config, kind, refId, amount, itemName, unit: text(material?.unit) });
  }

  const nextEntry = { ...(entry || {}) };
  const requirements = [];
  for (const planned of grouped.values()) {
    const catalogMatches = (Array.isArray(catalog?.[planned.section]) ? catalog[planned.section] : [])
      .filter((item) => item && sameId(item.id, planned.refId));
    if (!catalogMatches.length) {
      throw estimateIntegrityError(
        "inventory-item-missing",
        `${planned.itemName} was removed from inventory. Restore or relink it before completing this estimate stop.`,
        planned.itemName,
      );
    }
    if (catalogMatches.length !== 1) {
      throw estimateIntegrityError(
        "inventory-item-ambiguous",
        `${planned.itemName} appears more than once in inventory. Merge the duplicates before completing this estimate stop.`,
        planned.itemName,
      );
    }

    const catalogItem = catalogMatches[0];
    const submitted = Array.isArray(nextEntry[planned.entryKey])
      ? nextEntry[planned.entryKey].map((line) => ({ ...line }))
      : [];
    const matchingIndexes = submitted
      .map((line, index) => (line && sameId(line.id, planned.refId) ? index : -1))
      .filter((index) => index >= 0);
    if (matchingIndexes.length > 1) {
      throw estimateIntegrityError(
        "inventory-usage-duplicate",
        `${catalogItem.name || planned.itemName} appears more than once in this report. Combine the duplicate usage lines before saving.`,
        String(catalogItem.name || planned.itemName),
      );
    }

    const existingIndex = matchingIndexes[0];
    const existing = existingIndex == null ? null : submitted[existingIndex];
    // The quote establishes the minimum consumption. A technician may record a larger actual
    // amount, but cannot lower or remove the approved material by editing the completion form.
    const requestedAmount = Math.max(
      planned.amount,
      existing ? quantity(existing[planned.amountKey]) : 0,
    );
    const canonicalLine = {
      ...(existing || {}),
      id: copy(catalogItem.id),
      name: String(catalogItem.name || planned.itemName),
      unit: String(catalogItem.unit || planned.unit || ""),
      [planned.amountKey]: requestedAmount,
      ...(text(existing?.locId || nextEntry.usageLoc)
        ? { locId: text(existing?.locId || nextEntry.usageLoc) }
        : {}),
    };
    if (existingIndex == null) submitted.push(canonicalLine);
    else submitted[existingIndex] = canonicalLine;
    nextEntry[planned.entryKey] = submitted;
    requirements.push({
      section: planned.section,
      itemId: copy(catalogItem.id),
      itemName: canonicalLine.name,
      requestedAmount,
    });
  }

  return { entry: nextEntry, requirements };
}

export function assertScheduledEstimateInventoryApplied(requirements, inventoryReceipt) {
  for (const required of Array.isArray(requirements) ? requirements : []) {
    const matches = (Array.isArray(inventoryReceipt) ? inventoryReceipt : [])
      .filter((line) => (
        line
        && line.section === required.section
        && sameId(line.itemId, required.itemId)
      ));
    const deducted = matches.reduce((sum, line) => (
      sum + (Array.isArray(line.deductions) ? line.deductions : [])
        .reduce((lineSum, delta) => lineSum + quantity(delta?.amount), 0)
    ), 0);
    if (matches.length !== 1 || deducted + 1e-8 < required.requestedAmount) {
      throw estimateIntegrityError(
        "estimate-inventory-not-applied",
        `${required.itemName || "An estimate material"} could not be fully deducted from inventory. Correct its stock quantity or location before completing the stop.`,
        required.itemName || "",
      );
    }
  }
  return true;
}

export function estimateScheduledStopId(estimate) {
  const source = safeIdPart(estimate?.id || estimate?.number);
  if (!source) throw new Error("Save the estimate before scheduling it.");
  return `stop_est_${source}`;
}

export function findScheduledStopForEstimate(schedule, estimate) {
  const days = Array.isArray(schedule) ? schedule : [];
  const explicitId = text(estimate?.linkedScheduledStopId);
  const sourceId = estimateId(estimate);
  let deterministicId = "";
  try { deterministicId = estimateScheduledStopId(estimate); } catch (_) {}

  const matches = [];
  days.forEach((day, dayIndex) => {
    (Array.isArray(day?.stops) ? day.stops : []).forEach((stop, stopIndex) => {
      const explicitMatch = explicitId && text(stop?.sid) === explicitId;
      const sourceMatch = sourceId && text(stop?.sourceEstimateId) === sourceId;
      const deterministicMatch = deterministicId && text(stop?.sid) === deterministicId;
      if (explicitMatch || sourceMatch || deterministicMatch) {
        matches.push({ day, dayIndex, stop, stopIndex });
      }
    });
  });

  if (matches.length > 1) {
    throw new Error("This estimate is linked to more than one scheduled stop. Review the duplicates before continuing.");
  }
  return matches[0] || null;
}

export function scheduleApprovedEstimate(estimate, schedule, {
  client,
  date,
  time = "",
  duration = "60",
  assigneeId = "",
  stopType = "",
  createdAt = Date.now(),
} = {}) {
  const sourceId = estimateId(estimate);
  if (!sourceId) throw new Error("Save the estimate before scheduling it.");
  if (!client || client.id == null || text(client.id) === "") {
    throw new Error("Choose the estimate's client before scheduling it.");
  }
  if (text(estimate?.clientId) && text(estimate.clientId) !== text(client.id)) {
    throw new Error("The scheduled client must match the estimate.");
  }

  const days = Array.isArray(schedule) ? schedule : [];
  const existing = findScheduledStopForEstimate(days, estimate);
  if (existing) {
    if (text(existing.stop?.sourceEstimateId) && text(existing.stop.sourceEstimateId) !== sourceId) {
      throw new Error("That scheduled stop is already linked to a different estimate.");
    }
    const estimateInvoiceId = text(estimate?.linkedInvoiceId);
    const stopInvoiceId = text(existing.stop?.linkedInvoiceId);
    if (estimateInvoiceId && stopInvoiceId && estimateInvoiceId !== stopInvoiceId) {
      throw new Error("This estimate and its scheduled stop are linked to different invoices. Review the links before continuing.");
    }
    const linkedInvoiceId = estimateInvoiceId || stopInvoiceId;
    const sourceEstimateStatus = text(estimate?.status) || text(existing.stop?.sourceEstimateStatus);
    const fulfillment = existing.stop?.estimateFulfillment || {};
    const billingDisposition = linkedInvoiceId
      ? "linked-invoice"
      : (text(fulfillment.billingDisposition) || "convert-estimate-once");
    const estimateTaxEnabled = estimate?.taxEnabled === true;
    const estimateTaxRate = text(estimate?.taxRate);
    const estimateTaxModel = text(estimate?.taxModel);
    const sourceLines = Array.isArray(estimate?.items) ? estimate.items : [];
    const estimateItemBackfill = backfillTaxableSnapshots(
      existing.stop?.estimateItems,
      estimate,
      sourceLines,
      "id",
    );
    const serviceBackfill = backfillTaxableSnapshots(
      existing.stop?.services,
      estimate,
      sourceLines,
      "sourceEstimateLineId",
    );
    const stopNeedsUpdate = (
      (linkedInvoiceId && stopInvoiceId !== linkedInvoiceId)
      || text(existing.stop?.sourceEstimateStatus) !== sourceEstimateStatus
      || existing.stop?.estimateTaxEnabled !== estimateTaxEnabled
      || text(existing.stop?.estimateTaxRate) !== estimateTaxRate
      || text(existing.stop?.estimateTaxModel) !== estimateTaxModel
      || text(fulfillment.billingDisposition) !== billingDisposition
      || Number(existing.stop?.estimateScheduleVersion) !== ESTIMATE_SCHEDULE_LINK_VERSION
      || Number(fulfillment.version) !== ESTIMATE_SCHEDULE_LINK_VERSION
      || estimateItemBackfill.changed
      || serviceBackfill.changed
    );
    const nextStop = stopNeedsUpdate
      ? {
        ...existing.stop,
        sourceEstimateStatus,
        ...(linkedInvoiceId ? { linkedInvoiceId } : {}),
        estimateTaxEnabled,
        estimateTaxRate,
        estimateTaxModel,
        estimateScheduleVersion: ESTIMATE_SCHEDULE_LINK_VERSION,
        estimateItems: estimateItemBackfill.value,
        services: serviceBackfill.value,
        estimateFulfillment: {
          ...fulfillment,
          version: ESTIMATE_SCHEDULE_LINK_VERSION,
          billingDisposition,
        },
      }
      : existing.stop;
    const nextSchedule = stopNeedsUpdate
      ? days.map((day, dayIndex) => (
        dayIndex === existing.dayIndex
          ? {
            ...day,
            stops: (Array.isArray(day?.stops) ? day.stops : []).map((stop, stopIndex) => (
              stopIndex === existing.stopIndex ? nextStop : stop
            )),
          }
          : day
      ))
      : days;
    const estimateNeedsUpdate = (
      text(estimate.linkedScheduledStopId) !== text(nextStop.sid)
      || (!estimateInvoiceId && !!linkedInvoiceId)
    );
    return {
      estimate: estimateNeedsUpdate
        ? {
          ...estimate,
          linkedScheduledStopId: nextStop.sid,
          ...(linkedInvoiceId ? { linkedInvoiceId } : {}),
        }
        : estimate,
      schedule: nextSchedule,
      stop: nextStop,
      existing: true,
    };
  }

  if (!schedulableStatuses.has(text(estimate?.status).toLowerCase())) {
    throw new Error("Approve the estimate before putting the work on the schedule.");
  }
  if (!text(date)) throw new Error("Choose a service date before scheduling the estimate.");

  const rawLines = usableEstimateLines(estimate);
  if (!rawLines.length) throw new Error("Add at least one priced line before scheduling the estimate.");
  const estimateItems = rawLines.map((line, index) => estimateLineSnapshot(line, index, estimate));
  const plannedMaterials = plannedMaterialsFromLines(estimateItems);
  const linkedInvoiceId = text(estimate?.linkedInvoiceId);
  const sid = estimateScheduledStopId(estimate);
  const timestamp = new Date(createdAt).toISOString();
  const stop = {
    sid,
    id: client.id,
    clientId: client.id,
    client: client.name || estimate.clientName || "Client",
    address: client.address || "",
    type: text(stopType) || estimate.title || "Approved Estimate",
    time: text(time),
    duration: `${text(duration).replace(/[^\d.]/g, "") || "60"} min`,
    assigneeId: text(assigneeId),
    source: "estimate",
    sourceEstimateId: estimate.id,
    sourceEstimateNumber: estimate.number || "",
    sourceEstimateTitle: estimate.title || "",
    sourceEstimateStatus: estimate.status,
    ...(linkedInvoiceId ? { linkedInvoiceId } : {}),
    estimateTaxEnabled: estimate?.taxEnabled === true,
    estimateTaxRate: text(estimate?.taxRate),
    estimateTaxModel: text(estimate?.taxModel),
    estimateScheduleVersion: ESTIMATE_SCHEDULE_LINK_VERSION,
    estimateItems,
    // Every quoted line is represented in the stop's existing service-price shape so the
    // completion screen starts with the approved total. Materials remain plans until completion;
    // merely scheduling the work never changes stock or posts another sale.
    services: estimateItems.map((line) => ({
      name: line.description,
      price: line.lineTotal,
      qty: line.quantity,
      unitPrice: line.unitPrice,
      kind: line.kind,
      ...(line.chargeType ? { chargeType: line.chargeType } : {}),
      ...(line.chargeLabel ? { chargeLabel: line.chargeLabel } : {}),
      refId: line.refId,
      taxable: line.taxable,
      sourceEstimateLineId: line.id,
      includedInEstimate: true,
    })),
    products: plannedMaterials.map((material) => ({ ...copy(material) })),
    plannedMaterials,
    estimateFulfillment: {
      version: ESTIMATE_SCHEDULE_LINK_VERSION,
      state: "scheduled",
      scheduledAt: timestamp,
      inventoryDisposition: "consume-on-completion",
      billingDisposition: linkedInvoiceId ? "linked-invoice" : "convert-estimate-once",
      completionReceiptId: null,
      completedAt: null,
    },
  };

  const nextSchedule = days.map((day) => ({
    ...day,
    stops: Array.isArray(day?.stops) ? [...day.stops] : [],
  }));
  const target = nextSchedule.find((day) => text(day?.date) === text(date));
  if (target) target.stops.push(stop);
  else nextSchedule.push({ date: text(date), day: scheduledDayLabel(date), stops: [stop] });

  return {
    estimate: {
      ...estimate,
      linkedScheduledStopId: sid,
      scheduledAt: timestamp,
      scheduledDate: text(date),
    },
    schedule: nextSchedule,
    stop,
    existing: false,
  };
}

export function claimScheduledEstimateCompletion(stop, {
  completionReceiptId,
  completedAt = new Date().toISOString(),
  linkedInvoiceId,
} = {}) {
  if (!stop || text(stop.source) !== "estimate" || !text(stop.sourceEstimateId)) {
    throw new Error("This stop is not linked to an estimate.");
  }
  const receiptId = text(completionReceiptId);
  if (!receiptId) throw new Error("A completion receipt is required.");
  const fulfillment = stop.estimateFulfillment || {};
  const priorReceiptId = text(fulfillment.completionReceiptId);
  if (priorReceiptId) {
    if (priorReceiptId !== receiptId) {
      throw new Error("This estimate stop was already completed by a different receipt.");
    }
    return {
      stop,
      alreadyClaimed: true,
      inventoryUsage: [],
      shouldPostInventory: false,
      shouldCreateInvoice: false,
      shouldPostRevenue: false,
    };
  }

  const invoiceId = text(linkedInvoiceId || stop.linkedInvoiceId);
  const inventoryUsage = (Array.isArray(stop.plannedMaterials) ? stop.plannedMaterials : [])
    .map((material) => copy(material));
  const nextStop = {
    ...stop,
    ...(invoiceId ? { linkedInvoiceId: invoiceId } : {}),
    estimateFulfillment: {
      ...fulfillment,
      version: ESTIMATE_SCHEDULE_LINK_VERSION,
      state: "completed",
      completionReceiptId: receiptId,
      completedAt,
      billingDisposition: invoiceId ? "linked-invoice" : "convert-estimate-once",
    },
  };

  return {
    stop: nextStop,
    alreadyClaimed: false,
    inventoryUsage,
    shouldPostInventory: inventoryUsage.length > 0,
    shouldCreateInvoice: !invoiceId,
    // Revenue belongs to the one linked/converted invoice. Completion records actual costs and
    // usage, but must never post a second sale for the same approved estimate.
    shouldPostRevenue: false,
  };
}

export function releaseScheduledEstimateCompletion(stop, {
  completionReceiptId,
  reopenedAt = new Date().toISOString(),
} = {}) {
  if (!stop || text(stop.source) !== "estimate" || !text(stop.sourceEstimateId)) {
    throw new Error("This stop is not linked to an estimate.");
  }
  const fulfillment = stop.estimateFulfillment || {};
  const activeReceiptId = text(fulfillment.completionReceiptId);
  const expectedReceiptId = text(completionReceiptId);
  if (!activeReceiptId) return { stop, alreadyReleased: true };
  if (expectedReceiptId && activeReceiptId !== expectedReceiptId) {
    throw new Error("This estimate stop was completed by a different receipt.");
  }
  return {
    stop: {
      ...stop,
      estimateFulfillment: {
        ...fulfillment,
        state: "reopened",
        completionReceiptId: null,
        completedAt: null,
        reopenedAt,
        priorCompletionReceiptId: activeReceiptId,
      },
    },
    alreadyReleased: false,
  };
}
