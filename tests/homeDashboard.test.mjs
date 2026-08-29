import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readApp = () => readFile(new URL("App.jsx", root), "utf8");

function homeSource(app) {
  return app.slice(app.indexOf("function Dashboard({"), app.indexOf("// CLIENT LIST"));
}

test("Home is an asymmetric operations dashboard with schedule and save health first", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /data-home-dashboard="operations"/);
  assert.match(home, /Today \/ route/);
  assert.match(home, /Next stops/);
  assert.match(home, /Save health/);
  assert.match(home, /gridTemplateColumns: isWide \? "repeat\(12, minmax\(0, 1fr\)\)"/);
  assert.match(home, /data-dashboard-widget=\{item\.id\}/);
  assert.match(home, /upcomingStops = todayStops\.filter\(stop => !isStopDone\(stop\)\)\.slice\(0, 3\)/);
});

test("Home fails closed for staff finance and scopes assigned route work", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /const canBalance = canSeeBalanceMoney\(perms\)/);
  assert.match(home, /const canProfit = canSeeProfitMoney\(perms\)/);
  assert.match(home, /const businessPulse = widgetEnabled\("profit"\) && canFinance/);
  assert.match(home, /canBalance && \{ label: "Outstanding"/);
  assert.match(home, /canProfit && \{ label: "Profit this month"/);
  assert.match(home, /!perms\.isAdmin && memberId && hasAssignments/);
  assert.match(home, /String\(stop\?\.assigneeId \|\| ""\) === memberId/);
});

test("Home and Invoices share the confirmed QuickBooks accounting summary", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /resolveInvoiceAccountingSummary\(qbAccounting/);
  assert.match(home, /accountingSummary\.outstandingTotal/);
  assert.match(home, /accountingSummary\.outstandingCount/);
  assert.match(home, /accountingSummary\.collectedMonth/);
  assert.match(app, /qbAccounting=\{qbAccounting\}/);
});

test("Home surfaces durable-save and owner-only media health actions", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /completionOutboxSummary\(completionOutboxItems\)/);
  assert.match(home, /id: "saved-report-review"/);
  assert.match(home, /id: "saved-report-sync"/);
  assert.match(home, /id: "shared-conflict"/);
  assert.match(home, /id: "shared-save-error"/);
  assert.match(home, /perms\.isAdmin && legacyMediaCount > 0/);
  assert.match(home, /legacyMediaHealth\?\.inlineDataUrlCount/);
  assert.match(home, /onNav\("settings", \{ settingsTab: "sync", settingsSection: "mediaCleanup" \}\)/);
  assert.match(app, /const legacyMediaHealth = useMemo\(\(\) => inspectLegacyMediaHealth\(clients\), \[clients\]\)/);
  assert.match(app, /legacyMediaHealth=\{legacyMediaHealth\}/);
});

test("Home uses the SPS crimson system without gradients or purple accents", async () => {
  const app = await readApp();
  const home = homeSource(app);
  const comms = app.slice(app.indexOf("function HomeCommsWidget"), app.indexOf("function LegacyDashboard"));

  assert.match(home, /const crimson = "#AF011A"/);
  assert.doesNotMatch(home, /linear-gradient|radial-gradient/i);
  assert.doesNotMatch(`${home}\n${comms}`, /#7c3aed|#8b5cf6|#6366f1|#4f46e5|purple|indigo|violet/i);
});

test("Home customization covers the full dashboard and owner role or member audiences", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /data-dashboard-customizer="true"/);
  assert.match(home, /Field staff default/);
  assert.match(home, /Office staff default/);
  assert.match(home, /Dashboard audience/);
  assert.match(home, /DASHBOARD_WIDGETS\.find/);
  assert.match(home, /Show, hide, and arrange/);
  assert.match(home, /moveSection\(item\.id, -1\)/);
  assert.match(home, /moveSection\(item\.id, 1\)/);
  assert.match(app, /me=\{currentUser\}[\s\S]*team=\{team\}[\s\S]*scheduleCfg=\{scheduleCfg\}/);
});

test("Home customization enforces permissions and staff self-only edits", async () => {
  const app = await readApp();
  const home = homeSource(app);

  assert.match(home, /if \(!editing \|\| perms\.isAdmin\) return/);
  assert.match(home, /if \(editTargetKey !== selfTargetKey\) setEditTargetKey\(selfTargetKey\)/);
  assert.match(home, /if \(!canEditDashboardTarget\(me, editTarget\)\) return/);
  assert.match(home, /Hidden by this member's access/);
  assert.match(home, /const liveAllowedIds = new Set/);
  assert.match(home, /visibleDashboardItems\(liveLayout\.items, liveAllowedIds\)/);
});
