export const STOP_REVERSAL_LEDGER_KEY = "__stopReversalReceipts";
export const STOP_BALANCE_OWNER_KEY = "__spsCompletionBalanceReceipt";

const RECEIPT_VERSION = 1;
const COMPLETION_MARKER_VERSION = 2;
const INVENTORY_SECTIONS = [
  { section: "treatments", entryKey: "treatmentsUsed", amountKey: "oz" },
  { section: "parts", entryKey: "partsUsed", amountKey: "qty" },
  { section: "products", entryKey: "productsPurchased", amountKey: "qty" },
];
const INVENTORY_SECTION_NAMES = new Set(INVENTORY_SECTIONS.map((item) => item.section));
const RECEIPT_KEYS = new Set(["v", "id", "sid", "clientId", "idempotencyKey", "completedAt", "history", "balance", "inventory"]);
const HISTORY_RECEIPT_KEYS = new Set(["entryReceiptId", "historyHadOwn"]);
const BALANCE_RECEIPT_KEYS = new Set(["changed", "afterValue", "before"]);
const BALANCE_BEFORE_KEYS = new Set(["hadOwn", "value", "ownerReceiptId"]);
const INVENTORY_LINE_KEYS = new Set(["section", "itemId", "itemName", "unit", "requestedAmount", "deductions"]);
const INVENTORY_DELTA_KEYS = new Set(["locationId", "amount"]);
const COMPLETION_MARKER_KEYS = new Set(["v", "receiptId", "completedAt"]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const asArray = (value) => Array.isArray(value) ? value : [];
const finiteNumber = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const quantity = (value) => {
  const rounded = Math.round((finiteNumber(value) + Number.EPSILON) * 1e10) / 1e10;
  return Math.abs(rounded) < 1e-10 ? 0 : rounded;
};
const sameId = (left, right) => String(left) === String(right);
const sameValue = (left, right) => {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch (_) { return false; }
};
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
const isIdentity = (value) => (typeof value === "string" && value.trim() !== "") || (typeof value === "number" && Number.isFinite(value));
const isJsonSafe = (value, seen = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, seen))
    : Object.keys(value).every((key) => isJsonSafe(value[key], seen));
  seen.delete(value);
  return valid;
};
export const isNonnegativeMoneyString = (value) => {
  if (typeof value !== "string" || value.length > 24 || !/^\$\d+(?:\.\d{1,2})?$/.test(value)) return false;
  const amount = Number(value.slice(1));
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000_000;
};
export const normalizeCompletionInvoice = (value) => {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "$0";
  if (!/^\d+(?:\.\d*)?$/.test(raw)) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) return null;
  return amount === 0 ? "$0" : `$${amount.toFixed(2)}`;
};
const copy = (value) => {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

function receiptSchemaError(receipt) {
  if (!hasExactKeys(receipt, RECEIPT_KEYS) || receipt.v !== RECEIPT_VERSION) return "receipt-shape-invalid";
  if (typeof receipt.id !== "string" || !receipt.id || receipt.id.length > 320) return "receipt-id-invalid";
  if (!isIdentity(receipt.sid) || !isIdentity(receipt.clientId)) return "receipt-identity-invalid";
  if (typeof receipt.idempotencyKey !== "string" || receipt.idempotencyKey.length < 8 || receipt.idempotencyKey.length > 240) return "receipt-idempotency-invalid";
  if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt)) || new Date(receipt.completedAt).toISOString() !== receipt.completedAt) return "receipt-time-invalid";
  if (!hasExactKeys(receipt.history, HISTORY_RECEIPT_KEYS)) return "receipt-history-invalid";
  if (receipt.history.entryReceiptId !== receipt.id || typeof receipt.history.historyHadOwn !== "boolean") return "receipt-history-invalid";
  if (!hasExactKeys(receipt.balance, BALANCE_RECEIPT_KEYS) || typeof receipt.balance.changed !== "boolean") return "receipt-balance-invalid";
  if (!hasExactKeys(receipt.balance.before, BALANCE_BEFORE_KEYS) || typeof receipt.balance.before.hadOwn !== "boolean") return "receipt-balance-before-invalid";
  const before = receipt.balance.before;
  if (before.hadOwn ? !isJsonSafe(before.value) : before.value !== null) return "receipt-balance-before-invalid";
  if (before.ownerReceiptId !== null && (typeof before.ownerReceiptId !== "string" || !before.ownerReceiptId || !before.hadOwn)) return "receipt-balance-owner-invalid";
  if (receipt.balance.changed ? !isNonnegativeMoneyString(receipt.balance.afterValue) : receipt.balance.afterValue !== null) return "receipt-balance-after-invalid";
  if (!Array.isArray(receipt.inventory) || receipt.inventory.length > 1500) return "receipt-inventory-invalid";
  const seenItems = new Set();
  for (const line of receipt.inventory) {
    if (!hasExactKeys(line, INVENTORY_LINE_KEYS) || !INVENTORY_SECTION_NAMES.has(line.section) || !isIdentity(line.itemId)) return "receipt-inventory-line-invalid";
    if (typeof line.itemName !== "string" || !line.itemName || line.itemName.length > 500 || typeof line.unit !== "string" || line.unit.length > 100) return "receipt-inventory-line-invalid";
    if (!Number.isFinite(line.requestedAmount) || line.requestedAmount <= 0 || line.requestedAmount > 1_000_000_000_000 || !Array.isArray(line.deductions) || !line.deductions.length || line.deductions.length > 1000) return "receipt-inventory-line-invalid";
    const itemKey = `${line.section}:${String(line.itemId)}`;
    if (seenItems.has(itemKey)) return "receipt-inventory-duplicate-item";
    seenItems.add(itemKey);
    const seenLocations = new Set();
    let deducted = 0;
    for (const delta of line.deductions) {
      if (!hasExactKeys(delta, INVENTORY_DELTA_KEYS) || typeof delta.locationId !== "string" || !delta.locationId || delta.locationId.length > 220 || !Number.isFinite(delta.amount) || delta.amount <= 0 || delta.amount > 1_000_000_000_000) return "receipt-inventory-delta-invalid";
      if (seenLocations.has(delta.locationId)) return "receipt-inventory-duplicate-location";
      seenLocations.add(delta.locationId);
      deducted = quantity(deducted + delta.amount);
    }
    if (deducted > quantity(line.requestedAmount) + 1e-8) return "receipt-inventory-overdrawn";
  }
  return null;
}

export function validateStopReceipt(receipt) {
  const error = receiptSchemaError(receipt);
  return error ? { ok: false, code: error } : { ok: true };
}

function uniqueClientIndex(clients, clientId) {
  const matches = [];
  asArray(clients).forEach((client, index) => { if (client && sameId(client.id, clientId)) matches.push(index); });
  if (!matches.length) return { ok: false, code: "client-not-found" };
  if (matches.length !== 1) return { ok: false, code: "client-id-ambiguous" };
  return { ok: true, index: matches[0] };
}

function isModernCompletionMarker(marker) {
  return hasExactKeys(marker, COMPLETION_MARKER_KEYS)
    && marker.v === COMPLETION_MARKER_VERSION
    && typeof marker.receiptId === "string"
    && !!marker.receiptId
    && typeof marker.completedAt === "string"
    && Number.isFinite(Date.parse(marker.completedAt))
    && new Date(marker.completedAt).toISOString() === marker.completedAt;
}

function completionMarkerForReceipt(completed, receipt) {
  const marker = completed && completed[receipt.sid];
  return !!(isModernCompletionMarker(marker) && marker.receiptId === receipt.id && marker.completedAt === receipt.completedAt);
}

function validBalanceOwner(client, completed, ledger) {
  const ownerId = client && client[STOP_BALANCE_OWNER_KEY];
  const owner = ownerId && ledger && ledger[ownerId];
  if (!ownerId) return { ok: true, ownerId: null };
  if (!owner || receiptSchemaError(owner) || !owner.balance.changed || !completionMarkerForReceipt(completed, owner)) {
    return { ok: false, code: "balance-chain-unprovable" };
  }
  // A later manual balance edit supersedes the old completion assignment and starts a new proven
  // root. Otherwise verify the owner's own predecessor chain before linking a new receipt to it.
  if (!sameValue(client.balance, owner.balance.afterValue)) return { ok: true, ownerId: null };
  const chain = resolvePriorBalance(owner, completed, ledger);
  return chain.ok ? { ok: true, ownerId } : chain;
}

function deductFromItem(item, requestedAmount, preferredLocation) {
  const stock = { ...((item && item.stockByLoc) || {}) };
  const deductions = [];
  let remaining = Math.max(0, quantity(requestedAmount));

  const takeFrom = (locationId) => {
    if (remaining <= 0 || !hasOwn(stock, locationId)) return;
    const available = Math.max(0, quantity(stock[locationId]));
    const taken = quantity(Math.min(available, remaining));
    if (taken <= 0) return;
    stock[locationId] = quantity(available - taken);
    remaining = quantity(remaining - taken);
    deductions.push({ locationId, amount: taken });
  };

  if (preferredLocation) takeFrom(preferredLocation);
  for (const locationId of Object.keys(stock)) {
    if (remaining <= 0) break;
    if (locationId === preferredLocation) continue;
    takeFrom(locationId);
  }

  if (!deductions.length) return { item, deductions: [] };
  const total = quantity(Object.values(stock).reduce((sum, value) => sum + finiteNumber(value), 0));
  return { item: { ...item, stockByLoc: stock, inventoryOz: String(total) }, deductions };
}

function applyInventoryDeduction(catalog, entry) {
  let nextCatalog = { ...(catalog || {}) };
  const receiptLines = [];

  for (const config of INVENTORY_SECTIONS) {
    const uses = asArray(entry && entry[config.entryKey]);
    if (!uses.length) continue;
    const items = asArray(nextCatalog[config.section]);
    let changed = false;
    const nextItems = items.map((item) => {
      const used = uses.find((line) => line && sameId(line.id, item && item.id));
      const requested = used ? Math.max(0, quantity(used[config.amountKey])) : 0;
      if (!used || requested <= 0) return item;
      const result = deductFromItem(item, requested, used.locId || entry.usageLoc || "");
      if (!result.deductions.length) return item;
      changed = true;
      receiptLines.push({
        section: config.section,
        itemId: copy(item.id),
        itemName: String((used && used.name) || item.name || "Inventory item"),
        unit: String((used && used.unit) || item.unit || ""),
        requestedAmount: requested,
        deductions: result.deductions,
      });
      return result.item;
    });
    if (changed) nextCatalog = { ...nextCatalog, [config.section]: nextItems };
  }

  return { catalog: nextCatalog, inventory: receiptLines };
}

export function hasPositiveTrackedUsage(entry) {
  return INVENTORY_SECTIONS.some((config) => asArray(entry && entry[config.entryKey]).some((line) => line && quantity(line[config.amountKey]) > 0));
}

export function validatePositiveTrackedUsage(entry, catalog) {
  for (const config of INVENTORY_SECTIONS) {
    const seen = new Set();
    for (const line of asArray(entry && entry[config.entryKey])) {
      if (!line) continue;
      if (isIdentity(line.id)) {
        const anyUsageId = String(line.id);
        if (seen.has(anyUsageId)) return { ok: false, code: "inventory-usage-duplicate", itemName: String(line.name || anyUsageId) };
        seen.add(anyUsageId);
      }
      if (quantity(line[config.amountKey]) <= 0) continue;
      if (!isIdentity(line.id)) return { ok: false, code: "inventory-usage-id-invalid" };
      const usageId = String(line.id);
      const matches = asArray(catalog && catalog[config.section]).filter((item) => item && sameId(item.id, line.id));
      if (!matches.length) return { ok: false, code: "inventory-item-missing", itemName: String(line.name || usageId) };
      if (matches.length !== 1) return { ok: false, code: "inventory-item-ambiguous", itemName: String(line.name || usageId) };
    }
  }
  return { ok: true };
}

function restoreInventory(catalog, inventoryReceipt) {
  let nextCatalog = { ...(catalog || {}) };
  const restored = [];
  const knownLocations = new Set(asArray(nextCatalog.locations).filter((location) => location && isIdentity(location.id)).map((location) => String(location.id)));

  // Validate every referenced item first. A missing item makes an exact reversal impossible, so
  // nothing is changed and the caller can leave the completion active for a deliberate repair.
  for (const line of asArray(inventoryReceipt)) {
    const items = asArray(nextCatalog[line.section]);
    const matches = items.filter((candidate) => candidate && sameId(candidate.id, line.itemId));
    if (!matches.length) {
      return { ok: false, code: "inventory-item-missing", itemName: line.itemName || String(line.itemId) };
    }
    if (matches.length !== 1) return { ok: false, code: "inventory-item-ambiguous", itemName: line.itemName || String(line.itemId) };
    const item = matches[0];
    for (const delta of line.deductions) {
      if (!knownLocations.has(String(delta.locationId)) || !hasOwn(item.stockByLoc || {}, delta.locationId)) {
        return { ok: false, code: "inventory-location-missing", itemName: line.itemName || String(line.itemId), locationId: delta.locationId };
      }
    }
  }

  for (const line of asArray(inventoryReceipt)) {
    const items = asArray(nextCatalog[line.section]);
    const nextItems = items.map((item) => {
      if (!item || !sameId(item.id, line.itemId)) return item;
      const stock = { ...(item.stockByLoc || {}) };
      for (const delta of asArray(line.deductions)) {
        const amount = Math.max(0, quantity(delta && delta.amount));
        if (amount <= 0) continue;
        const locationId = String((delta && delta.locationId) || "");
        stock[locationId] = quantity(finiteNumber(stock[locationId]) + amount);
        restored.push({
          section: line.section,
          itemId: copy(line.itemId),
          itemName: line.itemName,
          unit: line.unit,
          locationId,
          amount,
        });
      }
      const total = quantity(Object.values(stock).reduce((sum, value) => sum + finiteNumber(value), 0));
      return { ...item, stockByLoc: stock, inventoryOz: String(total) };
    });
    nextCatalog = { ...nextCatalog, [line.section]: nextItems };
  }

  return { ok: true, catalog: nextCatalog, restored };
}

function resolvePriorBalance(receipt, completed, ledger) {
  let before = receipt.balance.before;
  const visited = new Set([receipt.id]);

  while (before.ownerReceiptId) {
    const predecessor = ledger && ledger[before.ownerReceiptId];
    if (!predecessor || receiptSchemaError(predecessor) || visited.has(predecessor.id)) return { ok: false, code: "balance-chain-unprovable" };
    if (!predecessor.balance.changed || !sameId(predecessor.clientId, receipt.clientId) || !sameValue(before.value, predecessor.balance.afterValue)) {
      return { ok: false, code: "balance-chain-unprovable" };
    }
    const marker = completed && completed[predecessor.sid];
    if (completionMarkerForReceipt(completed, predecessor)) return { ok: true, before: copy(before) };
    if (marker) {
      if (!isModernCompletionMarker(marker)) return { ok: false, code: "balance-chain-unprovable" };
      const replacement = ledger && ledger[marker.receiptId];
      if (!replacement || receiptSchemaError(replacement) || replacement.id !== marker.receiptId || !sameId(replacement.sid, predecessor.sid) || !sameId(replacement.clientId, predecessor.clientId)) return { ok: false, code: "balance-chain-unprovable" };
    }
    visited.add(predecessor.id);
    before = predecessor.balance.before;
  }
  return { ok: true, before: copy(before) };
}

function applyPriorBalance(client, receipt, resolvedBefore) {
  if (!receipt.balance?.changed) return client;
  if (client[STOP_BALANCE_OWNER_KEY] !== receipt.id) return client;

  const next = { ...client };
  if (!sameValue(client.balance, receipt.balance.afterValue)) {
    // A manual edit superseded this completion's balance assignment. Preserve that edit and only
    // discard the stale ownership marker so no older receipt can claim it later.
    delete next[STOP_BALANCE_OWNER_KEY];
    return next;
  }

  const before = resolvedBefore;
  if (before.hadOwn) next.balance = copy(before.value);
  else delete next.balance;
  if (before.ownerReceiptId) next[STOP_BALANCE_OWNER_KEY] = before.ownerReceiptId;
  else delete next[STOP_BALANCE_OWNER_KEY];
  return next;
}

function compactActiveLedger(completed, ledger) {
  const compacted = {};
  for (const [sid, marker] of Object.entries(completed || {})) {
    if (sid === STOP_REVERSAL_LEDGER_KEY || marker === true) continue;
    if (!isModernCompletionMarker(marker)) return { ok: false, code: "reversal-ledger-invalid" };
    const active = ledger && ledger[marker.receiptId];
    if (!active || receiptSchemaError(active) || active.id !== marker.receiptId || !sameId(active.sid, sid) || active.completedAt !== marker.completedAt) return { ok: false, code: "reversal-ledger-invalid" };
    const resolved = resolvePriorBalance(active, completed, ledger);
    if (!resolved.ok) return resolved;
    compacted[active.id] = active.balance.changed && !sameValue(active.balance.before, resolved.before)
      ? { ...active, balance: { ...active.balance, before: resolved.before } }
      : active;
  }
  return { ok: true, ledger: compacted };
}

export function applyStopCompletion({ clients, catalog, completed, clientId, entry, sid, receiptId, idempotencyKey, completedAt }) {
  if (sid == null || String(sid).trim() === "") return { ok: false, code: "missing-stop-id" };
  if (!receiptId || typeof receiptId !== "string") return { ok: false, code: "missing-receipt-id" };
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 240) return { ok: false, code: "missing-idempotency-key" };
  if (String(sid) === STOP_REVERSAL_LEDGER_KEY) return { ok: false, code: "reserved-stop-id" };
  if (!entry || !isNonnegativeMoneyString(entry.invoice)) return { ok: false, code: "invalid-invoice" };

  const currentCompleted = completed && typeof completed === "object" ? completed : {};
  const ledger = currentCompleted[STOP_REVERSAL_LEDGER_KEY] && typeof currentCompleted[STOP_REVERSAL_LEDGER_KEY] === "object"
    ? currentCompleted[STOP_REVERSAL_LEDGER_KEY]
    : {};
  if (currentCompleted[sid]) {
    const marker = currentCompleted[sid];
    if (!isModernCompletionMarker(marker)) return { ok: false, code: marker === true ? "completion-already-owned" : "completion-marker-invalid" };
    const priorReceipt = ledger[marker.receiptId];
    if (!priorReceipt || receiptSchemaError(priorReceipt) || priorReceipt.id !== marker.receiptId || !sameId(priorReceipt.sid, sid) || priorReceipt.completedAt !== marker.completedAt) {
      return { ok: false, code: "completion-marker-invalid" };
    }
    if (priorReceipt.idempotencyKey !== idempotencyKey) {
      return { ok: false, code: "completion-already-owned" };
    }
    if (!sameId(priorReceipt.clientId, clientId)) return { ok: false, code: "completion-already-owned" };
    const priorClientMatch = uniqueClientIndex(clients, priorReceipt.clientId);
    if (!priorClientMatch.ok) return priorClientMatch;
    const matchingHistory = asArray(clients[priorClientMatch.index].history).filter((item) => item && item.completionReceiptId === priorReceipt.history.entryReceiptId);
    if (matchingHistory.length !== 1) return { ok: false, code: "history-receipt-count-invalid" };
    return {
      ok: true,
      alreadyCompleted: true,
      sameRequest: true,
      clients,
      catalog,
      completed: currentCompleted,
      receipt: priorReceipt,
      inventoryDeducted: [],
    };
  }

  const clientMatch = uniqueClientIndex(clients, clientId);
  if (!clientMatch.ok) return clientMatch;
  const clientIndex = clientMatch.index;
  const usageValidation = validatePositiveTrackedUsage(entry, catalog);
  if (!usageValidation.ok) return usageValidation;
  const currentClient = clients[clientIndex];
  if (ledger[receiptId]) return { ok: false, code: "receipt-id-collision" };

  const storedEntry = { ...(entry || {}), sid, completionReceiptId: receiptId };
  const priorHistory = asArray(currentClient.history);
  const changesBalance = !!(storedEntry.invoice && storedEntry.invoice !== "$0");
  const ownerResolution = changesBalance ? validBalanceOwner(currentClient, currentCompleted, ledger) : { ok: true, ownerId: null };
  if (!ownerResolution.ok) return ownerResolution;
  const priorOwnerId = ownerResolution.ownerId;
  let nextClient = { ...currentClient, history: [storedEntry, ...priorHistory] };
  if (nextClient.history.filter((item) => item && item.completionReceiptId === receiptId).length !== 1) {
    return { ok: false, code: "history-receipt-count-invalid" };
  }
  if (changesBalance) {
    nextClient.balance = copy(storedEntry.invoice);
    nextClient[STOP_BALANCE_OWNER_KEY] = receiptId;
  }

  const inventoryResult = applyInventoryDeduction(catalog, storedEntry);
  const timestamp = completedAt || new Date().toISOString();
  const receipt = {
    v: RECEIPT_VERSION,
    id: receiptId,
    sid: copy(sid),
    clientId: copy(currentClient.id),
    idempotencyKey,
    completedAt: timestamp,
    history: {
      entryReceiptId: receiptId,
      historyHadOwn: hasOwn(currentClient, "history"),
    },
    balance: {
      changed: changesBalance,
      afterValue: changesBalance ? copy(storedEntry.invoice) : null,
      before: {
        hadOwn: hasOwn(currentClient, "balance"),
        value: hasOwn(currentClient, "balance") ? copy(currentClient.balance) : null,
        ownerReceiptId: priorOwnerId,
      },
    },
    inventory: inventoryResult.inventory,
  };
  const schemaError = receiptSchemaError(receipt);
  if (schemaError) return { ok: false, code: schemaError };
  const knownLocations = new Set(asArray(catalog && catalog.locations).filter((location) => location && isIdentity(location.id)).map((location) => String(location.id)));
  for (const line of receipt.inventory) {
    if (line.deductions.some((delta) => !knownLocations.has(String(delta.locationId)))) {
      return { ok: false, code: "inventory-location-missing", itemName: line.itemName };
    }
  }
  const nextClients = [...clients];
  nextClients[clientIndex] = nextClient;
  const nextCompleted = {
    ...currentCompleted,
    [sid]: { v: COMPLETION_MARKER_VERSION, receiptId, completedAt: timestamp },
    [STOP_REVERSAL_LEDGER_KEY]: { ...ledger, [receiptId]: receipt },
  };

  return {
    ok: true,
    clients: nextClients,
    catalog: inventoryResult.catalog,
    completed: nextCompleted,
    receipt,
    inventoryDeducted: inventoryResult.inventory,
  };
}

export function reverseStopCompletion({ clients, catalog, completed, clientId, sid, allowLegacy = false }) {
  const currentCompleted = completed && typeof completed === "object" ? completed : {};
  const marker = currentCompleted[sid];
  if (!marker) {
    return { ok: true, alreadyReversed: true, clients, catalog, completed: currentCompleted, inventoryRestored: [] };
  }

  const ledger = currentCompleted[STOP_REVERSAL_LEDGER_KEY] && typeof currentCompleted[STOP_REVERSAL_LEDGER_KEY] === "object"
    ? currentCompleted[STOP_REVERSAL_LEDGER_KEY]
    : {};
  const isModernMarker = isModernCompletionMarker(marker);

  if (!isModernMarker) {
    if (marker !== true) return { ok: false, code: "completion-marker-invalid" };
    if (!allowLegacy) return { ok: false, code: "legacy-completion", legacy: true };
    const clientMatch = uniqueClientIndex(clients, clientId);
    if (!clientMatch.ok) return clientMatch;
    const clientIndex = clientMatch.index;
    const currentClient = clients[clientIndex];
    const history = asArray(currentClient.history);
    const matchIndex = history.findIndex((item) => item && sameId(item.sid, sid));
    const nextHistory = matchIndex >= 0 ? history.filter((_, index) => index !== matchIndex) : history;
    const nextClient = { ...currentClient, history: nextHistory };
    const nextClients = [...clients];
    nextClients[clientIndex] = nextClient;
    const nextCompleted = { ...currentCompleted };
    delete nextCompleted[sid];
    return {
      ok: true,
      legacy: true,
      degraded: true,
      clients: nextClients,
      catalog,
      completed: nextCompleted,
      inventoryRestored: [],
    };
  }

  const receipt = ledger[marker.receiptId];
  if (!receipt || receiptSchemaError(receipt) || receipt.id !== marker.receiptId || !sameId(receipt.sid, sid)) {
    return { ok: false, code: "reversal-receipt-missing" };
  }
  if (clientId != null && !sameId(receipt.clientId, clientId)) return { ok: false, code: "reversal-client-mismatch" };
  const clientMatch = uniqueClientIndex(clients, receipt.clientId);
  if (!clientMatch.ok) return clientMatch;
  const clientIndex = clientMatch.index;

  const resolvedBalance = resolvePriorBalance(receipt, currentCompleted, ledger);
  if (!resolvedBalance.ok) return resolvedBalance;

  const currentClient = clients[clientIndex];
  const history = asArray(currentClient.history);
  const historyMatches = history.filter((item) => item && item.completionReceiptId === receipt.history.entryReceiptId);
  if (historyMatches.length !== 1) return { ok: false, code: "history-receipt-count-invalid" };

  const inventoryResult = restoreInventory(catalog, receipt.inventory);
  if (!inventoryResult.ok) return inventoryResult;

  const nextHistory = history.filter((item) => !(item && item.completionReceiptId === receipt.history.entryReceiptId));
  let nextClient = { ...currentClient, history: nextHistory };
  if (!receipt.history.historyHadOwn && nextHistory.length === 0) delete nextClient.history;
  nextClient = applyPriorBalance(nextClient, receipt, resolvedBalance.before);

  const nextClients = [...clients];
  nextClients[clientIndex] = nextClient;
  const nextCompleted = { ...currentCompleted };
  delete nextCompleted[sid];
  const compacted = compactActiveLedger(nextCompleted, ledger);
  if (!compacted.ok) return compacted;
  if (Object.keys(compacted.ledger).length) nextCompleted[STOP_REVERSAL_LEDGER_KEY] = compacted.ledger;
  else delete nextCompleted[STOP_REVERSAL_LEDGER_KEY];

  return {
    ok: true,
    clients: nextClients,
    catalog: inventoryResult.catalog,
    completed: nextCompleted,
    receipt,
    inventoryRestored: inventoryResult.restored,
  };
}
