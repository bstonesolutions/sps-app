import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { buildSharedStateIntent, applySharedStateIntent, validateSharedStateIntent } from "../sharedStateIntent.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";

const client = (id = "c1", extra = {}) => ({ id, name: "Cedar House", phone: "555-0100", ...extra });
const day = (date, stops, extra = {}) => ({ date, day: "Mon", ...extra, stops });
const stop = (sid = "s1", extra = {}) => ({ sid, clientId: "c1", type: "Pond", time: "9:00 AM", ...extra });
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash("sha256").update(stableInvoiceReviewJSON(value)).digest("hex");
const build = (key, base, local, operationId = "save-1") => buildSharedStateIntent(key, base, local, { operationId, cryptoImpl: webcrypto });
const apply = (intent, current, resolutions = []) => applySharedStateIntent(intent, current, { resolutions, cryptoImpl: webcrypto });
const findStop = (rows, sid = "s1") => rows.flatMap(item => item.stops).find(item => String(item.sid) === sid);

test("a client contact edit sends only its changed field and preserves other saved work", async () => {
  const base = [client("c1", { history: [{ photos: ["x".repeat(100_000)] }], plans: { Pond: "Essential" } }), client("c2")];
  const intent = await build("sps_clients", base, [{ ...base[0], name: "Cedar Gardens" }, base[1]]);
  assert.equal(intent.operations.length, 1);
  assert.deepEqual(intent.operations[0].path, ["name"]);
  assert.equal(intent.operations[0].expected.hash, digest("Cedar House"));
  assert.ok(JSON.stringify(intent).length < 600);
  assert.equal(JSON.stringify(intent).includes("photos"), false);
  const latest = [{ ...base[0], phone: "555-0199", history: [...base[0].history, { id: "new-report" }] }, { ...base[1], name: "Other current" }, client("c3")];
  const result = await apply(intent, latest);
  assert.equal(result.applied, true);
  assert.deepEqual(result.value, [{ ...latest[0], name: "Cedar Gardens" }, ...latest.slice(1)]);
  assert.deepEqual(latest[0].name, "Cedar House");
});

test("a current-version stale field replay conflicts rather than reverting the saved field", async () => {
  const base = [client()], intent = await build("sps_clients", base, [client("c1", { name: "Old stale name" })]);
  const current = [client("c1", { name: "Correct saved name" })];
  const result = await apply(intent, current);
  assert.equal(result.applied, false); assert.deepEqual(result.value, current);
  assert.equal(result.conflicts[0].current.hash, digest("Correct saved name"));
});

test("an intentional revert remains possible when based on the currently observed field", async () => {
  const current = [client("c1", { name: "New name" })];
  const intent = await build("sps_clients", current, [client()]);
  assert.deepEqual((await apply(intent, current)).value, [client()]);
});

test("a lost reply is idempotent and does not create a second record or rewrite its collection", async () => {
  const base = [client()], intent = await build("sps_clients", base, [client("c1", { phone: "555-0123" })]);
  const saved = (await apply(intent, base)).value;
  const result = await apply(intent, saved);
  assert.equal(result.replayed, true); assert.equal(result.changed, false); assert.equal(result.applied, true);
  assert.deepEqual(result.appliedOperations, [intent.operations[0].id]);
  assert.deepEqual(result.value, saved);
});

test("different nested plan fields merge without shipping or replacing the plan object", async () => {
  const base = [client("c1", { plans: { Pond: "Essential", Pool: "Basic" } })];
  const intent = await build("sps_clients", base, [client("c1", { plans: { Pond: "Premium", Pool: "Basic" } })]);
  assert.deepEqual(intent.operations[0].path, ["plans", "Pond"]);
  const current = [client("c1", { plans: { Pond: "Essential", Pool: "Premium", Leaf: "Seasonal" } })];
  assert.deepEqual((await apply(intent, current)).value[0].plans, { Pond: "Premium", Pool: "Premium", Leaf: "Seasonal" });
});

test("missing, null, and an empty string have distinct preconditions", async () => {
  const base = [client()], local = [client("c1", { notes: null })], intent = await build("sps_clients", base, local);
  assert.deepEqual(intent.operations[0].expected, { present: false });
  assert.equal((await apply(intent, base)).value[0].notes, null);
  assert.equal((await apply(intent, [client("c1", { notes: "" })])).applied, false);
  assert.equal((await apply(intent, local)).replayed, true);
});

test("a field removal requires its actual old value and retains unrelated new fields", async () => {
  const base = [client("c1", { notes: "Old", city: "York" })], local = [client("c1", { city: "York" })];
  const intent = await build("sps_clients", base, local);
  assert.deepEqual(intent.operations[0].next, { present: false });
  const result = await apply(intent, [client("c1", { notes: "Old", city: "Reading", zip: "19601" })]);
  assert.equal(Object.hasOwn(result.value[0], "notes"), false);
  assert.equal(result.value[0].city, "Reading"); assert.equal(result.value[0].zip, "19601");
  assert.equal((await apply(intent, [client("c1", { notes: "Changed", city: "York" })])).applied, false);
});

test("child edits do not resurrect a remotely removed or scalar parent", async () => {
  const base = [client("c1", { plans: { Pond: "Basic" } })];
  const local = [client("c1", { plans: { Pond: "Basic", Pool: "Basic" } })];
  const intent = await build("sps_clients", base, local);
  for (const current of [[client()], [client("c1", { plans: null })], [client("c1", { plans: "Archived" })], []]) {
    const result = await apply(intent, current);
    assert.equal(result.applied, false); assert.deepEqual(result.value, current);
    assert.equal(result.conflicts[0].kind, "parent-or-record-removed");
  }
});

test("exact review can keep the removed remote parent without resurrecting a child", async () => {
  const intent = await build("sps_clients", [client("c1", { plans: { Pond: "Basic" } })], [client("c1", { plans: { Pond: "Premium" } })]);
  const current = [client()], conflict = (await apply(intent, current)).conflicts[0];
  const resolution = { operationId: conflict.operationId, choice: "remote", reviewed: conflict.current };
  assert.equal((await apply(intent, current, [resolution])).applied, true);
  assert.deepEqual((await apply(intent, current, [resolution])).value, current);
  assert.equal((await apply(intent, current, [{ ...resolution, choice: "local" }])).applied, false);
});

test("arrays are explicit atomic fields and never lose concurrent contents", async () => {
  const base = [client("c1", { tags: ["pond"] })], local = [client("c1", { tags: ["pond", "leaf"] })];
  const intent = await build("sps_clients", base, local), current = [client("c1", { tags: ["pond", "pool"] })];
  assert.deepEqual(intent.operations[0].path, ["tags"]);
  assert.equal((await apply(intent, current)).applied, false);
});

test("one conflicting field makes the complete intent atomic", async () => {
  const base = [client()], local = [client("c1", { name: "New name", phone: "New phone" })];
  const intent = await build("sps_clients", base, local), current = [client("c1", { phone: "Other phone" })];
  const result = await apply(intent, current);
  assert.equal(result.applied, false); assert.equal(result.changed, false); assert.deepEqual(result.appliedOperations, []);
  assert.deepEqual(result.value, current);
});

test("offline additions preserve independently added clients and stable numeric identities", async () => {
  const base = [client(1)], added = client("c2", { name: "Offline new client" });
  const intent = await build("sps_clients", base, [base[0], added]);
  const current = [client(1, { phone: "New phone" }), client("c3")];
  const result = await apply(intent, current);
  assert.deepEqual(result.value, [...current, added]);
  assert.equal((await apply(intent, result.value)).replayed, true);
});

test("an add identity collision never overwrites a different existing client", async () => {
  const intent = await build("sps_clients", [], [client("c2")]), current = [client("c2", { name: "Other person" })];
  assert.equal((await apply(intent, current)).applied, false);
  assert.deepEqual((await apply(intent, current)).value, current);
});

test("client deletion hashes the complete record and cannot remove newer work", async () => {
  const base = [client(), client("c2")], intent = await build("sps_clients", base, [base[1]]);
  assert.equal(intent.operations[0].kind, "delete"); assert.equal(intent.operations[0].expected.hash, digest(base[0]));
  assert.equal(JSON.stringify(intent).includes("555-0100"), false);
  assert.deepEqual((await apply(intent, [...base, client("c3")])).value, [base[1], client("c3")]);
  assert.equal((await apply(intent, [client("c1", { notes: "New work" }), base[1]])).applied, false);
  assert.equal((await apply(intent, [base[1]])).replayed, true);
});

test("same-day stop edits merge with other stop fields and other new stops", async () => {
  const base = [day("10/22/2026", [stop()])], local = [day("10/22/2026", [stop("s1", { time: "10:00 AM" })])];
  const intent = await build("sps_schedule", base, local);
  assert.deepEqual(intent.operations[0].path, ["stop", "time"]);
  const current = [day("10/22/2026", [stop("s1", { notes: "Gate code saved" }), stop("s2")])];
  const result = await apply(intent, current);
  assert.equal(result.applied, true); assert.equal(findStop(result.value).notes, "Gate code saved");
  assert.equal(findStop(result.value).time, "10:00 AM"); assert.equal(result.value[0].stops.length, 2);
});

test("a stop moves by global sid while preserving newer details and source-day additions", async () => {
  const base = [day("10/22/2026", [stop()])], local = [day("10/23/2026", [stop()])];
  const intent = await build("sps_schedule", base, local);
  assert.equal(intent.operations.filter(item => item.entity === "stop").length, 1);
  assert.deepEqual(intent.operations.find(item => item.entity === "stop").path, ["date"]);
  const current = [day("10/22/2026", [stop("s1", { time: "11:00 AM", notes: "New note" }), stop("s2")])];
  const result = await apply(intent, current);
  assert.equal(result.applied, true);
  assert.deepEqual(result.value.map(item => [item.date, item.stops.map(item => item.sid)]), [["10/22/2026", ["s2"]], ["10/23/2026", ["s1"]]]);
  assert.equal(findStop(result.value).notes, "New note"); assert.equal(findStop(result.value).time, "11:00 AM");
});

test("different concurrent reschedules conflict instead of duplicating a stop", async () => {
  const base = [day("10/22/2026", [stop()])], intent = await build("sps_schedule", base, [day("10/23/2026", [stop()])]);
  const current = [day("10/24/2026", [stop()])], result = await apply(intent, current);
  assert.equal(result.applied, false); assert.deepEqual(result.value, current);
});

test("a stop edit follows a remotely moved stop without undoing that move", async () => {
  const base = [day("10/22/2026", [stop()])], intent = await build("sps_schedule", base, [day("10/22/2026", [stop("s1", { notes: "My note" })])]);
  const result = await apply(intent, [day("10/24/2026", [stop()])]);
  assert.equal(result.value[0].date, "10/24/2026"); assert.equal(findStop(result.value).notes, "My note");
});

test("deleting a stop does not remove a concurrent addition in its day", async () => {
  const base = [day("10/22/2026", [stop()])], intent = await build("sps_schedule", base, []);
  const result = await apply(intent, [day("10/22/2026", [stop(), stop("s2")])]);
  assert.equal(result.applied, true); assert.deepEqual(result.value, [day("10/22/2026", [stop("s2")])]);
});

test("deleting a moved or edited stop requires a fresh reviewed choice", async () => {
  const base = [day("10/22/2026", [stop()])], intent = await build("sps_schedule", base, []);
  for (const current of [[day("10/23/2026", [stop()])], [day("10/22/2026", [stop("s1", { notes: "New work" })])]]) {
    const result = await apply(intent, current);
    assert.equal(result.applied, false); assert.deepEqual(result.value, current);
  }
});

test("adding a stop does not manufacture an order conflict or replace concurrent stops", async () => {
  const base = [day("10/22/2026", [stop()])], local = [day("10/22/2026", [stop(), stop("s2")])];
  const intent = await build("sps_schedule", base, local);
  assert.equal(intent.operations.length, 1); assert.equal(intent.operations[0].kind, "add");
  const result = await apply(intent, [day("10/22/2026", [stop(), stop("s3")])]);
  assert.deepEqual(result.value[0].stops.map(item => item.sid), ["s1", "s3", "s2"]);
});

test("manual route reorder preserves unrelated stop additions in their existing slots", async () => {
  const base = [day("10/22/2026", [stop("a"), stop("b"), stop("c")])];
  const local = [day("10/22/2026", [stop("c"), stop("a"), stop("b")])], intent = await build("sps_schedule", base, local);
  assert.equal(intent.operations.length, 1); assert.equal(intent.operations[0].kind, "order");
  const current = [day("10/22/2026", [stop("a"), stop("x"), stop("b"), stop("c")])];
  const result = await apply(intent, current);
  assert.equal(result.applied, true); assert.deepEqual(result.value[0].stops.map(item => item.sid), ["c", "x", "a", "b"]);
  assert.equal((await apply(intent, result.value)).replayed, true);
});

test("different manual reorders conflict but the same reordered route is idempotent", async () => {
  const make = ids => [day("10/22/2026", ids.map(id => stop(id)))];
  const intent = await build("sps_schedule", make(["a", "b", "c"]), make(["b", "a", "c"]));
  assert.equal((await apply(intent, make(["a", "c", "b"]))).applied, false);
  assert.equal((await apply(intent, make(["b", "a", "c"]))).replayed, true);
  assert.equal((await apply(intent, make(["a", "b"]))).applied, false);
});

test("a reviewed local choice is bound to exact operation and current field value", async () => {
  const intent = await build("sps_clients", [client()], [client("c1", { name: "My name" })]);
  const current = [client("c1", { name: "Their name", notes: "Other saved note" })];
  const conflict = (await apply(intent, current)).conflicts[0];
  const resolution = { operationId: conflict.operationId, choice: "local", reviewed: conflict.current };
  const saved = await apply(intent, current, [resolution]);
  assert.equal(saved.value[0].name, "My name"); assert.equal(saved.value[0].notes, "Other saved note");
  const changed = [client("c1", { name: "Third name", notes: "Other saved note" })];
  const rejected = await apply(intent, changed, [resolution]);
  assert.equal(rejected.applied, false); assert.equal(rejected.conflicts[0].kind, "reviewed-value-changed");
  assert.deepEqual(rejected.value, changed);
});

test("reviewed remote choice discards only that field and saves the other intended field", async () => {
  const intent = await build("sps_clients", [client()], [client("c1", { name: "My name", phone: "New phone" })]);
  const current = [client("c1", { name: "Their name" })], conflict = (await apply(intent, current)).conflicts[0];
  const saved = await apply(intent, current, [{ operationId: conflict.operationId, choice: "remote", reviewed: conflict.current }]);
  assert.equal(saved.applied, true); assert.equal(saved.value[0].name, "Their name"); assert.equal(saved.value[0].phone, "New phone");
});

test("a lost reply after an explicit local choice retries as success only at its exact desired value", async () => {
  const intent = await build("sps_clients", [client()], [client("c1", { name: "My name" })]);
  const current = [client("c1", { name: "Their name" })], conflict = (await apply(intent, current)).conflicts[0];
  const resolution = { operationId: conflict.operationId, choice: "local", reviewed: conflict.current };
  const saved = await apply(intent, current, [resolution]);
  const retry = await apply(intent, saved.value, [resolution]);
  assert.equal(retry.applied, true); assert.equal(retry.replayed, true); assert.equal(retry.changed, false);
  const third = await apply(intent, [client("c1", { name: "Third name" })], [resolution]);
  assert.equal(third.applied, false); assert.equal(third.conflicts[0].kind, "reviewed-value-changed");
  const remoteChoice = await apply(intent, saved.value, [{ ...resolution, choice: "remote" }]);
  assert.equal(remoteChoice.applied, false);
});

test("top-level resolutions are accepted by validator and consumed by apply", async () => {
  const intent = await build("sps_clients", [client()], [client("c1", { name: "My name" })]);
  const current = [client("c1", { name: "Their name" })], conflict = (await apply(intent, current)).conflicts[0];
  intent.resolutions = [{ operationId: conflict.operationId, choice: "local", reviewed: conflict.current }];
  assert.equal(validateSharedStateIntent(intent), true);
  assert.equal((await applySharedStateIntent(intent, current, { cryptoImpl: webcrypto })).value[0].name, "My name");
});

test("no-op preserves exact schedule representation and does not reorder days", async () => {
  const current = [day("10/24/2026", []), day("10/22/2026", [stop()])], intent = await build("sps_schedule", current, current);
  const result = await apply(intent, current);
  assert.equal(result.changed, false); assert.equal(result.operations, undefined); assert.deepEqual(result.value, current);
});

test("empty collections and serialized durable envelopes are supported", async () => {
  const intent = await build("sps_clients", "[]", JSON.stringify([client()]));
  assert.deepEqual((await apply(intent, "[]")).value, [client()]);
});

test("operation IDs are deterministic across identical retries", async () => {
  const base = [client()], local = [client("c1", { phone: "New", city: "York" })];
  assert.deepEqual(await build("sps_clients", base, local), await build("sps_clients", base, local));
});

test("invalid duplicate identities are rejected before any intent or application", async () => {
  for (const rows of [[client(1), client("1")], [{ name: "No identity" }]]) await assert.rejects(build("sps_clients", rows, rows), /identity/);
  const duplicate = [day("10/22/2026", [stop()]), day("10/23/2026", [stop()])];
  await assert.rejects(build("sps_schedule", duplicate, duplicate), /identity/);
  await assert.rejects(build("sps_schedule", [day("10/22/2026", []), day("10/22/2026", [])], []), /identity/);
});

test("unsafe fields, malformed paths, immutable identities, and overlapping operations reject", async () => {
  const valid = await build("sps_clients", [client()], [client("c1", { name: "New" })]);
  const mutations = [
    intent => { intent.operations[0].path = ["__proto__", "polluted"]; },
    intent => { intent.operations[0].path = ["id"]; },
    intent => { intent.operations[0].path = []; },
    intent => { intent.operations[0].expected.hash = "invalid"; },
    intent => { intent.operations.push({ ...clone(intent.operations[0]), id: `${intent.operationId}:other` }); },
    intent => { intent.operations[0].kind = "replaceAll"; },
    intent => { intent.operations[0].id = "other-intent:0"; },
    intent => { intent.operations[0].next.value = NaN; },
  ];
  for (const mutate of mutations) { const intent = clone(valid); mutate(intent); assert.throws(() => validateSharedStateIntent(intent), error => error.status === 400); }
  await assert.rejects(build("sps_clients", [], JSON.parse('[{"id":"c1","__proto__":{"polluted":true}}]')), /unsafe/);
  assert.equal({}.polluted, undefined);
});

test("new-record and order identities are verified, not trusted from operation fields", async () => {
  const intent = await build("sps_clients", [], [client()]); intent.operations[0].next.value.id = "another";
  assert.throws(() => validateSharedStateIntent(intent), /identity/);
  const make = ids => [day("10/22/2026", ids.map(id => stop(id)))];
  const order = await build("sps_schedule", make(["a", "b"]), make(["b", "a"]));
  order.operations[0].expected.hash = "a".repeat(64);
  await assert.rejects(apply(order, make(["a", "b"])), /precondition/);
});

test("unrecognized or duplicate reviewed choices cannot force unrelated operations", async () => {
  const intent = await build("sps_clients", [client()], [client("c1", { name: "New" })]);
  const resolution = { operationId: intent.operations[0].id, choice: "local", reviewed: { present: true, hash: digest("Cedar House") } };
  await assert.rejects(apply(intent, [client()], [{ ...resolution, operationId: "other:0" }]), /choice/);
  await assert.rejects(apply(intent, [client()], [resolution, resolution]), /choice/);
});
