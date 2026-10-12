import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../main.jsx", import.meta.url), "utf8");
const start = main.indexOf("supabase.auth.onAuthStateChange(") + "supabase.auth.onAuthStateChange(".length;
const end = main.indexOf("\n      });", start);
const callback = main.slice(start, end) + "\n      }";

function harness({ alreadyCleaned = false } = {}) {
  const sessions = [], identities = [], timers = [];
  let clears = 0, nativeClears = 0;
  const never = new Promise(() => {});
  const listener = new Function("store", "sessionStorage", "SIGNOUT_CLEANUP_MARKER", "cleanupNativeSessionAfterUnexpectedSignOut", "setTimeout", "setAuthBootFailure", "setSession", "window", `
    let active = true, authEventVersion = 0;
    return ${callback};
  `)(
    { clearCache() { clears++; identities.push(null); return never; }, setUser(id) { identities.push(id); } },
    { getItem: () => alreadyCleaned ? "1" : null, removeItem() {} },
    "marker", () => { nativeClears++; return never; },
    action => timers.push(action), () => {}, value => sessions.push(value),
    { location: { hash: "", pathname: "/" }, history: { replaceState() {} } },
  );
  return { listener, sessions, identities, timers, counts: () => ({ clears, nativeClears }) };
}

test("stalled disk and native sign-out cleanup cannot hold the Supabase auth lock", () => {
  const h = harness();
  assert.equal(h.listener("SIGNED_OUT", null), undefined);
  assert.deepEqual(h.sessions, [null]);
  assert.deepEqual(h.counts(), { clears: 1, nativeClears: 0 });
  h.timers[0]();
  assert.deepEqual(h.counts(), { clears: 1, nativeClears: 1 });
  const next = { user: { id: "second-user" } };
  assert.equal(h.listener("SIGNED_IN", next), undefined);
  assert.deepEqual(h.sessions, [null, next]);
});

test("deferred sign-out cleanup does not clear a newer account's native state", () => {
  const h = harness();
  h.listener("SIGNED_OUT", null);
  h.listener("SIGNED_IN", { user: { id: "second-user" } });
  h.timers[0]();
  assert.deepEqual(h.identities, [null, "second-user"]);
  assert.deepEqual(h.counts(), { clears: 1, nativeClears: 0 });
});

test("completed explicit sign-out cleanup is not repeated", () => {
  const h = harness({ alreadyCleaned: true });
  h.listener("SIGNED_OUT", null);
  assert.deepEqual(h.sessions, [null]);
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.counts(), { clears: 1, nativeClears: 0 });
});
