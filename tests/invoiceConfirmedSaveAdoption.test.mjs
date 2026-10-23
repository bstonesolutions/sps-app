import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
const start = app.indexOf('      if (options.invoiceRefresh) {', app.indexOf('  const handleSaveInvoice ='));
const end = app.indexOf('      // Source reservations', start);
assert.ok(start > 0 && end > start);
const branch = app.slice(start, end);
const canonical = {id:'one',qbId:'123',status:'Paid',total:100,balance:0};
const pending = {...canonical,status:'Overdue',total:150,balance:150};

function harness(receipt) {
  const calls = [];
  const store = {captureIdentity:()=>({uid:'owner'}), acceptInvoiceRefreshSnapshot:async()=>receipt,
    set(){assert.fail('A confirmed accounting receipt must not trigger another generic ledger write');}};
  const invoicesRef = {current:[]};
  const adoptInvoicesDisplay = (...args)=>calls.push(args);
  const run = new Function('store','storeReceiptIssue','invoicesRef','adoptInvoicesDisplay',
    `return async (inv,options)=>{${branch}}`)(store,()=>null,invoicesRef,adoptInvoicesDisplay);
  return {run,calls,invoicesRef};
}

test('confirmed invoice completion uses server accounting even while a local edit remains in the display', async()=>{
  const h = harness({ok:true,confirmedParsedValue:[canonical],parsedValue:[pending]});
  assert.deepEqual(await h.run(canonical,{invoiceRefresh:{ok:true}}),canonical);
  assert.deepEqual(h.calls[0],[ [pending], {confirmedInvoice:{before:canonical,after:canonical}} ]);
  assert.deepEqual(h.invoicesRef.current,[pending]);
});

test('a projected target alone cannot certify an accounting save', async()=>{
  const h = harness({ok:true,confirmedParsedValue:null,parsedValue:[pending]});
  await assert.rejects(h.run(canonical,{invoiceRefresh:{ok:true}}),/identity could not be confirmed/);
  assert.equal(h.calls.length,0);
});
