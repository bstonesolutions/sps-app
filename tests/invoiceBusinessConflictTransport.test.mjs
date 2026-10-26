import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-private-service';
const {compareAndSetCanonicalInvoices}=await import('../api/_invoice-canonical-state.js');
const {invoiceAuthorityRpc}=await import('../api/_invoice-write-candidates.js');
const {patchReviewedInvoice}=await import('../api/_invoice-review-resolution.js');
const invoice={id:'one',qbId:'qb-one',total:100,balance:100};
const operations=[
  {code:'INVOICE_CANONICAL_CONFLICT',run:fetchImpl=>compareAndSetCanonicalInvoices(1,[invoice],{actorId:'owner',action:'quickbooks-refresh',authority:{one:invoice},fetchImpl})},
  {code:'INVOICE_AUTHORITY_CONFLICT',run:fetchImpl=>invoiceAuthorityRpc('sps_invoice_authorize_delete',{}, {fetchImpl})},
  {code:'INVOICE_REVIEW_SAVE_CONFLICT',run:fetchImpl=>patchReviewedInvoice({invoiceId:'one',beforeInvoice:invoice,invoice,actorId:'owner',action:'retry-linked'},{fetchImpl})},
];

test('permanent invoice business conflicts return one explicit409 without retry or privateSQLcontents',async()=>{
  for(const operation of operations){
    let calls=0;
    await assert.rejects(operation.run(async()=>{calls++;return{ok:false,status:409,json:async()=>({code:'PT409',message:'invoice_canonical_stale_revision',details:'PRIVATE INVOICE CONTENT',hint:'PRIVATE SQL'})};}),error=>{
      assert.equal(error.code,operation.code);assert.equal(error.status,409);assert.equal(error.retryable,false);assert.equal(error.databaseCode,'PT409');
      assert.ok(!JSON.stringify(error).includes('PRIVATE'));assert.ok(!error.message.includes('PRIVATE'));return true;
    });
    assert.equal(calls,1);
  }
});

test('genuine database serialization failures are not reclassified as permanent business conflicts',async()=>{
  for(const operation of operations){
    let calls=0;
    await assert.rejects(operation.run(async()=>{calls++;return{ok:false,status:500,json:async()=>({code:'40001',message:'could not serialize access due to concurrent update'})};}),error=>{
      assert.notEqual(error.code,operation.code);assert.notEqual(error.retryable,false);assert.equal(error.status,operation.code==='INVOICE_CANONICAL_CONFLICT'?500:503);return true;
    });
    assert.equal(calls,1);
  }
});


test('a successful HTTP response with malformed or null authority JSON remains unconfirmed',async()=>{
  for(const json of [async()=>{throw new SyntaxError('Invalid JSON');},async()=>null]){
    await assert.rejects(invoiceAuthorityRpc('sps_invoice_delete_receipt',{}, {fetchImpl:async()=>({ok:true,status:200,json})}),
      {code:'INVOICE_AUTHORITY_UNAVAILABLE',status:503});
  }
});
