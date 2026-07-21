import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("client app and browser links route to reports, estimates, invoices, and tracking", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const portalStart = app.indexOf("function SPSClientPortal");
  const portalEnd = app.indexOf("function stopStateValue", portalStart);
  const portal = app.slice(portalStart, portalEnd);
  const browserRouteStart = app.indexOf("const _openParamRef");
  const browserRouteEnd = app.indexOf("// ── Website leads auto-import", browserRouteStart);
  const browserRoute = app.slice(browserRouteStart, browserRouteEnd);

  assert.match(portal, /reports.*property.*history.*setPage\("cp_property"\)/);
  assert.match(portal, /estimates.*setPage\("cp_estimates"\)/);
  assert.match(portal, /track.*home.*setPage\("cp_home"\)/);
  assert.match(browserRoute, /\(!currentUser && !clientUser\)/);
  assert.match(browserRoute, /hashParams\.get\("open"\)/);
  assert.match(browserRoute, /setPortalDeepLink\(open\)/);
});

test("client message send paths guarantee paired destinations after editable content", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const cron = await readFile(new URL("../api/cron-automations.js", import.meta.url), "utf8");

  assert.match(app, /appendClientLinks\(short, \{ target: "reports"/);
  assert.match(app, /target: "estimates", origin: PROD_URL, heading: "Review your estimate/);
  assert.match(app, /appendClientLinks\(smsMsg, \{ target: "invoices"/);
  assert.match(app, /appendClientLinks\(reviewMsg, \{\s*target: "invoices"/);
  assert.match(app, /appendClientLinks\(draft, \{ target: "track"/);
  assert.match(app, /appendClientLinks\(message, \{ target: "track"/);
  assert.match(app, /withoutClientLinks\(outgoing, \{ target: "track"/);
  assert.match(cron, /appendClientLinks\(fill\(tpl/);
  assert.doesNotMatch(cron, /portal: spsway\.app/);
});

test("the editable Head Here send keeps the tracking URL in component scope", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const componentStart = app.indexOf("function HeadHereModal");
  const componentEnd = app.indexOf("function computeMissingStops", componentStart);
  const component = app.slice(componentStart, componentEnd);
  const buildStart = component.indexOf("const buildMsg");
  const sendStart = component.indexOf("const sendOmwText");

  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.ok(buildStart > 0 && sendStart > buildStart);
  assert.match(component.slice(0, buildStart), /const trackUrl =/);
  assert.match(component.slice(sendStart), /appendClientLinks\(draft, \{ target: "track"/);
});
