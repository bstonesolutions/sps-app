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
after(() => { Object.assign(idb,originalIdb); Object.assign(supabase,original); });
const key='sps_invoices', json=JSON.stringify;
const invoice={id:'invoice-1',qbId:'5225',number:'2058',status:'Sent',balance:350,total:350,notes:'Visit note',lineItems:[{id:'l1',desc:'Monthly service',qty:'1',unitPrice:'350',unitCost:'40',sourceStopId:'stop-1'}]};
const other={...invoice,id:'invoice-2',qbId:'5226',number:'2059',notes:'Other original'};
const paid={...invoice,status:'Paid',balance:0,qbNeedsReview:false,qbSyncStatus:'synced',locallyEdited:false};
function database(rows=[invoice,other],version=1) {
  const db={value:json(rows),version,reads:0,writes:0};
  supabase.from=()=>({select(){const b={eq(){return b;},in(){return b;},async maybeSingle(){db.reads++;return {data:{key,value:db.value,version:db.version},error:null};},then(resolve,reject){db.reads++;return Promise.resolve({data:[{key,value:db.value,version:db.version}],error:null}).then(resolve,reject);}};return b;}});
  supabase.rpc=async(_name,args)=>{db.writes++;if(args.p_expected_version!==db.version)return {data:[{applied:false,current_version:db.version}],error:null};db.value=args.p_value;db.version++;return {data:[{applied:true,current_version:db.version}],error:null};};
  return db;
}
async function setup(uid,rows=[invoice,other],version=1){const db=database(rows,version);store.setUser(uid);await store.initialize();await store.get(key);return db;}
const receipt=overrides=>({ok:true,invoice:paid,beforeInvoice:invoice,beforeVersion:1,afterVersion:2,...overrides});
const accept=(value=receipt(),expectedInvoice=invoice)=>store.acceptInvoiceReviewResolution(value,store.captureIdentity(),{expectedInvoice});
function pending(uid){return JSON.parse(local.get(`sps_pending_writes:${uid}`)||'{}')[key];}

test('targeted receipt adopts exact predecessor without fetching or rewriting full ledger',async()=>{
  const db=await setup('invoice-review-exact'),reads=db.reads;
  const result=await accept();
  assert.equal(result.ok,true);assert.equal(result.projected,false);
  assert.deepEqual(result.parsedValue,[paid,other]);assert.equal((await store.get(key)).version,2);
  assert.equal(db.reads,reads);assert.equal(db.writes,0);
});

test('target resolution retires only its conflicts and preserves other drafts through later retry',async()=>{
  const uid='invoice-review-conflicts',db=await setup(uid);
  const remoteInvoice={...invoice,notes:'Office target'},remoteOther={...other,notes:'Office other'};
  db.value=json([remoteInvoice,remoteOther]);db.version=2;
  const localInvoice={...invoice,notes:'Field target'},localOther={...other,notes:'Field other'};
  const failed=await store.set(key,json([localInvoice,localOther]),{baseValue:json([invoice,other])});
  assert.equal(failed.conflict,true);
  const beforePending=pending(uid);assert.equal(beforePending.conflicts.length,2);
  db.value=json([paid,remoteOther]);db.version=3;
  const reads=db.reads,writes=db.writes;
  const result=await accept(receipt({beforeInvoice:remoteInvoice,beforeVersion:2,afterVersion:3}),localInvoice);
  assert.equal(result.ok,true);assert.equal(result.projected,false);assert.deepEqual(result.parsedValue,[paid,localOther]);
  assert.equal(db.reads,reads);assert.equal(db.writes,writes);
  const afterPending=pending(uid);
  assert.deepEqual(JSON.parse(afterPending.baseValue),[paid,other]);
  assert.deepEqual(JSON.parse(afterPending.localValue),[paid,localOther]);
  assert.deepEqual(afterPending.conflicts,beforePending.conflicts.filter(item=>item.path.includes('invoice-2')));
  assert.equal(afterPending.status,'conflict');assert.equal(afterPending.baseVersion,beforePending.baseVersion);
  assert.equal(store.listConflicts()[0].conflicts.length,1);
  const finished=await store.resolveConflict(key,'local');assert.equal(finished.ok,true);
  assert.deepEqual(JSON.parse(db.value),[paid,localOther]);assert.equal(store.listConflicts().length,0);
});

test('when target was the only pending intent both durable queues are cleared',async()=>{
  const uid='invoice-review-only-conflict',db=await setup(uid);
  const remote={...invoice,notes:'Office'},expected={...invoice,notes:'Field'};
  db.value=json([remote,other]);db.version=2;
  assert.equal((await store.set(key,json([expected,other]),{baseValue:json([invoice,other])})).conflict,true);
  const result=await accept(receipt({beforeInvoice:remote,beforeVersion:2,afterVersion:3}),expected);
  assert.equal(result.ok,true);assert.equal(result.pending,false);assert.equal(store.listConflicts().length,0);
  assert.equal(local.get(`sps_pending_writes:${uid}`),undefined);assert.equal(disk.get(`pending-v2:${uid}`),undefined);
});

test('version gap changes only target projection and pending target base without certifying unrelated data',async()=>{
  const uid='invoice-review-gap',db=await setup(uid);
  const remoteOther={...other,notes:'Office'},localOther={...other,notes:'Field'};
  db.value=json([invoice,remoteOther]);db.version=2;
  assert.equal((await store.set(key,json([invoice,localOther]),{baseValue:json([invoice,other])})).conflict,true);
  const oldPending=pending(uid),result=await accept(receipt({beforeVersion:8,afterVersion:9}));
  assert.equal(result.ok,true);assert.equal(result.projected,true);assert.equal((await store.get(key)).version,2);
  assert.deepEqual(result.parsedValue,[paid,localOther]);
  assert.deepEqual(pending(uid).conflicts,oldPending.conflicts);
  assert.deepEqual(JSON.parse(pending(uid).baseValue),[paid,other]);
});

test('late receipt cannot replace a newer confirmed invoice or pending edit',async()=>{
  const newer={...paid,notes:'Newer server note'};
  await setup('invoice-review-stale',[newer,other],5);
  const result=await accept();assert.equal(result.superseded,true);assert.deepEqual(result.invoice,newer);
  assert.deepEqual(JSON.parse((await store.get(key)).value),[newer,other]);
});

test('same-version receipt can clear exact reviewed pending target after realtime has learned canonical result',async()=>{
  const uid='invoice-review-realtime',db=await setup(uid);
  const expected={...invoice,notes:'Field'};
  db.value=json([paid,other]);db.version=2;
  // A second change to the same field ensures the local target remains a conflict.
  const canonical={...paid,notes:'Office canonical'};
  db.value=json([canonical,other]);
  assert.equal((await store.set(key,json([expected,other]),{baseValue:json([invoice,other])})).conflict,true);
  const result=await accept(receipt({invoice:canonical}),expected);
  assert.equal(result.ok,true);assert.equal(result.superseded,undefined);assert.deepEqual(result.invoice,canonical);
  assert.equal(store.listConflicts().length,0);assert.equal((await store.get(key)).version,2);
});

test('target changed since click is preserved and cannot borrow an older confirmation',async()=>{
  const uid='invoice-review-newer-target',db=await setup(uid);
  db.value=json([{...invoice,notes:'Office'},other]);db.version=2;
  const newer={...invoice,notes:'New field edit'};
  await store.set(key,json([newer,other]),{baseValue:json([invoice,other])});
  const before=pending(uid),result=await accept(receipt({beforeVersion:2,afterVersion:3}));
  assert.equal(result.ok,false);assert.equal(result.targetChanged,true);assert.equal(result.serverConfirmed,true);
  assert.deepEqual(pending(uid),before);assert.deepEqual(JSON.parse((await store.get(key)).value),[newer,other]);
});

test('removing target while its request is underway never resurrects it',async()=>{
  const db=await setup('invoice-review-deleted-target');
  db.value=json([{...invoice,notes:'Office'},other]);db.version=2;
  await store.set(key,json([other]),{baseValue:json([invoice,other])});
  const result=await accept(receipt({beforeVersion:2,afterVersion:3}));
  assert.equal(result.ok,false);assert.deepEqual(JSON.parse((await store.get(key)).value),[other]);
});

test('account switch including switching back invalidates receipt identity',async()=>{
  await setup('invoice-review-account-a');const identity=store.captureIdentity();
  store.setUser('invoice-review-account-b');
  assert.equal((await store.acceptInvoiceReviewResolution(receipt(),identity,{expectedInvoice:invoice})).staleIdentity,true);
  store.setUser('invoice-review-account-a');
  assert.equal((await store.acceptInvoiceReviewResolution(receipt(),identity,{expectedInvoice:invoice})).staleIdentity,true);
});

test('invalid receipt or target identity changes never alter displayed invoice data',async()=>{
  await setup('invoice-review-invalid');
  for(const invalid of [{ok:false},{invoice:null},{beforeInvoice:null},{invoice:{...paid,id:'other'}},{afterVersion:4},{beforeVersion:-1},{afterVersion:NaN},{afterVersion:1}]){
    assert.equal((await accept(receipt(invalid))).ok,false);
    assert.deepEqual(JSON.parse((await store.get(key)).value),[invoice,other]);
  }
});

test('a target edit staged while durable receipt cleanup runs remains pending and visible',async()=>{
  const uid='invoice-review-edit-during-adoption',db=await setup(uid);
  db.value=json([invoice,{...other,notes:'Office'}]);db.version=2;
  const localOther={...other,notes:'Field'};
  await store.set(key,json([invoice,localOther]),{baseValue:json([invoice,other])});
  const normalSet=idb.set;let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});const reached=new Promise(resolve=>{entered=resolve;});
  idb.set=async(k,v)=>{if(k===`pending-v2:${uid}`){entered();await gate;}return normalSet(k,v);};
  try{
    const adopting=accept(receipt({beforeVersion:2,afterVersion:3}));await reached;
    const newer={...paid,notes:'Typed after the review click'};
    const editing=store.set(key,json([newer,localOther]),{baseValue:json([paid,other])});
    release();const result=await adopting;await editing;
    assert.equal(result.ok,false);assert.equal(result.targetChanged,true);
    assert.deepEqual(JSON.parse((await store.get(key)).value),[newer,localOther]);
    assert.deepEqual(JSON.parse(pending(uid).localValue),[newer,localOther]);
  } finally {release();idb.set=normalSet;}
});

test('account switch during durable cleanup never applies an old account receipt to the new account',async()=>{
  const uid='invoice-review-switch-during-adoption',db=await setup(uid);
  db.value=json([invoice,{...other,notes:'Office'}]);db.version=2;
  await store.set(key,json([invoice,{...other,notes:'Field'}]),{baseValue:json([invoice,other])});
  const identity=store.captureIdentity(),normalSet=idb.set;let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});const reached=new Promise(resolve=>{entered=resolve;});
  idb.set=async(k,v)=>{if(k===`pending-v2:${uid}`){entered();await gate;}return normalSet(k,v);};
  try{
    const adopting=store.acceptInvoiceReviewResolution(receipt({beforeVersion:2,afterVersion:3}),identity,{expectedInvoice:invoice});
    await reached;store.setUser('invoice-review-other-account');release();
    assert.equal((await adopting).staleIdentity,true);
    assert.equal(local.has('sps_pending_writes:invoice-review-other-account'),false);
    assert.equal(disk.has('pending-v2:invoice-review-other-account'),false);
  } finally {release();idb.set=normalSet;}
});

test('receipt cleanup failure is not reported as success and retains unrelated in-memory intent',async()=>{
  const uid='invoice-review-durability-failure',db=await setup(uid);
  db.value=json([invoice,{...other,notes:'Office'}]);db.version=2;
  const localOther={...other,notes:'Field'};
  await store.set(key,json([invoice,localOther]),{baseValue:json([invoice,other])});
  const normalSet=idb.set,normalLocalSet=localStorage.setItem;
  idb.set=async()=>{throw new Error('Storage unavailable');};localStorage.setItem=()=>{throw new Error('Storage unavailable');};
  try{
    const result=await accept(receipt({beforeVersion:2,afterVersion:3}));
    assert.equal(result.ok,false);assert.equal(result.serverConfirmed,true);assert.equal(result.durabilityFailed,true);
    assert.deepEqual(JSON.parse((await store.get(key)).value),[paid,localOther]);
    assert.equal(store.listConflicts()[0].conflicts.length,1);
  } finally {idb.set=normalSet;localStorage.setItem=normalLocalSet;}
});

test('a pending addition whose old baseline lacks the now-saved target is rebased narrowly',async()=>{
  const uid='invoice-review-newly-confirmed',db=await setup(uid,[other]);
  const localTarget={...invoice,notes:'Pending addition'},remoteOther={...other,notes:'Office'},localOther={...other,notes:'Field'};
  db.value=json([invoice,remoteOther]);db.version=2;
  await store.set(key,json([localTarget,localOther]),{baseValue:json([other])});
  const result=await accept(receipt({beforeVersion:2,afterVersion:3}),localTarget);
  assert.equal(result.ok,true);assert.deepEqual(result.parsedValue.find(item=>item.id===invoice.id),paid);
  assert.deepEqual(result.parsedValue.find(item=>item.id===other.id),localOther);
  const base=JSON.parse(pending(uid).baseValue);
  assert.deepEqual(base.find(item=>item.id===invoice.id),paid);
  assert.deepEqual(base.find(item=>item.id===other.id),other);
});

test('an ambiguous printable identity prefix never clears another invoice conflict',async()=>{
  const uid='invoice-review-prefix',ambiguousOther={...other,id:'invoice-1.notes'},db=await setup(uid,[invoice,ambiguousOther]);
  const localTarget={...invoice,notes:'Field target'},localOther={...ambiguousOther,notes:'Field other'};
  db.value=json([{...invoice,notes:'Office target'},{...ambiguousOther,notes:'Office other'}]);db.version=2;
  await store.set(key,json([localTarget,localOther]),{baseValue:json([invoice,ambiguousOther])});
  const conflicts=pending(uid).conflicts;
  const result=await accept(receipt({beforeInvoice:{...invoice,notes:'Office target'},beforeVersion:2,afterVersion:3}),localTarget);
  assert.equal(result.ok,true);assert.deepEqual(pending(uid).conflicts,conflicts);
  assert.deepEqual(result.parsedValue,[paid,localOther]);
});

test('unknown-result replay adopts canonical saved choice over the exact original local invoice',async()=>{
  const db=await setup('invoice-review-unknown-result-replay');
  const canonical={...paid,qbReviewResolution:{action:'retry-linked',reviewedInvoiceHash:'a'.repeat(64),confirmedResultHash:'b'.repeat(64),requestAction:'retry-linked',requestedQuickBooksInvoiceId:'5225',resolvedAt:'2026-10-22T12:00:00Z'}};
  // The first request committed, but its response never reached the browser.
  // Retrying the original hash returns a verified no-op at the current version.
  db.value=json([canonical,other]);db.version=2;
  const reads=db.reads,writes=db.writes;
  const result=await accept(receipt({invoice:canonical,beforeInvoice:canonical,beforeVersion:2,afterVersion:2,replayed:true}));
  assert.equal(result.ok,true);assert.equal(result.projected,true);assert.deepEqual(result.parsedValue,[canonical,other]);
  assert.equal((await store.get(key)).version,1,'target-only replay cannot certify the full ledger revision');
  assert.equal(db.reads,reads);assert.equal(db.writes,writes);
});
