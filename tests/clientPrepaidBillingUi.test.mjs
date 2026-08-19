import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("client editor exposes accounting-only prepaid maintenance coverage", async () => {
  const app = await read("App.jsx");
  const start = app.indexOf("function ClientEditForm");
  const end = app.indexOf("function ClientDetail", start);
  const editor = app.slice(start, end);

  assert.match(editor, /function ClientEditForm\(\{ client, invoices = \[\]/);
  assert.match(editor, /const manageClientAutoInvoice = canManageInvoiceAccounting\(perms\)/);
  assert.match(editor, /manageClientAutoInvoice && hasPersistedClient && \([\s\S]*data-client-maintenance-billing/);
  assert.match(editor, /Standard billing/);
  assert.match(editor, /Prepaid plan/);
  assert.match(editor, /maintenanceBilling\?\.coveredFrom/);
  assert.match(editor, /maintenanceBilling\?\.coveredThrough/);
  assert.match(editor, /sourceInvoiceId/);
  assert.match(editor, /sourceInvoiceNumber/);
  assert.match(editor, /Routine maintenance is covered/);
  assert.match(editor, /Repairs, upgrades, and purchased parts or products remain billable/);
});

test("client save validates the shared prepaid policy and removes standard-mode metadata", async () => {
  const app = await read("App.jsx");
  const start = app.indexOf("function ClientEditForm");
  const end = app.indexOf("function ClientDetail", start);
  const editor = app.slice(start, end);

  assert.match(app, /import \{ normalizeMaintenanceBillingPolicy \} from "\.\/maintenanceBilling"/);
  assert.match(editor, /const policy = normalizeMaintenanceBillingPolicy\(form\.maintenanceBilling\)/);
  assert.match(editor, /Choose a valid prepaid coverage start and end date before saving/);
  assert.match(editor, /next\.maintenanceBilling = policy/);
  assert.match(editor, /delete next\.maintenanceBilling/);
  assert.match(editor, /fetch\(`\$\{PROD_URL\}\/api\/client-maintenance-billing`/);
  assert.match(editor, /clientId: client\.id/);
  assert.match(editor, /maintenanceBilling: next\.maintenanceBilling \|\| null/);
  assert.match(editor, /if \(!response\.ok \|\| !payload\.ok\)/);
  assert.match(editor, /onSave\(next\)/);
});

test("client detail passes invoice choices into the editor and identifies active coverage", async () => {
  const app = await read("App.jsx");
  const start = app.indexOf("function ClientDetail");
  const end = app.indexOf("function ClientList", start) > start
    ? app.indexOf("function ClientList", start)
    : app.indexOf("function StaffClientPreview", start);
  const detail = app.slice(start, end > start ? end : start + 14000);

  assert.match(detail, /normalizeMaintenanceBillingPolicy\(client\.maintenanceBilling\)/);
  assert.match(detail, /<ClientEditForm client=\{client\} invoices=\{invoices\}/);
  assert.match(detail, /Prepaid through/);
});

test("the client portal endpoint does not expose internal prepaid accounting metadata", async () => {
  const portal = await read("api/portal-data.js");
  assert.doesNotMatch(portal, /maintenanceBilling/);
  assert.doesNotMatch(portal, /sourceInvoiceId/);
});
