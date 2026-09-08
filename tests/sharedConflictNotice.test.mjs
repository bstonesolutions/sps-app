import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { currentSharedConflict, sharedConflictReview } from "../sharedConflictNotice.js";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const invoiceConflict = {
  key: "sps_invoices",
  conflicts: [{ path: "$.qb:42.notes", kind: "same-field-edit" }],
};
const scheduleConflict = {
  key: "sps_schedule",
  conflicts: [{ path: "$.stops.visit-1.date", kind: "same-field-edit" }],
};

test("live conflict status removes an obsolete notice and preserves another unresolved choice", () => {
  assert.equal(currentSharedConflict([], invoiceConflict), null);
  assert.equal(currentSharedConflict([scheduleConflict], invoiceConflict), scheduleConflict);
  assert.equal(currentSharedConflict([scheduleConflict, invoiceConflict], invoiceConflict), invoiceConflict);
  assert.equal(currentSharedConflict([structuredClone(invoiceConflict)], invoiceConflict), invoiceConflict);
  const expanded = { ...invoiceConflict, conflicts: [...invoiceConflict.conflicts, { path: "$.qb:42.total", kind: "same-field-edit" }] };
  assert.equal(currentSharedConflict([expanded], invoiceConflict), expanded);
});

test("save completion and account events reconcile the actual App notice without choosing a version", () => {
  const start = app.indexOf("  useEffect(() => {", app.indexOf("const [dataConflict, setDataConflict]"));
  const end = app.indexOf("  }, []);", start);
  assert.ok(start >= 0 && end > start);
  const effect = app.slice(start + "  useEffect(() => {".length, end);
  const events = new EventTarget();
  let active = [invoiceConflict];
  let displayed = null;
  let error = "Previous save failed";
  let readFails = false;
  const store = {
    listConflicts() { if (readFails) throw new Error("Status unavailable"); return active; },
    resolveConflict() { assert.fail("Status updates must never resolve a conflict"); },
    set() { assert.fail("Status updates must never save data"); },
  };
  const mount = new Function("document", "store", "setDataConflict", "setConflictError", "currentSharedConflict", effect);
  const cleanup = mount(events, store, value => { displayed = typeof value === "function" ? value(displayed) : value; }, value => { error = value; }, currentSharedConflict);
  assert.equal(displayed, invoiceConflict);

  active = [invoiceConflict, scheduleConflict];
  events.dispatchEvent(new Event("sps-conflict"));
  assert.equal(displayed, invoiceConflict);
  active = [scheduleConflict];
  events.dispatchEvent(new Event("sps-reconciled"));
  assert.equal(displayed, scheduleConflict);

  readFails = true;
  events.dispatchEvent(new Event("sps-db-status"));
  assert.equal(displayed, scheduleConflict, "a failed status read must retain a real warning");
  readFails = false;
  active = [];
  events.dispatchEvent(new Event("sps-db-status"));
  assert.equal(displayed, null);
  assert.equal(error, "");

  cleanup();
  active = [invoiceConflict];
  events.dispatchEvent(new Event("sps-conflict"));
  assert.equal(displayed, null, "unmounted listeners must be removed");
});

test("review describes business fields without displaying raw invoice ids or internal merge paths", () => {
  const review = sharedConflictReview({
    key: "sps_invoices",
    conflicts: [
      { path: "$.qb:42.qbContentFingerprint", kind: "same-field-edit" },
      { path: "$.qb:42.qbBaseContentFingerprint", kind: "same-field-edit" },
      { path: "$.qb:42.notes", kind: "same-field-edit" },
      { path: "$.qb:42.internalUnknownField", kind: "same-field-edit" },
    ],
  });
  assert.deepEqual(review.fields, ["QuickBooks invoice revision", "Notes", "Saved details"]);
  assert.equal(review.needsFullReview, false);
  assert.doesNotMatch(JSON.stringify(review), /qb:42|internalUnknownField|\$\./);
});

test("whole-record and deletion conflicts do not promise field-level preservation", () => {
  for (const kind of ["legacy-base-unknown", "delete-vs-edit", "restore-baseline-changed", "concurrent-reorder"]) {
    const review = sharedConflictReview({ key: "sps_invoices", conflicts: [{ path: "$", kind }] });
    assert.equal(review.needsFullReview, true);
    assert.doesNotMatch(review.explanation, /other fields will be combined/);
  }
});

test("version-choice actions are shown only inside the explicit review disclosure", () => {
  const start = app.indexOf("function DataConflictBanner(");
  const end = app.indexOf("const STOP_MUTATION_KEYS", start);
  const banner = app.slice(start, end);
  assert.match(banner, /const \[reviewing, setReviewing\] = useState\(false\)/);
  assert.match(banner, /aria-expanded=\{reviewing\}/);
  const disclosure = banner.indexOf("{reviewing &&");
  assert.ok(disclosure > 0);
  assert.ok(banner.indexOf('onResolve("remote")') > disclosure);
  assert.ok(banner.indexOf('onResolve("local")') > disclosure);
  assert.doesNotMatch(banner, /Use shared change|Use my change|#C2410C|conflict\.summary/);
});
