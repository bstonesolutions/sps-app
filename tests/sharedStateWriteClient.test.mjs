import test from "node:test";
import assert from "node:assert/strict";
import { sendSharedStateIntent } from "../sharedStateWriteClient.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = (id = "actor-a") => ({ data: { session: { user: { id }, access_token: `token-${id}` } } });
const response = (data = { ok: true }, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const intent = () => ({ protocol: 1, key: "sps_clients", operationId: "save-1", operations: [{ id: "save-1:0", next: { present: true, value: "My edit" } }] });
const options = (extra = {}) => ({ expectedActorId: "actor-a", isCurrentIdentity: () => true, getSession: async () => session(), fetchImpl: async () => response(), ...extra });

test("the transport posts one captured intent using its original account session", async () => {
  const request = intent(); let sent;
  const result = await sendSharedStateIntent(request, options({ fetchImpl: async (url, init) => { sent = { url, ...init }; return response({ ok: true, actorId: "actor-a" }); } }));
  assert.equal(result.error, null); assert.match(sent.url, /\/api\/shared-state-patch$/);
  assert.equal(sent.method, "POST"); assert.equal(sent.headers.Authorization, "Bearer token-actor-a");
  assert.deepEqual(JSON.parse(sent.body), request); assert.ok(sent.signal instanceof AbortSignal);
});

test("missing captured identity, callback, or session account cannot post", async () => {
  let posts = 0;
  for (const extra of [{ expectedActorId: undefined }, { isCurrentIdentity: undefined }, { isCurrentIdentity: () => false }, { getSession: async () => ({ data: { session: { access_token: "token" } } }) }, { getSession: async () => session("actor-b") }]) {
    const result = await sendSharedStateIntent(intent(), options({ ...extra, fetchImpl: async () => { posts += 1; return response(); } }));
    assert.equal(result.error.code, "SHARED_STATE_IDENTITY_CHANGED");
  }
  assert.equal(posts, 0);
});

test("sign-out during session retrieval prevents any mutation even when the old session resolves", async () => {
  const gate = deferred(); let current = true, posts = 0;
  const run = sendSharedStateIntent(intent(), options({ getSession: () => gate.promise, isCurrentIdentity: () => current, fetchImpl: async () => { posts += 1; return response(); } }));
  await tick(); current = false; gate.resolve(session());
  assert.equal((await run).error.code, "SHARED_STATE_IDENTITY_CHANGED"); assert.equal(posts, 0);
});

test("switching accounts during session retrieval cannot send A's intent with B's token", async () => {
  const gate = deferred(); let posts = 0;
  const run = sendSharedStateIntent(intent(), options({ getSession: () => gate.promise, fetchImpl: async () => { posts += 1; return response(); } }));
  await tick(); gate.resolve(session("actor-b"));
  assert.equal((await run).error.code, "SHARED_STATE_IDENTITY_CHANGED"); assert.equal(posts, 0);
});

test("same-account sign-out and sign-in still fails the captured generation fence", async () => {
  const gate = deferred(); let generation = 1, posts = 0;
  const run = sendSharedStateIntent(intent(), options({ getSession: () => gate.promise, isCurrentIdentity: () => generation === 1, fetchImpl: async () => { posts += 1; return response(); } }));
  await tick(); generation = 3; gate.resolve(session());
  assert.equal((await run).error.code, "SHARED_STATE_IDENTITY_CHANGED"); assert.equal(posts, 0);
});

test("account change after dispatch or while reading a receipt cannot acknowledge the prior account's save", async () => {
  for (const phase of ["fetch", "json"]) {
    const gate = deferred(); let current = true;
    const run = sendSharedStateIntent(intent(), options({ isCurrentIdentity: () => current, fetchImpl: async () => phase === "fetch" ? gate.promise : { ...response(), json: () => gate.promise } }));
    await tick(); current = false; gate.resolve(phase === "fetch" ? response() : { ok: true });
    const result = await run; assert.equal(result.error.code, "SHARED_STATE_IDENTITY_CHANGED"); assert.equal(result.data, null);
  }
});

test("a cancelled request never asks for a session or sends data", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const result = await sendSharedStateIntent(intent(), options({ signal: controller.signal, getSession: async () => { calls += 1; return session(); }, fetchImpl: async () => { calls += 1; return response(); } }));
  assert.equal(result.error.code, "SHARED_STATE_REQUEST_CANCELLED"); assert.equal(calls, 0);
});

test("cancellation releases a hung session lookup and fences its late result", async () => {
  const gate = deferred(), controller = new AbortController(); let posts = 0;
  const run = sendSharedStateIntent(intent(), options({ signal: controller.signal, getSession: () => gate.promise, fetchImpl: async () => { posts += 1; return response(); } }));
  await tick(); controller.abort();
  assert.equal((await run).error.code, "SHARED_STATE_REQUEST_CANCELLED");
  gate.resolve(session()); await tick(); assert.equal(posts, 0);
});

test("cancellation aborts the in-flight fetch but does not claim an unsaved or saved outcome", async () => {
  const gate = deferred(), controller = new AbortController(); let signal;
  const run = sendSharedStateIntent(intent(), options({ signal: controller.signal, fetchImpl: async (_url, init) => { signal = init.signal; return gate.promise; } }));
  await tick(); controller.abort(); const result = await run;
  assert.equal(signal.aborted, true); assert.equal(result.error.commitState, "unconfirmed"); assert.equal(result.data, null);
  gate.resolve(response()); await tick();
});

test("session timeout releases the save queue and cannot post when the session arrives later", async () => {
  const gate = deferred(); let posts = 0;
  const result = await sendSharedStateIntent(intent(), options({ requestOptions: { timeoutMs: 5 }, getSession: () => gate.promise, fetchImpl: async () => { posts += 1; return response(); } }));
  assert.equal(result.error.code, "APP_STATE_REQUEST_TIMEOUT");
  gate.resolve(session()); await tick(); assert.equal(posts, 0);
});

test("fetch and response-body timeouts remain ambiguous and abort their request", async () => {
  for (const phase of ["fetch", "json"]) {
    const gate = deferred(); let signal, posts = 0;
    const result = await sendSharedStateIntent(intent(), options({ requestOptions: { timeoutMs: 5 }, fetchImpl: async (_url, init) => {
      posts += 1; signal = init.signal;
      return phase === "fetch" ? gate.promise : { ...response(), json: () => gate.promise };
    } }));
    assert.equal(result.error.code, "APP_STATE_REQUEST_TIMEOUT"); assert.equal(signal.aborted, true); assert.equal(posts, 1);
    gate.resolve(phase === "fetch" ? response() : { ok: true }); await tick();
  }
});

test("a lost response returns its error and a manual retry keeps the identical operation and reviewed choice", async () => {
  const request = intent(), resolutions = [{ operationId: "save-1:0", choice: "local", reviewed: { present: true, hash: "a".repeat(64) } }];
  const bodies = [];
  const transport = options({ resolutions, fetchImpl: async (_url, init) => {
    bodies.push(init.body); if (bodies.length === 1) throw new Error("response lost after commit");
    return response({ ok: true, replayed: true });
  } });
  const first = await sendSharedStateIntent(request, transport);
  assert.match(first.error.message, /response lost/); assert.equal(bodies.length, 1);
  const second = await sendSharedStateIntent(request, transport);
  assert.equal(second.data.replayed, true); assert.equal(bodies[0], bodies[1]);
});

test("a newer form edit cannot mutate the request already waiting for its session", async () => {
  const gate = deferred(), request = intent(), resolutions = [{ operationId: "save-1:0", choice: "local", reviewed: { present: true, hash: "a".repeat(64) } }];
  let body;
  const run = sendSharedStateIntent(request, options({ resolutions, getSession: () => gate.promise, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response(); } }));
  await tick(); request.operations[0].next.value = "Newer edit"; resolutions[0].choice = "remote"; gate.resolve(session());
  await run; assert.equal(body.operations[0].next.value, "My edit"); assert.equal(body.resolutions[0].choice, "local");
});

test("field conflicts remain structured receipts while server failures remain errors", async () => {
  const conflict = { ok: false, code: "shared-state-field-conflict", conflicts: [{ operationId: "save-1:0" }] };
  const result = await sendSharedStateIntent(intent(), options({ fetchImpl: async () => response(conflict, 409) }));
  assert.equal(result.error, null); assert.deepEqual(result.data, conflict);
  const failed = await sendSharedStateIntent(intent(), options({ fetchImpl: async () => response({ ok: false, code: "server-unavailable", error: "Retry the same change" }, 503) }));
  assert.equal(failed.error.status, 503); assert.equal(failed.error.code, "server-unavailable"); assert.equal(failed.data, null);
});

test("missing tokens and malformed successful bodies cannot acknowledge a save", async () => {
  let posts = 0;
  const signedOut = await sendSharedStateIntent(intent(), options({ getSession: async () => ({ data: { session: { user: { id: "actor-a" } } } }), fetchImpl: async () => { posts += 1; return response(); } }));
  assert.equal(signedOut.error.status, 401); assert.equal(posts, 0);
  const invalid = await sendSharedStateIntent(intent(), options({ fetchImpl: async () => ({ ...response(), json: async () => { throw new Error("truncated JSON"); } }) }));
  assert.ok(invalid.error); assert.equal(invalid.data, null);
});
