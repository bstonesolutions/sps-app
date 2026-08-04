import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("client and technician access no longer implies access to balances or Home money", async () => {
  const app = await read("App.jsx");
  const tabs = app.slice(app.indexOf("const PERMISSION_TABS"), app.indexOf("const ALL_PERM_FLAGS"));
  const legacy = app.slice(app.indexOf("function memberPerms"), app.indexOf("function applyFinePerms"));
  const clientRow = tabs.split("\n").find((line) => line.includes('id: "clients"')) || "";

  assert.match(clientRow, /view:\s*\[\]/);
  assert.doesNotMatch(clientRow, /seeBalances/);
  assert.match(legacy, /seeBalances:\s*P\("canSeeBalances",\s*false\)/);
  assert.match(app, /out\.seeBalances\s*=\s*g\("seeBalances",\s*out\.seeBalances\)/);
  assert.match(app, /row\("seeBalances",\s*"Client balances & Home money"/);
});

test("staff workflows keep financial details behind explicit capabilities", async () => {
  const app = await read("App.jsx");

  assert.match(app, /const canSeeBalanceMoney = \(perms\)/);
  assert.match(app, /const canSeeInvoiceMoney = \(perms\)/);
  assert.match(app, /const canSeeProfitMoney = \(perms\)/);
  assert.match(app, /const canManageInvoiceAccounting = \(perms\)/);

  const stop = app.slice(app.indexOf("function CompleteStopModal"), app.indexOf("function AddStopForm"));
  assert.match(stop, /const showStopBilling = canSeeInvoiceMoney\(perms\)/);
  assert.match(stop, /const showStopProfit = canSeeProfitMoney\(perms\)/);
  assert.match(stop, /completionConfirmed && canManageInvoiceAccounting\(perms\) && invoiceOutcome/);
  assert.match(stop, /showStopProfit && \(/);

  const clients = app.slice(app.indexOf("function ClientList"), app.indexOf("function ClientEditForm"));
  assert.match(clients, /const showClientSpend =/);
  assert.match(clients, /!showClientSpend && \(sortBy === "spent_desc" \|\| sortBy === "spent_asc"\)/);
  assert.match(clients, /showSpend=\{showClientSpend\}/);

  const clientEdit = app.slice(app.indexOf("function ClientEditForm"), app.indexOf("function ClientDetail"));
  assert.match(clientEdit, /const showClientPlanMoney = canSeeInvoiceMoney\(perms\) \|\| canSeeProfitMoney\(perms\)/);
  assert.match(clientEdit, /const manageClientAutoInvoice = canManageInvoiceAccounting\(perms\)/);
  assert.match(clientEdit, /curTier && showClientPlanMoney/);
  assert.match(clientEdit, /manageClientAutoInvoice && <div>/);
});

test("staff portal previews and accounting review do not expose invoice data without permission", async () => {
  const app = await read("App.jsx");
  assert.match(app, /function StaffClientPreview\([\s\S]*?canSeeFinancials = false/);
  assert.match(app, /showFinancials=\{canSeeFinancials\}/);
  assert.match(app, /portalNav = showFinancials \? CLIENT_NAV : CLIENT_NAV\.filter/);
  assert.match(app, /showFinancials && page === "cp_invoices"/);
  assert.match(app, /canSeeFinancials=\{canSeeInvoiceMoney\(perms\)\}/);

  const invoices = app.slice(app.indexOf("function InvoicesScreen"), app.indexOf("function InvoiceDetail"));
  assert.match(invoices, /const canReviewAccounting = canManageInvoiceAccounting\(perms\)/);
  assert.match(invoices, /if \(!canReviewAccounting\) return/);
  assert.match(invoices, /canReviewAccounting && localReviewInvoices\.length > 0/);
});

test("native owner widgets reject and clear cached owner data after switching to staff", async () => {
  const [app, overview, invoices, profit, stops] = await Promise.all([
    read("App.jsx"),
    read("ios/App/SPSWidgets/OwnerOverviewWidget.swift"),
    read("ios/App/SPSWidgets/OwnerInvoiceWidget.swift"),
    read("ios/App/SPSWidgets/OwnerProfitWidget.swift"),
    read("ios/App/SPSWidgets/OwnerStopsWidget.swift"),
  ]);

  assert.match(app, /effRole\(currentUser\) !== "owner"[\s\S]{0,500}clearWidgetPayload\(\)/);
  for (const source of [overview, invoices, profit, stops]) {
    assert.match(source, /p\?\.role == "owner"/);
  }
});
