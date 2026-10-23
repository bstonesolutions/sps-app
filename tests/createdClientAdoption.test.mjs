import { installSharedStateEndpointFixture } from "./helpers/sharedStateEndpointFixture.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
if (!globalThis.CustomEvent) globalThis.CustomEvent = class extends Event { constructor(type, init) { super(type); this.detail = init?.detail; } };
globalThis.document = new EventTarget();
const disk = new Map(), local = new Map();
globalThis.localStorage = { getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v), removeItem: k => local.delete(k) };
const { idb } = await import('../idbStore.js');
const originalIdb = { ...idb };
idb.get = idb.getVerified = async k => structuredClone(disk.get(k));
idb.set = async (k,v) => { disk.set(k,structuredClone(v)); return k; };
idb.del = async k => disk.delete(k);
const { store, supabase } = await import('../supabaseClient.js');
const original = { from: supabase.from, rpc: supabase.rpc };
let restoreEndpoint = () => {};
after(() => { restoreEndpoint(); Object.assign(idb,originalIdb); Object.assign(supabase,original); });
const key = 'sps_clients', json = JSON.stringify;
const old = {id:'existing',name:'Existing client',notes:'Original',history:[]};
const created = {id:'11223344-5566-4777-8888-99aabbccddee',name:'Cedar House',phone:'555-0100',history:[],equipment:[]};
function database(clients=[old],version=1) {
  const db = { value:json(clients),version,reads:0,writes:0,readError:null };
  supabase.from = () => ({ select() { const b = { eq() { return b; }, in() { return b; }, async maybeSingle() { db.reads++; return db.readError ? {error:db.readError} : {data:{key,value:db.value,version:db.version},error:null}; }, then(resolve,reject) { db.reads++; return Promise.resolve({data:[{key,value:db.value,version:db.version}],error:null}).then(resolve,reject); } }; return b; } });
  supabase.rpc = async (_name,args) => { db.writes++; if(args.p_expected_version!==db.version) return {data:[{applied:false,current_version:db.version}],error:null}; db.value=args.p_value; db.version++; return {data:[{applied:true,current_version:db.version}],error:null}; };
  restoreEndpoint(); restoreEndpoint = installSharedStateEndpointFixture({ store, supabase, readRow: requested => requested === key ? db : null });
  return db;
}
async function setup(uid,clients=[old],version=1) { const db=database(clients,version); store.setUser(uid); await store.initialize(); await store.get(key); return db; }
const receipt = overrides => ({client:created,beforeVersion:1,afterVersion:2,replayed:false,...overrides});

test('compact creation reconstructs exact predecessor without fetching or writing the roster',async()=>{
  const db=await setup('create-exact'); const reads=db.reads;
  const saved=await store.acceptCreatedClient(receipt(),store.captureIdentity());
  assert.equal(saved.ok,true); assert.equal(saved.projected,false);
  assert.deepEqual(saved.parsedValue,[old,created]);
  assert.equal((await store.get(key)).version,2); assert.equal(db.reads,reads); assert.equal(db.writes,0);
});

test('a receipt with a version gap projects the client without certifying stale unrelated records',async()=>{
  const db=await setup('create-gap'); const saved=await store.acceptCreatedClient(receipt({beforeVersion:4,afterVersion:5}),store.captureIdentity());
  assert.equal(saved.ok,true); assert.equal(saved.projected,true); assert.equal((await store.get(key)).version,1);
  assert.deepEqual(saved.parsedValue,[old,created]); assert.equal(db.writes,0);
  db.readError=new Error('Connection unavailable'); assert.equal((await store.refresh(key)).ok,false);
  assert.deepEqual(JSON.parse((await store.get(key)).value),[old,created],'failed background refresh must not remove the confirmed addition');
});

test('unrelated pending conflict remains durable and unchanged after compact creation',async()=>{
  const uid='create-pending',db=await setup(uid);
  db.value=json([{...old,notes:'Office edit'}]); db.version=2;
  const failed=await store.set(key,json([{...old,notes:'Field edit'}]),{baseValue:json([old])});
  assert.equal(failed.conflict,true);
  const pending=local.get(`sps_pending_writes:${uid}`),conflicts=store.listConflicts(),writes=db.writes,reads=db.reads;
  const saved=await store.acceptCreatedClient(receipt({beforeVersion:2,afterVersion:3}),store.captureIdentity());
  assert.equal(saved.ok,true); assert.equal(saved.projected,true); assert.equal(saved.parsedValue[0].notes,'Field edit');
  assert.deepEqual(saved.parsedValue[1],created); assert.deepEqual(store.listConflicts(),conflicts);
  assert.equal(local.get(`sps_pending_writes:${uid}`),pending); assert.equal(db.writes,writes); assert.equal(db.reads,reads);
  assert.equal((await store.get(key)).version,1,"a conflict receipt does not certify a newer complete roster");
});

test('replay cannot overwrite newer existing profile or erase its completed reports',async()=>{
  const newer={...created,phone:'555-0200',history:[{completionReceiptId:'r1',notes:'Saved work'}]};
  const db=await setup('create-replay-existing',[old,newer],4);
  const saved=await store.acceptCreatedClient(receipt({beforeVersion:6,afterVersion:6,replayed:true,clientProjection:true}),store.captureIdentity());
  assert.deepEqual(saved.parsedValue,[old,newer]); assert.equal((await store.get(key)).version,4); assert.equal(db.writes,0);
});

test('replay with a projection never advances the full roster version even at a matching predecessor',async()=>{
  await setup('create-replay-projection');
  const saved=await store.acceptCreatedClient(receipt({beforeVersion:2,afterVersion:2,replayed:true,clientProjection:true}),store.captureIdentity());
  assert.equal(saved.projected,true); assert.equal((await store.get(key)).version,1);
});

test('late receipt does not resurrect a record absent from a newer confirmed roster',async()=>{
  await setup('create-late',[old],5);
  const saved=await store.acceptCreatedClient(receipt(),store.captureIdentity());
  assert.equal(saved.superseded,true); assert.deepEqual(saved.parsedValue,[old]); assert.equal((await store.get(key)).version,5);
});

test('late replay does not undo the visible intent of a pending client deletion',async()=>{
  const uid='create-late-pending-delete',base=[old,created];
  const db=await setup(uid,base,2);
  db.value=json([old,{...created,phone:'Office update'}]);db.version=3;
  const failed=await store.set(key,json([old]),{baseValue:json(base)});
  assert.equal(failed.conflict,true);
  const before=(await store.get(key)).value;
  assert.equal(JSON.parse(before).some(client=>client.id===created.id),false);
  const pending=local.get(`sps_pending_writes:${uid}`),conflicts=store.listConflicts();
  const writes=db.writes,reads=db.reads;
  const saved=await store.acceptCreatedClient(receipt({beforeVersion:2,afterVersion:2,replayed:true,clientProjection:true}),store.captureIdentity());
  assert.equal(saved.ok,true);assert.equal(saved.superseded,true);
  assert.equal(saved.value,before);assert.deepEqual(saved.parsedValue,[old]);
  assert.equal(local.get(`sps_pending_writes:${uid}`),pending);
  assert.deepEqual(store.listConflicts(),conflicts);
  assert.equal(db.reads,reads);assert.equal(db.writes,writes);
});

test('account switch and switching back invalidate the original receipt identity',async()=>{
  await setup('create-account-a'); const identity=store.captureIdentity();
  store.setUser('create-account-b'); assert.equal(store.isCurrentIdentity(identity),false);
  assert.equal((await store.acceptCreatedClient(receipt(),identity)).staleIdentity,true);
  store.setUser('create-account-a'); assert.equal(store.isCurrentIdentity(identity),false);
  assert.equal((await store.acceptCreatedClient(receipt(),identity)).staleIdentity,true);
});

test('invalid compact receipts do not alter the displayed roster',async()=>{
  await setup('create-invalid'); const identity=store.captureIdentity();
  for(const invalid of [{client:null},{client:{...created,name:''}},{afterVersion:1},{beforeVersion:-1},{afterVersion:NaN}]) {
    assert.equal((await store.acceptCreatedClient(receipt(invalid),identity)).ok,false);
    assert.deepEqual(JSON.parse((await store.get(key)).value),[old]);
  }
});
