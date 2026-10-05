import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceDraftInvoice } from '../maintenanceDraftInvoice.js';
import { invoiceServiceDescriptionIssue } from '../invoiceServiceDescription.js';
const client = { id:'sample', name:'Sample property', plans:{Pool:'Essential'}, division:'Pool', monthlyRate:229 };
const options = { client, monthKeys:['2026-04','2026-05'], id:'sample-draft', number:'INV-1', date:'10/05/2026', dueDate:'10/19/2026' };
test('calendar draft uses selected performed months and canonical assigned price, without payment or delivery evidence', () => {
  const invoice = maintenanceDraftInvoice(options);
  assert.equal(invoice.status,'Draft');
  assert.equal(invoice.total,458);
  assert.deepEqual(invoice.lineItems.map(line=>line.desc), ['Monthly Service - April 2026','Monthly Service - May 2026']);
  assert.equal(invoiceServiceDescriptionIssue(invoice),null);
  assert.equal(invoice.qbId,undefined); assert.equal(invoice.paidDate,undefined);
});
test('calendar draft rejects missing plans, missing prices, and invalid months instead of creating a zero or guessed invoice', () => {
  assert.throws(()=>maintenanceDraftInvoice({...options, client:{id:'no-plan',monthlyRate:229}}));
  assert.throws(()=>maintenanceDraftInvoice({...options, client:{...client,monthlyRate:''}}));
  assert.throws(()=>maintenanceDraftInvoice({...options, monthKeys:['2026-13']}));
});
