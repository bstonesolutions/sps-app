import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { mergeStoredState } from "../stateMerge.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const identityStart = app.indexOf("function matchesPendingEditorCreation(");
const identityEnd = app.indexOf("function storeReceiptIssue(", identityStart);
const matchesPendingEditorCreation = new Function(`${app.slice(identityStart, identityEnd)}; return matchesPendingEditorCreation;`)();
function action(component, name, next, dependencies) {
  const start = app.indexOf(`  const ${name} =`, app.indexOf(`function ${component}(`));
  const end = app.indexOf(`  const ${next} =`, start);
  assert.ok(start > 0 && end > start, `${name} source exists`);
  return new Function(...Object.keys(dependencies), `${app.slice(start, end)}; return ${name};`)(...Object.values(dependencies));
}
const original = { id: "estimate-1", number: "EST-1001", status: "draft", title: "Original scope", notes: "", items: [{ id: "line-1", desc: "Service", price: "50", qty: "1" }] };
const edited = { ...original, title: "Owner's edited scope" };
const receiptIssue = receipt => receipt?.ok ? "" : "The database did not confirm this save.";

function persistenceHarness(rows = [original], receiptFactory = async (_next, value) => ({ ok: true, value })) {
  const adopted = [];
  const writes = [];
  const persist = action("EstimatesScreen", "persistEstimate", "saveEstimate", {
    canManage: true, estimates: rows, matchesPendingEditorCreation, retainEstimateBillingLinks: (entry, canonical) => ({ ...entry, ...(canonical?.linkedBillingReviewId ? { linkedBillingReviewId: canonical.linkedBillingReviewId } : {}) }),
    store: { set: async (key, value, options) => { writes.push({ key, next: JSON.parse(value), base: JSON.parse(options.baseValue) }); return receiptFactory(JSON.parse(value), value, options); } },
    storeReceiptIssue: receiptIssue, setEstimates: rows => adopted.push(rows), setSelected() {},
  });
  return { persist, writes, adopted };
}

test("ordinary estimate save waits for its exact receipt before closing", async () => {
  let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const { persist, adopted } = persistenceHarness([original], async () => gate);
  const views = [];
  const save = action("EstimatesScreen", "saveEstimate", "deleteEstimate", { persistEstimate: persist, setView: view => views.push(view) });
  const pending = save(edited, { baselineEstimate: original });
  assert.deepEqual(views, []);
  assert.deepEqual(adopted, []);
  complete({ ok: true, value: JSON.stringify([edited]) });
  assert.deepEqual(await pending, edited);
  assert.deepEqual(views, ["list"]);
  assert.deepEqual(adopted, [[edited]]);
});

test("queued or malformed estimate receipts keep the editor open and do not adopt a false save", async () => {
  for (const receipt of [{ ok: false, queued: true }, { ok: true, value: "broken" }, { ok: true, value: "[]" }]) {
    const { persist, adopted } = persistenceHarness([original], async () => receipt);
    const save = action("EstimatesScreen", "saveEstimate", "deleteEstimate", { persistEstimate: persist, setView() { assert.fail("Must remain in the editor"); } });
    await assert.rejects(save(edited), /confirm|verified/);
    assert.deepEqual(adopted, []);
  }
});

test("an open estimate uses its original baseline so another device's independent changes survive", async () => {
  const latest = { ...original, notes: "Saved from the office", linkedBillingReviewId: "review-1" };
  const { persist, writes } = persistenceHarness([latest], async (next, _value, options) => {
    const merged = mergeStoredState("sps_estimates", JSON.parse(options.baseValue), next, [latest]);
    assert.deepEqual(merged.conflicts, []);
    return { ok: true, value: merged.value };
  });
  const saved = await persist(edited, { baselineEstimate: original });
  assert.deepEqual(writes[0].base, [original]);
  assert.equal(saved.title, edited.title);
  assert.equal(saved.notes, latest.notes);
  assert.equal(saved.linkedBillingReviewId, "review-1");
});

test("saving an estimate removed while its editor was open does not resurrect it", async () => {
  const { persist, writes } = persistenceHarness([]);
  await assert.rejects(persist(edited, { baselineEstimate: original }), /removed/);
  assert.deepEqual(writes, []);
});

test("rapid Save clicks issue one request and a failed save preserves dirty form contents", async () => {
  let reject;
  let calls = 0;
  const ref = { current: false };
  const errors = [];
  const busy = [];
  const save = action("EstimateForm", "saveCurrent", "convertToInvoice", {
    canManage: true, shareBusyRef: ref, savedEstimateRef: { current: original }, attemptedEstimateRef: { current: null }, form: edited, defaultTaxRate: "6",
    validateEstimateSettings: () => "", validateEstimateLines: () => "", withEstimateTotals: entry => entry,
    setFormError: error => errors.push(error), setSentMsg() {}, setSaving: value => busy.push(value), setSaveFailed() {},
    setDirty() { assert.fail("Failed save must preserve dirty state"); }, setForm() { assert.fail("Failed save must preserve typed contents"); },
    onSave: async (entry, options) => { calls++; assert.deepEqual(entry, edited); assert.deepEqual(options.baselineEstimate, original); return new Promise((_resolve, fail) => { reject = fail; }); },
  });
  const first = save();
  await save();
  assert.equal(calls, 1);
  assert.equal(ref.current, true);
  reject(new Error("Save is offline"));
  await first;
  assert.equal(ref.current, false);
  assert.deepEqual(busy, [true, false]);
  assert.equal(errors.at(-1), "Save is offline");
});

test("accepted customer delivery plus failed status persistence keeps Sent and tells the user to retry Save only", async () => {
  const states = [];
  const dirty = [];
  const errors = [];
  const markSent = action("EstimateForm", "markSent", "buildSmsText", {
    defaultTaxRate: "6", withEstimateTotals: entry => entry,
    setForm: entry => states.push(entry), setDirty: value => dirty.push(value), setFormError: error => errors.push(error),
    persistCurrent: async () => { throw new Error("Database offline"); },
  });
  const warning = await markSent(edited);
  assert.equal(states[0].status, "sent");
  assert.deepEqual(dirty, [true]);
  assert.match(warning, /was sent/);
  assert.match(warning, /Save to retry saving without sending again/);
  assert.equal(errors[0], warning);
});

test("confirmed review sync and deletion stay successful when list refresh fails", async () => {
  for (const verb of ["confirm", "discard"]) {
    const result = { ok: true, review: { id: "review-1", reviewState: verb === "discard" ? "discarded" : "synced", reviewRevision: 4 }, ...(verb === "confirm" ? { invoice: { id: "review-1", number: "2041", qbId: "QB-1" } } : {}) };
    const warnings = [];
    let calls = 0;
    const mutate = action("EstimatesScreen", "mutateEstimateBillingReview", "saveConvertedInvoice", {
      requestBillingReview: async payload => { assert.ok(payload); calls++; return result; },
      setInvoiceEditor() {}, setBillingRefreshWarning: value => warnings.push(value),
      refreshBillingInvoiceState: async () => { throw new Error("Billing saved; refresh offline"); },
    });
    assert.equal(await mutate(verb, { id: "review-1", reviewRevision: 3 }), result);
    assert.equal(calls, 1);
    assert.equal(warnings.at(-1), "Billing saved; refresh offline");
  }
});

test("new estimate retry after a background commit preserves later office changes", async () => {
  const attempted = { ...edited, createdAt: 1001, clientId: "client-1" };
  const current = { ...attempted, notes: "Office note after background save" };
  const { persist } = persistenceHarness([current], async (next, _value, options) => {
    const merged = mergeStoredState("sps_estimates", JSON.parse(options.baseValue), next, [current]);
    assert.deepEqual(merged.conflicts, []);
    return { ok: true, value: merged.value };
  });
  const confirmed = await persist(attempted, { baselineEstimate: null, attemptedEstimate: attempted });
  assert.equal(confirmed.notes, current.notes);
  assert.equal(confirmed.title, attempted.title);
});

test("a new estimate collision needs its own frozen attempt before it can merge a saved record", async () => {
  const current = { ...edited, createdAt: 1001, clientId: "client-1" };
  const { persist, writes } = persistenceHarness([current]);
  await assert.rejects(persist(edited, { baselineEstimate: null }), /already exists/);
  await assert.rejects(persist(edited, { baselineEstimate: null, attemptedEstimate: { ...current, createdAt: 2002 } }), /already exists/);
  assert.deepEqual(writes, []);
});
