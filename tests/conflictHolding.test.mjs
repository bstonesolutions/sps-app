// Overlapping edits must not freeze a section. When two people change the same field of a shared
// section (inventory, estimates, team, settings, …), only that field is held on the device for
// review: everything else saves immediately, later edits keep saving, the device keeps seeing
// everyone else's changes, and nothing anyone saved is ever overwritten without a choice.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";
import { mergeStoredState } from "../stateMerge.js";
import { invoiceDeletionReviewMatches } from "../invoiceBulkDeletion.js";

if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const localValues = new Map(), disk = new Map();
globalThis.localStorage = { getItem: key => localValues.get(key) ?? null, setItem: (key, value) => localValues.set(key, String(value)), removeItem: key => localValues.delete(key) };
const { idb } = await import("../idbStore.js");
const originalIdb = { get: idb.get, getVerified: idb.getVerified, set: idb.set, del: idb.del };
idb.get = idb.getVerified = async key => structuredClone(disk.get(key));
idb.set = async (key, value) => { disk.set(key, structuredClone(value)); return key; };
idb.del = async key => { disk.delete(key); };
const { store, supabase } = await import("../supabaseClient.js");
// Defined only after the client loads, so supabase-js does not start its browser token-refresh timer.
globalThis.window = {};
const original = { from: supabase.from, rpc: supabase.rpc, refresh: supabase.auth.refreshSession };
after(() => { Object.assign(idb, originalIdb); supabase.from = original.from; supabase.rpc = original.rpc; supabase.auth.refreshSession = original.refresh; });

const json = JSON.stringify;
const settle = async (passes = 8) => { for (let i = 0; i < passes; i++) await new Promise(resolve => setImmediate(resolve)); };
let stampCounter = 0;
const stamp = () => `2026-10-30T09:00:00.${String(++stampCounter).padStart(6, "0")}+00:00`;

function installDb(initial, opts = {}) {
  const rows = new Map(Object.entries(initial).map(([key, row]) => [key, { updated_at: stamp(), ...row }]));
  const log = { writes: 0 };
  supabase.auth.refreshSession = async () => ({ data: {}, error: null });
  supabase.from = (table) => {
    assert.equal(table, "app_state");
    return { select(columns) {
      let keys = null, single = null;
      const builder = {
        eq(field, value) { assert.equal(field, "key"); single = value; return builder; },
        in(field, values) { assert.equal(field, "key"); keys = [...values]; return builder; },
        abortSignal() { return builder; },
        async maybeSingle() {
          if (opts.offline?.()) return { data: null, error: { message: "Load failed" } };
          const row = rows.get(single);
          return { data: row ? { key: single, ...row } : null, error: null };
        },
        then(resolve, reject) {
          if (opts.offline?.()) return Promise.resolve({ data: null, error: { message: "Load failed" } }).then(resolve, reject);
          const data = [...rows.entries()].filter(([key]) => !keys || keys.includes(key)).map(([key, row]) => (
            columns === "key, version" ? { key, version: row.version }
              : columns === "key, version, updated_at" ? { key, version: row.version, updated_at: row.updated_at }
                : { key, ...row }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    } };
  };
  supabase.rpc = async (name, args) => {
    assert.equal(name, "sps_app_state_cas");
    if (opts.offline?.()) return { data: null, error: { message: "Load failed" } };
    const current = rows.get(args.p_key);
    if (Number(args.p_expected_version) !== (current ? current.version : 0)) {
      return { data: [{ applied: false, outcome: "conflict", current_version: current?.version ?? null, changed_at: null }], error: null };
    }
    const version = current ? current.version + 1 : 1;
    const updated_at = stamp();
    rows.set(args.p_key, { value: args.p_value, version, updated_at });
    log.writes += 1;
    return { data: [{ applied: true, outcome: current ? "updated" : "inserted", current_version: version, changed_at: updated_at }], error: null };
  };
  return {
    rows, log,
    saved: key => JSON.parse(rows.get(key).value),
    // Another employee saves from a different device.
    officeSaves(key, value) { rows.set(key, { value: json(value), version: rows.get(key).version + 1, updated_at: stamp() }); },
  };
}

async function launch(uid, key) {
  store.setUser(`switch-${Math.random()}`);
  store.setUser(uid);
  await store.get(key);
  const result = await store.initialize();
  await settle();
  return result;
}
const shown = async key => JSON.parse((await store.get(key)).value);
const pendingOf = (uid, key) => JSON.parse(localValues.get(`sps_pending_writes:${uid}`) || "{}")[key];
const conflictsFor = key => (store.listConflicts().find(item => item.key === key)?.conflicts || []).map(item => item.path).sort();

// Inventory as the tech's phone loaded it this morning.
const start = { chlorine: { qty: "10", unit: "gal" }, acid: { qty: "5", unit: "gal" } };
const officeVersion = { chlorine: { qty: "8", unit: "gal" }, acid: { qty: "5", unit: "gal" }, shock: { qty: "2", unit: "bag" } };
const techVersion = { chlorine: { qty: "7", unit: "gal" }, acid: { qty: "4", unit: "gal" }, tabs: { qty: "12", unit: "lb" } };

// Office and tech both changed the chlorine count. The tech also used acid and added tabs.
async function overlap(uid) {
  const key = "sps_catalog";
  const db = installDb({ [key]: { value: json(start), version: 5 } });
  assert.equal((await launch(uid, key)).ok, true);
  db.officeSaves(key, officeVersion);
  const result = await store.set(key, json(techVersion), { baseValue: json(start) });
  return { key, db, result };
}

test("merge options: prefer base keeps the starting value at an overlap; dropLocal ignores local-only changes", () => {
  const base = json({ a: 1, b: 1, c: 1 });
  const local = json({ a: 2, b: 2, c: 1 });
  const remote = json({ a: 3, b: 1, c: 3 });
  const kept = mergeStoredState("sps_catalog", base, local, remote, { prefer: "base" });
  assert.deepEqual(JSON.parse(kept.value), { a: 1, b: 2, c: 3 });
  assert.deepEqual(kept.conflicts.map(item => item.path), ["$.a"]);
  assert.deepEqual(JSON.parse(mergeStoredState("sps_catalog", base, local, remote, { prefer: "base", dropLocal: true }).value), { a: 1, b: 1, c: 3 });
});

test("an overlapping field no longer blocks the section: everything else saves at once and only that field is held", async () => {
  const uid = "hold-overlap";
  const { key, db, result } = await overlap(uid);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.held, true);
  assert.deepEqual(db.saved(key), {
    chlorine: { qty: "8", unit: "gal" }, // the office's saved count is untouched until someone chooses
    acid: { qty: "4", unit: "gal" },     // the tech's other changes are saved immediately
    shock: { qty: "2", unit: "bag" },
    tabs: { qty: "12", unit: "lb" },
  });
  assert.deepEqual(conflictsFor(key), ["$.chlorine.qty"], "only the overlapping field needs review");
  assert.deepEqual(await shown(key), { ...db.saved(key), chlorine: { qty: "7", unit: "gal" } }, "the phone shows everyone's changes plus its held value");
  const pending = pendingOf(uid, key);
  assert.equal(pending.status, "conflict");
  assert.equal(pending.heldConflicts, true);
  assert.equal(JSON.parse(pending.baseValue).chlorine.qty, "10", "the held field keeps its original starting point");
});

test("later edits keep saving while the overlap waits for review, and the held field itself never overwrites", async () => {
  const uid = "hold-later-edits";
  const { key, db } = await overlap(uid);
  const screen = await shown(key);
  const nextEdit = { ...screen, acid: { qty: "3", unit: "gal" } };
  const second = await store.set(key, json(nextEdit), { baseValue: json(screen) });
  assert.equal(second.held, true);
  assert.equal(db.saved(key).acid.qty, "3", "a second edit saved without anyone tapping Review");
  assert.equal(db.saved(key).chlorine.qty, "8");

  const again = await shown(key);
  await store.set(key, json({ ...again, chlorine: { qty: "6", unit: "gal" } }), { baseValue: json(again) });
  assert.equal(db.saved(key).chlorine.qty, "8", "re-editing the held field still waits for a choice");
  assert.equal(JSON.parse(pendingOf(uid, key).localValue).chlorine.qty, "6");
  assert.deepEqual(conflictsFor(key), ["$.chlorine.qty"]);
});

test("a screen that never refreshed cannot erase anything the office saved, and its edit is never lost", async () => {
  const uid = "hold-stale-screen";
  const { key, db } = await overlap(uid);
  // The tech's screen still shows this morning's copy plus their first edit, and they keep typing.
  const stale = { ...techVersion, acid: { qty: "2", unit: "gal" }, algaecide: { qty: "1", unit: "qt" } };
  await store.set(key, json(stale), { baseValue: json(start) });
  assert.deepEqual(db.saved(key), {
    chlorine: { qty: "8", unit: "gal" },
    acid: { qty: "4", unit: "gal" },
    shock: { qty: "2", unit: "bag" },
    tabs: { qty: "12", unit: "lb" },
    algaecide: { qty: "1", unit: "qt" },
  }, "the office's work is intact and the unambiguous new edit saved");
  // The acid count moved from what this old screen showed on both sides, so it waits for review
  // rather than guessing. The value the tech typed is kept on the phone, not dropped.
  assert.equal(JSON.parse(pendingOf(uid, key).localValue).acid.qty, "2");
  assert.deepEqual(conflictsFor(key), ["$.acid.qty", "$.chlorine.qty"]);
});

test("a field someone else changed after the overlap also pauses instead of being overwritten", async () => {
  const uid = "hold-new-overlap";
  const { key, db } = await overlap(uid);
  const screen = await shown(key);
  db.officeSaves(key, { ...db.saved(key), acid: { qty: "9", unit: "gal" } });
  await store.set(key, json({ ...screen, acid: { qty: "1", unit: "gal" } }), { baseValue: json(screen) });
  assert.equal(db.saved(key).acid.qty, "9", "the office's newer count was not overwritten by a screen that never showed it");
  assert.deepEqual(conflictsFor(key), ["$.acid.qty", "$.chlorine.qty"]);
});

test("the held section keeps receiving everyone else's updates", async () => {
  const uid = "hold-stays-live";
  const { key, db } = await overlap(uid);
  db.officeSaves(key, { ...db.saved(key), acid: { qty: "4", unit: "drum" }, salt: { qty: "40", unit: "lb" } });
  assert.equal((await store.refresh(key)).ok, true);
  const screen = await shown(key);
  assert.deepEqual(screen.acid, { qty: "4", unit: "drum" });
  assert.deepEqual(screen.salt, { qty: "40", unit: "lb" });
  assert.equal(screen.chlorine.qty, "7", "the device's held value stays visible until it is reviewed");
});

test("review choices finish the held field either way", async () => {
  const mine = await overlap("hold-choose-local");
  assert.equal((await store.resolveConflict(mine.key, "local")).ok, true);
  assert.equal(mine.db.saved(mine.key).chlorine.qty, "7");
  assert.equal(mine.db.saved(mine.key).shock.qty, "2", "choosing this device's value keeps the office's other changes");
  assert.equal(pendingOf("hold-choose-local", mine.key), undefined);
  assert.deepEqual(conflictsFor(mine.key), []);

  const theirs = await overlap("hold-choose-remote");
  const before = theirs.db.log.writes;
  assert.equal((await store.resolveConflict(theirs.key, "remote")).ok, true);
  assert.equal(theirs.db.log.writes, before, "keeping the saved value needs no write");
  assert.equal(theirs.db.saved(theirs.key).chlorine.qty, "8");
  assert.deepEqual(await shown(theirs.key), theirs.db.saved(theirs.key));
  assert.equal(pendingOf("hold-choose-remote", theirs.key), undefined);
});

test("the overlap clears by itself once the saved value matches the device", async () => {
  const uid = "hold-self-clears";
  const { key, db } = await overlap(uid);
  db.officeSaves(key, { ...db.saved(key), chlorine: { qty: "7", unit: "gal" } });
  const screen = await shown(key);
  const result = await store.set(key, json({ ...screen, acid: { qty: "1", unit: "gal" } }), { baseValue: json(screen) });
  assert.equal(result.ok, true);
  assert.equal(db.saved(key).acid.qty, "1");
  assert.deepEqual(conflictsFor(key), []);
  assert.equal(pendingOf(uid, key), undefined);
});

test("a held section survives the app closing and new edits still save after reopening", async () => {
  const uid = "hold-relaunch";
  const { key, db } = await overlap(uid);
  assert.equal((await launch(uid, key)).ok, true);
  assert.deepEqual(conflictsFor(key), ["$.chlorine.qty"], "the held field is still waiting after a relaunch");
  const screen = await shown(key);
  assert.equal(screen.chlorine.qty, "7");
  await store.set(key, json({ ...screen, tabs: { qty: "10", unit: "lb" } }), { baseValue: json(screen) });
  assert.equal(db.saved(key).tabs.qty, "10");
  assert.equal(db.saved(key).chlorine.qty, "8");
});

test("an edit made offline while a field is held is queued and saves when signal returns", async () => {
  const uid = "hold-offline";
  let offline = false;
  const key = "sps_catalog";
  const db = installDb({ [key]: { value: json(start), version: 5 } }, { offline: () => offline });
  await launch(uid, key);
  db.officeSaves(key, officeVersion);
  await store.set(key, json(techVersion), { baseValue: json(start) });
  const screen = await shown(key);
  offline = true;
  const failed = await store.set(key, json({ ...screen, acid: { qty: "0", unit: "gal" } }), { baseValue: json(screen) });
  assert.equal(failed.ok, false);
  assert.equal(pendingOf(uid, key).heldDirty, true, "the offline edit is in the durable queue");
  assert.equal(db.saved(key).acid.qty, "4");
  offline = false;
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000; // past the outage back-off
  try { await store.flush(); await settle(); } finally { Date.now = realNow; }
  assert.equal(db.saved(key).acid.qty, "0");
  assert.equal(db.saved(key).chlorine.qty, "8");
});

test("a whole-value disagreement still pauses for review as before", async () => {
  const uid = "hold-whole-value";
  const key = "sps_palette";
  const db = installDb({ [key]: { value: json("red"), version: 2 } });
  await launch(uid, key);
  db.officeSaves(key, "blue");
  const result = await store.set(key, json("green"), { baseValue: json("red") });
  assert.equal(result.conflict, true);
  assert.notEqual(result.held, true);
  assert.equal(db.saved(key), "blue");
  assert.equal(pendingOf(uid, key).heldConflicts, false);
  assert.equal((await store.set(key, json("purple"), { baseValue: json("red") })).conflict, true);
  assert.equal(db.saved(key), "blue", "nothing is written until someone chooses");
});

// ── The real save hook from App.jsx ───────────────────────────────────────────────────────────
const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const hookStart = source.indexOf("function useStoredState(");
const hookSource = source.slice(hookStart, source.indexOf("// Debounced auto-save", hookStart));
function mountHook(key, initial) {
  let cursor = 0, dirty = true;
  const slots = [], effects = [];
  let output;
  function useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = init; return [slots[i], update => { const next = typeof update === "function" ? update(slots[i]) : update; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; }
  function useRef(init) { const i = cursor++; return slots[i] || (slots[i] = { current: init }); }
  function useEffect(effect, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } }
  const hook = new Function("useState", "useRef", "useEffect", "useCallback", "store", "mergeStoredState", "stableInvoiceReviewJSON", "invoiceDeletionReviewMatches",
    `const DB_READ_OK = true; ${hookSource}; return useStoredState;`)(useState, useRef, useEffect, fn => fn, store, mergeStoredState, stableInvoiceReviewJSON, invoiceDeletionReviewMatches);
  const render = () => { cursor = 0; dirty = false; output = hook(key, initial); };
  return {
    get result() { return output; },
    async settle() { for (let pass = 0; pass < 20; pass++) { if (dirty) render(); while (effects.length) effects.shift()(); await settle(1); } },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("on the real inventory screen, an overlap shows the office's changes and the next edit saves", async () => {
  const uid = "hold-real-screen";
  const key = "sps_catalog";
  const db = installDb({ [key]: { value: json(start), version: 5 } });
  await launch(uid, key);
  const screen = mountHook(key, {});
  await screen.settle();
  assert.deepEqual(screen.result[0], start);

  db.officeSaves(key, officeVersion);
  screen.result[1](items => ({ ...items, chlorine: { qty: "7", unit: "gal" }, acid: { qty: "4", unit: "gal" } }));
  await screen.settle();
  assert.equal(db.saved(key).acid.qty, "4");
  assert.equal(db.saved(key).chlorine.qty, "8");
  assert.deepEqual(screen.result[0].shock, { qty: "2", unit: "bag" }, "the office's new item appears on the tech's screen");
  assert.equal(screen.result[0].chlorine.qty, "7");

  screen.result[1](items => ({ ...items, acid: { qty: "3", unit: "gal" } }));
  await screen.settle();
  assert.equal(db.saved(key).acid.qty, "3", "the next edit saved without a review");
  assert.deepEqual(db.saved(key).shock, { qty: "2", unit: "bag" }, "and it did not erase the office's item");
  assert.deepEqual(conflictsFor(key), ["$.chlorine.qty"]);
  screen.dispose();
});
