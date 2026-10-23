import test from 'node:test';
import assert from 'node:assert/strict';
import {readInvoiceWriteProposal, authorizeConfirmedInvoiceDeletion} from '../api/_invoice-write-candidates.js';
const saved={id:'a',qbId:'q1',status:'Paid',balance:0,qbWriteReview:{candidateId:'12'}};
const state={exists:true,value:[saved],version:9};
const row={id:12,invoice_id:'a',candidate_invoice:{id:'a',total:150},reason:'unconfirmed-accounting-change',created_at:'2026-10-22T20:00:00Z',resolved_at:null};
test('held invoice proposal is read only for the exact current marker',async()=>{
 const calls=[];const result=await readInvoiceWriteProposal({invoiceId:'a',candidateId:'12'},{readState:async()=>state,rpc:async(name,args)=>{calls.push({name,args});return[row]}});
 assert.deepEqual(result.invoice,saved);assert.deepEqual(result.proposal.invoice,row.candidate_invoice);assert.equal(result.version,9);assert.equal(calls.length,1);assert.equal(calls[0].name,'sps_invoice_write_candidates_read');
});
test('old or other invoice candidate cannot be substituted',async()=>{
 let reads=0;await assert.rejects(readInvoiceWriteProposal({invoiceId:'a',candidateId:'13'},{readState:async()=>state,rpc:async()=>{reads++;return[row]}}),{code:'INVOICE_PROPOSAL_CHANGED'});assert.equal(reads,0);
 for(const candidate of [{...row,invoice_id:'b'},{...row,resolved_at:'2026-10-23'}, {...row,id:13}]) await assert.rejects(readInvoiceWriteProposal({invoiceId:'a',candidateId:'12'},{readState:async()=>state,rpc:async()=>[candidate]}),{code:'INVOICE_PROPOSAL_UNAVAILABLE'});
});
test('invalid ids fail before reading private records',async()=>{
 for(const body of [{invoiceId:'a',candidateId:'12 OR 1=1'},{invoiceId:'',candidateId:'12'}]) await assert.rejects(readInvoiceWriteProposal(body,{readState:async()=>{throw Error('must not read')}}),{code:'INVOICE_PROPOSAL_INVALID'});
});
test('deletion authorization binds exact saved invoice and actor after remote receipt',async()=>{
 let call;await authorizeConfirmedInvoiceDeletion(saved,'owner',{rpc:async(name,body)=>{call={name,body};return[{authorized:true}]}});
 assert.equal(call.name,'sps_invoice_authorize_delete');assert.deepEqual(call.body,{p_invoice_id:'a',p_expected_invoice:saved,p_actor_id:'owner'});
 await assert.rejects(authorizeConfirmedInvoiceDeletion(saved,'owner',{rpc:async()=>[{authorized:false,outcome:'changed'}]}),{code:'INVOICE_DELETE_CHANGED'});
});
