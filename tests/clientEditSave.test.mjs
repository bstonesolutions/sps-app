import test from 'node:test';
import assert from 'node:assert/strict';
import { saveClientEditorChanges } from '../clientEditSave.js';
const policy = {version:1,mode:'prepaid',coveredFrom:'2026-04-01',coveredThrough:'2026-11-30',sourceInvoiceId:'historical-2025',sourceInvoiceNumber:'718'};
const base = () => ({id:'c1',name:'Cedar House',plans:{Pond:'Essential'},history:[]});
const receipt = clients => ({ok:true,parsedValue:clients});

test('billing-only save adopts canonical historical link without a second roster write', async () => {
  const client=base(), canonical={...client,maintenanceBilling:policy,history:[{id:'new-visit'}]};
  let writes=0;
  const saved=await saveClientEditorChanges({clients:[client],updated:{...client,maintenanceBilling:policy},baselineClient:client,billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[canonical]}),persistClients:async()=>{writes++;}});
  assert.deepEqual(saved,canonical); assert.equal(writes,0);
});
test('standard billing really removes the prepaid mirror on reload', async () => {
  const client={...base(),maintenanceBilling:policy};
  const saved=await saveClientEditorChanges({clients:[client],updated:base(),baselineClient:client,billingConfirmed:null,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[base()]}),persistClients:async()=>assert.fail('must not write')});
  assert.equal(Object.hasOwn(saved,'maintenanceBilling'),false);
});
test('a failed or pending refresh cannot close the editor as confirmed', async () => {
  for(const refreshed of [{ok:false},{ok:true,pending:true,clients:[base()]}]) {
    await assert.rejects(saveClientEditorChanges({clients:[base()],updated:{...base(),maintenanceBilling:policy},baselineClient:base(),billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>refreshed}),/Billing was saved, but this device could not reload/);
  }
});
test('billing receipt cannot silently replace a newer billing choice', async () => {
  await assert.rejects(saveClientEditorChanges({clients:[base()],updated:{...base(),maintenanceBilling:policy},baselineClient:base(),billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[base()]})}),/billing changed again/);
});
test('profile edits preserve concurrent history and other service-plan edits', async () => {
  const original=base(), current={...original,history:[{id:'new-visit'}],plans:{Pond:'Essential',Pool:'Premium'}};
  let payload;
  const saved=await saveClientEditorChanges({clients:[current,{id:'c2',name:'Other'}],updated:{...original,name:'Cedar Gardens',maintenanceBilling:policy},baselineClient:original,billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[{...current,maintenanceBilling:policy},{id:'c2',name:'Other'}]}),persistClients:async rows=>{payload=rows;return receipt(rows);}});
  assert.equal(saved.name,'Cedar Gardens'); assert.deepEqual(saved.history,current.history); assert.deepEqual(saved.plans,current.plans); assert.deepEqual(saved.maintenanceBilling,policy); assert.deepEqual(payload[1],{id:'c2',name:'Other'});
});
test('overlapping profile changes are not silently overwritten', async () => {
  await assert.rejects(saveClientEditorChanges({clients:[{...base(),name:'Other device'}],updated:{...base(),name:'My edit'},baselineClient:base(),refreshClients:async()=>({ok:true,clients:[{...base(),name:'Other device'}]}),persistClients:async()=>assert.fail('must not write')}),/overlapping changes/);
});
test('profile-save failure accurately states that billing was already saved', async () => {
  await assert.rejects(saveClientEditorChanges({clients:[base()],updated:{...base(),name:'Cedar Gardens',maintenanceBilling:policy},baselineClient:base(),billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[{...base(),maintenanceBilling:policy}]}),persistClients:async()=>({ok:false,error:new Error('Client conflict')})}),/Billing was saved, but the other client changes were not confirmed. Client conflict/);
});
test('editor defaults do not create a second billing-only profile write', async () => {
  const initial={...base(),street:'',city:'',zip:'',plan:'Essential'};
  const saved=await saveClientEditorChanges({clients:[base()],updated:{...initial,maintenanceBilling:policy},baselineClient:initial,billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[{...base(),maintenanceBilling:policy}]}),persistClients:async()=>assert.fail('must not write')});
  assert.equal(Object.hasOwn(saved,'street'),false);
});
test('missing and duplicate client identities reject without changing another client', async () => {
  for(const clients of [[],[base(),base()]]) await assert.rejects(saveClientEditorChanges({clients,updated:base(),baselineClient:base()}),/identified uniquely/);
});
test('profile saves merge against the refreshed roster after the billing request, preserving new history and other clients', async () => {
  const captured=[base(),{id:'c2',name:'Other before'}];
  const latest=[{...base(),maintenanceBilling:policy,history:[{id:'visit-during-billing-save'}]}, {id:'c2',name:'Other after',phone:'555-0102'}, {id:'c3',name:'New during save'}];
  let payload;
  const saved=await saveClientEditorChanges({clients:captured,updated:{...base(),name:'My contact edit',maintenanceBilling:policy},baselineClient:base(),billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:latest}),persistClients:async rows=>{payload=rows;return receipt(rows);}});
  assert.equal(saved.name,'My contact edit');
  assert.deepEqual(saved.history,latest[0].history);
  assert.deepEqual(payload.slice(1),latest.slice(1));
});
test('profile edits cannot overwrite a newer canonical billing choice after the first receipt', async () => {
  const newer={...policy,coveredThrough:'2026-12-31'};
  await assert.rejects(saveClientEditorChanges({clients:[base()],updated:{...base(),name:'My contact edit',maintenanceBilling:policy},baselineClient:base(),billingConfirmed:policy,hasBillingReceipt:true,refreshClients:async()=>({ok:true,clients:[{...base(),maintenanceBilling:newer}]}),persistClients:async()=>assert.fail('must not overwrite the newer billing mirror')}),/billing changed again/);
});
test('ordinary profile edits also use fresh history and cannot save over a pending roster', async () => {
  const latest={...base(),history:[{id:'latest-visit'}]};
  const options={clients:[base()],updated:{...base(),name:'My contact edit'},baselineClient:base(),persistClients:async rows=>receipt(rows)};
  const saved=await saveClientEditorChanges({...options,refreshClients:async()=>({ok:true,clients:[latest]})});
  assert.deepEqual(saved.history,latest.history);
  await assert.rejects(saveClientEditorChanges({...options,refreshClients:async()=>({ok:true,pending:true,clients:[latest]}),persistClients:async()=>assert.fail('pending client edits need review first')}),/latest client details could not be loaded/);
});
