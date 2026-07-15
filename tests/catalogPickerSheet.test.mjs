import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("catalog picker owns its scroll instead of chaining to the page behind it", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function CatalogPickerSheet");
  const end = app.indexOf("function QBConnect", start);
  const source = app.slice(start, end);

  assert.match(source, /useBackgroundScrollLock\(\)/);
  assert.match(source, /return createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /minHeight: 0[\s\S]*?overflow: "hidden"/);
  assert.match(source, /flex: "1 1 auto"[\s\S]*?minHeight: 0[\s\S]*?overflowY: "auto"/);
  assert.match(source, /WebkitOverflowScrolling: "touch"/);
  assert.match(source, /overscrollBehavior: "contain"/);
  assert.match(source, /touchAction: "pan-y"/);

  const lockStart = app.indexOf("function useBackgroundScrollLock");
  const lockEnd = app.indexOf("function Modal", lockStart);
  const lockSource = app.slice(lockStart, lockEnd);
  assert.match(lockSource, /document\.querySelectorAll\("main, \[data-sps-modal-scroll\]"\)/);
  assert.match(lockSource, /target\.style\.overflow = "hidden"/);
  assert.match(lockSource, /target\.scrollTop = snapshot\.scrollTop/);
  assert.match(app, /data-sps-modal-scroll/);

  assert.equal((app.match(/<CatalogPickerSheet/g) || []).length, 2, "invoice and estimate builders should share the fixed picker");
});
