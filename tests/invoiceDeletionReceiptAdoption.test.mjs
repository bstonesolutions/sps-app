import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMaintenancePaymentLedger } from '../maintenancePaymentLedger.js';
if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const disk = new Map(), local = new Map();
globalThis.localStorage = { getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v), removeItem: k => local.delete(k) };
const { idb } = await import('../idbStore.js'); const originalIdb = { ...idb };
idb.get = idb.getVerified = async k => structuredClone(disk.get(k));
idb.set = async (k,v) => { disk.set(k,structuredClone(v)); return k; };
idb.del = async k => disk.delete(k);
const { store, supabase } = await import('../supabaseClient.js');
const original = { from: supabase.from, rpc: supabase.rpc };
after(() => { Object.assign(idb,originalIdb); Object.assign(supabase,original); });
const json=JSON.stringify, key='sps_invoices';
const invoice={id:'invoice-1',qbId:'5287',number:'2035',status:'Sent',balance:192.5,total:192.5,notes:'Repair',qbNeedsReview:true,qbSyncStatus:'missing-remote'};
const other={id:'invoice-2',number:'2036',status:'Draft',total:100,notes:'Original'};
const values=()=>({sps_invoices:[invoice,other],sps_estimates:[{id:'e1',linkedInvoiceId:invoice.id,notes:'Estimate'}],
  sps_schedule:[{date:'2026-10-26',stops:[{sid:'s1',clientId:'c1',linkedInvoiceId:invoice.id,notes:'Stop'}]}],sps_maintenance_billing:emptyMaintenancePaymentLedger()});
let sequence=0;
async function setup(){
  const uid=`invoice-deletion-${++sequence}`,db={values:values(),versions:Object.fromEntries(Object.keys(values()).map(k=>[k,1])),writes:0,reads:0};
  supabase.from=()=>({select(){let target;const b={eq(_name,value){target=value;return b;},in(){return b;},async maybeSingle(){db.reads++;return {data:{key:target,value:json(db.values[target]),version:db.versions[target]},error:null};},then(resolve,reject){db.reads++;return Promise.resolve({data:Object.entries(db.values).map(([key,value])=>({key,value:json(value),version:db.versions[key]})),error:null}).then(resolve,reject);}};return b;}});
  supabase.rpc=async(_name,args)=>{db.writes++;if(args.p_expected_version!==db.versions[args.p_key])return {data:[{applied:false,current_version:db.versions[args.p_key]}],error:null};db.values[args.p_key]=JSON.parse(args.p_value);db.versions[args.p_key]++;return {data:[{applied:true,current_version:db.versions[args.p_key]}],error:null};};
  store.setUser(uid);await store.initialize();await store.get(key);
  return {uid,db,identity:store.captureIdentity(),pending:()=>JSON.parse(local.get(`sps_pending_writes:${uid}`)||'{}')[key]};
}
function receipt(h,overrides={}){
  const v=values();v.sps_invoices=[other];delete v.sps_estimates[0].linkedInvoiceId;delete v.sps_schedule[0].stops[0].linkedInvoiceId;
  return {success:true,complete:true,actorId:h.uid,deletedInvoiceId:invoice.id,qbId:invoice.qbId,beforeInvoice:invoice,
    beforeVersions:Object.fromEntries(Object.keys(v).map(k=>[k,1])),versions:Object.fromEntries(Object.keys(v).map(k=>[k,2])),values:v,...overrides};
}
const accept=(h,r=receipt(h),expectedInvoice=invoice)=>store.acceptInvoiceDeletionSnapshot(r,h.identity,{expectedInvoice});

test('server deletion adopts all confirmed sections without another network mutation',async()=>{
  const h=await setup(),reads=h.db.reads,r=receipt(h),result=await accept(h,r);
  assert.equal(result.ok,true);assert.deepEqual(result.values,r.values);assert.equal(h.db.writes,0);assert.equal(h.db.reads,reads);
  for(const k of Object.keys(r.values)){assert.deepEqual(JSON.parse((await store.get(k)).value),r.values[k]);assert.equal((await store.get(k)).version,2);}
});

test('unrelated invoice conflict retains original base and local work while target disappears',async()=>{
  const h=await setup();h.db.values[key]=[invoice,{...other,notes:'Office'}];h.db.versions[key]=2;
  const localOther={...other,notes:'Field'};
  assert.equal((await store.set(key,json([invoice,localOther]),{baseValue:json([invoice,other])})).conflict,true);
  const before=h.pending(),r=receipt(h);r.beforeVersions[key]=2;r.versions[key]=3;r.values[key]=[{...other,notes:'Office'}];
  const writes=h.db.writes,result=await accept(h,r);
  assert.equal(result.ok,true);assert.deepEqual(result.values[key],[localOther]);assert.equal(h.db.writes,writes);
  assert.deepEqual(JSON.parse(h.pending().baseValue),[other]);assert.deepEqual(JSON.parse(h.pending().localValue),[localOther]);
  assert.equal(h.pending().baseVersion,before.baseVersion);assert.deepEqual(h.pending().conflicts,before.conflicts);
});

test('exact reviewed target intent is retired and both durable pending stores clear',async()=>{
  const h=await setup(),expected={...invoice,notes:'Chosen for deletion'};
  h.db.values[key]=[{...invoice,notes:'Office'},other];h.db.versions[key]=2;
  await store.set(key,json([expected,other]),{baseValue:json([invoice,other])});
  const r=receipt(h,{beforeInvoice:expected});r.beforeVersions[key]=2;r.versions[key]=3;
  assert.equal((await accept(h,r,expected)).ok,true);assert.equal(h.pending(),undefined);
  assert.equal(local.has(`sps_pending_writes:${h.uid}`),false);assert.equal(disk.has(`pending-v2:${h.uid}`),false);
});

test('a newer target edit is preserved for recovery without resurrecting the deleted row',async()=>{
  const h=await setup(),newer={...invoice,notes:'Newer work'};
  h.db.values[key]=[{...invoice,notes:'Office'},other];h.db.versions[key]=2;
  await store.set(key,json([newer,other]),{baseValue:json([invoice,other])});
  const r=receipt(h);r.beforeVersions[key]=2;r.versions[key]=3;
  const result=await accept(h,r);assert.equal(result.ok,true);assert.equal(result.recoveryPending,true);
  assert.deepEqual(result.values[key],[other]);assert.deepEqual(JSON.parse(h.pending().localValue),[newer,other]);
  assert.equal(h.pending().status,'conflict');const writes=h.db.writes;await store.flush();assert.equal(h.db.writes,writes);
});

test('incomplete, wrong-account, mismatched-target and remaining-row receipts alter nothing',async()=>{
  const h=await setup();
  for(const changes of [{complete:false},{actorId:'someone-else'},{qbId:'999'},{beforeInvoice:{...invoice,total:999}},{values:values()},{versions:{}}]){
    assert.equal((await accept(h,receipt(h,changes))).ok,false);assert.deepEqual(JSON.parse((await store.get(key)).value),[invoice,other]);
  }
});

test('late deletion receipt keeps a newer canonical ledger instead of rolling other invoices back',async()=>{
  const h=await setup(),newer={...other,notes:'Latest'};h.db.values[key]=[newer];h.db.versions[key]=8;
  await store.refresh(key);const result=await accept(h);assert.equal(result.ok,true);assert.deepEqual(result.values[key],[newer]);assert.equal(result.versions[key],8);
});

test('account switch invalidates all parts of a deletion receipt',async()=>{
  const h=await setup();store.setUser('different-account');assert.equal((await accept(h)).staleIdentity,true);
  assert.equal(disk.has('snapshot-v2:different-account'),false);
});

test('local persistence failure reports committed deletion separately from device failure',async()=>{
  const h=await setup(),normal=idb.set;idb.set=async()=>{throw new Error('Disk full');};
  try{const result=await accept(h);assert.equal(result.ok,false);assert.equal(result.serverConfirmed,true);assert.equal(result.durabilityFailed,true);assert.deepEqual(result.values[key],[other]);}
  finally{idb.set=normal;}
});

test('late typing during receipt persistence stays durable and cannot automatically recreate invoice',async()=>{
  const h=await setup(),normal=idb.set;let release,entered;
  const gate=new Promise(r=>{release=r;}),reached=new Promise(r=>{entered=r;});
  idb.set=async(k,v)=>{if(k.startsWith('snapshot-v2:')){entered();await gate;}return normal(k,v);};
  try{
    const adopting=accept(h);await reached;
    const newer={...invoice,notes:'Typed while deletion completed'};
    const editing=store.set(key,json([newer,other]),{baseValue:json([invoice,other])});
    release();const adopted = await adopting;await editing;
    assert.equal(adopted.recoveryPending,true);
    assert.deepEqual(JSON.parse(h.pending().localValue),[newer,other]);assert.equal(h.pending().status,'conflict');
    assert.deepEqual(JSON.parse((await store.get(key)).value),[other]);const writes=h.db.writes;await store.flush();assert.equal(h.db.writes,writes);
  }finally{release();idb.set=normal;}
});
