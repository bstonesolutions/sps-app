import { invoiceReviewHash, stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";

// Compact, base-aware edits for ordinary client and schedule work. The original
// field hashes remain unchanged across retries. A newer row version is never
// treated as permission to replace a stale collection.
const KEYS = new Set(["sps_clients", "sps_schedule"]);
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const HASH = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => stableInvoiceReviewJSON(left) === stableInvoiceReviewJSON(right);
const copy = value => JSON.parse(JSON.stringify(value));
const scalarId = value => ["string", "number"].includes(typeof value) && String(value).trim() ? String(value) : "";
const invalid = message => Object.assign(new Error(message), { status: 400, code: "invalid-shared-state-intent" });

function validJSON(value, depth = 0) {
  if (depth > 60) throw invalid("The shared edit is nested too deeply.");
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => validJSON(item, depth + 1)); return; }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid("The shared edit must contain JSON values.");
  for (const key of Object.keys(value)) {
    if (UNSAFE.has(key)) throw invalid("The shared edit contains an unsafe field.");
    validJSON(value[key], depth + 1);
  }
}

function list(value) {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch (_) { throw invalid("The saved collection could not be read."); } }
  if (!Array.isArray(parsed)) throw invalid("The saved collection must be a list.");
  validJSON(parsed);
  return parsed;
}

function normalize(key, value) {
  if (!KEYS.has(key)) throw invalid("This section does not support field edits.");
  const rows = list(value), entities = new Map(), orders = new Map();
  const put = (entity, id, record) => {
    if (!id || id.length > 320 || entities.has(`${entity}:${id}`)) throw invalid("The saved collection contains a missing or duplicate identity.");
    entities.set(`${entity}:${id}`, { entity, entityId: id, value: record });
  };
  if (key === "sps_clients") {
    for (const client of rows) {
      if (!object(client)) throw invalid("A client record is invalid.");
      put("client", scalarId(client.id), client);
    }
  } else {
    for (const day of rows) {
      if (!object(day) || typeof day.date !== "string" || !day.date.trim() || !Array.isArray(day.stops)) throw invalid("A schedule day is invalid.");
      const { stops, ...metadata } = day;
      put("day", day.date, metadata);
      const order = [];
      for (const stop of stops) {
        if (!object(stop)) throw invalid("A scheduled stop is invalid.");
        const sid = scalarId(stop.sid);
        put("stop", sid, { date: day.date, stop });
        order.push(sid);
      }
      orders.set(day.date, order);
    }
  }
  return { rows, entities, orders };
}

function slot(value, path) {
  let cursor = value;
  for (let index = 0; index < path.length; index += 1) {
    if (!object(cursor)) return { present: false, parentMissing: true };
    if (!own(cursor, path[index])) return { present: false, parentMissing: index < path.length - 1 };
    cursor = cursor[path[index]];
  }
  return { present: true, value: cursor };
}

async function stamp(value, cryptoImpl) {
  return value.present ? { present: true, hash: await invoiceReviewHash(value.value, cryptoImpl) } : { present: false };
}

function immutable(entity, path) {
  return entity === "client" && path[0] === "id"
    || entity === "day" && ["date", "stops"].includes(path[0])
    || entity === "stop" && (path[0] !== "date" && path[0] !== "stop" || path[0] === "date" && path.length !== 1 || path[0] === "stop" && (path.length === 1 || path[1] === "sid"));
}

function validStamp(value) {
  return object(value) && typeof value.present === "boolean"
    && (value.present ? typeof value.hash === "string" && HASH.test(value.hash) : !own(value, "hash"));
}

function validRecord(entity, id, value) {
  if (!object(value)) return false;
  if (entity === "client") return scalarId(value.id) === id;
  if (entity === "day") return value.date === id && !own(value, "stops");
  return typeof value.date === "string" && !!value.date.trim() && object(value.stop) && scalarId(value.stop.sid) === id;
}

export function validateSharedStateIntent(intent) {
  validJSON(intent);
  if (!object(intent) || intent.protocol !== 1 || !KEYS.has(intent.key)
    || typeof intent.operationId !== "string" || !intent.operationId.trim() || intent.operationId.length > 320
    || !Array.isArray(intent.operations) || intent.operations.length > 5000) throw invalid("The shared edit request is invalid.");
  const ids = new Set(), paths = new Map();
  for (const operation of intent.operations) {
    if (!object(operation) || typeof operation.id !== "string" || !operation.id.startsWith(`${intent.operationId}:`) || operation.id.length > 350 || ids.has(operation.id)
      || !["set", "add", "delete", "order"].includes(operation.kind)
      || !(intent.key === "sps_clients" ? operation.entity === "client" : ["day", "stop"].includes(operation.entity))
      || typeof operation.entityId !== "string" || !operation.entityId.trim() || operation.entityId.length > 320
      || !validStamp(operation.expected) || !object(operation.next) || typeof operation.next.present !== "boolean"
      || operation.next.present !== own(operation.next, "value")) throw invalid("A shared edit operation is invalid.");
    ids.add(operation.id);
    const path = operation.path || [];
    if (!Array.isArray(path) || path.length > 24 || path.some(part => typeof part !== "string" || !part || part.length > 320 || UNSAFE.has(part))) throw invalid("A shared edit path is invalid.");
    if (operation.kind === "set" && (!path.length || immutable(operation.entity, path))) throw invalid("A shared identity cannot be changed by a field edit.");
    if (["add", "delete"].includes(operation.kind) && path.length) throw invalid("Record additions and removals cannot target a field.");
    if (operation.kind === "add" && (operation.expected.present || !operation.next.present || !validRecord(operation.entity, operation.entityId, operation.next.value))) throw invalid("The new record identity is invalid.");
    if (operation.kind === "delete" && (!operation.expected.present || operation.next.present)) throw invalid("The removed record precondition is invalid.");
    if (operation.kind === "order") {
      const before = operation.expected.ids, after = operation.next.value;
      if (operation.entity !== "day" || !same(path, ["stops"]) || !operation.expected.present || !operation.next.present
        || !Array.isArray(before) || !Array.isArray(after) || !before.length
        || before.some(id => typeof id !== "string" || !id || id.length > 320) || new Set(before).size !== before.length
        || after.length !== before.length || new Set(after).size !== after.length || after.some(id => !before.includes(id))) throw invalid("The route order edit is invalid.");
    }
    if (operation.kind === "set" && operation.entity === "stop" && same(path, ["date"])
      && (!operation.next.present || typeof operation.next.value !== "string" || !operation.next.value.trim())) throw invalid("A stop must have a schedule date.");
    const target = `${operation.entity}:${operation.entityId}`, existing = paths.get(target) || [];
    if (existing.some(prior => prior.every((part, index) => path[index] === part) || path.every((part, index) => prior[index] === part))) throw invalid("The shared edit contains overlapping operations.");
    existing.push(path); paths.set(target, existing);
  }
  if (intent.resolutions !== undefined) validateResolutions(intent, intent.resolutions);
  return true;
}

function validateResolutions(intent, resolutions) {
  if (!Array.isArray(resolutions)) throw invalid("The reviewed choices must be a list.");
  const seen = new Set();
  for (const resolution of resolutions) {
    if (!object(resolution) || !intent.operations.some(operation => operation.id === resolution.operationId)
      || seen.has(resolution.operationId) || !["local", "remote"].includes(resolution.choice) || !validStamp(resolution.reviewed)) throw invalid("A reviewed choice is invalid.");
    seen.add(resolution.operationId);
  }
}

export async function buildSharedStateIntent(key, base, local, { operationId, cryptoImpl = globalThis.crypto } = {}) {
  const before = normalize(key, base), after = normalize(key, local);
  const intent = { protocol: 1, key, operationId, operations: [] };
  const append = async (entity, entityId, kind, path, expected, next, extra = {}) => {
    intent.operations.push({ id: `${operationId}:${intent.operations.length}`, entity, entityId, kind,
      ...(path.length ? { path } : {}), expected: { ...await stamp(expected, cryptoImpl), ...extra }, next });
  };
  const diff = async (entity, id, a, b, path = []) => {
    if (same(a, b)) return;
    if (object(a) && object(b)) {
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (own(a, field) && own(b, field)) await diff(entity, id, a[field], b[field], [...path, field]);
        else await append(entity, id, "set", [...path, field], own(a, field) ? { present: true, value: a[field] } : { present: false },
          own(b, field) ? { present: true, value: copy(b[field]) } : { present: false });
      }
    } else await append(entity, id, "set", path, { present: true, value: a }, { present: true, value: copy(b) });
  };
  for (const target of [...new Set([...before.entities.keys(), ...after.entities.keys()])]) {
    const a = before.entities.get(target), b = after.entities.get(target), record = b || a;
    if (!a) await append(record.entity, record.entityId, "add", [], { present: false }, { present: true, value: copy(b.value) });
    else if (!b) await append(record.entity, record.entityId, "delete", [], { present: true, value: a.value }, { present: false });
    else await diff(record.entity, record.entityId, a.value, b.value);
  }
  if (key === "sps_schedule") for (const [date, beforeIds] of before.orders) {
    const afterIds = after.orders.get(date) || [], shared = beforeIds.filter(id => afterIds.includes(id));
    const next = afterIds.filter(id => shared.includes(id));
    if (!same(shared, next)) await append("day", date, "order", ["stops"], { present: true, value: shared }, { present: true, value: next }, { ids: shared });
  }
  validateSharedStateIntent(intent);
  return intent;
}

function replaceSlot(value, path, next) {
  let cursor = value;
  for (const part of path.slice(0, -1)) cursor = cursor[part];
  if (next.present) cursor[path.at(-1)] = copy(next.value);
  else delete cursor[path.at(-1)];
}

function dayNumber(date) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
  const number = match ? Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])) : Date.parse(date);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

function serialize(key, state) {
  if (key === "sps_clients") return [...state.entities.values()].filter(item => item.entity === "client").map(item => item.value);
  const days = new Map([...state.entities.values()].filter(item => item.entity === "day").map(item => [item.entityId, item.value]));
  const stops = [...state.entities.values()].filter(item => item.entity === "stop");
  for (const record of stops) if (!days.has(record.value.date)) days.set(record.value.date, { date: record.value.date });
  return [...days].sort(([a], [b]) => dayNumber(a) - dayNumber(b) || a.localeCompare(b)).map(([date, day]) => {
    const available = new Map(stops.filter(item => item.value.date === date).map(item => [item.entityId, item.value.stop]));
    const ids = [...new Set([...(state.orders.get(date) || []), ...available.keys()])].filter(id => available.has(id));
    return { ...day, stops: ids.map(id => available.get(id)) };
  });
}

export async function applySharedStateIntent(intent, current, { resolutions = intent?.resolutions || [], cryptoImpl = globalThis.crypto } = {}) {
  validateSharedStateIntent(intent); validateResolutions(intent, resolutions);
  const state = normalize(intent.key, copy(list(current))), original = copy(state.rows), decisions = new Map(resolutions.map(item => [item.operationId, item]));
  const conflicts = [], accepted = [], mutations = [];
  for (const operation of intent.operations) {
    const target = `${operation.entity}:${operation.entityId}`, record = state.entities.get(target);
    const present = operation.kind === "order"
      ? { present: true, value: (state.orders.get(operation.entityId) || []).filter(id => operation.expected.ids.includes(id)), ...(!record ? { parentMissing: true } : {}) }
      : operation.kind === "set" ? record ? slot(record.value, operation.path) : { present: false, parentMissing: true }
        : record ? { present: true, value: record.value } : { present: false };
    const actual = await stamp(present, cryptoImpl), resolution = decisions.get(operation.id);
    if (operation.kind === "order" && await invoiceReviewHash(operation.expected.ids, cryptoImpl) !== operation.expected.hash) throw invalid("The route order precondition is invalid.");
    const reviewed = !resolution || same(actual, resolution.reviewed);
    const nextMatches = present.present === operation.next.present && (!present.present || same(present.value, operation.next.value));
    const expectedMatches = same(actual, { present: operation.expected.present, ...(operation.expected.present ? { hash: operation.expected.hash } : {}) });
    const resolvedReplay = resolution?.choice === "local" && nextMatches && !present.parentMissing;
    if (!reviewed && !resolvedReplay || present.parentMissing && resolution?.choice !== "remote" || (!nextMatches && !expectedMatches && !resolution)) {
      conflicts.push({ operationId: operation.id, entity: operation.entity, entityId: operation.entityId, path: operation.path || [],
        kind: !reviewed ? "reviewed-value-changed" : present.parentMissing ? "parent-or-record-removed" : "same-field-edit", current: actual });
      continue;
    }
    accepted.push(operation.id);
    if (nextMatches || resolution?.choice === "remote") continue;
    mutations.push(operation);
  }
  // One request is one atomic intent. Never apply its easy fields while silently
  // leaving its conflicting fields behind.
  if (conflicts.length) return { value: original, conflicts, applied: false, changed: false, replayed: false, appliedOperations: [] };
  if (!mutations.length) return { value: original, conflicts: [], applied: true, changed: false, replayed: true, appliedOperations: accepted };
  for (const operation of mutations.filter(item => item.kind !== "order" && !(item.entity === "day" && item.kind === "delete"))) {
    const target = `${operation.entity}:${operation.entityId}`;
    if (operation.kind === "delete") state.entities.delete(target);
    else if (operation.kind === "add") state.entities.set(target, { entity: operation.entity, entityId: operation.entityId, value: copy(operation.next.value) });
    else replaceSlot(state.entities.get(target).value, operation.path, operation.next);
  }
  for (const operation of mutations.filter(item => item.entity === "day" && item.kind === "delete")) {
    // Removing an empty day is incidental cleanup, never permission to remove a
    // different device's newly added stop in that day.
    if (![...state.entities.values()].some(item => item.entity === "stop" && item.value.date === operation.entityId)) state.entities.delete(`day:${operation.entityId}`);
  }
  for (const operation of mutations.filter(item => item.kind === "order")) {
    const wanted = operation.next.value, scoped = new Set(operation.expected.ids), currentOrder = state.orders.get(operation.entityId) || [];
    let index = 0;
    state.orders.set(operation.entityId, currentOrder.map(id => scoped.has(id) ? wanted[index++] : id));
  }
  const value = serialize(intent.key, state), changed = !same(value, original);
  return { value: changed ? value : original, conflicts: [], applied: true, changed, replayed: !changed, appliedOperations: accepted };
}
