import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const loadApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("staff and client shells keep page actions reachable above the mobile nav and keyboard", async () => {
  const app = await loadApp();

  assert.equal((app.match(/data-sps-app-scroll/g) || []).length, 2, "both app shells should own their mobile scroll surface");
  assert.equal((app.match(/data-sps-page-end/g) || []).length, 2, "both shells should include a physical end-of-page target");
  assert.ok((app.match(/--sps-page-bottom-clearance/g) || []).length >= 4, "shared nav clearance should be defined and consumed by both shells");
  assert.ok((app.match(/--sps-floating-action-bottom/g) || []).length >= 6, "all mobile action bars should use the same nav offset");
  assert.match(app, /paddingBottom: keyboardOpen \? `calc\(\$\{keyboardInset\}px \+ 40px\)` : "var\(--sps-page-bottom-clearance\)"/);
  assert.match(app, /paddingBottom: portalKeyboardOpen \? `calc\(\$\{portalKeyboardInset\}px \+ 40px\)` : "var\(--sps-page-bottom-clearance\)"/);
  assert.match(app, /!keyboardOpen && \(\(\) => \{/);
  assert.match(app, /!isDesktopShell && !portalKeyboardOpen && \(/);
});

test("navigation resets the real app scrollers instead of the locked window", async () => {
  const app = await loadApp();

  assert.match(app, /const appMainRef = useRef\(null\)/);
  assert.match(app, /const resetAppMainScroll = \(\) => \{[\s\S]*?appMainRef\.current\.scrollTop = 0/);
  assert.ok((app.match(/ref=\{appMainRef\}/g) || []).length >= 2, "desktop and mobile staff mains should share the reset ref");
  assert.ok((app.match(/ref=\{portalMainRef\}/g) || []).length >= 2, "desktop and mobile portal mains should share the reset ref");
  assert.doesNotMatch(app, /window\.scrollTo\(\{ top: 0/);
});

test("estimate editor and modal polish prevents clipped actions and accidental data loss", async () => {
  const app = await loadApp();
  const estimateStart = app.indexOf("function EstimateForm");
  const estimateEnd = app.indexOf("function TotalSalesScreen", estimateStart);
  const estimate = app.slice(estimateStart, estimateEnd);

  assert.match(estimate, /const wideEstimateLayout = vp\.width >= 900/);
  assert.match(estimate, /data-estimate-actions/);
  assert.match(estimate, /Discard the unsaved changes to this estimate/);
  assert.match(estimate, /data-estimate-line-id/);
  assert.match(estimate, /scrollIntoView\(\{ block: "center", behavior: "smooth" \}\)/);
  assert.match(app, /function Modal\(\{ title, children, onClose, maxWidth = 600, dismissOnBackdrop = false \}\)/);
  assert.match(app, /role="dialog" aria-modal="true" aria-label=\{title \|\| "Dialog"\}/);
});

test("short-screen staff chat no longer forces its composer below the nav", async () => {
  const app = await loadApp();
  const start = app.indexOf("function StaffChat");
  const end = app.indexOf("function CPMessages", start);
  const chat = app.slice(start, end);

  assert.doesNotMatch(chat, /clamp\(430px/);
  assert.match(chat, /min\(760px, calc\(100dvh - 238px\)\)/);
  assert.match(chat, /maxHeight: embedded \? "100%" : "calc\(100dvh - 238px\)"/);
});
