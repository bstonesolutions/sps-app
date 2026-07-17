import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const loadApp = () => readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("staff and client shells keep page actions reachable above the mobile nav and keyboard", async () => {
  const app = await loadApp();

  assert.equal((app.match(/data-sps-app-scroll/g) || []).length, 2, "both app shells should own their mobile scroll surface");
  assert.match(app, /function MobilePageEndClearance\(\{ keyboardOpen = false, keyboardInset = 0 \}\)/);
  assert.equal((app.match(/<MobilePageEndClearance /g) || []).length, 2, "both shells should render the physical end-of-page clearance block");
  assert.match(app, /data-sps-page-end-clearance/);
  assert.match(app, /height, minHeight: height, flex: `0 0 \$\{height\}`/);
  assert.ok((app.match(/--sps-page-bottom-clearance/g) || []).length >= 4, "shared nav clearance should be defined and consumed by both shells");
  assert.ok((app.match(/--sps-mobile-nav-reserve/g) || []).length >= 4, "both shells should reserve the floating dock outside the scroll viewport");
  assert.ok((app.match(/--sps-floating-action-bottom/g) || []).length >= 6, "all mobile action bars should use the same nav offset");
  assert.equal((app.match(/paddingBottom: 0, scrollPaddingBottom:/g) || []).length, 2, "mobile shells must not depend on Safari scroll-container padding for reachability");
  assert.match(app, /marginBottom: keyboardOpen \? 0 : "var\(--sps-mobile-nav-reserve\)"/);
  assert.match(app, /marginBottom: portalKeyboardOpen \? 0 : "var\(--sps-mobile-nav-reserve\)"/);
  assert.match(app, /<MobilePageEndClearance keyboardOpen=\{keyboardOpen\} keyboardInset=\{keyboardInset\} \/>/);
  assert.match(app, /<MobilePageEndClearance keyboardOpen=\{portalKeyboardOpen\} keyboardInset=\{portalKeyboardInset\} \/>/);
  assert.match(app, /!keyboardOpen && \(\(\) => \{/);
  assert.match(app, /!isDesktopShell && !portalKeyboardOpen && \(/);

  // Geometry contract: <main> physically ends above the 64px dock and its 4px bottom gap, with
  // extra separation. The real end block then provides ordinary content breathing room.
  const reserves = [...app.matchAll(/\["--sps-mobile-nav-reserve"\]: "calc\(env\(safe-area-inset-bottom\) \+ (\d+)px\)"/g)]
    .map((match) => Number(match[1]));
  assert.equal(reserves.length, 2, "staff and client shells should declare the same measured dock reserve");
  assert.ok(reserves.every((value) => value >= 64 + 4 + 8), "scroll viewport must end above the dock instead of beneath it");
  assert.equal((app.match(/\["--sps-page-bottom-clearance"\]: "24px"/g) || []).length, 2, "the physical page-end block should keep a consistent 24px content gap");
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
