import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKSPACE_STATE_PREFIX,
  clearAllWorkspaceStates,
  clearWorkspaceState,
  normalizeWorkspaceState,
  patchWorkspaceState,
  readWorkspaceState,
  workspaceStateKey,
} from "../workspaceState.js";

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return Object.fromEntries(values); },
  };
}

test("workspace snapshots are scoped to the authenticated user", () => {
  const storage = memoryStorage();
  patchWorkspaceState("owner@example.com", { page: "comms", comms: { section: "email" } }, storage);
  patchWorkspaceState("tech@example.com", { page: "schedule", client: { id: "c-2" } }, storage);

  assert.notEqual(workspaceStateKey("owner@example.com"), workspaceStateKey("tech@example.com"));
  assert.equal(readWorkspaceState("owner@example.com", storage).page, "comms");
  assert.equal(readWorkspaceState("tech@example.com", storage).page, "schedule");
  assert.equal(readWorkspaceState("owner@example.com", storage).client.id, undefined);
});

test("reads return a normalized location and tolerate missing or corrupt storage", () => {
  const storage = memoryStorage({
    [workspaceStateKey("broken")]: "{not-json",
    [workspaceStateKey("partial")]: JSON.stringify({
      page: "clients",
      comms: null,
      client: { id: "c-1" },
      scroll: { clients: 142 },
      ignored: "not workspace state",
    }),
  });

  assert.deepEqual(readWorkspaceState("", storage), { page: null, comms: {}, client: {}, scroll: {} });
  assert.deepEqual(readWorkspaceState("broken", storage), { page: null, comms: {}, client: {}, scroll: {} });
  assert.deepEqual(readWorkspaceState("partial", storage), {
    page: "clients",
    comms: {},
    client: { id: "c-1" },
    scroll: { clients: 142 },
  });
});

test("patches deep-merge page, comms, client, and scroll state", () => {
  const storage = memoryStorage();
  patchWorkspaceState("u-1", {
    page: "comms",
    comms: { section: "email", thread: { key: "main:+14845551212", open: true } },
    client: { id: "c-1", tab: "history" },
    scroll: { comms: 240, clients: 80 },
  }, storage);

  const next = patchWorkspaceState("u-1", {
    comms: { thread: { open: false }, filter: "unread" },
    client: { tab: "invoices" },
    scroll: { comms: 12 },
  }, storage);

  assert.deepEqual(next, {
    page: "comms",
    comms: {
      section: "email",
      thread: { key: "main:+14845551212", open: false },
      filter: "unread",
    },
    client: { id: "c-1", tab: "invoices" },
    scroll: { comms: 12, clients: 80 },
  });
  assert.deepEqual(readWorkspaceState("u-1", storage), next);
});

test("only JSON-safe caller UI state is persisted", () => {
  const storage = memoryStorage();
  const cycle = {};
  cycle.self = cycle;

  const next = patchWorkspaceState("u-1", {
    page: "comms",
    comms: {
      section: "email",
      fn: () => "secret",
      absent: undefined,
      huge: 1n,
      invalidNumber: Number.NaN,
      cycle,
      list: ["ok", undefined, () => {}, 4],
    },
    client: new Date(),
    scroll: { comms: 33 },
    secretTopLevel: "not allowed",
  }, storage);

  assert.deepEqual(next, {
    page: "comms",
    comms: { section: "email", cycle: {}, list: ["ok", 4] },
    client: {},
    scroll: { comms: 33 },
  });
  assert.deepEqual(JSON.parse(storage.getItem(workspaceStateKey("u-1"))), next);
});

test("clear removes one user's snapshot without touching another user or unrelated storage", () => {
  const storage = memoryStorage({ unrelated: "keep" });
  patchWorkspaceState("u-1", { page: "comms" }, storage);
  patchWorkspaceState("u-2", { page: "schedule" }, storage);

  assert.equal(clearWorkspaceState("u-1", storage), true);
  assert.equal(readWorkspaceState("u-1", storage).page, null);
  assert.equal(readWorkspaceState("u-2", storage).page, "schedule");
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("clear-all removes only workspace snapshots", () => {
  const storage = memoryStorage({
    unrelated: "keep",
    [`${WORKSPACE_STATE_PREFIX}old-user`]: "{}",
    [`${WORKSPACE_STATE_PREFIX}other-user`]: "{}",
  });

  assert.equal(clearAllWorkspaceStates(storage), 2);
  assert.deepEqual(storage.dump(), { unrelated: "keep" });
});

test("storage failures never escape", () => {
  const storage = {
    get length() { throw new Error("blocked"); },
    key() { throw new Error("blocked"); },
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };

  assert.doesNotThrow(() => readWorkspaceState("u-1", storage));
  assert.doesNotThrow(() => patchWorkspaceState("u-1", { page: "comms" }, storage));
  assert.equal(clearWorkspaceState("u-1", storage), false);
  assert.equal(clearAllWorkspaceStates(storage), 0);
});

test("normalization blocks prototype-pollution keys", () => {
  const state = JSON.parse('{"page":"comms","comms":{"__proto__":{"polluted":true},"section":"email"},"client":{},"scroll":{}}');
  const normalized = normalizeWorkspaceState(state);

  assert.deepEqual(normalized.comms, { section: "email" });
  assert.equal({}.polluted, undefined);
});
