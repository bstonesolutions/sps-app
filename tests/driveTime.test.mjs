import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  driveTimeErrorMessage,
  getCurrentPositionWithDeadline,
  requestGoogleDrivingRoute,
  summarizeGoogleRoute,
  withDeadline,
} from "../driveTime.js";

test("outer deadlines stop a Maps or WebKit promise that never settles", async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 10, "maps_timeout"), (error) => error.code === "maps_timeout");
  await assert.rejects(
    getCurrentPositionWithDeadline({ getCurrentPosition() {} }, {}, 10),
    (error) => error.code === "location_timeout",
  );
});

test("geolocation denial is preserved for an actionable staff message", async () => {
  const geolocation = {
    getCurrentPosition(_success, error) { error({ code: 1, message: "denied" }); },
  };
  await assert.rejects(getCurrentPositionWithDeadline(geolocation, {}, 50), (error) => {
    assert.equal(error.code, "location_denied");
    assert.match(driveTimeErrorMessage(error), /turn it on/i);
    return true;
  });
});

test("callback-style Google routes resolve and prefer traffic duration", async () => {
  const result = {
    routes: [{ legs: [{
      duration: { value: 900 },
      duration_in_traffic: { value: 1200 },
      distance: { value: 16093.44 },
    }] }],
  };
  const maps = {
    DirectionsStatus: { OK: "OK" },
    DirectionsService: class {
      route(_request, callback) { callback(result, "OK"); }
    },
  };
  const returned = await requestGoogleDrivingRoute(maps, { destination: "Generic destination" }, 50);
  assert.equal(returned, result);
  assert.deepEqual(summarizeGoogleRoute(returned), { minutes: 20, distanceMiles: 10, trafficAware: true });
});

test("Google route requests have their own deadline", async () => {
  const maps = {
    DirectionsService: class { route() {} },
  };
  await assert.rejects(requestGoogleDrivingRoute(maps, {}, 10), (error) => error.code === "route_timeout");
});

test("the installed iOS app registers MapKit routing and the modal exposes retry", async () => {
  const [app, controller, bridge] = await Promise.all([
    readFile(new URL("../App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/MainViewController.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/SPSWidgetBridge.swift", import.meta.url), "utf8"),
  ]);
  assert.match(app, /registerPlugin\("SPSDriveTimeBridge"\)/);
  assert.match(app, /cancel\(\{ requestId \}\)/);
  assert.match(app, /setAutoEtaAttempt\(v => v \+ 1\)/);
  assert.match(app, /driveMiles\.toFixed\(1\)/);
  assert.match(controller, /registerPluginInstance\(SPSDriveTimeBridge\(\)\)/);
  assert.match(bridge, /class SPSDriveTimeBridge/);
  assert.match(bridge, /CAPPluginMethod\(name: "cancel"/);
  assert.match(bridge, /activeDirections\.removeValue\(forKey: requestId\)\?\.cancel\(\)/);
  assert.match(bridge, /MKDirections\(request: request\)/);
});
