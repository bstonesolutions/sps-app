import test from "node:test";
import assert from "node:assert/strict";

import { memberCanSendEstimates } from "../api/_estimate-auth.js";

test("estimate sending follows the Estimates tab independently from Invoices", () => {
  assert.equal(memberCanSendEstimates({ role: "owner", tabAccess: { estimates: "hidden", invoices: "hidden" } }), true);
  assert.equal(memberCanSendEstimates({ role: "custom", tabAccess: { estimates: "edit", invoices: "hidden" } }), true);
  assert.equal(memberCanSendEstimates({ role: "custom", tabAccess: { estimates: "view", invoices: "edit" } }), false);
  assert.equal(memberCanSendEstimates({ role: "custom", tabAccess: { estimates: "hidden", invoices: "edit" } }), false);
  assert.equal(memberCanSendEstimates({ role: "custom", tabAccess: { estimates: "edit", invoices: "hidden" }, fine: { invoiceSend: false } }), false);
  assert.equal(memberCanSendEstimates({ role: "custom", tabAccess: { estimates: "edit", invoices: "hidden" }, fine: { estimateSend: false } }), false);
});

test("legacy estimate access remains compatible for existing lead and custom accounts", () => {
  assert.equal(memberCanSendEstimates({ role: "lead" }), true);
  assert.equal(memberCanSendEstimates({ role: "field" }), false);
  assert.equal(memberCanSendEstimates({ role: "custom", perms: { canInvoice: true } }), true);
  assert.equal(memberCanSendEstimates({ role: "custom", perms: { canInvoice: false } }), false);
});
