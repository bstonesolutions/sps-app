import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createMaintenanceRefreshController } from "../maintenanceCalendarRefresh.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function events(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    listeners,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name) { for (const callback of listeners.get(name) || []) callback(); },
  };
}

test("calendar tab reentry retains its throttle, current callback, and in-flight request", async () => {
  const source = await readFile(new URL("../useMaintenanceCalendarRefresh.js", import.meta.url), "utf8");
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;
  let pending = [];
  let time = 0;
  const timers = new Set();
  const window = events({ setInterval(callback) { timers.add(callback); return callback; }, clearInterval(id) { timers.delete(id); } });
  const document = events({ visibilityState: "visible" });
  const useRef = value => refs[refIndex++] ||= { current: value };
  const useEffect = (callback, deps) => {
    const index = effectIndex++;
    if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index].deps[i]))) {
      pending.push(() => {
        effects[index]?.cleanup?.();
        effects[index] = { deps, cleanup: callback() };
      });
    }
  };
  const useRefresh = new Function("useRef", "useEffect", "createMaintenanceRefreshController", "window", "document",
    `${source.replace(/^import .*;\n/gm, "").replace("export default ", "")}\nreturn useMaintenanceCalendarRefresh;`
  )(useRef, useEffect, options => createMaintenanceRefreshController({ ...options, now: () => time }), window, document);
  const render = options => {
    refIndex = 0;
    effectIndex = 0;
    pending = [];
    useRefresh(options);
    pending.forEach(effect => effect());
  };
  let calls = 0;
  const firstRefresh = async () => { calls++; };
  render({ active: true, connected: true, refresh: firstRefresh });
  await settle();
  assert.equal(calls, 1);
  render({ active: false, connected: true, refresh: firstRefresh });
  assert.equal(timers.size, 0);
  assert.equal(window.listeners.get("focus").size, 0);
  time = 500;
  const inFlight = deferred();
  const latestRefresh = () => { calls += 10; return inFlight.promise; };
  render({ active: true, connected: true, refresh: latestRefresh });
  await settle();
  assert.equal(calls, 1, "tab switching must not discard the successful refresh throttle");
  time = 60_000;
  window.dispatch("focus");
  await settle();
  assert.equal(calls, 11, "focus uses the current callback after the interval");
  render({ active: false, connected: true, refresh: latestRefresh });
  render({ active: true, connected: true, refresh: latestRefresh });
  document.dispatch("visibilitychange");
  await settle();
  assert.equal(calls, 11, "returning while refresh is pending cannot start another request");
  inFlight.resolve();
  await settle();
  effects.forEach(effect => effect.cleanup?.());
  assert.equal(timers.size, 0);
  assert.equal(window.listeners.get("focus").size, 0);
  assert.equal(document.listeners.get("visibilitychange").size, 0);
});

test("unmount before a queued refresh starts does not issue a QuickBooks request", async () => {
  let calls = 0;
  const controller = createMaintenanceRefreshController({ refresh: async () => { calls++; } });
  const queued = controller.request();
  controller.stop();
  assert.equal(await queued, null);
  assert.equal(calls, 0);
});

function appCallback(app, name, dependencies) {
  const start = app.indexOf(`const ${name} = useCallback(`) + `const ${name} = useCallback(`.length;
  const end = app.indexOf("\n  }, [", start) + "\n  }".length;
  assert.ok(start > 0 && end > start, `${name} callback must exist`);
  return new Function(...Object.keys(dependencies), `return (${app.slice(start, end)});`)(...Object.values(dependencies));
}

for (const lateFailure of [false, true]) {
  test(`delayed initial ledger ${lateFailure ? "failure" : "response"} cannot replace newer reconciliation state`, async () => {
    const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
    const initialGet = deferred();
    const oldLedger = { version: 2, allocations: { old: {} } };
    const freshLedger = { version: 2, allocations: { fresh: {} } };
    const state = {};
    const dependencies = {
      canReviewAccounting: true,
      maintenanceLedgerRequestRef: { current: 0 },
      PROD_URL: "https://local.test",
      authHeaders: async () => ({}),
      fetch: async (_url, options = {}) => options.method === "POST"
        ? { ok: true, json: async () => ({ ledger: freshLedger, reconciliationReceipt: { counts: {} } }) }
        : initialGet.promise,
      setMaintenanceLedger: value => { state.ledger = value; },
      setMaintenanceLedgerLoading: value => { state.loading = value; },
      setMaintenanceLedgerSaving: value => { state.saving = value; },
      setMaintenanceLedgerError: value => { state.error = value; },
      setMaintenanceReconciliationReceipt: value => { state.receipt = value; },
      setMaintenanceLastCheckedAt: value => { state.lastChecked = value; },
      qbIsConnected: () => true,
      syncQuickBooks: async () => ({ realmId: "test-company" }),
      maintenanceQuickBooksSnapshotIssue: () => "",
      maintenanceReconciliationStorageKey: () => "test-receipt",
      currentUserId: "test-owner",
      branding: {},
      sessionStorage: { setItem() {} },
    };
    const load = appCallback(app, "loadMaintenanceLedger", dependencies);
    const reconcile = appCallback(app, "reconcileMaintenanceHistory", dependencies);
    const pendingGet = load().catch(error => error);
    await settle();
    assert.equal(state.loading, true);
    await reconcile({ automatic: true });
    const checkedAt = state.lastChecked;
    assert.equal(state.ledger, freshLedger);
    assert.ok(checkedAt > 0);
    initialGet.resolve({ ok: !lateFailure, json: async () => lateFailure ? { error: "older request failed" } : { ledger: oldLedger } });
    await pendingGet;
    assert.equal(state.ledger, freshLedger);
    assert.equal(state.error, "");
    assert.equal(state.loading, false);
    assert.equal(state.saving, false);
    assert.equal(state.lastChecked, checkedAt);
    assert.equal(state.receipt.automatic, true);
  });
}
