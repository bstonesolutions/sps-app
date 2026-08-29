import test from "node:test";
import assert from "node:assert/strict";

import {
  DASHBOARD_WIDGETS,
  canEditDashboardTarget,
  dashboardLayoutForTarget,
  resolveDashboardLayout,
  safeDashboardItems,
  visibleDashboardItems,
  writeDashboardLayout,
} from "../dashboardLayout.js";

const owner = { id: "owner-1", name: "Brandon", role: "owner" };
const field = { id: "field-1", name: "David", role: "field" };
const office = { id: "office-1", name: "Office", role: "full" };
const team = [owner, field, office];

test("legacy sps_home items are retained while new dashboard sections are added", () => {
  const legacy = {
    items: [
      { id: "comms", on: false },
      { id: "todayRoute", on: true },
      { id: "profit", on: true },
    ],
    unrelatedPreference: "preserved",
  };

  const resolved = resolveDashboardLayout(legacy, owner);
  assert.equal(resolved.source, "legacy");
  assert.deepEqual(resolved.items.slice(0, 5), [
    { id: "todayHero", on: true },
    { id: "quickActions", on: true },
    { id: "comms", on: false },
    { id: "todayRoute", on: true },
    { id: "profit", on: true },
  ]);
  assert.deepEqual(new Set(resolved.items.map(item => item.id)), new Set(DASHBOARD_WIDGETS.map(widget => widget.id)));
});

test("member layout overrides role layout, which overrides the safe default", () => {
  const home = {
    dashboard: {
      roles: {
        field: { items: [{ id: "alerts", on: false }, { id: "todayRoute", on: true }] },
      },
      members: {
        "field-1": { items: [{ id: "todayRoute", on: false }, { id: "stats", on: true }] },
      },
    },
  };

  const personal = resolveDashboardLayout(home, field);
  assert.equal(personal.source, "member");
  assert.equal(personal.items.find(item => item.id === "todayRoute").on, false);

  const roleOnly = resolveDashboardLayout({ dashboard: { roles: home.dashboard.roles } }, field);
  assert.equal(roleOnly.source, "role");
  assert.equal(roleOnly.items.find(item => item.id === "alerts").on, false);

  const fallback = resolveDashboardLayout({}, field);
  assert.equal(fallback.source, "safe");
  assert.deepEqual(fallback.items, safeDashboardItems("field"));
});

test("owner can save role and member layouts without discarding the existing home shape", () => {
  const original = { items: [{ id: "stats", on: true }], favoriteMetric: "revenue" };
  const roleItems = safeDashboardItems("field").map(item => item.id === "comms" ? { ...item, on: false } : item);
  const withRole = writeDashboardLayout(original, { type: "role", id: "field" }, roleItems, owner);
  const withMember = writeDashboardLayout(withRole, { type: "member", id: office.id }, safeDashboardItems("office"), owner);

  assert.equal(withMember.favoriteMetric, "revenue");
  assert.equal(withMember.dashboard.roles.field.items.find(item => item.id === "comms").on, false);
  assert.deepEqual(withMember.dashboard.members[office.id].items, safeDashboardItems("office"));
  assert.deepEqual(withMember.items, original.items);
});

test("owner partial member writes inherit the target staff role while self writes trust the actor role", () => {
  const officeTarget = { type: "member", id: office.id, role: office.role };
  const officeWrite = writeDashboardLayout({}, officeTarget, [{ id: "comms", on: false }], owner);
  assert.equal(officeWrite.dashboard.members[office.id].items.find(item => item.id === "profit").on, false);

  const forgedSelfTarget = { type: "member", id: field.id, role: "owner" };
  const selfWrite = writeDashboardLayout({}, forgedSelfTarget, [{ id: "todayHero", on: true }], field);
  assert.equal(selfWrite.dashboard.members[field.id].items.find(item => item.id === "profit").on, false);
});

test("staff can edit only their own member override, including forged role or member targets", () => {
  const ownTarget = { type: "member", id: field.id };
  const otherTarget = { type: "member", id: office.id };
  const roleTarget = { type: "role", id: "field" };
  assert.equal(canEditDashboardTarget(field, ownTarget), true);
  assert.equal(canEditDashboardTarget(field, otherTarget), false);
  assert.equal(canEditDashboardTarget(field, roleTarget), false);

  const original = { marker: "unchanged" };
  const blockedOther = writeDashboardLayout(original, otherTarget, safeDashboardItems("field"), field);
  const blockedRole = writeDashboardLayout(original, roleTarget, safeDashboardItems("field"), field);
  const own = writeDashboardLayout(original, ownTarget, safeDashboardItems("field"), field);
  assert.equal(blockedOther, original);
  assert.equal(blockedRole, original);
  assert.notEqual(own, original);
  assert.ok(own.dashboard.members[field.id]);
});

test("permission filtering fails closed even when a stored section is enabled", () => {
  const enabled = DASHBOARD_WIDGETS.map(widget => ({ id: widget.id, on: true }));
  const fieldAllowed = new Set(["todayHero", "quickActions", "alerts", "todayRoute", "stats", "clock"]);
  const visible = visibleDashboardItems(enabled, fieldAllowed).map(item => item.id);

  assert.ok(!visible.includes("profit"));
  assert.ok(!visible.includes("comms"));
  assert.deepEqual(new Set(visible), fieldAllowed);
});

test("owner target editor resolves role defaults and individual overrides independently", () => {
  const home = {
    dashboard: {
      roles: { office: { items: [{ id: "comms", on: false }] } },
      members: { [office.id]: { items: [{ id: "comms", on: true }, { id: "profit", on: false }] } },
    },
  };

  const roleLayout = dashboardLayoutForTarget(home, { type: "role", id: "office" }, team);
  const memberLayout = dashboardLayoutForTarget(home, { type: "member", id: office.id }, team);
  assert.equal(roleLayout.source, "role");
  assert.equal(roleLayout.items.find(item => item.id === "comms").on, false);
  assert.equal(memberLayout.source, "member");
  assert.equal(memberLayout.items.find(item => item.id === "comms").on, true);
  assert.equal(memberLayout.items.find(item => item.id === "profit").on, false);
});
