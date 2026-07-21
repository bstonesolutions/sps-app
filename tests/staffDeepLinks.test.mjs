import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveStaffDeepLink } from "../staffDeepLinks.js";

test("an inbound-text alert opens the unified Comms Inbox rather than Chat", async () => {
  assert.deepEqual(resolveStaffDeepLink("comms/inbox"), {
    page: "comms",
    options: { commsSection: "email" },
  });

  const intake = await readFile(new URL("../api/sms-intake.js", import.meta.url), "utf8");
  assert.match(intake, /INBOUND_TEXT_PUSH_LINK = "comms\/inbox"/);
  assert.match(intake, /pushOwner\("inbound_text"[\s\S]{0,180}INBOUND_TEXT_PUSH_LINK/);
  assert.match(intake, /pushStaff\(staffKey[\s\S]{0,180}INBOUND_TEXT_PUSH_LINK/);
});

test("Comms subsection aliases are explicit and plain Comms still keeps its normal landing page", () => {
  assert.deepEqual(resolveStaffDeepLink("comms"), { page: "comms", options: {} });
  assert.deepEqual(resolveStaffDeepLink("COMMS/TEXTS"), { page: "comms", options: { commsSection: "email" } });
  assert.deepEqual(resolveStaffDeepLink("comms/chat"), { page: "comms", options: { commsSection: "messages" } });
  assert.deepEqual(resolveStaffDeepLink("comms/leads"), { page: "comms", options: { commsSection: "inbox" } });
  assert.equal(resolveStaffDeepLink("comms/not-a-section"), null);
});

test("all existing staff deep links retain their prior destinations", () => {
  const expected = {
    home: "dashboard",
    alerts: "dashboard",
    profit: "dashboard",
    schedule: "schedule",
    invoices: "invoices",
    invoice: "invoices",
    estimates: "estimates",
    leads: "leads",
    comms: "comms",
    budget: "budget",
    clients: "clients",
    reports: "reports",
    property: "clients",
    history: "clients",
  };
  for (const [link, page] of Object.entries(expected)) {
    assert.deepEqual(resolveStaffDeepLink(link), { page, options: {} }, link);
  }
  assert.equal(resolveStaffDeepLink("unknown"), null);
  assert.equal(resolveStaffDeepLink("comms/inbox/extra"), null);
});

test("both browser and native push consumers pass resolved Comms options through handleNav", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const staffRoute = resolveStaffDeepLink\(open\)/);
  assert.match(app, /handleNav\(staffRoute\.page, staffRoute\.options\)/);
  assert.match(app, /const staffRoute = resolveStaffDeepLink\(sec\)/);
});
