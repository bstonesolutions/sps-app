import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  AuthBootstrapTimeoutError,
  loadInitialSession,
} from "../authBootstrap.js";

test("initial auth bootstrap returns the Supabase session and accepts signed-out null", async () => {
  const session = { user: { id: "staff-1" } };
  assert.equal(
    await loadInitialSession(async () => ({ data: { session }, error: null }), { timeoutMs: 100 }),
    session,
  );
  assert.equal(
    await loadInitialSession(async () => ({ data: { session: null }, error: null }), { timeoutMs: 100 }),
    null,
  );
});

test("initial auth bootstrap treats Supabase response errors as failures", async () => {
  const authError = Object.assign(new Error("storage unavailable"), { status: 503 });
  await assert.rejects(
    loadInitialSession(async () => ({ data: { session: null }, error: authError }), { timeoutMs: 100 }),
    (error) => error === authError,
  );
});

test("initial auth bootstrap bounds a getSession call that never settles", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    loadInitialSession(() => new Promise(() => {}), { timeoutMs: 20 }),
    (error) => {
      assert.ok(error instanceof AuthBootstrapTimeoutError);
      assert.equal(error.code, "AUTH_BOOTSTRAP_TIMEOUT");
      assert.equal(error.timeoutMs, 20);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 250, "auth timeout should settle promptly");
});

test("the root swaps the static splash for bounded loading and recoverable error screens", async () => {
  const main = await readFile(new URL("../main.jsx", import.meta.url), "utf8");

  assert.match(main, /loadInitialSession\(/);
  assert.match(main, /AUTH_BOOTSTRAP_TIMEOUT_MS/);
  assert.match(main, /authEventVersion\s*!==\s*0/);
  assert.match(main, /if\s*\(authBootFailure\)/);
  assert.match(main, /<StartupScreen loading\s*\/>/);
  assert.match(main, /primaryLabel="Try again"/);
  assert.match(main, /<RootErrorBoundary>/);
  assert.match(main, /removeBootSplash\(\)/);
  assert.match(main, /function reloadFreshEntry\(\)/);
  assert.match(main, /url\.searchParams\.set\("_sps_retry"/);
  assert.match(main, /onSecondary=\{reloadFreshEntry\}/);
});
