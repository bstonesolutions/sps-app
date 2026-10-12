import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { persistStopDraft, readStopDraft } from "../completionOutbox.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const start = app.indexOf("  const draftRestored = useRef(false);");
const effectStart = app.indexOf("  useEffect(() => {", start);
const effectEnd = app.indexOf("\n\n  const draftSnapshot =", effectStart);
const restoreEffect = app.slice(effectStart, effectEnd);
const writerStart = app.indexOf("  writeDraftRef.current = () => {", effectEnd);
const writerEnd = app.indexOf("\n  useEffect(() => {", writerStart);
const writerSource = app.slice(writerStart, writerEnd);
const finishStart = app.indexOf("  const finish = async () => {", writerEnd);
const finishGuard = `${app.slice(finishStart, app.indexOf("    finishInFlight.current = true;", finishStart))}\nreturn 'would-submit';\n};\nreturn finish;`;
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a failed saved-draft read keeps autosave and completion fenced until explicit restore succeeds", async () => {
  const values = new Map();
  let failRead = false;
  const storage = {
    async get(key) { return structuredClone(values.get(key) ?? null); },
    async getVerified(key) { if (failRead) throw new Error("Device storage temporarily unavailable"); return this.get(key); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
  const original = {
    notesClient: "Latest device notes", notesOffice: "Keep these details",
    photos: [{ src: "sps-storage://client-media/original.jpg", label: "After" }],
    svcList: [{ name: "Pond Netting", price: "80" }],
  };
  await persistStopDraft("fixture-user", "fixture-stop", original, { storage, now: 200 });
  failRead = true;
  let effect;
  const restoredFields = {}, states = [], warnings = [], saveErrors = [], writes = [];
  const deps = {
    draftReady: true, draftRestored: { current: false }, draftLoadAttempt: 0,
    draftScope: "fixture-user", stop: { sid: "fixture-stop" },
    draft: { notesClient: "Older shared draft", photos: [], __draftSavedAt: 100 },
    useEffect: callback => { effect = callback; },
    readStopDraft: (uid, sid) => readStopDraft(uid, sid, { storage }),
    setDraftLoadState: state => states.push(state),
    console: { warn: (...args) => warnings.push(args) },
  };
  for (const setter of [...new Set(restoreEffect.match(/set[A-Z][A-Za-z]+(?=\()/g))]) {
    if (!(setter in deps)) deps[setter] = value => { restoredFields[setter] = value; };
  }
  new Function(...Object.keys(deps), restoreEffect)(...Object.values(deps));
  effect();
  await tick();
  assert.equal(deps.draftRestored.current, false);
  assert.deepEqual(states, ["loading", "error"]);
  assert.deepEqual(restoredFields, {}, "the older shared copy must not replace the unread newer device draft");
  assert.equal(warnings.length, 1);

  const writerDeps = {
    draftRestored: deps.draftRestored, completionFinished: { current: false }, stop: deps.stop,
    draftSnapshotRef: { current: { notesClient: "", photos: [] } },
    writeDraftRef: { current: null }, draftScope: deps.draftScope,
    onSaveDraft: (...args) => writes.push(["shared", ...args]),
    persistStopDraft: (...args) => { writes.push(["device", ...args]); return Promise.resolve(); },
  };
  new Function(...Object.keys(writerDeps), writerSource)(...Object.values(writerDeps));
  assert.equal(await writerDeps.writeDraftRef.current(), null);
  assert.deepEqual(writes, []);
  const finishDeps = { finishInFlight: { current: false }, busy: false, draftRestored: deps.draftRestored, setSaveError: message => saveErrors.push(message) };
  const finish = new Function(...Object.keys(finishDeps), finishGuard)(...Object.values(finishDeps));
  assert.equal(await finish(), undefined);
  assert.match(saveErrors[0], /Load the saved draft/);

  failRead = false;
  effect();
  await tick();
  assert.equal(deps.draftRestored.current, true);
  assert.equal(states.at(-1), "ready");
  assert.equal(restoredFields.setNotesClient, original.notesClient);
  assert.deepEqual(restoredFields.setPhotos, original.photos);
  assert.deepEqual((await readStopDraft(deps.draftScope, deps.stop.sid, { storage })).payload, original);
  writerDeps.draftSnapshotRef.current = { notesClient: restoredFields.setNotesClient, photos: restoredFields.setPhotos };
  await writerDeps.writeDraftRef.current();
  assert.deepEqual(writes[1][3].photos, original.photos);
  assert.equal(await finish(), "would-submit");
});
