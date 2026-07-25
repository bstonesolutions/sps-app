import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

test("a stalled boot keeps the branded screen and exposes a cache-busting retry", () => {
  assert.match(index, /id="boot-recovery"\s+hidden/);
  assert.match(index, /SPS Way couldn’t finish loading/);
  assert.match(index, /url\.searchParams\.set\('_sps_retry'/);
  assert.match(index, /window\.location\.replace\(url\.toString\(\)\)/);
  assert.doesNotMatch(
    index,
    /setTimeout\(function \(\) \{ var b = document\.getElementById\('boot-splash'\); if \(b\) b\.remove\(\); \}, 8000\)/
  );
});

test("entry HTML is never reused across deployments", () => {
  for (const source of ["/", "/index.html"]) {
    const rule = vercel.headers.find((entry) => entry.source === source);
    assert.ok(rule, `missing header rule for ${source}`);
    const cache = rule.headers.find((header) => header.key.toLowerCase() === "cache-control");
    assert.equal(cache?.value, "no-store, max-age=0");
  }
});
