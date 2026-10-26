import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInvoiceDeletionSnapshot, completeConfirmedInvoiceDeletion, confirmedInvoiceDeletionReplay } from '../api/_invoice-deletion.js';
import { invoiceBulkDeleteEligibility, invoiceDeletionReviewMatches } from '../invoiceBulkDeletion.js';
const copy = structuredClone;
const invoice = () => ({ id:'missing-invoice', qbId:'5287', clientId:'client-one', qbCustomerId:'qb-customer', number:'2035', status:'Sent',
  total:192.5, balance:192.5, lineItems:[{desc:'Repair visit',qty:1,unitPrice:192.5}], qbNeedsReview:true, qbSyncError:'Object Not Found' });
const snapshot = () => Object.fromEntries(Object.entries({
  sps_invoices:[invoice(), {id:'unrelated',number:'2036',status:'Draft',total:5}],
  sps_estimates:[{id:'estimate-one',linkedInvoiceId:'missing-invoice',notes:'Keep the work'}],
  sps_schedule:[{date:'2026-10-26',stops:[{sid:'stop-one',clientId:'client-one',linkedInvoiceId:'missing-invoice',completionReceiptId:'accepted-report',notes:'Keep report'}]}],
  sps_maintenance_billing:{version:2,policies:{},allocations:{'client-one':{'2026-08':{status:'due',sources:[{kind:'invoice',invoiceId:'missing-invoice',amountCents:19250}]}}}},
  sps_clients:[{id:'client-one',name:'Client One',qbId:'qb-customer'}],
}).map(([key,value])=>[key,{key,value,exists:true,version:3}]));
const committed = operations => ({ applied:true, outcome:'applied', currentVersions:Object.fromEntries(operations.map(op=>[op.key,op.expectedVersion+1])), values:Object.fromEntries(operations.map(op=>[op.key,copy(op.value)])) });

test('targeted missing-invoice cleanup removes only that invoice and unpaid backlinks in one receipt', async()=>{
  const before=snapshot();let authorization;let written;
  const receipt=await completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
    read:async()=>copy(before),authorize:async(value,actor)=>{authorization={value,actor};},
    batch:async(operations,options)=>{written={operations,options};return committed(operations);},
  });
  assert.equal(receipt.complete,true);assert.equal(receipt.qbId,'5287');assert.equal(receipt.deletedInvoiceId,'missing-invoice');
  assert.deepEqual(receipt.beforeInvoice,invoice());assert.deepEqual(authorization,{value:invoice(),actor:'owner'});
  assert.deepEqual(receipt.values.sps_invoices,[before.sps_invoices.value[1]]);
  assert.equal(receipt.values.sps_estimates[0].notes,'Keep the work');assert.equal(receipt.values.sps_estimates[0].linkedInvoiceId,undefined);
  assert.equal(receipt.values.sps_schedule[0].stops[0].completionReceiptId,'accepted-report');assert.equal(receipt.values.sps_schedule[0].stops[0].notes,'Keep report');
  assert.equal(receipt.values.sps_schedule[0].stops[0].linkedInvoiceId,undefined);
  assert.deepEqual(receipt.values.sps_maintenance_billing.allocations,{});
  assert.deepEqual(written.options.expectedCurrent,{sps_schedule:before.sps_schedule.value});
  assert.deepEqual(written.operations.map(op=>op.key),['sps_invoices','sps_estimates','sps_schedule','sps_maintenance_billing']);
});

test('unrelated changes are retained when atomic cleanup retries a CAS conflict',async()=>{
  let state=snapshot(),batches=0;
  const receipt=await completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
    read:async()=>copy(state),authorize:async()=>{},batch:async operations=>{
      batches+=1;
      if(batches===1){state.sps_estimates.value.push({id:'other-estimate',notes:'New work'});state.sps_estimates.version+=1;
        state.sps_invoices.value[1].notes='Unrelated invoice edit';state.sps_invoices.version+=1;return{applied:false,outcome:'conflict'};}
      return committed(operations);
    },
  });
  assert.equal(batches,2);assert.equal(receipt.values.sps_estimates[1].notes,'New work');
  assert.equal(receipt.values.sps_invoices[0].notes,'Unrelated invoice edit');
});

test('a payment allocated during a failed CAS stops cleanup instead of rebasing consent',async()=>{
  let state=snapshot(),batches=0;
  await assert.rejects(completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
    read:async()=>copy(state),authorize:async()=>{},batch:async()=>{batches+=1;state.sps_maintenance_billing.value.allocations['client-one']['2026-08'].status='paid';return{applied:false,outcome:'conflict'};},
  }),{code:'payment-coverage'});
  assert.equal(batches,1);
});

test('a changed target is not silently accepted during retry',async()=>{
  let state=snapshot(),batches=0;
  await assert.rejects(completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
    read:async()=>copy(state),authorize:async()=>{},batch:async()=>{batches+=1;state.sps_invoices.value[0].lineItems[0].desc='Different work';return{applied:false,outcome:'conflict'};},
  }),{code:'review-required'});
  assert.equal(batches,1);
});

test('a normalized or incomplete transaction response never reports removal',async()=>{
  for(const broken of ['invoice','schedule','version']){
    await assert.rejects(completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
      read:async()=>snapshot(),authorize:async()=>{},batch:async operations=>{const result=committed(operations);
        if(broken==='invoice')result.values.sps_invoices.push(invoice());
        if(broken==='schedule')result.values.sps_schedule=snapshot().sps_schedule.value;
        if(broken==='version')delete result.currentVersions.sps_estimates;
        return result;
      },
    }),{code:'INVOICE_DELETE_SAVE_UNCONFIRMED'});
  }
});

test('lost-reply retry uses a consumed exact deletion receipt and makes no second write',async()=>{
  const state=snapshot();state.sps_invoices.value=state.sps_invoices.value.filter(row=>row.id!=='missing-invoice');
  delete state.sps_estimates.value[0].linkedInvoiceId;delete state.sps_schedule.value[0].stops[0].linkedInvoiceId;
  state.sps_maintenance_billing.value.allocations={};
  const receipt=await completeConfirmedInvoiceDeletion(invoice(),'5287','owner',true,{
    read:async()=>state,authorize:async()=>assert.fail('Already deleted'),batch:async()=>assert.fail('No repeat write'),
    replay:(snap,reviewed,qbId,actorId)=>confirmedInvoiceDeletionReplay(snap,reviewed,qbId,actorId,{rpc:async(name,body)=>{
      assert.equal(name,'sps_invoice_delete_receipt');assert.deepEqual(body,{p_invoice_id:'missing-invoice',p_qb_id:'5287'});
      return[{deleted:true,invoice_id:'missing-invoice',qb_id:'5287',expected_invoice:invoice(),consumed_at:'2026-10-26T12:00:00Z'}];
    }}),
  });
  assert.equal(receipt.complete,true);assert.equal(receipt.existing,true);assert.deepEqual(receipt.beforeInvoice,invoice());
});

test('absence alone or a receipt for another invoice cannot authorize a successful replay',async()=>{
  const state=snapshot();state.sps_invoices.value=[];
  for(const payload of [[],[{deleted:true,invoice_id:'other',qb_id:'5287',expected_invoice:invoice(),consumed_at:'now'}],
    [{deleted:true,invoice_id:'missing-invoice',qb_id:'other',expected_invoice:invoice(),consumed_at:'now'}],
    [{deleted:true,invoice_id:'missing-invoice',qb_id:'5287',expected_invoice:{...invoice(),number:'OTHER'},consumed_at:'now'}]]){
    await assert.rejects(confirmedInvoiceDeletionReplay(state,invoice(),'5287','owner',{rpc:async()=>payload}),{code:'INVOICE_DELETE_RECEIPT_MISSING'});
  }
});

test('sync attempt diagnostic changes do not invalidate the reviewed financial selection',()=>{
  assert.equal(invoiceDeletionReviewMatches(invoice(),{...invoice(),qbSyncError:'Still missing',qbSyncErrorCode:'QB_SYNC_FAILED',qbSyncAttemptedAt:'new'}),true);
  for(const changed of [{total:193},{balance:0},{qbId:'other'},{clientId:'other'},{lineItems:[]},{number:'different'}])
    assert.equal(invoiceDeletionReviewMatches(invoice(),{...invoice(),...changed}),false);
});

test('review errors are checkable only through explicit server verification and paid evidence stays protected',()=>{
  const target=invoice(),context={invoices:[target],reviewedInvoice:target,ledger:{version:2,policies:{},allocations:{}},includeQuickBooks:true};
  assert.equal(invoiceBulkDeleteEligibility(target,context).code,'quickbooks-review');
  assert.equal(invoiceBulkDeleteEligibility(target,{...context,allowQuickBooksReviewCheck:true}).eligible,true);
  for(const change of [{payments:[{id:'paid'}]},{qbDuplicate:true},{qbCreateOutcomeUnknown:true},{qbPendingRemote:{Balance:0}}]){
    const candidate={...target,...change};
    assert.equal(invoiceBulkDeleteEligibility(candidate,{...context,invoices:[candidate],reviewedInvoice:candidate,allowQuickBooksReviewCheck:true}).eligible,false);
  }
});

test('missing linked customer details do not prevent checking an already-missing QB invoice',()=>{
  const state=snapshot();delete state.sps_invoices.value[0].qbCustomerId;state.sps_clients.value=[];
  const checked=checkInvoiceDeletionSnapshot(state,state.sps_invoices.value[0],'5287',true);
  assert.equal(checked.expectedCustomer,'');assert.equal(checked.canonical.id,'missing-invoice');
});
