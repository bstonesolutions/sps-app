import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { normalizePracticalGardenPondsProduct, practicalGardenPondsPreviewSource } = await import("../inventorySourcePreview.js");
const { default: handler } = await import("../api/inventory-source-preview.js");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}
const request = (body, method = "POST", token = "owner-session") => ({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
const authResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const productPayload = {
  title: "Aquascape Liquid Algaecide",
  vendor: "Aquascape",
  featured_image: "//cdn.shopify.com/s/files/product.jpg",
  variants: [
    { id: 47235934970138, title: "32 Ounces", sku: "AQ-96024", price: 2999, available: true },
    { id: 47235935002906, title: "128 Ounces", sku: "AQ-96026", price: "8999", available: false },
  ],
};
function ownerFetch(supplierResponse) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return authResponse({ id: "owner-1", email: "owner@example.test" });
    if (target.includes("key=eq.sps_team")) return authResponse([{ value: JSON.stringify([{ email: "owner@example.test", role: "owner", active: true }]) }]);
    if (target.startsWith("https://practicalgardenponds.com/products/")) return supplierResponse(target, options);
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

test("derives a fixed same-origin Shopify JSON endpoint and strips query and hash", () => {
  assert.deepEqual(practicalGardenPondsPreviewSource("https://practicalgardenponds.com/products/Aquascape-Liquid-Algaecide/?variant=123#details"), {
    valid: true, code: "", error: "", handle: "aquascape-liquid-algaecide",
    canonicalUrl: "https://practicalgardenponds.com/products/aquascape-liquid-algaecide",
    apiUrl: "https://practicalgardenponds.com/products/aquascape-liquid-algaecide.js",
  });
});

test("rejects off-domain, private, insecure, credentialed, custom-port, and non-product URLs", () => {
  for (const url of [
    "https://example.com/products/algaecide", "https://127.0.0.1/products/algaecide", "https://localhost/products/algaecide",
    "https://192.168.1.2/products/algaecide", "http://practicalgardenponds.com/products/algaecide",
    "https://user:secret@practicalgardenponds.com/products/algaecide", "https://practicalgardenponds.com:8443/products/algaecide",
    "https://practicalgardenponds.com/account", "https://practicalgardenponds.com/products/algaecide/extra",
    "https://practicalgardenponds.com/products/%2e%2e%2faccount",
  ]) assert.equal(practicalGardenPondsPreviewSource(url).valid, false, url);
});

test("normalizes public fields, HTTPS image, variants, and Shopify cents", () => {
  const source = practicalGardenPondsPreviewSource("https://www.practicalgardenponds.com/products/liquid-algaecide");
  assert.deepEqual(normalizePracticalGardenPondsProduct(productPayload, source), {
    title: "Aquascape Liquid Algaecide", vendor: "Aquascape",
    canonicalUrl: "https://www.practicalgardenponds.com/products/liquid-algaecide",
    imageUrl: "https://cdn.shopify.com/s/files/product.jpg", currency: "USD",
    variants: [
      { id: "47235934970138", title: "32 Ounces", sku: "AQ-96024", price: 29.99, available: true },
      { id: "47235935002906", title: "128 Ounces", sku: "AQ-96026", price: 89.99, available: false },
    ],
  });
});

test("drops product images outside the supplier and exact Shopify CDN hosts", () => {
  const source = practicalGardenPondsPreviewSource("https://practicalgardenponds.com/products/liquid-algaecide");
  const normalized = normalizePracticalGardenPondsProduct({
    ...productPayload,
    featured_image: "https://tracking.example.test/open.gif",
  }, source);
  assert.equal(normalized.imageUrl, "");

  const deceptive = normalizePracticalGardenPondsProduct({
    ...productPayload,
    featured_image: "https://cdn.shopify.com.evil.example/product.jpg",
  }, source);
  assert.equal(deceptive.imageUrl, "");
});

test("requires POST and an authenticated owner", async () => {
  const methodRes = makeRes(); await handler(request({}, "GET"), methodRes); assert.equal(methodRes.statusCode, 405);
  const anonymousRes = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/a" }, "POST", ""), anonymousRes); assert.equal(anonymousRes.statusCode, 401);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return authResponse({ id: "field-1", email: "field@example.test" });
    if (target.includes("key=eq.sps_team")) return authResponse([{ value: JSON.stringify([{ email: "field@example.test", role: "field", active: true }]) }]);
    throw new Error(`Unexpected fetch: ${target}`);
  };
  const fieldRes = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/a" }), fieldRes); assert.equal(fieldRes.statusCode, 403);
});

test("returns a bounded no-store preview without forwarding auth or cookies", async () => {
  let supplierOptions = null;
  globalThis.fetch = ownerFetch(async (_url, options) => {
    supplierOptions = options;
    return new Response(JSON.stringify(productPayload), { status: 200, headers: { "content-type": "application/json" } });
  });
  const res = makeRes();
  await handler(request({ url: "https://practicalgardenponds.com/products/liquid-algaecide?variant=123" }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.product.variants[0].price, 29.99);
  assert.equal(res.headers["Cache-Control"], "no-store"); assert.equal(supplierOptions.redirect, "manual");
  assert.equal(supplierOptions.credentials, "omit"); assert.deepEqual(supplierOptions.headers, { Accept: "application/json" });
});

test("accepts Shopify's text/javascript product JSON content type", async () => {
  globalThis.fetch = ownerFetch(async () => new Response(JSON.stringify(productPayload), {
    status: 200,
    headers: { "content-type": "text/javascript; charset=utf-8" },
  }));
  const res = makeRes();
  await handler(request({ url: "https://practicalgardenponds.com/products/liquid-algaecide" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.product.title, "Aquascape Liquid Algaecide");
});

test("rejects redirects without following them", async () => {
  globalThis.fetch = ownerFetch(async () => new Response(null, { status: 302, headers: { location: "https://internal.example/private" } }));
  const res = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/a" }), res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.code, "source_redirected");
});

test("reports malformed, oversized, and aborted supplier responses safely", async (t) => {
  await t.test("malformed", async () => {
    globalThis.fetch = ownerFetch(async () => new Response("{bad", { status: 200, headers: { "content-type": "application/json" } }));
    const res = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/broken" }), res);
    assert.equal(res.body.code, "source_invalid_json");
  });
  await t.test("oversized", async () => {
    globalThis.fetch = ownerFetch(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(600 * 1024) } }));
    const res = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/huge" }), res);
    assert.equal(res.body.code, "source_too_large");
  });
  await t.test("timeout", async () => {
    globalThis.fetch = ownerFetch(async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; });
    const res = makeRes(); await handler(request({ url: "https://practicalgardenponds.com/products/timeout" }), res);
    assert.equal(res.statusCode, 504); assert.equal(res.body.code, "source_timeout");
  });
});
