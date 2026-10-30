// Field reliability: a technician's phone on weak cell signal must (1) not re-download the whole
// workspace on every launch, (2) keep partial progress when a download is cut off, and (3) never
// hold an edit only in screen memory while the database is unreachable.
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
const weakSignal = () => ({ message: "Load failed" }); // what iOS WKWebView reports for a dropped request
let stampCounter = 0;
const stamp = () => `2026-10-29T12:00:00.${String(++stampCounter).padStart(6, "0")}+00:00`;

// A fake PostgREST app_state table that records exactly which rows startup downloads in full.
function installDb(initial, opts = {}) {
  const rows = new Map(Object.entries(initial).map(([key, row]) => [key, { updated_at: stamp(), ...row }]));
  const log = { probes: 0, valueRequests: [], maxInFlight: 0 };
  let inFlight = 0;
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
          if (opts.offline?.()) return { data: null, error: weakSignal() };
          const row = rows.get(single);
          return { data: row ? { key: single, ...row } : null, error: null };
        },
        then(resolve, reject) {
          const run = async () => {
            if (opts.offline?.()) return { data: null, error: weakSignal() };
            if (columns === "key, version, updated_at") {
              log.probes += 1;
              const data = [...rows.entries()].map(([key, row]) => ({ key, version: row.version, updated_at: row.updated_at }));
              await opts.afterProbe?.(rows);
              return { data, error: null };
            }
            if (columns === "key, value, version, updated_at" && keys) {
              log.valueRequests.push(keys);
              inFlight += 1; log.maxInFlight = Math.max(log.maxInFlight, inFlight);
              await settle(2);
              inFlight -= 1;
              const error = opts.valueError?.(keys);
              if (error) return { data: null, error };
              return { data: keys.filter(key => rows.has(key)).map(key => ({ key, ...rows.get(key) })), error: null };
            }
            const data = [...rows.entries()].filter(([key]) => !keys || keys.includes(key))
              .map(([key, row]) => columns === "key, version" ? { key, version: row.version } : { key, ...row });
            return { data, error: null };
          };
          return run().then(resolve, reject);
        },
      };
      return builder;
    } };
  };
  supabase.rpc = async (name, args) => {
    assert.equal(name, "sps_app_state_cas");
    if (opts.offline?.()) return { data: null, error: weakSignal() };
    const current = rows.get(args.p_key);
    if (Number(args.p_expected_version) !== (current ? current.version : 0)) {
      return { data: [{ applied: false, outcome: "conflict", current_version: current?.version ?? null, changed_at: null }], error: null };
    }
    const version = current ? current.version + 1 : 1;
    const updated_at = stamp();
    rows.set(args.p_key, { value: args.p_value, version, updated_at });
    return { data: [{ applied: true, outcome: current ? "updated" : "inserted", current_version: version, changed_at: updated_at }], error: null };
  };
  return { rows, log, fetched: () => log.valueRequests.flat().sort() };
}

// Launch (or relaunch) the app for an account: memory is cleared, the device's saved snapshot and
// pending queue are reloaded from storage, and the connection to the shared database starts.
async function launch(uid, key = "sps_anchor") {
  store.setUser(`switch-${Math.random()}`);
  store.setUser(uid);
  await store.get(key);
  const result = await store.initialize();
  await settle();
  return result;
}
const valueOf = async key => { const row = await store.get(key); return row ? JSON.parse(row.value) : undefined; };

test("relaunch reuses every unchanged row and downloads only the row that changed", async () => {
  const db = installDb({
    sps_clients: { value: json([{ id: "c1", name: "Harlan" }]), version: 7 },
    sps_schedule: { value: json([]), version: 3 },
    sps_catalog: { value: json({ chlorine: { qty: 4 } }), version: 2 },
  });
  assert.equal((await launch("reuse")).ok, true);
  assert.deepEqual(db.fetched(), ["sps_catalog", "sps_clients", "sps_schedule"], "first launch has no cache yet");

  db.rows.set("sps_catalog", { value: json({ chlorine: { qty: 1 } }), version: 3, updated_at: stamp() });
  db.log.valueRequests.length = 0;
  assert.equal((await launch("reuse")).ok, true);
  assert.deepEqual(db.fetched(), ["sps_catalog"], "only the changed row is downloaded on relaunch");
  assert.deepEqual(await valueOf("sps_catalog"), { chlorine: { qty: 1 } });
  assert.deepEqual(await valueOf("sps_clients"), [{ id: "c1", name: "Harlan" }]);
});

test("a row recreated with the same version number is re-downloaded, never served stale", async () => {
  const db = installDb({ sps_budget: { value: json({ note: "before reset" }), version: 1 } });
  await launch("recreated");
  // Deleted and recreated elsewhere: the version restarts at 1 but the write time differs.
  db.rows.set("sps_budget", { value: json({ note: "after reset" }), version: 1, updated_at: stamp() });
  db.log.valueRequests.length = 0;
  await launch("recreated");
  assert.deepEqual(db.fetched(), ["sps_budget"]);
  assert.deepEqual(await valueOf("sps_budget"), { note: "after reset" });
});

test("a snapshot saved by the previous app version (no write times) is re-downloaded, not trusted", async () => {
  const uid = "legacy-snapshot";
  const db = installDb({ sps_estimates: { value: json([{ id: "e1", status: "sent" }]), version: 4 } });
  disk.set(`snapshot-v2:${uid}`, { uid, at: Date.now(), data: { sps_estimates: json([{ id: "e1", status: "draft" }]) }, versions: { sps_estimates: 4 } });
  assert.equal((await launch(uid)).ok, true);
  assert.deepEqual(db.fetched(), ["sps_estimates"]);
  assert.deepEqual(await valueOf("sps_estimates"), [{ id: "e1", status: "sent" }]);
});

test("a cut-off download keeps every batch that arrived; the retry fetches only what is missing", async () => {
  const originalNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    const initial = {};
    for (let i = 0; i < 20; i++) initial[`k${String(i).padStart(2, "0")}`] = { value: json({ n: i }), version: 1 };
    let dropped = false;
    const db = installDb(initial, { valueError: keys => (!dropped && keys.includes("k09") ? (dropped = true, weakSignal()) : null) });
    const first = await launch("partial", "k00");
    assert.equal(first.ok, false, "the startup read is incomplete");
    assert.equal(first.retryable, true);
    const lostBatch = db.log.valueRequests.find(keys => keys.includes("k09"));

    now += 10 * 60 * 1000; // past the retry window
    db.log.valueRequests.length = 0;
    const retry = await store.initialize();
    assert.equal(retry.ok, true);
    assert.deepEqual(db.fetched(), [...lostBatch].sort(), "only the lost batch is downloaded again");
    assert.deepEqual(await valueOf("k19"), { n: 19 });
    assert.deepEqual(await valueOf("k09"), { n: 9 });
  } finally { Date.now = originalNow; }
});

test("a row deleted between the version check and the download is treated as deleted", async () => {
  const db = installDb({
    sps_route_assignments: { value: json({ r1: "tech-a" }), version: 2 },
    sps_enroute: { value: json({ s1: "2026-10-29T13:00:00.000Z" }), version: 5 },
  });
  await launch("deleted-midway");
  db.rows.set("sps_route_assignments", { value: json({ r1: "tech-b" }), version: 3, updated_at: stamp() });
  const reopened = installDb(Object.fromEntries(db.rows), { afterProbe: rows => { rows.delete("sps_route_assignments"); } });
  assert.equal((await launch("deleted-midway")).ok, true);
  assert.deepEqual(reopened.fetched(), ["sps_route_assignments"], "unchanged rows are still reused");
  assert.equal(await store.get("sps_route_assignments"), null);
  assert.deepEqual(await valueOf("sps_enroute"), { s1: "2026-10-29T13:00:00.000Z" });
});

test("a large workspace downloads in small bounded batches instead of one request", async () => {
  const initial = {};
  for (let i = 0; i < 50; i++) initial[`key${String(i).padStart(2, "0")}`] = { value: json({ i }), version: 1 };
  const db = installDb(initial);
  assert.equal((await launch("batched", "key00")).ok, true);
  assert.equal(db.fetched().length, 50);
  assert.ok(db.log.valueRequests.every(keys => keys.length <= 8), "no request carries more than 8 rows");
  assert.ok(db.log.maxInFlight <= 3, "at most 3 downloads share the connection at once");
});

// ── The real save hook from App.jsx, executed with the database unreachable ──────────────────────
const source = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const hookStart = source.indexOf("function useStoredState(");
const hookSource = source.slice(hookStart, source.indexOf("// Debounced auto-save", hookStart));
function mountHook(key, initial, dbReadOk) {
  let cursor = 0, dirty = true;
  const slots = [], effects = [];
  let output;
  function useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = init; return [slots[i], update => { const next = typeof update === "function" ? update(slots[i]) : update; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; }
  function useRef(init) { const i = cursor++; return slots[i] || (slots[i] = { current: init }); }
  function useEffect(effect, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } }
  const hook = new Function("useState", "useRef", "useEffect", "useCallback", "store", "mergeStoredState", "stableInvoiceReviewJSON", "invoiceDeletionReviewMatches",
    `const DB_READ_OK = ${dbReadOk}; ${hookSource}; return useStoredState;`)(useState, useRef, useEffect, fn => fn, store, mergeStoredState, stableInvoiceReviewJSON, invoiceDeletionReviewMatches);
  const render = () => { cursor = 0; dirty = false; output = hook(key, initial); };
  return {
    get result() { return output; },
    async settle() { for (let pass = 0; pass < 15; pass++) { if (dirty) render(); while (effects.length) effects.shift()(); await settle(1); } },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test("an arrival logged with no signal is queued on the phone, survives the app closing, and syncs without erasing the office's arrivals", async () => {
  const uid = "tech-weak-signal";
  let offline = true;
  const officeArrival = { "stop-A": "2026-10-29T13:00:00.000Z" };
  const db = installDb({ sps_arrivals: { value: json(officeArrival), version: 3 } }, { offline: () => offline });

  // Tech opens the app at a stop with no usable signal: the first database read fails.
  const opened = await launch(uid, "sps_arrivals");
  assert.equal(opened.ok, false);
  const screen = mountHook("sps_arrivals", {}, false);
  await screen.settle();
  screen.result[1](arrivals => ({ ...arrivals, "stop-B": "2026-10-29T14:05:00.000Z" }));
  await screen.settle();

  const queued = JSON.parse(localValues.get(`sps_pending_writes:${uid}`) || "{}").sps_arrivals;
  assert.ok(queued, "the arrival is in the durable pending queue, not only on screen");
  assert.deepEqual(JSON.parse(queued.localValue), { "stop-B": "2026-10-29T14:05:00.000Z" });
  assert.deepEqual(JSON.parse(db.rows.get("sps_arrivals").value), officeArrival, "nothing was sent while offline");

  // iOS closes the app in the background. Later the tech reopens it with signal.
  screen.dispose();
  offline = false;
  assert.equal((await launch(uid, "sps_arrivals")).ok, true);
  await store.flush();
  await settle();

  assert.deepEqual(JSON.parse(db.rows.get("sps_arrivals").value), {
    "stop-A": "2026-10-29T13:00:00.000Z",
    "stop-B": "2026-10-29T14:05:00.000Z",
  }, "the tech's arrival synced and the office's existing arrival was preserved");
  assert.equal(JSON.parse(localValues.get(`sps_pending_writes:${uid}`) || "{}").sps_arrivals, undefined, "the queue is cleared once confirmed");
});
