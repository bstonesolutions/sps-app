import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridge = await readFile(new URL("../ios/App/App/SPSWidgetBridge.swift", import.meta.url), "utf8");
const infoPlist = await readFile(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8");
const project = await readFile(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8");

test("the iOS target declares only the background location mode needed for arrival geofences", () => {
  assert.match(project, /com\.apple\.BackgroundModes = \{[\s\S]{0,80}enabled = 1;/);
  assert.match(infoPlist, /<key>UIBackgroundModes<\/key>[\s\S]{0,80}<string>location<\/string>/);
  assert.doesNotMatch(infoPlist, /<string>remote-notification<\/string>/);
});

test("preservePending retains native state only for a matching durable detection", () => {
  assert.match(bridge, /let hasDurablePending = preservePending[\s\S]*active\?\.stopId == pending\?\.stopId[\s\S]*active\?\.detectedAt != nil/);
  assert.match(bridge, /if !hasDurablePending \{[\s\S]*removeObject\(forKey: self\.activeStopKey\)[\s\S]*removeObject\(forKey: self\.pendingArrivalKey\)/);
});

test("a pending region event wins over a configure callback", () => {
  const guardIndex = bridge.indexOf("if loadPendingArrival() != nil");
  const stopIndex = bridge.indexOf("stopArrivalRegions()", guardIndex);
  assert.ok(guardIndex >= 0, "finishConfigure must check durable pending state");
  assert.ok(stopIndex > guardIndex, "pending must be checked before replacing the monitored region");
  const guardedBlock = bridge.slice(guardIndex, stopIndex);
  assert.match(guardedBlock, /activeConfigureCall = nil/);
  assert.match(guardedBlock, /resolveStatus\(call\)/);
  assert.doesNotMatch(bridge.slice(stopIndex, stopIndex + 180), /removeObject\(forKey: pendingArrivalKey\)/);
});

test("native status reports Background App Refresh as a stable string", () => {
  assert.match(bridge, /"backgroundRefreshStatus": backgroundRefreshStatusName\(UIApplication\.shared\.backgroundRefreshStatus\)/);
  assert.match(bridge, /case \.available: return "available"/);
  assert.match(bridge, /case \.denied: return "denied"/);
  assert.match(bridge, /case \.restricted: return "restricted"/);
  assert.match(bridge, /@unknown default: return "unknown"/);
});

test("native arrival regions expire instead of surviving into a later workday", () => {
  assert.match(bridge, /let validUntil: String\?/);
  assert.match(bridge, /private func normalizedArrivalExpiry/);
  assert.match(bridge, /configuredAt\)\?\.addingTimeInterval\(20 \* 60 \* 60\)/);
  assert.match(bridge, /private func pruneExpiredArrivalMonitor/);
  assert.match(bridge, /pruneExpiredArrivalMonitor\(\)[\s\S]{0,220}guard locationManager\.authorizationStatus/);
  assert.match(bridge, /private func handleArrival[\s\S]{0,100}pruneExpiredArrivalMonitor\(\)/);
  const pruneStart = bridge.indexOf("private func pruneExpiredArrivalMonitor()");
  const pruneEnd = bridge.indexOf("private func locationAuthorizationName", pruneStart);
  const pruneBody = bridge.slice(pruneStart, pruneEnd);
  assert.match(pruneBody, /stopMonitoring\(for: region\)/);
  assert.match(pruneBody, /removeObject\(forKey: activeStopKey\)/);
  assert.ok(pruneBody.indexOf("stopMonitoring(for: region)") < pruneBody.indexOf("removeObject(forKey: activeStopKey)"));
});

test("native arrival readiness requires Precise Location", () => {
  assert.match(bridge, /locationManager\.accuracyAuthorization == \.fullAccuracy/);
  assert.match(bridge, /"locationAccuracy": locationManager\.accuracyAuthorization == \.fullAccuracy \? "full" : "reduced"/);
  assert.match(bridge, /Precise Location is off/);
});

test("native configuration failures persist a diagnostic until setup succeeds", () => {
  assert.match(bridge, /private func rejectConfigure\(/);
  assert.ok(bridge.includes('saveLastError("Arrival configuration: \\(diagnostic)")'));
  assert.match(bridge, /call\.reject\(message, code, underlyingError\)/);
  assert.match(bridge, /code: "geocode_failed",[\s\S]{0,120}underlyingError: error/);

  const saveStopIndex = bridge.indexOf("guard save(stop, forKey: activeStopKey)");
  const clearErrorIndex = bridge.indexOf("defaults.removeObject(forKey: lastErrorKey)", saveStopIndex);
  assert.ok(saveStopIndex >= 0, "configuration must persist the active stop");
  assert.ok(clearErrorIndex > saveStopIndex, "a stale error must only clear after persistence succeeds");

  const monitorSuccessIndex = bridge.indexOf("didStartMonitoringFor region: CLRegion");
  const monitorErrorClearIndex = bridge.indexOf("removeObject(forKey: lastErrorKey)", monitorSuccessIndex);
  assert.ok(monitorSuccessIndex >= 0, "native monitoring must expose its success callback");
  assert.ok(monitorErrorClearIndex > monitorSuccessIndex, "successful monitoring must clear a stale failure");
});
