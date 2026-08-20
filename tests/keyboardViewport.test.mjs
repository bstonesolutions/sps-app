import test from "node:test";
import assert from "node:assert/strict";
import { stableKeyboardInset } from "../keyboardViewport.js";

test("caret viewport pans cannot change the keyboard inset", () => {
  const first = stableKeyboardInset({ baselineHeight: 844, viewportHeight: 524, previousInset: 0 });
  const panned = stableKeyboardInset({ baselineHeight: 844, viewportHeight: 524, previousInset: first });
  assert.equal(first, 320);
  assert.equal(panned, 320);
});

test("small browser chrome changes are not treated as a keyboard", () => {
  assert.equal(stableKeyboardInset({ baselineHeight: 844, viewportHeight: 790 }), 0);
});

test("tiny keyboard-height jitter is held while a keyboard is open", () => {
  assert.equal(stableKeyboardInset({ baselineHeight: 844, viewportHeight: 522, previousInset: 320 }), 320);
  assert.equal(stableKeyboardInset({ baselineHeight: 844, viewportHeight: 510, previousInset: 320 }), 334);
});
