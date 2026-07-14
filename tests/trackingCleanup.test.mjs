import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  expiredTrackingKeys,
  expiredTrackingRecords,
  pruneExpiredTrackingRecords,
  trackingRecordExpiry,
} from "../api/_tracking-cleanup.js";

const NOW = Date.parse("2026-07-14T20:00:00.000Z");

test("tracking expiry matches the public endpoint for explicit and legacy records", () => {
  assert.equal(trackingRecordExpiry({ expiresAt: "2026-07-14T19:00:00.000Z" }), Date.parse("2026-07-14T19:00:00.000Z"));
  assert.equal(trackingRecordExpiry(JSON.stringify({ at: "2026-07-14T18:30:00.000Z" })), Date.parse("2026-07-14T19:30:00.000Z"));
  assert.equal(trackingRecordExpiry("not-json"), 0);
});

test("only expired, well-formed tracking keys qualify for deletion", () => {
  const rows = [
    { key: "sps_track_expired1", value: { expiresAt: "2026-07-14T19:59:59.000Z" } },
    { key: "sps_track_active22", value: { expiresAt: "2026-07-14T20:00:01.000Z" } },
    { key: "sps_clients", value: { expiresAt: "2026-07-14T18:00:00.000Z" } },
    { key: "sps_track_bad", value: "malformed" },
    { key: "sps_track_expired1", value: { expiresAt: "2026-07-14T19:00:00.000Z" } },
  ];
  assert.deepEqual(expiredTrackingKeys(rows, NOW), ["sps_track_expired1"]);
});

test("cleanup candidates carry the exact inspected version", () => {
  assert.deepEqual(expiredTrackingRecords([
    { key: "sps_track_expired1", version: 7, value: { expiresAt: "2026-07-14T19:00:00.000Z" } },
    { key: "sps_track_missingversion", value: { expiresAt: "2026-07-14T19:00:00.000Z" } },
  ], NOW), [{ key: "sps_track_expired1", version: 7 }]);
});

test("hourly cleanup scans only tracking rows and deletes only the expired subset", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            { key: "sps_track_expired1", version: 4, updated_at: "2026-07-14T18:00:00.000Z", value: { expiresAt: "2026-07-14T19:00:00.000Z" } },
            { key: "sps_track_active22", version: 2, updated_at: "2026-07-14T19:00:00.000Z", value: { expiresAt: "2026-07-14T21:00:00.000Z" } },
          ];
        },
      };
    }
    return { ok: true, status: 200, async json() { return [{ key: "sps_track_expired1", version: 4 }]; } };
  };

  const result = await pruneExpiredTrackingRecords({
    now: NOW,
    fetchImpl,
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
  });

  assert.deepEqual(result, { ok: true, scanned: 2, eligible: 1, deleted: 1, renewed: 0 });
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get("key"), "like.sps_track_*");
  assert.equal(new URL(requests[0].url).searchParams.get("order"), "updated_at.asc,key.asc");
  assert.equal(requests[1].options.method, "DELETE");
  assert.equal(new URL(requests[1].url).searchParams.get("or"), "(and(key.eq.sps_track_expired1,version.eq.4))");
  assert.equal(requests[1].url.includes("active22"), false);
});

test("a tracking link renewed after the scan is not deleted", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            key: "sps_track_renewed22",
            version: 8,
            updated_at: "2026-07-14T18:00:00.000Z",
            value: { expiresAt: "2026-07-14T19:00:00.000Z" },
          }];
        },
      };
    }
    // Supabase evaluates the version predicate at DELETE time. A renewal has already advanced the
    // row to version 9, so the scanned version 8 predicate returns no deleted representation.
    return { ok: true, status: 200, async json() { return []; } };
  };

  const result = await pruneExpiredTrackingRecords({
    now: NOW,
    fetchImpl,
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-key",
  });

  assert.deepEqual(result, { ok: true, scanned: 1, eligible: 1, deleted: 0, renewed: 1 });
  assert.equal(new URL(requests[1].url).searchParams.get("or"), "(and(key.eq.sps_track_renewed22,version.eq.8))");
});

test("safety snapshots exclude ephemeral tracking rows", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("async function snapshotState");
  const end = app.indexOf("async function loadSnapshots", start);
  const source = app.slice(start, end);
  assert.match(source, /\.not\("key", "like", "sps_track_\*"\)/);
  assert.match(source, /startsWith\("sps_track_"\)/);
});
