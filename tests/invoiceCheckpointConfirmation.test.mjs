import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceCheckpointMatches} from '../invoiceMetadata.js';

const candidate = {id:'one',qbId:'123',status:'Paid',total:100,balance:0,
  qbAuthoritative:false,locallyEdited:true,qbPendingLocalEdits:true,qbSyncStatus:'pending-push',
  notes:'Visit completed',sourceStopId:'stop-one',lineItems:[{id:'line',desc:'Service',qty:1,unitPrice:100,unitCost:25}]};
const confirmed = {...candidate,qbAuthoritative:true,locallyEdited:false,qbPendingLocalEdits:false,qbLocalChangesPending:false,qbSyncStatus:'synced'};

test('a confirmed notes and cost checkpoint tolerates server normalization of editor sync flags',()=>{
  assert.equal(invoiceCheckpointMatches(candidate,confirmed),true);
  assert.equal(invoiceCheckpointMatches(candidate,JSON.parse(JSON.stringify(candidate))),true);
});
test('normalization cannot certify lost metadata, changed charges, a new proposal, or another identity',()=>{
  for (const change of [{notes:'Older note'},{sourceStopId:'another-stop'},{total:150},{balance:100},
    {lineItems:[{...confirmed.lineItems[0],unitCost:0}]},{qbId:'456'},
    {qbWriteReview:{candidateId:'new'}},{qbAuthoritative:false}]) {
    assert.equal(invoiceCheckpointMatches(candidate,{...confirmed,...change}),false,JSON.stringify(change));
  }
});
