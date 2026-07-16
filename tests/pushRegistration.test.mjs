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

test("notification primer trusts iOS state and persists done only after registration", async () => {
  const app = await read("App.jsx");
  const stateCheck = app.indexOf("const state = await pushPermissionState()");
  const markerRead = app.indexOf('const marker = localStorage.getItem("sps_push_primer")', stateCheck);
  assert.ok(stateCheck >= 0 && markerRead > stateCheck, "OS permission must be checked before the saved primer marker");

  const enableAwait = app.indexOf("const result = await enableDevicePush()");
  const successMarker = app.indexOf('localStorage.setItem("sps_push_primer", "done")', enableAwait);
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

test("iOS release metadata is version 1.2.1 build 29 for the app and widgets", async () => {
  const project = await read("ios/App/App.xcodeproj/project.pbxproj");
  assert.equal((project.match(/MARKETING_VERSION = 1\.2\.1;/g) || []).length, 4);
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 29;/g) || []).length, 4);
});
