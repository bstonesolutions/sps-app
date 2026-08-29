import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const migrationStart = app.indexOf("function PhotoMigration({ clients = [] })");
const migrationEnd = app.indexOf("function BackupRestore()", migrationStart);
const migration = app.slice(migrationStart, migrationEnd);

test("legacy media cleanup is inspect-first and reads the authoritative client version", () => {
  assert.ok(migrationStart >= 0, "PhotoMigration should accept the current client snapshot");
  assert.match(migration, /const \[inspection, setInspection\] = useState\(null\)/);
  assert.match(migration, /select\("key, value, version"\)\.eq\("key", "sps_clients"\)\.single\(\)/);
  assert.match(migration, /inspectLegacyMediaHealth\(liveClients\)/);
  assert.match(migration, /Inspect the current client media before applying cleanup/);
});

test("legacy media cleanup refuses stale or incomplete inspections", () => {
  assert.match(migration, /if \(inspection\.truncated\)/);
  assert.match(migration, /if \(baselineVersion !== inspection\.version\)/);
  assert.match(migration, /Client data changed after inspection\. Inspect again before applying cleanup\./);
  assert.match(migration, /expectedVersion: baselineVersion/);
});

test("legacy media cleanup preserves backup and upload verification safeguards", () => {
  assert.match(migration, /sps_clients_premigrate_/);
  assert.match(migration, /verified\.data\.size === expected\.size/);
  assert.match(migration, /upload failed.*keep inline/);
  assert.match(migration, /Apply verified cleanup/);
});

test("Home can deep-link the owner directly to the inspect-first cleanup", () => {
  assert.match(app, /settingsSection: "mediaCleanup"/);
  assert.match(app, /defaultOpen=\{initialSection === "mediaCleanup"\}/);
  assert.match(app, /<PhotoMigration clients=\{clients\} \/>/);
});
