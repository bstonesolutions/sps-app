import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNewClientAttempt, saveNewClientChanges } from "../clientCreateSave.js";

const clientId = "3eb79851-78fe-44b7-937d-149cc9ae40aa";
const form = () => ({ name: "Cedar House", phone: "555-0100", email: "cedar@example.test", address: "100 Synthetic Lane", history: [], equipment: [] });
const attempt = () => ({ id: clientId, submittedClient: null, identity: null });
const makeApi = () => {
  let clients = [];
  let version = 10;
  const originals = new Map();
  const requests = [], commits = [], accepted = [];
  return {
    requests, commits, accepted,
    get clients() { return clients; },
    set clients(value) { clients = structuredClone(value); version++; },
    isCurrentIdentity: () => true,
    createClient: async ({ client }) => {
      requests.push(structuredClone(client));
      const original = originals.get(client.id);
      if (original && JSON.stringify(original) !== JSON.stringify(client)) throw new Error("This creation request was already saved with different details. Open the saved client to edit it.");
      if (original) return { ok: true, client: structuredClone(clients.find(row => row.id === client.id)), beforeVersion: version, afterVersion: version, replayed: true, requestId: client.id };
      originals.set(client.id, structuredClone(client));
      clients = [...clients, structuredClone(client)];
      commits.push(client.id);
      return { ok: true, client: structuredClone(client), beforeVersion: version++, afterVersion: version, replayed: false, requestId: client.id };
    },
    acceptClient: async receipt => { accepted.push(structuredClone(receipt)); return { ok: true }; },
  };
};

test("client creation waits for a compact shared receipt before returning a usable client", async () => {
  const api = makeApi();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let finished = false;
  const work = saveNewClientChanges({ ...api, form: form(), attempt: attempt(), createClient: async payload => {
    await hold; return api.createClient(payload);
  } }).then(saved => { finished = true; return saved; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(api.accepted.length, 0);
  release();
  const saved = await work;
  assert.equal(saved.name, "Cedar House");
  assert.equal(saved.id, clientId);
  assert.equal(api.accepted.length, 1);
});

test("creation sends only the new profile and never drains or downloads the full client roster", async () => {
  const api = makeApi();
  await saveNewClientChanges({ ...api, form: form(), attempt: attempt(), flushClients: () => assert.fail("unrelated pending conflicts must not block creation"), refreshClients: () => assert.fail("must not download roster"), persistClients: () => assert.fail("must not replace roster"), createClient: async payload => {
    assert.deepEqual(Object.keys(payload), ["client"]);
    assert.equal(payload.client.name, "Cedar House");
    return api.createClient(payload);
  } });
  assert.equal(api.commits.length, 1);
});

test("blank or non-text names never reach the server", async () => {
  for (const name of ["", "   ", null, {}]) {
    await assert.rejects(saveNewClientChanges({ form: { name }, attempt: attempt(), createClient: async () => assert.fail("must validate first") }), /full name/);
  }
});

test("new-client identity is a UUID and does not collide for forms opened at the same millisecond", () => {
  const original = Date.now;
  Date.now = () => 1791985240867;
  try {
    const ids = Array.from({ length: 30 }, () => createNewClientAttempt().id);
    assert.equal(new Set(ids).size, 30);
    ids.forEach(id => assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  } finally { Date.now = original; }
});

test("a failed request retries the same identity and saves one client", async () => {
  const api = makeApi(), a = attempt();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: a, createClient: async () => { throw new Error("Connection lost before commit"); } }), /Connection lost/);
  const saved = await saveNewClientChanges({ ...api, form: form(), attempt: a });
  assert.equal(saved.id, clientId);
  assert.equal(api.clients.length, 1);
});

test("response lost after server commit replays one creation without duplication", async () => {
  const api = makeApi(), a = attempt();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: a, createClient: async payload => {
    await api.createClient(payload); throw new Error("Response lost");
  } }), /Response lost/);
  const saved = await saveNewClientChanges({ ...api, form: form(), attempt: a });
  assert.equal(saved.id, a.id);
  assert.equal(api.clients.length, 1);
  assert.equal(api.requests.length, 2);
  assert.equal(api.commits.length, 1);
  assert.equal(api.accepted[0].replayed, true);
});

test("an already open form can retain its prefixed UUID identity", async () => {
  const api = makeApi(), a = { ...attempt(), id: `client-${clientId}` };
  const saved = await saveNewClientChanges({ ...api, form: form(), attempt: a });
  assert.equal(saved.id, a.id);
  assert.equal(api.accepted[0].requestId, a.id);
});

test("changed retry payload cannot overwrite a client already created by an uncertain request", async () => {
  const api = makeApi(), a = attempt();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: a, createClient: async payload => {
    await api.createClient(payload); throw new Error("Response lost");
  } }));
  await assert.rejects(saveNewClientChanges({ ...api, form: { ...form(), name: "Cedar House corrected" }, attempt: a }), /different details/);
  assert.equal(api.clients[0].name, "Cedar House");
  assert.equal(api.accepted.length, 0);
});

test("unchanged replay adopts the current saved client with another device's later edits and visit", async () => {
  const api = makeApi(), a = attempt();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: a, createClient: async payload => {
    await api.createClient(payload); throw new Error("Response lost");
  } }));
  api.clients = [{ ...api.clients[0], name: "Cedar House corrected by office", phone: "555-0199", history: [{ sid: "report-one", notes: "Saved visit" }] }];
  const saved = await saveNewClientChanges({ ...api, form: form(), attempt: a });
  assert.equal(saved.name, "Cedar House corrected by office");
  assert.equal(saved.phone, "555-0199");
  assert.equal(saved.history.length, 1);
  assert.equal(api.commits.length, 1);
});

test("first receipt verifies all submitted profile fields instead of accepting the right name alone", async () => {
  for (const field of ["name", "phone", "email", "address", "status", "balance"]) {
    const api = makeApi();
    await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: attempt(), createClient: async payload => {
      const receipt = await api.createClient(payload);
      receipt.client[field] = "incorrect";
      return receipt;
    } }), /did not confirm all/);
    assert.equal(api.accepted.length, 0);
  }
});

test("malformed or mismatched compact receipts never reach the display cache", async () => {
  const changes = [{ client: null }, { requestId: "other-request" }, { beforeVersion: -1 }, { afterVersion: 0 }, { afterVersion: 15 }, { replayed: undefined }, { ok: false }];
  for (const change of changes) {
    const api = makeApi();
    await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: attempt(), createClient: async payload => ({ ...await api.createClient(payload), ...change }) }), /valid client save receipt/);
    assert.equal(api.accepted.length, 0);
  }
});

test("account changes before or during creation prevent receipt adoption", async () => {
  const api = makeApi();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: attempt(), isCurrentIdentity: () => false }), /account changed/);
  assert.equal(api.requests.length, 0);
  let current = true;
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: attempt(), isCurrentIdentity: () => current, createClient: async payload => { const receipt = await api.createClient(payload); current = false; return receipt; } }), /account changed/);
  assert.equal(api.accepted.length, 0);
});

test("failed local receipt adoption reports that the client reached the server and can replay", async () => {
  const api = makeApi(), a = attempt();
  await assert.rejects(saveNewClientChanges({ ...api, form: form(), attempt: a, acceptClient: async () => ({ ok: false }) }), /client was saved/);
  await saveNewClientChanges({ ...api, form: form(), attempt: a });
  assert.equal(api.commits.length, 1);
});

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const start = app.indexOf("  const handleSaveNewClient = ");
const end = app.indexOf("\n\n  // Convert a lead", start);
assert.ok(start > 0 && end > start);
const handlerExpression = app.slice(start, end).trim().replace(/^const handleSaveNewClient = /, "").replace(/;$/, "");
function handlerHarness(overrides = {}) {
  const api = makeApi(), effects = [];
  let identity = { uid: "owner-one", generation: 1 };
  const store = {
    captureIdentity: () => identity,
    isCurrentIdentity: token => token === identity,
    acceptCreatedClient: async receipt => { await api.acceptClient(receipt); return { ok: true, parsedValue: api.clients }; },
  };
  const dependencies = {
    saveNewClientChanges, store,
    adoptClientsDisplay: value => effects.push(["display", value]),
    authHeaders: async extra => ({ ...extra, Authorization: "Bearer fixture" }), PROD_URL: "https://example.test",
    fetch: async (url, options) => {
      assert.equal(url, "https://example.test/api/client-create");
      assert.equal(options.headers.Authorization, "Bearer fixture");
      const receipt = await api.createClient(JSON.parse(options.body));
      return { ok: true, json: async () => receipt };
    },
    convertLead: { id: "lead-one" },
    setLeads: updater => effects.push(["lead", updater([{ id: "lead-one", status: "new" }])]),
    setConvertLead: value => effects.push(["convert", value]),
    setAdding: value => effects.push(["adding", value]),
    ...overrides,
  };
  return { api, effects, store, switchAccount: () => { identity = { uid: "owner-two", generation: 2 }; }, handler: new Function(...Object.keys(dependencies), `return (${handlerExpression});`)(...Object.values(dependencies)) };
}

test("actual Add Client handler waits for compact receipt adoption before closing or converting a lead", async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const h = handlerHarness({ authHeaders: async extra => { await hold; return { ...extra, Authorization: "Bearer fixture" }; } });
  const pending = h.handler(form(), { newClientAttempt: attempt() });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.effects, []);
  release();
  const saved = await pending;
  assert.equal(h.effects[0][0], "display");
  assert.equal(h.effects[1][1][0].convertedClientId, saved.id);
  assert.equal(h.effects[1][1][0].status, "won");
  assert.deepEqual(h.effects.slice(2), [["convert", null], ["adding", false]]);
});

test("actual Add Client handler leaves form and lead intact when API rejects the save", async () => {
  const h = handlerHarness({ fetch: async () => ({ ok: false, json: async () => ({ error: "Try this save again" }) }) });
  await assert.rejects(h.handler(form(), { newClientAttempt: attempt() }), /Try this save again/);
  assert.deepEqual(h.effects, []);
});

test("account change while awaiting auth headers prevents sending the prior form with the new account", async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const h = handlerHarness({ authHeaders: async extra => { await hold; return extra; }, fetch: async () => assert.fail("must not send under changed account") });
  const pending = h.handler(form(), { newClientAttempt: attempt() });
  h.switchAccount(); release();
  await assert.rejects(pending, /account changed/);
  assert.deepEqual(h.effects, []);
});

test("the form retains one attempt ref across retries and shows failed creation errors", () => {
  const editor = app.slice(app.indexOf("function ClientEditForm("), app.indexOf("function ClientDetail("));
  assert.match(editor, /newClientAttemptRef = useRef\(null\)/);
  assert.match(editor, /!newClientAttemptRef\.current\) newClientAttemptRef\.current = createNewClientAttempt\(\)/);
  assert.match(editor, /await onSave\(next, \{[^\n]*newClientAttempt: newClientAttemptRef\.current/);
  assert.match(editor, /catch \(error\) \{\s*setFormError\(error\?\.message/);
  assert.doesNotMatch(handlerExpression, /flushKey|store\.refresh|persistClientsExact/);
});
