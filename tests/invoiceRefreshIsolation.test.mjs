import {stableInvoiceReviewJSON} from '../invoiceReviewIdentity.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeStoredState } from '../stateMerge.js';
import { reconcileQuickBooksInvoice } from '../quickbooksInvoiceReconciliation.js';

const source=fs.readFileSync(new URL('../App.jsx',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,`Expected App block ${start}`);return source.slice(a,b);}
const parseMDYSource=between('const parseMDY =','const fmtMDY =');
const mathSource=between('const invoiceTotals =','const nextInvoiceNumber =');
class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-10-22T12:00:00']));} static now(){return new Date('2026-10-22T12:00:00').getTime();} }
const {applyLateFees,effectiveStatus}=new Function('Date',`${parseMDYSource}\n${mathSource}\nreturn {applyLateFees,effectiveStatus};`)(FixedDate);
const invoice={id:'local-invoice',qbId:'5225',qbCustomerId:'qb-primary',number:'2058',clientId:null,clientName:'Old QuickBooks name',status:'Sent',date:'09/01/2026',dueDate:'09/15/2026',total:350,balance:350,lineItems:[{id:'l1',desc:'September service',qty:'1',unitPrice:'350',unitCost:'40',sourceStopId:'s1'}]};
const other={...invoice,id:'other-invoice',qbId:'5226',number:'2059',notes:'Other original'};
const paid={...invoice,status:'Paid',balance:0,qbSyncStatus:'synced',qbAuthoritative:true,locallyEdited:false};
const config={lateFee:{enabled:true,graceDays:'15',pct:'5',label:'Late Fee'}};
const json=JSON.stringify;

test('actual hydration fee logic never adds charges to a cached linked overdue invoice',()=>{
  for(const qbId of ['5225',5225,' 5225 ']){
    const linked={...invoice,qbId},before=structuredClone(linked);
    assert.equal(effectiveStatus(linked),'Overdue');
    const result=applyLateFees([linked],config,'2026-10-22');
    assert.equal(result.changed,false);assert.equal(result.invoices[0],linked);assert.deepEqual(linked,before);
    assert.equal(linked.qbPendingLocalEdits,undefined);
  }
});

test('actual hydration fee logic still applies a configured fee once to eligible unlinked invoices',()=>{
  const unlinked={...invoice,id:'unlinked',qbId:null};
  const result=applyLateFees([invoice,unlinked],config,'2026-10-22');
  assert.equal(result.changed,true);assert.equal(result.invoices[0],invoice);
  assert.equal(result.invoices[1].lineItems.length,2);assert.equal(result.invoices[1].lineItems[1].unitPrice,'17.50');
  assert.equal(result.invoices[1].lateFeeAppliedAt,'2026-10-22');
  assert.equal(result.invoices[1].qbPendingLocalEdits,undefined);
  assert.equal(applyLateFees(result.invoices,config,'2026-10-22').changed,false);
  assert.equal(applyLateFees([{...unlinked,status:'Paid',balance:0}],config,'2026-10-22').changed,false);
});

const syncSource=between('  const handleQBSync = async','  // Push a new invoice to QuickBooks');
function syncHarness({currentClients=[],capturedClients=[],invoices=[],receiptError=null}={}){
  const clientRef={current:currentClients},invoicesRef={current:invoices};
  const writes=[],summaries=[],banners=[],localValues=new Map();let clientWriteCount=0;
  const handle=new Function('clientsRef','clients','invoicesRef','persistClientsExact','persistInvoicesExact','storeReceiptIssue','reconcileQuickBooksInvoice','effectiveStatus','setQbAccounting','localStorage','perms','setPayBanner','console',`${syncSource}\nreturn handleQBSync;`)(
    clientRef,capturedClients,invoicesRef,async()=>{clientWriteCount++;throw new Error('Unrelated client changes need review');},
    async rows=>{writes.push(structuredClone(rows));return receiptError?{ok:false,error:new Error(receiptError)}:{ok:true,parsedValue:structuredClone(rows)};},
    receipt=>receipt?.ok?null:receipt?.error?.message||'Invoice save failed',reconcileQuickBooksInvoice,effectiveStatus,
    summary=>summaries.push(summary),{setItem:(k,v)=>localValues.set(k,v)}, {isAdmin:true},banner=>banners.push(banner), {log(){},error(){}}
  );
  return {handle,clientRef,invoicesRef,writes,summaries,banners,localValues,get clientWriteCount(){return clientWriteCount;}};
}
const remoteInvoice=overrides=>({qbId:'5225',qbCustomerId:'qb-primary',number:'2058',clientName:'Neri',date:'09/01/2026',dueDate:'09/15/2026',status:'Paid',total:350,balance:0,taxAmount:0,subTotal:350,lineItems:[{id:'qb-line',qbLineId:'1',desc:'September service',qty:'1',unitPrice:'350',taxable:false}],...overrides});
const complete={reconciliation:{pagination:{invoices:{complete:true}},fetchedAt:'2026-10-22T12:00:00Z'},accounting:{complete:true,outstandingTotal:0},realmId:'company'};

test('actual QB sync uses newest client ref and saves invoices despite an unrelated client conflict',async()=>{
  const current=Object.freeze({id:'client-current',name:'Neri',qbId:'qb-primary',email:'neri@example.test'});
  const captured={id:'wrong-stale-client',name:'Neri',qbId:'qb-primary',email:'neri@example.test'};
  const h=syncHarness({currentClients:Object.freeze([current]),capturedClients:[captured],invoices:[invoice]});
  const result=await h.handle([remoteInvoice()],[{qbId:'qb-primary',name:'Neri',email:'neri@example.test'}],complete);
  assert.equal(result.ok,true);assert.equal(h.clientWriteCount,0);assert.equal(h.writes.length,1);
  assert.equal(h.writes[0][0].clientId,current.id);assert.equal(h.writes[0][0].id,invoice.id);
  assert.equal(h.writes[0][0].balance,0);assert.equal(h.writes[0][0].status,'Paid');
  assert.equal(h.writes[0][0].lineItems[0].sourceStopId,'s1');assert.equal(h.writes[0][0].lineItems[0].unitCost,'40');
  assert.deepEqual(result.clients,[current]);assert.equal(current.qbId,'qb-primary');
  assert.equal(h.summaries.length,1);assert.equal(h.invoicesRef.current[0].clientId,current.id);
});

test('duplicate QB customer profiles map invoices to one client without changing its primary QB id',async()=>{
  const client=Object.freeze({id:'neri',name:'Neri',email:'neri@example.test',qbId:'qb-primary'});
  const h=syncHarness({currentClients:Object.freeze([client])});
  const result=await h.handle([
    remoteInvoice(),remoteInvoice({qbId:'other-qb-invoice',number:'2060',qbCustomerId:'qb-duplicate',clientName:'Neri duplicate'})
  ],[
    {qbId:'qb-primary',name:'Neri',email:'neri@example.test'},
    {qbId:'qb-duplicate',name:'Neri duplicate',email:'neri@example.test'},
  ],complete);
  assert.equal(result.ok,true);assert.deepEqual(result.invoices.map(row=>row.clientId),['neri','neri']);
  assert.equal(client.qbId,'qb-primary');assert.equal(h.clientWriteCount,0);
});

test('shared client emails never cross-attribute an unmapped QB customer',async()=>{
  const h=syncHarness({currentClients:[{id:'a',name:'Alpha',email:'owner@example.test'},{id:'b',name:'Beta',email:'owner@example.test'}]});
  const result=await h.handle([remoteInvoice({qbCustomerId:'unknown',clientName:'Unknown'})],[{qbId:'unknown',name:'Unknown',email:'owner@example.test'}],complete);
  assert.equal(result.invoices[0].clientId,null);assert.equal(h.clientWriteCount,0);
});

test('failed invoice persistence never publishes refreshed accounting totals',async()=>{
  const h=syncHarness({receiptError:'Invoice write unavailable'});
  await assert.rejects(()=>h.handle([remoteInvoice()],[],complete),/Invoice write unavailable/);
  assert.equal(h.summaries.length,0);assert.equal(h.localValues.size,0);assert.equal(h.clientWriteCount,0);
});

if(!globalThis.CustomEvent)globalThis.CustomEvent=class extends Event{constructor(type,init){super(type);this.detail=init?.detail;}};
globalThis.document=new EventTarget();
const localValues=new Map(),disk=new Map();
globalThis.localStorage={getItem:k=>localValues.get(k)??null,setItem:(k,v)=>localValues.set(k,v),removeItem:k=>localValues.delete(k)};
const {idb}=await import('../idbStore.js'),originalIdb={...idb};
idb.get=idb.getVerified=async k=>structuredClone(disk.get(k));idb.set=async(k,v)=>{disk.set(k,structuredClone(v));return k;};idb.del=async k=>disk.delete(k);
const {store,supabase}=await import('../supabaseClient.js'),original={from:supabase.from,rpc:supabase.rpc};
globalThis.window={};
after(()=>{Object.assign(idb,originalIdb);Object.assign(supabase,original);});
const hookSource=between('function useStoredState(','// Debounced auto-save');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function mountHook(key,initial){
  let cursor=0,dirty=true,output;const slots=[],effects=[];
  function useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],update=>{const next=typeof update==='function'?update(slots[i]):update;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];}
  function useRef(initial){const i=cursor++;return slots[i]||(slots[i]={current:initial});}
  function useEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((value,n)=>!Object.is(value,old.deps[n]))){effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});slots[i]={deps};}}
  const hook=new Function('useState','useRef','useEffect','useCallback','store','mergeStoredState','stableInvoiceReviewJSON',`const DB_READ_OK=true;${hookSource};return useStoredState;`)(useState,useRef,useEffect,fn=>fn,store,mergeStoredState,stableInvoiceReviewJSON);
  function render(){cursor=0;dirty=false;output=hook(key,initial);}
  return {get result(){return output;},async settle(){for(let pass=0;pass<15;pass++){if(dirty)render();while(effects.length)effects.shift()();await tick();}},dispose(){slots.forEach(slot=>slot?.cleanup?.());}};
}
function invoiceDatabase(rows){
  const db={value:json(rows),version:1,calls:0};
  supabase.from=()=>({select(){const b={eq(){return b;},in(){return b;},async maybeSingle(){return {data:{key:'sps_invoices',value:db.value,version:db.version},error:null};},then(resolve,reject){return Promise.resolve({data:[{key:'sps_invoices',value:db.value,version:db.version}],error:null}).then(resolve,reject);}};return b;}});
  supabase.rpc=async(_name,args)=>{db.calls++;if(args.p_expected_version!==db.version)return {data:[{applied:false,current_version:db.version}],error:null};db.value=args.p_value;db.version++;return {data:[{applied:true,current_version:db.version}],error:null};};return db;
}
for(const newerTarget of [false,true]){
  test(`actual hook adopts a reviewed target while preserving ${newerTarget?'a newer unstaged target edit':'unrelated pending invoice edits without another save'}`,async()=>{
    const uid=`review-display-isolation-${newerTarget}`,key='sps_invoices',db=invoiceDatabase([invoice,other]);
    store.setUser(uid);await store.initialize();const h=mountHook(key,[]);
    try{
      await h.settle();
      const localTarget={...invoice,notes:'Target field edit'},localOther={...other,notes:'Other field edit'};
      const remoteTarget={...invoice,notes:'Target office edit'},remoteOther={...other,notes:'Other office edit'};
      db.value=json([remoteTarget,remoteOther]);db.version=2;
      h.result[1]([localTarget,localOther]);await h.settle();
      assert.equal(store.listConflicts()[0].conflicts.length,2);
      db.value=json([paid,remoteOther]);db.version=3;
      const adopted=await store.acceptInvoiceReviewResolution({ok:true,beforeInvoice:remoteTarget,invoice:paid,beforeVersion:2,afterVersion:3},store.captureIdentity(),{expectedInvoice:localTarget});
      assert.equal(adopted.ok,true);const calls=db.calls;
      if(newerTarget)h.result[1](rows=>rows.map(row=>row.id===localTarget.id?{...row,notes:'Typed after review click'}:row));
      h.result[4](adopted.parsedValue,{confirmedInvoice:{before:localTarget,after:paid}});await h.settle();
      const target=h.result[0].find(row=>row.id===invoice.id),otherDisplayed=h.result[0].find(row=>row.id===other.id);
      assert.equal(otherDisplayed.notes,'Other field edit');
      if(newerTarget){
        assert.equal(target.notes,'Typed after review click');
        const pending=JSON.parse(localValues.get(`sps_pending_writes:${uid}`))[key];
        assert.equal(JSON.parse(pending.localValue).find(row=>row.id===invoice.id).notes,'Typed after review click');
      }else{
        assert.deepEqual(target,paid);assert.equal(db.calls,calls,'receipt display must not restage the whole ledger');
        assert.equal(store.listConflicts()[0].conflicts.length,1);
      }
    }finally{h.dispose();}
  });
}

test('duplicate SPS QB identities never move an existing invoice to whichever client is last',async()=>{
  const clients=[{id:'original',name:'Neri',qbId:'qb-primary',email:'one@example.test'},{id:'duplicate',name:'Neri duplicate',qbId:'qb-primary',email:'two@example.test'}];
  const h=syncHarness({currentClients:clients,invoices:[{...invoice,clientId:'original',qbCustomerId:'qb-primary'}]});
  const result=await h.handle([remoteInvoice(),remoteInvoice({qbId:'fresh-qb'})],[{qbId:'qb-primary',name:'Neri duplicate',email:'two@example.test'}],complete);
  assert.equal(result.invoices[0].clientId,'original');
  assert.equal(result.invoices[1].clientId,null);
  assert.equal(h.clientWriteCount,0);
});
