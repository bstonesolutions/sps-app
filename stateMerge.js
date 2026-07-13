// Three-way merge for SPS app_state values.
//
// The database stores each app section as one JSON value. Compare-and-swap prevents a stale
// whole-section write from landing, while this module combines independent edits made from the
// same confirmed base. It never guesses when both sides changed the same scalar differently.

const MISSING = Symbol("sps-state-missing");

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const scalarId = (value) => (["string", "number"].includes(typeof value) ? String(value) : "");

export function normalizeStoredValue(value) {
  if (value === undefined || value === null) return value === null ? "null" : undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseStored(value) {
  if (value === undefined) return MISSING;
  const raw = normalizeStoredValue(value);
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function serializeStored(value) {
  return value === MISSING ? undefined : JSON.stringify(value);
}

function equal(a, b) {
  if (a === MISSING || b === MISSING) return a === b;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i += 1) {
      if (ak[i] !== bk[i] || !equal(a[ak[i]], b[bk[i]])) return false;
    }
    return true;
  }
  return false;
}

function printablePath(path) {
  if (!path.length) return "$";
  return path.reduce((out, part) => {
    const s = String(part);
    return /^\d+$/.test(s) ? `${out}[${s}]` : `${out}.${s}`;
  }, "$");
}

function recordConflict(ctx, path, kind, base, local, remote) {
  ctx.conflicts.push({ path: printablePath(path), kind, base, local, remote });
}

function chooseConflict(ctx, path, kind, base, local, remote) {
  recordConflict(ctx, path, kind, base, local, remote);
  return ctx.prefer === "local" ? local : remote;
}

function validDateMs(value) {
  if (typeof value !== "string" || !value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function timestampMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampExtreme(values, direction) {
  const candidates = values
    .map((value) => ({ value, at: timestampMs(value) }))
    .filter((item) => item.at != null);
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => direction === "min" ? a.at - b.at : b.at - a.at);
  return candidates[0].value;
}

function mergeSpecialScalar(base, local, remote, path, ctx) {
  const field = String(path[path.length - 1] || "");

  // Arrival / on-the-way timestamps are first-wins facts. Two devices stamping the same stop
  // should retain the earlier time rather than manufacture a conflict.
  if (["sps_arrivals", "sps_enroute"].includes(ctx.key) && path.length === 1) {
    const lm = validDateMs(local), rm = validDateMs(remote);
    if (lm != null && rm != null) {
      return { handled: true, value: timestampExtreme([base, local, remote], "min") };
    }
  }

  // These fields belong to a top-level invoice. Restrict the rule to path length two so a nested
  // line item whose id happens to start with "qb_" is never mistaken for an invoice identity.
  if (ctx.key === "sps_invoices" && path.length === 2) {
    // Two identical QuickBooks pulls create different volatile timestamps. These are bookkeeping
    // metadata, not competing business edits.
    if (field === "createdAt" && timestampMs(local) != null && timestampMs(remote) != null) {
      return { handled: true, value: timestampExtreme([base, local, remote], "min") };
    }
    if (field === "updatedAt" && timestampMs(local) != null && timestampMs(remote) != null) {
      return { handled: true, value: timestampExtreme([base, local, remote], "max") };
    }
    // Preserve the app-created identity when it is paired with a qb_<id> import of the same qbId.
    if (field === "id") {
      const ids = [base, local, remote].filter((value) => typeof value === "string" && value);
      const appIds = [...new Set(ids.filter((value) => !value.startsWith("qb_")))];
      const qbIds = [...new Set(ids.filter((value) => value.startsWith("qb_")))];
      if (appIds.length === 1 && qbIds.length > 0) return { handled: true, value: appIds[0] };
    }
  }
  return { handled: false, value: undefined };
}

function identityFor(item, key, path) {
  if (!isObject(item)) return "";
  // QuickBooks imports and their app-created counterpart are one business invoice.
  if (key === "sps_invoices" && path.length === 0 && scalarId(item.qbId)) return `qb:${scalarId(item.qbId)}`;
  if (scalarId(item.id)) return `id:${scalarId(item.id)}`;
  if (scalarId(item.sid)) return `sid:${scalarId(item.sid)}`;
  return "";
}

// A local invoice begins life with only its app id, then gains a qbId after creation. Another
// device may still be editing the pre-QB snapshot at that moment. Build one resolver across all
// three versions so that identity does not appear to change from id:<local> to qb:<external>, and
// so a qb_<id> pull is folded into the one app-created record when that mapping is unambiguous.
function invoiceIdentityResolver(arrays) {
  const appIdsByQb = new Map();
  arrays.forEach((arr) => (arr || []).forEach((item) => {
    if (!isObject(item)) return;
    const id = scalarId(item.id), qbId = scalarId(item.qbId);
    if (!id || !qbId || id.startsWith("qb_")) return;
    if (!appIdsByQb.has(qbId)) appIdsByQb.set(qbId, new Set());
    appIdsByQb.get(qbId).add(id);
  }));

  return (item) => {
    if (!isObject(item)) return "";
    const id = scalarId(item.id), qbId = scalarId(item.qbId);
    const appIds = qbId ? appIdsByQb.get(qbId) : null;
    if (appIds && appIds.size === 1) return `id:${[...appIds][0]}`;
    if (id && !id.startsWith("qb_")) return `id:${id}`;
    if (qbId) return `qb:${qbId}`;
    return id ? `id:${id}` : "";
  };
}

function keyedArrayMap(arr, key, path, resolveIdentity = null) {
  const map = new Map(), order = [];
  for (const item of arr) {
    const id = resolveIdentity ? resolveIdentity(item) : identityFor(item, key, path);
    if (!id || map.has(id)) return null;
    map.set(id, item); order.push(id);
  }
  return { map, order };
}

function projectedOrder(order, allowed) {
  const set = new Set(allowed);
  return order.filter((id) => set.has(id));
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function mergeOrder(baseOrder, localOrder, remoteOrder, available, path, ctx) {
  const availableSet = new Set(available);
  const baseExisting = baseOrder.filter((id) => availableSet.has(id));
  const localExistingBase = projectedOrder(localOrder, baseOrder).filter((id) => availableSet.has(id));
  const remoteExistingBase = projectedOrder(remoteOrder, baseOrder).filter((id) => availableSet.has(id));
  const expectedLocal = baseOrder.filter((id) => localOrder.includes(id) && availableSet.has(id));
  const expectedRemote = baseOrder.filter((id) => remoteOrder.includes(id) && availableSet.has(id));
  const localReordered = !sameOrder(localExistingBase, expectedLocal);
  const remoteReordered = !sameOrder(remoteExistingBase, expectedRemote);

  let preferred;
  if (localReordered && !remoteReordered) preferred = localOrder;
  else if (remoteReordered && !localReordered) preferred = remoteOrder;
  else if (localReordered && remoteReordered) {
    const common = baseOrder.filter((id) => localOrder.includes(id) && remoteOrder.includes(id) && availableSet.has(id));
    const lo = projectedOrder(localOrder, common), ro = projectedOrder(remoteOrder, common);
    if (sameOrder(lo, ro)) preferred = ctx.prefer === "local" ? localOrder : remoteOrder;
    else preferred = chooseConflict(ctx, [...path, "$order"], "concurrent-reorder", baseOrder, localOrder, remoteOrder);
  } else preferred = baseExisting;

  const out = [];
  const append = (order) => order.forEach((id) => {
    if (availableSet.has(id) && !out.includes(id)) out.push(id);
  });
  append(preferred || []);
  append(localOrder);
  append(remoteOrder);
  append(available);
  return out;
}

function mergeKeyedArray(base, local, remote, path, ctx) {
  const resolveIdentity = ctx.key === "sps_invoices" && path.length === 0
    ? invoiceIdentityResolver([base, local, remote])
    : null;
  const bm = keyedArrayMap(base, ctx.key, path, resolveIdentity);
  const lm = keyedArrayMap(local, ctx.key, path, resolveIdentity);
  const rm = keyedArrayMap(remote, ctx.key, path, resolveIdentity);
  if (!bm || !lm || !rm) return null;

  const ids = [];
  const addIds = (arr) => arr.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  addIds(bm.order); addIds(lm.order); addIds(rm.order);
  const merged = new Map();
  ids.forEach((id) => {
    const value = mergeNode(
      bm.map.has(id) ? bm.map.get(id) : MISSING,
      lm.map.has(id) ? lm.map.get(id) : MISSING,
      rm.map.has(id) ? rm.map.get(id) : MISSING,
      [...path, id],
      ctx
    );
    if (value !== MISSING) merged.set(id, value);
  });
  const order = mergeOrder(bm.order, lm.order, rm.order, [...merged.keys()], path, ctx);
  return order.map((id) => merged.get(id)).filter((value) => value !== undefined);
}

function mergeArray(base, local, remote, path, ctx) {
  const keyed = mergeKeyedArray(base, local, remote, path, ctx);
  if (keyed) return keyed;
  return chooseConflict(ctx, path, "concurrent-array-edit", base, local, remote);
}

function mergeObject(base, local, remote, path, ctx) {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const out = {};
  // inventoryOz is a compatibility mirror of stockByLoc, not an independently editable value.
  // Merging two different locations must not create a false conflict on their independently
  // recomputed totals; rebuild the mirror from the merged location cells instead.
  const deriveInventoryOz = ctx.key === "sps_catalog"
    && [base, local, remote].some((value) => isObject(value.stockByLoc))
    && [base, local, remote].some((value) => Object.prototype.hasOwnProperty.call(value, "inventoryOz"));
  keys.forEach((key) => {
    if (deriveInventoryOz && key === "inventoryOz") return;
    const value = mergeNode(
      Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
      Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
      Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
      [...path, key],
      ctx
    );
    if (value !== MISSING) out[key] = value;
  });
  if (deriveInventoryOz) {
    if (isObject(out.stockByLoc)) {
      const total = Object.values(out.stockByLoc).reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
      out.inventoryOz = String(total);
    } else {
      const value = mergeNode(
        Object.prototype.hasOwnProperty.call(base, "inventoryOz") ? base.inventoryOz : MISSING,
        Object.prototype.hasOwnProperty.call(local, "inventoryOz") ? local.inventoryOz : MISSING,
        Object.prototype.hasOwnProperty.call(remote, "inventoryOz") ? remote.inventoryOz : MISSING,
        [...path, "inventoryOz"],
        ctx
      );
      if (value !== MISSING) out.inventoryOz = value;
    }
  }
  return out;
}

function mergeNode(base, local, remote, path, ctx) {
  // Domain invariants (first arrival, stable app invoice id, QB timestamp extrema) must run before
  // the ordinary "only one side changed" shortcuts. A fresh QB pull may otherwise replace the
  // app invoice id simply because the local side still equals the base.
  const special = mergeSpecialScalar(base, local, remote, path, ctx);
  if (special.handled) return special.value;

  if (equal(local, remote)) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;

  if (local === MISSING || remote === MISSING || base === MISSING) {
    // Concurrent different additions, or delete-vs-edit, cannot be inferred safely.
    if (base === MISSING && local !== MISSING && remote !== MISSING && isObject(local) && isObject(remote)) {
      return mergeObject({}, local, remote, path, ctx);
    }
    return chooseConflict(
      ctx,
      path,
      base === MISSING ? "same-identity-add" : "delete-vs-edit",
      base,
      local,
      remote
    );
  }

  if (isObject(base) && isObject(local) && isObject(remote)) return mergeObject(base, local, remote, path, ctx);
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) return mergeArray(base, local, remote, path, ctx);

  return chooseConflict(ctx, path, "same-field-edit", base, local, remote);
}

function scheduleParts(days, ctx, label) {
  const dayMap = {}, stopMap = {}, dayOrder = [], stopOrder = {};
  for (const rawDay of Array.isArray(days) ? days : []) {
    if (!isObject(rawDay) || !rawDay.date) {
      recordConflict(ctx, ["schedule"], `invalid-${label}-day`, MISSING, rawDay, MISSING);
      continue;
    }
    const date = String(rawDay.date);
    if (!dayOrder.includes(date)) dayOrder.push(date);
    const anonymousStops = [];
    stopOrder[date] = [];
    for (const stop of Array.isArray(rawDay.stops) ? rawDay.stops : []) {
      const sid = scalarId(stop && stop.sid);
      if (!sid) { anonymousStops.push(stop); continue; }
      if (stopMap[sid]) {
        recordConflict(ctx, ["schedule", sid], `duplicate-${label}-sid`, MISSING, stopMap[sid], stop);
        continue;
      }
      stopMap[sid] = { date, stop };
      stopOrder[date].push(sid);
    }
    dayMap[date] = { ...rawDay, stops: anonymousStops };
  }
  return { dayMap, stopMap, dayOrder, stopOrder };
}

function parseDay(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || ""));
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  const n = Date.parse(String(value || ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function mergeSchedule(base, local, remote, ctx) {
  const b = scheduleParts(base, ctx, "base"), l = scheduleParts(local, ctx, "local"), r = scheduleParts(remote, ctx, "remote");
  const days = mergeObject(b.dayMap, l.dayMap, r.dayMap, ["days"], ctx);
  const stops = mergeObject(b.stopMap, l.stopMap, r.stopMap, ["stops"], ctx);
  const dates = new Set(Object.keys(days));
  Object.values(stops).forEach((record) => { if (record && record.date) dates.add(String(record.date)); });

  const result = [...dates].sort((a, z) => parseDay(a) - parseDay(z) || a.localeCompare(z)).map((date) => {
    const day = isObject(days[date]) ? { ...days[date], date } : { date };
    const available = Object.keys(stops).filter((sid) => stops[sid] && String(stops[sid].date) === date);
    const order = mergeOrder(
      b.stopOrder[date] || [], l.stopOrder[date] || [], r.stopOrder[date] || [],
      available, ["days", date, "stops"], ctx
    );
    const keyedStops = order.map((sid) => stops[sid] && stops[sid].stop).filter(Boolean);
    return { ...day, stops: [...keyedStops, ...(Array.isArray(day.stops) ? day.stops : [])] };
  });
  return result;
}

export function mergeStoredState(key, baseValue, localValue, remoteValue, options = {}) {
  const base = parseStored(baseValue), local = parseStored(localValue), remote = parseStored(remoteValue);
  const ctx = { key: String(key || ""), prefer: options.prefer === "local" ? "local" : "remote", conflicts: [] };
  let merged;
  if (ctx.key === "sps_schedule" && [base, local, remote].every(Array.isArray)) {
    if (equal(local, remote)) merged = local;
    else if (equal(local, base)) merged = remote;
    else if (equal(remote, base)) merged = local;
    else merged = mergeSchedule(base, local, remote, ctx);
  } else {
    merged = mergeNode(base, local, remote, [], ctx);
  }
  return {
    value: serializeStored(merged),
    conflicts: ctx.conflicts,
    merged: !equal(merged, local),
  };
}

export function describeStateConflicts(conflicts, limit = 4) {
  const paths = (conflicts || []).map((item) => item && item.path).filter(Boolean);
  if (!paths.length) return "";
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}
