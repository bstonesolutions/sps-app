export const DASHBOARD_LAYOUT_VERSION = 2;

export const DASHBOARD_WIDGETS = Object.freeze([
  { id: "todayHero", label: "Today's work", defaultOn: true, permission: "operations" },
  { id: "quickActions", label: "Quick actions", defaultOn: true, permission: "operations" },
  { id: "alerts", label: "Needs attention", defaultOn: true, permission: "operations" },
  { id: "todayRoute", label: "Upcoming stops", defaultOn: true, permission: "operations" },
  { id: "stats", label: "Field status", defaultOn: true, permission: "operations" },
  { id: "clock", label: "Time clock", defaultOn: true, permission: "operations" },
  { id: "comms", label: "Communications", defaultOn: true, permission: "comms" },
  { id: "profit", label: "Business pulse", defaultOn: true, permission: "finance" },
]);

const IDS = DASHBOARD_WIDGETS.map(widget => widget.id);
const ID_SET = new Set(IDS);
const NEW_IDS = new Set(["todayHero", "quickActions", "clock"]);

const SAFE_ORDER = Object.freeze({
  owner: ["todayHero", "quickActions", "alerts", "todayRoute", "stats", "clock", "profit", "comms"],
  field: ["todayHero", "quickActions", "alerts", "todayRoute", "stats", "clock", "comms", "profit"],
  office: ["alerts", "comms", "todayHero", "quickActions", "todayRoute", "stats", "clock", "profit"],
});

export function dashboardRoleBucket(member) {
  const role = String(member?.role || "field").trim().toLowerCase();
  if (role === "owner") return "owner";
  if (role === "field" || role === "lead") return "field";
  return "office";
}

export function safeDashboardItems(bucket = "field") {
  const role = SAFE_ORDER[bucket] ? bucket : "field";
  return SAFE_ORDER[role].map(id => ({
    id,
    on: id !== "profit" || role === "owner",
  }));
}

function rawItemsOf(layout) {
  if (Array.isArray(layout)) return layout;
  return Array.isArray(layout?.items) ? layout.items : [];
}

export function normalizeDashboardItems(layout, bucket = "field", { legacy = false } = {}) {
  const raw = rawItemsOf(layout);
  const seen = new Set();
  const normalized = [];
  raw.forEach(item => {
    const id = typeof item === "string" ? item : item?.id;
    if (!ID_SET.has(id) || seen.has(id)) return;
    seen.add(id);
    normalized.push({ id, on: typeof item === "string" ? true : item.on !== false });
  });

  const sourceLooksLegacy = legacy || (normalized.length > 0 && !normalized.some(item => NEW_IDS.has(item.id)));
  const safe = safeDashboardItems(bucket);
  if (sourceLooksLegacy) {
    const prefix = safe.filter(item => item.id === "todayHero" || item.id === "quickActions");
    const suffix = safe.filter(item => item.id === "clock");
    const carried = new Set([...prefix, ...normalized, ...suffix].map(item => item.id));
    const remaining = safe.filter(item => !carried.has(item.id));
    return [...prefix, ...normalized, ...suffix, ...remaining];
  }

  safe.forEach(item => {
    if (!seen.has(item.id)) normalized.push(item);
  });
  return normalized.length ? normalized : safe;
}

export function dashboardTargetKey(target) {
  if (target?.type === "role" && ["field", "office"].includes(target.id)) return `role:${target.id}`;
  if (target?.type === "member" && target.id != null) return `member:${String(target.id)}`;
  return "";
}

export function canEditDashboardTarget(actor, target) {
  const actorId = String(actor?.id || "");
  if (!actorId || !dashboardTargetKey(target)) return false;
  if (String(actor?.role || "field").toLowerCase() === "owner") return true;
  return target.type === "member" && String(target.id) === actorId;
}

export function resolveDashboardLayout(home, member) {
  const safeHome = home && typeof home === "object" ? home : {};
  const dashboard = safeHome.dashboard && typeof safeHome.dashboard === "object" ? safeHome.dashboard : {};
  const memberId = String(member?.id || "");
  const bucket = dashboardRoleBucket(member);
  const memberLayout = memberId && dashboard.members && dashboard.members[memberId];
  if (memberLayout) {
    return { source: "member", bucket, items: normalizeDashboardItems(memberLayout, bucket) };
  }
  if (bucket !== "owner" && dashboard.roles && dashboard.roles[bucket]) {
    return { source: "role", bucket, items: normalizeDashboardItems(dashboard.roles[bucket], bucket) };
  }
  if (bucket === "owner" && Array.isArray(safeHome.items)) {
    return { source: "legacy", bucket, items: normalizeDashboardItems(safeHome.items, bucket, { legacy: true }) };
  }
  return { source: "safe", bucket, items: safeDashboardItems(bucket) };
}

export function dashboardLayoutForTarget(home, target, team = []) {
  if (target?.type === "role") {
    const layout = home?.dashboard?.roles?.[target.id];
    return {
      source: layout ? "role" : "safe",
      bucket: target.id,
      items: layout ? normalizeDashboardItems(layout, target.id) : safeDashboardItems(target.id),
    };
  }
  const member = (team || []).find(person => String(person?.id) === String(target?.id));
  return resolveDashboardLayout(home, member || { id: target?.id, role: "field" });
}

export function writeDashboardLayout(home, target, items, actor) {
  const current = home && typeof home === "object" ? home : {};
  if (!canEditDashboardTarget(actor, target)) return current;
  const isSelfTarget = String(target?.id) === String(actor?.id);
  const memberRole = isSelfTarget ? actor?.role : (target?.role || "field");
  const bucket = target.type === "role" ? target.id : dashboardRoleBucket({ role: memberRole });
  const normalized = normalizeDashboardItems({ items }, bucket);
  const dashboard = current.dashboard && typeof current.dashboard === "object" ? current.dashboard : {};
  const nextDashboard = {
    ...dashboard,
    version: DASHBOARD_LAYOUT_VERSION,
    roles: { ...(dashboard.roles || {}) },
    members: { ...(dashboard.members || {}) },
  };
  const stored = { version: DASHBOARD_LAYOUT_VERSION, items: normalized };
  if (target.type === "role") nextDashboard.roles[target.id] = stored;
  else nextDashboard.members[String(target.id)] = stored;

  const next = { ...current, dashboard: nextDashboard };
  if (target.type === "member" && String(target.id) === String(actor?.id) && String(actor?.role).toLowerCase() === "owner") {
    next.items = normalized;
  }
  return next;
}

export function resetDashboardLayout(home, target, actor) {
  const current = home && typeof home === "object" ? home : {};
  if (!canEditDashboardTarget(actor, target)) return current;
  const dashboard = current.dashboard && typeof current.dashboard === "object" ? current.dashboard : {};
  const nextDashboard = {
    ...dashboard,
    version: DASHBOARD_LAYOUT_VERSION,
    roles: { ...(dashboard.roles || {}) },
    members: { ...(dashboard.members || {}) },
  };
  if (target.type === "role") delete nextDashboard.roles[target.id];
  else delete nextDashboard.members[String(target.id)];
  const next = { ...current, dashboard: nextDashboard };
  if (target.type === "member" && String(target.id) === String(actor?.id) && String(actor?.role).toLowerCase() === "owner") {
    next.items = safeDashboardItems("owner");
  }
  return next;
}

export function visibleDashboardItems(items, allowedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
  return normalizeDashboardItems({ items }, "field")
    .filter(item => item.on !== false && allowed.has(item.id));
}
