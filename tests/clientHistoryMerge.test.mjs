import test from "node:test";
import assert from "node:assert/strict";
import { mergeStoredState } from "../stateMerge.js";

const legacy = () => ({
  visitDate: "2026-08-01",
  notes: "Existing legacy visit",
  photos: [{ url: "data:image/jpeg;base64,legacy-photo", caption: "Pond 夏" }],
  readings: { ph: "7.2", ammonia: "0" },
});
const report = (name) => ({
  sid: `${name}-stop`, completionReceiptId: `${name}-receipt`, notes: `${name} saved report`,
  photos: [{ url: `https://example.test/${name}.jpg` }],
});
function mergeHistory(base, local, remote, options, key = "sps_clients") {
  const encode = (history) => JSON.stringify([{ id: "c1", name: "Client", history }]);
  const inputs = [base, local, remote].map(encode);
  const result = mergeStoredState(key, ...inputs, options);
  assert.deepEqual([base, local, remote].map(encode), inputs, "merge must not alter input snapshots");
  return { ...result, history: JSON.parse(result.value)[0].history };
}
function assertHistoryContents(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (const entry of expected) {
    assert.equal(actual.filter((candidate) => {
      try { assert.deepEqual(candidate, entry); return true; } catch { return false; }
    }).length, 1, "each exact report must be retained once");
  }
}

test("merges independent receipt-backed visits around an unchanged legacy visit without losing report content", () => {
  const old = legacy(), local = report("local"), remote = report("remote");
  for (const prefer of ["local", "remote"]) {
    const result = mergeHistory([old], [local, structuredClone(old)], [remote, structuredClone(old)], { prefer });
    assert.deepEqual(result.conflicts, []);
    assertHistoryContents(result.history, [old, local, remote]);
    assert.equal(JSON.stringify(result.history).includes("unchanged-history:"), false);
  }
});

test("legacy equality ignores object property order but preserves nested values and Unicode", () => {
  const old = legacy();
  const reordered = {
    readings: { ammonia: "0", ph: "7.2" },
    photos: [{ caption: "Pond 夏", url: "data:image/jpeg;base64,legacy-photo" }],
    notes: old.notes, visitDate: old.visitDate,
  };
  const local = report("local"), remote = report("remote");
  const result = mergeHistory([old], [local, reordered], [remote, structuredClone(old)]);
  assert.deepEqual(result.conflicts, []);
  assertHistoryContents(result.history, [old, local, remote]);
});

test("receipt-only history additions have stable identity without changing unrelated array identity rules", () => {
  const old = legacy();
  const local = { completionReceiptId: "receipt-local", notes: "Local" };
  const remote = { completionReceiptId: "receipt-remote", notes: "Remote" };
  const result = mergeHistory([old], [local, old], [remote, old]);
  assert.deepEqual(result.conflicts, []);
  assertHistoryContents(result.history, [old, local, remote]);
  const unrelated = mergeHistory([old], [local, old], [remote, old], undefined, "other_section");
  assert.equal(unrelated.conflicts[0]?.kind, "concurrent-array-edit");
});

test("ambiguous, changed, deleted, or newly anonymous legacy rows remain whole-history conflicts", () => {
  const old = legacy(), local = report("local"), remote = report("remote");
  const cases = [
    { label: "duplicate base", base: [old, structuredClone(old)], local: [local, old, structuredClone(old)], remote: [remote, old, structuredClone(old)] },
    { label: "duplicate local", base: [old], local: [local, old, structuredClone(old)], remote: [remote, old] },
    { label: "duplicate remote", base: [old], local: [local, old], remote: [remote, old, structuredClone(old)] },
    { label: "changed notes", base: [old], local: [local, { ...old, notes: "Changed" }], remote: [remote, old] },
    { label: "changed photo", base: [old], local: [local, { ...old, photos: [] }], remote: [remote, old] },
    { label: "deleted legacy", base: [old], local: [local], remote: [remote, old] },
    { label: "new anonymous visit", base: [old], local: [local, old, { notes: "New anonymous" }], remote: [remote, old] },
    { label: "same edit on both devices plus separate additions", base: [old], local: [local, { ...old, notes: "Changed" }], remote: [remote, { ...old, notes: "Changed" }] },
    { label: "primitive legacy entry", base: ["legacy"], local: [local, "legacy"], remote: [remote, "legacy"] },
  ];
  for (const item of cases) {
    for (const prefer of ["local", "remote"]) {
      const result = mergeHistory(item.base, item.local, item.remote, { prefer });
      assert.equal(result.conflicts.length, 1, item.label);
      assert.equal(result.conflicts[0].kind, "concurrent-array-edit", item.label);
      assert.match(result.conflicts[0].path, /\.history$/, item.label);
      assert.deepEqual(result.history, item[prefer], item.label);
    }
  }
});

test("legacy nested array order is data and is never ignored for a match", () => {
  const old = { ...legacy(), services: ["Pool", "Pond"] };
  const result = mergeHistory([old], [report("local"), { ...old, services: ["Pond", "Pool"] }], [report("remote"), old]);
  assert.equal(result.conflicts[0]?.kind, "concurrent-array-edit");
});

test("real edits to the same keyed report still conflict without discarding either independent report addition", () => {
  const old = legacy(), existing = report("existing"), local = report("local"), remote = report("remote");
  for (const prefer of ["local", "remote"]) {
    const result = mergeHistory(
      [existing, old],
      [local, { ...existing, notes: "Local correction" }, old],
      [remote, { ...existing, notes: "Remote correction" }, old],
      { prefer }
    );
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].kind, "same-field-edit");
    assert.match(result.conflicts[0].path, /\.notes$/);
    assertHistoryContents(result.history, [old, local, remote, { ...existing, notes: prefer === "local" ? "Local correction" : "Remote correction" }]);
  }
});

test("duplicate keyed report identities remain ambiguous even when the legacy row is unchanged", () => {
  const old = legacy(), local = report("local"), remote = report("remote");
  const result = mergeHistory([old], [local, { ...local, notes: "Duplicate" }, old], [remote, old]);
  assert.equal(result.conflicts[0]?.kind, "concurrent-array-edit");
});

test("same receipt-only addition with different content is not silently accepted", () => {
  const old = legacy();
  const result = mergeHistory([old], [{ completionReceiptId: "same", notes: "Local" }, old], [{ completionReceiptId: "same", notes: "Remote" }, old]);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].path, /\.notes$/);
  assert.equal(result.history.filter((entry) => entry.completionReceiptId === "same").length, 1);
});

test("inconsistent identities for the same receipt cannot create duplicate reports", () => {
  const old = legacy();
  const versions = [
    { completionReceiptId: "same", notes: "Report" },
    { completionReceiptId: "same", sid: "stop", notes: "Report" },
    { completionReceiptId: "same", id: "visit", notes: "Report" },
    { completionReceiptId: "same", id: "visit-other", sid: "stop", notes: "Report" },
  ];
  for (let left = 0; left < versions.length; left += 1) for (let right = 0; right < versions.length; right += 1) {
    if (left === right) continue;
    for (const base of [[], [old]]) {
      const result = mergeHistory(base, [versions[left], ...base], [versions[right], ...base]);
      assert.equal(result.conflicts[0]?.kind, "concurrent-array-edit");
      assert.equal(result.history.filter((entry) => entry.completionReceiptId === "same").length, 1);
    }
  }
});

test("unchanged legacy identities preserve existing order rules for every three-row permutation", () => {
  const original = [0, 1, 2];
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const rows = original.map((i) => ({ ...legacy(), visitDate: `2026-08-0${i + 1}` }));
  const local = report("local"), remote = report("remote");
  const sameOrder = (a, b) => a.every((value, i) => value === b[i]);
  for (const localOrder of permutations) for (const remoteOrder of permutations) for (const prefer of ["local", "remote"]) {
    const result = mergeHistory(rows, [local, ...localOrder.map((i) => structuredClone(rows[i]))], [remote, ...remoteOrder.map((i) => structuredClone(rows[i]))], { prefer });
    const localMoved = !sameOrder(localOrder, original), remoteMoved = !sameOrder(remoteOrder, original);
    const conflict = localMoved && remoteMoved && !sameOrder(localOrder, remoteOrder);
    assert.equal(result.conflicts.length, conflict ? 1 : 0);
    if (conflict) assert.equal(result.conflicts[0].kind, "concurrent-reorder");
    const expectedOrder = localMoved && !remoteMoved ? localOrder
      : remoteMoved && !localMoved ? remoteOrder
        : localMoved && remoteMoved ? (prefer === "local" ? localOrder : remoteOrder) : original;
    assert.deepEqual(result.history.filter((entry) => !entry.sid).map((entry) => entry.visitDate), expectedOrder.map((i) => rows[i].visitDate));
    assertHistoryContents(result.history, [...rows, local, remote]);
  }
});
