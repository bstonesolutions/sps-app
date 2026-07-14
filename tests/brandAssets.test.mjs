import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_APP_LOGO_PATH,
  DEFAULT_APP_LOGO_URL,
  brandLogoSource,
} from "../brandAssets.js";

test("the app icon is the relative default for browser and native UI", () => {
  assert.equal(brandLogoSource(), DEFAULT_APP_LOGO_PATH);
  assert.equal(brandLogoSource({}), "/icon-192.png");
});

test("the app icon resolves to an absolute public URL for customer-facing documents", () => {
  assert.equal(brandLogoSource({}, { absolute: true }), DEFAULT_APP_LOGO_URL);
  assert.equal(
    brandLogoSource({ logoImage: "/icon-192.png" }, { absolute: true, publicUrl: "https://preview.spsway.app/" }),
    "https://preview.spsway.app/icon-192.png",
  );
});

test("uploaded data-image and hosted HTTP logos are preserved", () => {
  const dataLogo = "data:image/png;base64,iVBORw0KGgo=";
  const hostedLogo = "https://cdn.example.com/stone-logo.png";

  assert.equal(brandLogoSource({ logoImage: dataLogo }), dataLogo);
  assert.equal(brandLogoSource({ logoImage: dataLogo }, { absolute: true }), dataLogo);
  assert.equal(brandLogoSource({ logoImage: hostedLogo }), hostedLogo);
  assert.equal(brandLogoSource({ logoImage: hostedLogo }, { absolute: true }), hostedLogo);
});

test("unsupported logo values safely fall back to the app icon", () => {
  assert.equal(brandLogoSource({ logoImage: "logo.png" }), DEFAULT_APP_LOGO_PATH);
  assert.equal(brandLogoSource({ logoImage: "logo.png" }, { absolute: true }), DEFAULT_APP_LOGO_URL);
});
