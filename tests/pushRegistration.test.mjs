import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("native push waits for APNs and server registration before reporting success", async () => {
  const app = await read("App.jsx");
  assert.match(app, /await P\.addListener\("registration"/);
  assert.match(app, /await P\.addListener\("registrationError"/);
  assert.match(app, /if \(!response\.ok \|\| data\.ok === false\)/);
  assert.match(app, /Notification registration timed out/);
  assert.match(app, /return registerAndBindDevicePush\(P\)/);
});

test("notification registration and diagnostics are scoped to this physical app install", async () => {
  const app = await read("App.jsx");
  const endpoint = await read("api/push/register.js");
  assert.match(app, /const PUSH_INSTALL_ID_KEY = "sps_push_install_id_v1"/);
  assert.match(app, /globalThis\.crypto\.getRandomValues\(bytes\)/);
  assert.match(app, /JSON\.stringify\(\{ action: "register", token, installId \}\)/);
  assert.match(app, /JSON\.stringify\(\{ action: "unregister", installId \}\)/);
  assert.match(app, /JSON\.stringify\(\{ action, installId \}\)/);
  const unbindStart = app.indexOf("async function unbindDevicePushToken()");
  const disableStart = app.indexOf("async function disableDevicePush()", unbindStart);
  assert.ok(unbindStart >= 0 && disableStart > unbindStart);
  assert.doesNotMatch(app.slice(unbindStart, disableStart), /if \(!_pushToken\) return/);
  assert.match(endpoint, /import \{ verifyUser \} from "\.\.\/_auth\.js"/);
  assert.match(endpoint, /import \{ resolveStaffUser \} from "\.\.\/_staff-auth\.js"/);
});

test("notification disable and sign-out do not falsely report or abandon device cleanup", async () => {
  const app = await read("App.jsx");
  assert.match(app, /const result = await disableDevicePush\(\)/);
  assert.match(app, /msg: result\.ok[\s\S]{0,180}Notifications couldn't be fully disabled/);
  const nativeHelperStart = app.indexOf("async function unregisterNativeDevicePush()");
  const disableStart = app.indexOf("async function disableDevicePush()", nativeHelperStart);
  assert.ok(nativeHelperStart >= 0 && disableStart > nativeHelperStart);
  const nativeHelper = app.slice(nativeHelperStart, disableStart);
  assert.match(nativeHelper, /Promise\.race/);
  assert.match(nativeHelper, /3000/);
  assert.match(nativeHelper, /await P\.unregister\(\)/);
  assert.match(nativeHelper, /_pushToken = ""/);

  const disableEnd = app.indexOf("async function devicePushBinding", disableStart);
  const disableBody = app.slice(disableStart, disableEnd);
  assert.match(disableBody, /const serverTask = Promise\.race/);
  assert.match(disableBody, /8000/);
  assert.match(disableBody, /Promise\.all\(\[serverTask, unregisterNativeDevicePush\(\)\]\)/);

  const signOutStart = app.indexOf("const handleSignOut = async () =>");
  const signOutEnd = app.indexOf("const resetAppMainScroll", signOutStart);
  assert.ok(signOutStart >= 0 && signOutEnd > signOutStart);
  const signOut = app.slice(signOutStart, signOutEnd);
  assert.match(signOut, /unbindDevicePushToken\(\)/);
  assert.match(signOut, /6000/);
  assert.match(signOut, /if \(!unbound\?\.ok \|\|/);
  assert.match(signOut, /await unregisterNativeDevicePush\(\)/);
  assert.match(signOut, /!unbound\?\.ok \|\| !arrivalCleared\?\.ok \|\| !widgetCleared\?\.ok \|\| !locationCleared\?\.ok/);
  assert.match(signOut, /previous client's arrival monitor was cleared/);
  assert.match(signOut, /const authResult = await onSignOut\(\)/);
  assert.match(signOut, /if \(authResult\?\.error\) throw authResult\.error/);
  assert.match(signOut, /const arrivalCleanup = Promise\.race\(\[/);
  assert.match(signOut, /clearNativeArrival\(\)/);
  assert.match(signOut, /const \[widgetCleared, arrivalCleared, locationCleared\] = await Promise\.all/);
  assert.ok(signOut.indexOf("unbindDevicePushToken()") < signOut.indexOf("const authResult = await onSignOut()"));
});

test("notification primer trusts iOS state and persists done only after registration", async () => {
  const app = await read("App.jsx");
  const stateCheck = app.indexOf("const state = await pushPermissionState()");
  const markerRead = app.indexOf('const marker = localStorage.getItem(PUSH_PRIMER_KEY)', stateCheck);
  assert.ok(stateCheck >= 0 && markerRead > stateCheck, "OS permission must be checked before the saved primer marker");

  const enableAwait = app.indexOf("const result = await enableDevicePush()");
  const successMarker = app.indexOf('localStorage.setItem(PUSH_PRIMER_KEY, "done")', enableAwait);
  assert.ok(enableAwait >= 0 && successMarker > enableAwait, "success marker must follow completed registration");
  assert.match(app.slice(enableAwait, successMarker), /if \(result\.ok\)/);
  assert.match(app, /setPushPrimerError\(result\.error/);
});

test("Xcode target explicitly enables the Push Notifications capability", async () => {
  const project = await read("ios/App/App.xcodeproj/project.pbxproj");
  const entitlements = await read("ios/App/App/App.entitlements");
  assert.match(project, /com\.apple\.Push = \{\s*enabled = 1;/);
  assert.match(entitlements, /<key>aps-environment<\/key>/);
});

test("every staff install has a permanent notification binding check and self-test", async () => {
  const app = await read("App.jsx");
  const push = await read("api/_push.js");
  const config = await read("capacitor.config.ts");
  assert.match(app, /devicePushBinding\("status"\)/);
  assert.match(app, /devicePushBinding\("test"\)/);
  assert.match(app, /Notification server/);
  assert.match(app, /Send test alert/);
  assert.match(app, /pushNotificationReceived/);
  assert.match(app, /notification\?\.data\?\.spsRemote/);
  assert.match(app, /if \(!isSpsRemotePush\(notification\)\) return false/);
  assert.match(push, /spsRemote:\s*true/);
  assert.match(app, /iPhone is not linked to the notification server/);
  assert.match(config, /presentationOptions:\s*\["badge", "sound", "banner", "list"\]/);
});

test("iOS arrival monitoring is native, background-capable, and confirmation-first", async () => {
  const app = await read("App.jsx");
  const bridge = await read("ios/App/App/SPSWidgetBridge.swift");
  const controller = await read("ios/App/App/MainViewController.swift");
  const appDelegate = await read("ios/App/App/AppDelegate.swift");
  const info = await read("ios/App/App/Info.plist");

  assert.match(appDelegate, /launchOptions\?\.keys\.contains\(\.location\) == true/);
  assert.match(appDelegate, /SPSArrivalCoordinator\.shared\.startForLocationRelaunch\(\)/);
  assert.match(controller, /registerPluginInstance\(SPSArrivalCoordinator\.shared\.plugin\)/);
  assert.doesNotMatch(controller, /SPSArrivalBridge\(\)/);
  assert.equal((bridge.match(/private let locationManager = CLLocationManager\(\)/g) ?? []).length, 1);
  assert.match(bridge, /guard !nativeLifecyclePrepared else \{ return \}/);
  assert.match(bridge, /if capacitorLoaded \{[\s\S]*notifyListeners\("arrivalDetected"/);
  assert.match(bridge, /override public func load\(\)[\s\S]*if let pending = loadPendingArrival\(\)[\s\S]*retainUntilConsumed: true/);
  const arrivalHandler = bridge.slice(
    bridge.indexOf("private func handleArrival(for region: CLRegion)"),
    bridge.indexOf("private func postArrivalNotification(stop: ActiveStop)")
  );
  assert.match(arrivalHandler, /stop\.detectedAt == nil/);
  assert.match(arrivalHandler, /!hasPendingArrival\(for: stop\.stopId\)/);
  assert.equal((arrivalHandler.match(/postArrivalNotification\(stop: stop\)/g) ?? []).length, 1);
  assert.equal((bridge.match(/UNUserNotificationCenter\.current\(\)\.add\(request\)/g) ?? []).length, 1);
  assert.match(bridge, /CAPPluginMethod\(name: "requestAlways"/);
  assert.match(bridge, /startMonitoring\(for: region\)/);
  assert.match(bridge, /You’re near .*confirm arrival/);
  assert.match(info, /NSLocationAlwaysAndWhenInUseUsageDescription/);
  assert.match(app, /status\?\.pendingArrival\?\.stopId/);
  assert.match(app, /allowAssignedToday: true/);
  assert.match(app, /const accepted = promptDetectedArrival/);
  assert.match(app, /const \[arrivalConfirmedSchedule, setArrivalConfirmedSchedule\] = useState\(null\)/);
  assert.match(app, /store\.refresh\("sps_schedule"\)/);
  assert.match(app, /if \(!arrivalPromptsEnabled \|\| !sid \|\| arrivals\[sid\] \|\| completedSids\[sid\]\) return false/);
  assert.match(app, /if \(!accepted && arrivalScheduleReady\) await clearStalePending/);
  assert.doesNotMatch(app, /if \(promptDetectedArrival\([\s\S]{0,160}consumePending/);
  assert.match(app, /clearNativeArrival\(\{ preservePending: true \}\)/);
  assert.match(bridge, /let preservePending = call\.getBool\("preservePending"\) \?\? false/);
  assert.match(app, /detectedArrivalModal/);
  assert.match(app, /configureNativeArrival\(stop, \{ checkCurrentState: false \}\)/);
  assert.match(app, /radiusMeters: 300/);
  assert.match(app, /validUntil: validUntil\.toISOString\(\)/);
  assert.match(app, /const serviceDate = parseMDY\(stop\.__arrivalDate \|\| ""\) \|\| new Date\(\)/);
  assert.match(app, /nativeArrivalRetryRef/);
  assert.match(app, /explicitTripActive: !!\(activeEnRouteStop/);
  assert.doesNotMatch(app, /if \(Array\.isArray\(o\.geofenceStops\) && o\.geofenceStops\.length\) return String\(o\.staffId\)/);
  assert.match(app, /scheduleCfg\?\.sort === "time"/);
  assert.match(app, /sps-geofence-dismissed/);
  assert.match(app, /backgroundRefresh: arrival\?\.backgroundRefreshStatus/);
  assert.match(app, /locationAccuracy: arrival\?\.locationAccuracy/);
  assert.match(app, /Turn on Precise Location/);
  assert.match(app, /arrivalEnabled = localStorage\.getItem\("sps_arrival_prompts_enabled"\) === "1"/);
  assert.match(app, /geofenceStops: arrivalPromptsEnabled && arrivalWatchStop/);
  assert.match(app, /Turn off arrival prompts/);
  assert.match(app, /validUntil: event\.validUntil \|\| ""/);
  assert.match(app, /myArrivalRecoveryStops/);
  assert.match(app, /const arrivalCleanup = Promise\.race\(\[/);
  assert.match(app, /Staff alerts held by Test Mode/);
  assert.match(bridge, /skipInitialStateIdentifiers\.remove\(region\.identifier\) != nil/);
  assert.match(app, /Nothing is sent until you confirm/);
  assert.doesNotMatch(app, /Auto-arrived at/);
});

test("inbound business text push is owner-configurable and on by default", async () => {
  const app = await read("App.jsx");
  assert.match(app, /key: "inbound_text"[\s\S]*label: "Inbound business text"[\s\S]*pushOnly: true/);
  assert.match(app, /inbound_text:\s*\{ push: true \}/);
});

test("detected-arrival delivery feedback stays mounted until its send settles", async () => {
  const app = await read("App.jsx");
  const handleStart = app.indexOf("const handleArrived = (sid, stop = null) =>");
  const dismissStart = app.indexOf("const dismissDetectedArrival =", handleStart);
  assert.ok(handleStart >= 0 && dismissStart > handleStart);
  const handleBody = app.slice(handleStart, dismissStart);
  assert.doesNotMatch(handleBody, /setDetectedArrival/);
  assert.match(handleBody, /nativeArrivalResetRef\.current = clearNativeArrival\(\)/);
  assert.match(app, /onClose=\{\(\) => setDetectedArrival\(null\)\}/);
});

test("iOS release metadata is version 1.2.1 build 31 for the app and widgets", async () => {
  const project = await read("ios/App/App.xcodeproj/project.pbxproj");
  assert.equal((project.match(/MARKETING_VERSION = 1\.2\.1;/g) || []).length, 4);
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 31;/g) || []).length, 4);
});
