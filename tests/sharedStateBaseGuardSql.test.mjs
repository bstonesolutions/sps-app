// Isolated real PostgreSQL semantics only. No credentials or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyStopCompletion } from '../stopCompletion.js';
const runtime=process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite=runtime ? (await import(pathToFileURL(runtime).href)).PGlite : null;
const sqlTest=(name,fn)=>test(name,{skip:!PGlite&&'Set SPS_SQL_TEST_PGLITE_PATH for real SQL'},fn);
const migrations=await Promise.all([
  'APP-STATE-CONCURRENCY-MIGRATION.sql','APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql',
  'supabase/migrations/20261005120855_client_maintenance_billing_rpc.sql',
  'supabase/migrations/20261012213546_stop_report_authority.sql',
  'supabase/migrations/20261012215154_stop_report_memory_bound.sql',
  'supabase/migrations/20261012222135_stop_report_linear_replace.sql',
  'supabase/migrations/20261019205512_scheduled_client_identity_guard.sql',
  'supabase/migrations/20261019205940_compact_client_create.sql',
  'supabase/migrations/20261023001232_invoice_review_targeted_resolution.sql',
  'supabase/migrations/20261023010217_invoice_accounting_authority.sql',
  'supabase/migrations/20261023013826_shared_state_base_guard.sql',
].map(file=>readFile(new URL(`../${file}`,import.meta.url),'utf8')));
const copy=x=>structuredClone(x);
const initialClients=()=>[{id:'one',name:'Corrected name',phone:'555-new',plan:'Essential',monthlyRate:250,notes:'New office note',
  history:[{date:'2026-10-22',notes:'Legacy report saved',photos:['fixture://photo']}]},{id:'two',name:'Unscheduled client',history:[]}];
const initialSchedule=()=>[{date:'2026-10-22',route:'North',stops:[{sid:'stop-one',clientId:'one',name:'Corrected name',notes:'New stop note'}]}];
const decode=value=>{for(let i=0;i<2&&typeof value==='string';i++)value=JSON.parse(value);return value;};
const wire=(value,depth=1)=>{while(depth--)value=JSON.stringify(value);return JSON.stringify(value);};
async function setup({clients=initialClients(),schedule=initialSchedule(),depth=1}={}){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
    create function auth.uid() returns uuid language sql stable as $$select '11111111-1111-1111-1111-111111111111'::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{"email":"fixture@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
  for(const sql of migrations.slice(0,2))await db.exec(sql);
  for(const [key,value]of Object.entries({sps_clients:clients,sps_schedule:schedule,sps_completed:{},sps_catalog:{treatments:[],parts:[],products:[]},sps_invoices:[],sps_billing_reviews:[],sps_maintenance_billing:{version:2,policies:{},allocations:{}},sps_other:{notes:'Before'}}))
    await db.query('insert into app_state(key,value) values($1,$2::jsonb)',[key,wire(value,depth)]);
  for(const sql of migrations.slice(2))await db.exec(sql);
  const role=async name=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claims',$2,false)",[name,JSON.stringify({role:name})]);await db.exec(`set role ${name}`);};
  await role('service_role');await db.query('select sps_activate_stop_report_guard()');
  const state=async key=>(await db.query('select value,version,updated_at from app_state where key=$1',[key])).rows[0];
  const value=async key=>decode((await state(key)).value);
  const cas=async(key,next,version)=>(await db.query('select * from sps_app_state_cas($1,$2,$3::jsonb)',[key,version??(await state(key)).version,wire(next,depth)])).rows[0];
  const patch=async(key,before,next,version)=>(await db.query('select * from sps_shared_state_patch_cas($1,$2,$3::jsonb,$4::jsonb,$5)',[key,version??(await state(key)).version,JSON.stringify(before),wire(next,depth),'fixture-owner'])).rows[0];
  const batch=async operations=>(await db.query('select * from sps_app_state_batch_cas($1::jsonb)',[JSON.stringify(operations)])).rows[0];
  const patchBatch=async(operations,expected)=>(await db.query('select * from sps_shared_state_patch_batch_cas($1::jsonb,$2::jsonb,$3)',[JSON.stringify(operations),JSON.stringify(expected),'fixture-owner'])).rows[0];
  const candidates=async key=>(await db.query('select * from sps_shared_write_candidates_read($1)',[key])).rows;
  return{db,role,state,value,cas,patch,batch,patchBatch,candidates,close:()=>db.close()};
}

sqlTest('current-version legacy client snapshots cannot revert profiles unreceipted history or any existing client omission',async()=>{
  const f=await setup();try{
    const before=await f.state('sps_clients');const stale=[{...initialClients()[0],name:'Old nonblank name',phone:'555-old',monthlyRate:100,notes:'Old note',history:[]}];
    await f.role('authenticated');const result=await f.cas('sps_clients',stale);
    assert.equal(result.applied,false);assert.equal(result.outcome,'requires-base-aware-save');assert.deepEqual(await f.state('sps_clients'),before);
    await f.role('service_role');const held=await f.candidates('sps_clients');
    assert.ok(held.some(c=>c.entity_id==='client:one'&&c.proposed_fields.name==='Old nonblank name'));
    assert.ok(held.some(c=>c.entity_id==='client:two'&&c.proposed_delete));
    await f.cas('sps_clients',stale);assert.equal((await f.candidates('sps_clients')).length,held.length,'retries do not multiply proposals');
  }finally{await f.close();}
});

sqlTest('legacy raw updates fail explicitly and a fresh version never grants replacement authority',async()=>{
  const f=await setup();try{
    await f.role('authenticated');
    await assert.rejects(f.db.query("update app_state set value=$1::jsonb where key='sps_clients'",[wire([])]),/requires_base_aware_save/);
    await assert.rejects(f.db.query("delete from app_state where key='sps_schedule'"),/requires_base_aware_save/);
    const before=await f.state('sps_clients');await f.role('service_role');
    const next=initialClients();next[0].name='Newest name';assert.equal((await f.patch('sps_clients',initialClients(),next)).applied,true);
    await f.role('authenticated');assert.equal((await f.cas('sps_clients',initialClients(),before.version)).outcome,'conflict');
    assert.equal((await f.cas('sps_clients',initialClients())).outcome,'requires-base-aware-save');assert.equal((await f.value('sps_clients'))[0].name,'Newest name');
  }finally{await f.close();}
});

sqlTest('safe stable-identity appends succeed without changing existing clients or stops',async()=>{
  const f=await setup();try{
    await f.role('authenticated');
    assert.equal((await f.cas('sps_clients',[...initialClients(),{id:'three',name:'New client',history:[]}])).applied,true);
    const next=initialSchedule();next[0].stops.push({sid:'stop-two',clientId:'two',notes:'New stop'});
    assert.equal((await f.cas('sps_schedule',next)).applied,true);assert.deepEqual(await f.value('sps_schedule'),next);
    const bad=copy(next);bad[0].stops[0].notes='Stale stop';
    const prior=await f.state('sps_schedule');assert.equal((await f.cas('sps_schedule',bad)).outcome,'requires-base-aware-save');assert.deepEqual(await f.state('sps_schedule'),prior);
  }finally{await f.close();}
});

sqlTest('legacy schedule omission moves route reorders and anonymous new stops are held',async()=>{
  const schedule=initialSchedule();schedule[0].stops.push({sid:'stop-two',clientId:'two'});
  const f=await setup({schedule});try{
    const before=await f.state('sps_schedule');
    for(const next of [[],[{...schedule[0],date:'2026-10-23'}],[{...schedule[0],stops:[...schedule[0].stops].reverse()}],[{...schedule[0],stops:[...schedule[0].stops,{clientId:'two'}]}]]){
      assert.equal((await f.cas('sps_schedule',next)).outcome,'requires-base-aware-save');assert.deepEqual(await f.state('sps_schedule'),before);
    }
  }finally{await f.close();}
});

sqlTest('legacy restore or replaceMany batch rolls back every row while durably holding the proposal',async()=>{
  const f=await setup();try{
    const before=await f.state('sps_clients'),other=await f.state('sps_other');
    const result=await f.batch([{key:'sps_other',expected_version:other.version,value:{notes:'Must roll back'}},{key:'sps_clients',expected_version:before.version,value:[]}]);
    assert.equal(result.applied,false);assert.equal(result.outcome,'requires-base-aware-save');assert.equal(result.conflict_key,'sps_clients');
    assert.deepEqual(await f.state('sps_clients'),before);assert.deepEqual(await f.state('sps_other'),other);assert.ok((await f.candidates('sps_clients')).length);
  }finally{await f.close();}
});

sqlTest('a blocked mixed snapshot durably retains its new client and stop as well as the stale change',async()=>{
  const f=await setup();try{
    const newClient={id:'new-client',name:'Newly entered client',phone:'555-important',history:[]};
    const clients=[{...initialClients()[0],notes:'Stale note'},initialClients()[1],newClient];
    const schedule=initialSchedule();schedule[0].stops[0].notes='Stale stop';
    const newStop={sid:'new-stop',clientId:'new-client',notes:'Newly entered work'};schedule[0].stops.push(newStop);
    const held=await f.batch([{key:'sps_clients',expected_version:1,value:clients},{key:'sps_schedule',expected_version:1,value:schedule}]);
    assert.equal(held.applied,false);assert.deepEqual(await f.value('sps_clients'),initialClients());assert.deepEqual(await f.value('sps_schedule'),initialSchedule());
    assert.deepEqual((await f.candidates('sps_clients')).find(c=>c.entity_id==='client:new-client').proposed_fields,newClient);
    assert.deepEqual((await f.candidates('sps_schedule')).find(c=>c.entity_id==='stop:new-stop').proposed_fields.stop,newStop);
  }finally{await f.close();}
});

sqlTest('exact service patch saves legitimate profile and schedule edits and rejects mismatched baselines',async()=>{
  for(const depth of [0,1,2]){const f=await setup({depth});try{
    const next=initialClients();next[0].name='Owner correction';next[0].history[0].notes='Corrected legacy report';
    const saved=await f.patch('sps_clients',initialClients(),next);assert.equal(saved.applied,true);assert.deepEqual(decode(saved.value),next);
    const before=await f.state('sps_clients');assert.equal((await f.patch('sps_clients',initialClients(),[])).outcome,'conflict');assert.deepEqual(await f.state('sps_clients'),before);
    const schedule=initialSchedule();schedule[0].date='2026-10-23';schedule[0].stops[0].notes='Rescheduled by owner';
    assert.equal((await f.patch('sps_schedule',initialSchedule(),schedule)).applied,true);assert.deepEqual(await f.value('sps_schedule'),schedule);
  }finally{await f.close();}}
});

sqlTest('explicit deletion tombstones identities so an old append cannot resurrect them',async()=>{
  const f=await setup();try{
    assert.equal((await f.patch('sps_clients',initialClients(),[initialClients()[0]])).applied,true);
    await f.role('authenticated');assert.equal((await f.cas('sps_clients',initialClients())).outcome,'requires-base-aware-save');
    assert.deepEqual(await f.value('sps_clients'),[initialClients()[0]]);
    await f.role('service_role');assert.equal((await f.patch('sps_schedule',initialSchedule(),[])).applied,true);
    await f.role('authenticated');assert.equal((await f.cas('sps_schedule',initialSchedule())).outcome,'requires-base-aware-save');assert.deepEqual(await f.value('sps_schedule'),[]);
    await f.role('service_role');
    await assert.rejects(f.patch('sps_clients',[initialClients()[0]],initialClients()),/shared_deleted_identity_reused/);
    await assert.rejects(f.patch('sps_schedule',[],initialSchedule()),/shared_deleted_identity_reused/);
    const newWork=[{date:'2026-10-22',stops:[{sid:'a-different-stop',clientId:'one'}]}];
    assert.equal((await f.patch('sps_schedule',[],newWork)).applied,true,'a genuinely new stop may reuse a removed date container');
  }finally{await f.close();}
});

sqlTest('verified stop completion keeps the accepted-report context and does not change unrelated profile fields',async()=>{
  const f=await setup();try{
    const completed=applyStopCompletion({clients:initialClients(),completed:{},catalog:{treatments:[],parts:[],products:[]},clientId:'one',
      entry:{sid:'stop-one',date:'2026-10-22',notes:'Accepted work',photos:[{src:'fixture://report-photo'}],invoice:'$0'},
      sid:'stop-one',receiptId:'receipt-one',idempotencyKey:'completion-one',completedAt:'2026-10-22T15:00:00.000Z',postBalance:false});
    assert.equal(completed.ok,true,completed.code);
    const operations=[{key:'sps_clients',expected_version:1,value:JSON.stringify(completed.clients)},
      {key:'sps_completed',expected_version:1,value:JSON.stringify(completed.completed)}];
    const receipt=(await f.db.query('select * from sps_stop_completion_batch_cas($1::jsonb,$2,$3,$4)',
      [JSON.stringify(operations),'complete','stop-one','receipt-one'])).rows[0];
    assert.equal(receipt.applied,true);assert.deepEqual(await f.value('sps_clients'),completed.clients);
    assert.deepEqual(await f.value('sps_completed'),completed.completed);
    assert.equal((await f.cas('sps_clients',initialClients())).outcome,'requires-base-aware-save');
    assert.deepEqual(await f.value('sps_clients'),completed.clients);
  }finally{await f.close();}
});

sqlTest('exact portal ratings may update accepted report metadata but cannot rewrite accepted work',async()=>{
  const clients=initialClients();clients[0].history.push({completionReceiptId:'accepted-one',sid:'stop-one',date:'2026-10-22',notes:'Verified work',photos:['fixture://accepted-photo']});
  const f=await setup({clients});try{
    const rating=copy(clients);Object.assign(rating[0].history[1],{clientRating:2,clientFeedback:'Please call',ratedAt:'2026-10-22T16:00:00.000Z',portalRatingAlertId:'alert-one'});
    const operations=[{key:'sps_clients',expected_version:1,value:JSON.stringify(rating)},{key:'sps_other',expected_version:1,value:{notes:'Related rating alert'}}];
    const receipt=await f.patchBatch(operations,{sps_clients:clients});assert.equal(receipt.applied,true);assert.deepEqual(await f.value('sps_clients'),rating);
    const before=await f.state('sps_clients');const edit=copy(rating);edit[0].history[1].notes='Attempt to rewrite accepted work';
    const other=await f.state('sps_other');
    await assert.rejects(f.patchBatch([{key:'sps_clients',expected_version:before.version,value:edit},{key:'sps_other',expected_version:other.version,value:{notes:'Must roll back'}}],{sps_clients:rating}),/shared_state_protected_change_rejected/);
    assert.deepEqual(await f.state('sps_clients'),before);assert.deepEqual(await f.state('sps_other'),other);
    await f.role('authenticated');assert.equal((await f.cas('sps_clients',clients)).outcome,'requires-base-aware-save');assert.deepEqual(await f.state('sps_clients'),before);
  }finally{await f.close();}
});

sqlTest('large roster profile edits avoid copying inline photos into the proposal journal',async()=>{
  const photo='a'.repeat(120000);
  const clients=Array.from({length:269},(_,i)=>({id:`client-${i}`,name:`Synthetic ${i}`,notes:'Before',history:i<164?[{date:'2026-10-22',notes:'Saved report',photos:[photo]}]:[]}));
  const f=await setup({clients,schedule:[]});try{
    const next=clients.map((c,i)=>i===0?{...c,notes:'New office note'}:c);
    let start=performance.now();const saved=await f.patch('sps_clients',clients,next);const canonicalMs=performance.now()-start;
    assert.equal(saved.applied,true);
    await f.role('authenticated');start=performance.now();const held=await f.cas('sps_clients',clients);const legacyMs=performance.now()-start;
    assert.equal(held.outcome,'requires-base-aware-save');await f.role('service_role');
    const proposals=await f.candidates('sps_clients');assert.equal(proposals.length,1);assert.deepEqual(proposals[0].proposed_fields,{notes:'Before'});
    console.log(JSON.stringify({sharedStateSqlBenchmark:true,clients:269,jsonBytes:Buffer.byteLength(JSON.stringify(clients)),canonicalMs:Math.round(canonicalMs),legacyMs:Math.round(legacyMs),proposalBytes:Buffer.byteLength(JSON.stringify(proposals))}));
  }finally{await f.close();}
});

sqlTest('protected service batch preserves atomic portal and billing side effects with exact scopes',async()=>{
  const f=await setup();try{
    const next=initialClients();next[0].notifyPrefs={channels:{text:false}};
    const operations=[{key:'sps_clients',expected_version:1,value:next},{key:'sps_other',expected_version:1,value:{notes:'Atomic related action'}}];
    const bad=await f.patchBatch(operations,{sps_clients:[]});assert.equal(bad.applied,false);assert.deepEqual(await f.value('sps_other'),{notes:'Before'});
    const saved=await f.patchBatch(operations,{sps_clients:initialClients()});assert.equal(saved.applied,true);assert.deepEqual(decode(saved.values.sps_clients),next);
    assert.deepEqual(await f.value('sps_other'),{notes:'Atomic related action'});
    assert.equal((await f.db.query("select coalesce(current_setting('sps.shared_state_write',true),'') v")).rows[0].v,'');
  }finally{await f.close();}
});

sqlTest('new RPCs private tables and forged context remain unavailable to generic clients',async()=>{
  const f=await setup();try{
    await f.role('authenticated');
    await assert.rejects(f.patch('sps_clients',initialClients(),[]),/permission denied/);
    await assert.rejects(f.candidates('sps_clients'),/permission denied/);
    await assert.rejects(f.db.query('select * from sps_shared_write_candidates'),/permission denied/);
    await f.db.query("select set_config('sps.shared_state_write',$1,false),set_config('request.jwt.claim.role','service_role',false)",[JSON.stringify({keys:{sps_clients:true}})]);
    assert.equal((await f.cas('sps_clients',[])).outcome,'requires-base-aware-save');assert.deepEqual(await f.value('sps_clients'),initialClients());
    await assert.rejects(f.db.query('select * from sps_app_state_cas_before_base_guard($1,$2,$3::jsonb)',['sps_clients',1,'[]']),/permission denied/);
  }finally{await f.close();}
});

sqlTest('compact client creation and verified maintenance billing remain usable after the guard',async()=>{
  const f=await setup();try{
    const id='client-11111111-2222-4333-8444-555555555555';
    const created=(await f.db.query('select * from sps_client_create($1,$2::jsonb,false)',[id,JSON.stringify({id,name:'Created on server'})])).rows[0];
    assert.equal(created.applied,true);assert.equal((await f.value('sps_clients')).at(-1).name,'Created on server');
    const current=await f.state('sps_clients');
    const saved=(await f.db.query('select * from sps_client_maintenance_billing_cas($1,$2,$3,$4::jsonb,$5::jsonb)',
      ['one',current.version,1,null,JSON.stringify({version:2,policies:{},allocations:{}})])).rows[0];
    assert.equal(saved.applied,true);assert.equal((await f.db.query("select coalesce(current_setting('sps.shared_state_write',true),'') v")).rows[0].v,'');
  }finally{await f.close();}
});


sqlTest('invoice authority remains independent and rejected shared batches roll back invoice side effects',async()=>{
  const f=await setup();try{
    const invoice={id:'inv-one',qbId:'qb-one',qbCustomerId:'customer-one',number:'2001',total:100,balance:0,status:'Paid',lineItems:[{id:'line-one',desc:'Service',qty:1,unitPrice:100}],qbSyncToken:'1',qbSyncStatus:'synced',qbAuthoritative:true};
    const receipt=(await f.db.query('select * from sps_invoice_canonical_cas($1,$2::jsonb,$3,$4,$5::jsonb)',[1,wire([invoice]),'fixture-owner','quickbooks-refresh',JSON.stringify({'inv-one':invoice})])).rows[0];
    assert.equal(receipt.applied,true);assert.equal((await f.value('sps_invoices'))[0].status,'Paid');
    const clients=initialClients();clients[0].name='Changed safely';assert.equal((await f.patch('sps_clients',initialClients(),clients)).applied,true);
    const ivBefore=await f.state('sps_invoices'),clBefore=await f.state('sps_clients');
    const result=await f.batch([{key:'sps_invoices',expected_version:ivBefore.version,value:[{...invoice,total:999,status:'Sent'}]},
      {key:'sps_clients',expected_version:clBefore.version,value:initialClients()}]);
    assert.equal(result.outcome,'requires-base-aware-save');assert.deepEqual(await f.state('sps_invoices'),ivBefore);assert.deepEqual(await f.state('sps_clients'),clBefore);
    assert.equal((await f.db.query('select * from sps_invoice_write_candidates_read($1)',['inv-one'])).rows.length,0);
    const scheduleBefore=await f.state('sps_schedule'),otherBefore=await f.state('sps_other');
    const unlinked=initialSchedule();unlinked[0].stops[0].linkedInvoiceId='';
    await assert.rejects(f.patchBatch([{key:'sps_schedule',expected_version:scheduleBefore.version,value:unlinked},
      {key:'sps_invoices',expected_version:ivBefore.version,value:[]},{key:'sps_other',expected_version:otherBefore.version,value:{notes:'Must roll back with protected invoice'}}],
      {sps_schedule:initialSchedule()}),/shared_state_protected_change_rejected/);
    assert.deepEqual(await f.state('sps_schedule'),scheduleBefore);assert.deepEqual(await f.state('sps_invoices'),ivBefore);assert.deepEqual(await f.state('sps_other'),otherBefore);
    assert.equal((await f.db.query('select * from sps_invoice_write_candidates_read($1)',['inv-one'])).rows.length,0,'failed atomic batch retains no invoice candidate side effect');
    await f.role('authenticated');assert.equal((await f.cas('sps_invoices',[{...invoice,total:999,status:'Sent'}])).applied,true);
    const kept=(await f.value('sps_invoices'))[0];assert.equal(kept.status,'Paid');assert.equal(kept.total,100);assert.ok(kept.qbWriteReview);
  }finally{await f.close();}
});
