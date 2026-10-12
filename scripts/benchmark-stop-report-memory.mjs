// Opt-in resource regression for report mutations. Never connects to production.
// Create a disposable PG17 cluster at /tmp/sps-stop-native-pg/data with its Unix
// socket at /tmp/sps-stop-native-pg and port65439; use postgres trust auth locally.
// Install pg into an isolated /tmp directory, then:
// SPS_NATIVE_MEMORY_TEST=1 SPS_NATIVE_PG_MODULE=/tmp/sps-stop-sql-harness/node_modules/pg SPS_MEMORY_REUSE=1 node scripts/benchmark-stop-report-memory.mjs optimized
// Repeat with baseline to compare the installed original authority migration.
// SPS_MEMORY_ALLOCATOR labels the server's launch configuration in the artifact;
// it does not change that configuration. Preserve default macOS RSS separately
// from diagnostic MallocSpaceEfficient=1 results (Apple caches freed large blocks).
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { applyStopCompletion, reverseStopCompletion } from '../stopCompletion.js';
if(process.env.SPS_NATIVE_MEMORY_TEST!=='1')throw Error('Opt-in required: SPS_NATIVE_MEMORY_TEST=1. This benchmark creates synthetic data in an isolated local PostgreSQL17 cluster.');
if(!process.env.SPS_NATIVE_PG_MODULE)throw Error('Set SPS_NATIVE_PG_MODULE to an isolated installation of the pg Node package.');
const require=createRequire(import.meta.url);const {Client}=require(process.env.SPS_NATIVE_PG_MODULE);
const exec=promisify(execFile);const root=new URL('../',import.meta.url);
const optimized=process.argv[2]!=='baseline';const dbname=`sps_stop_memory_${optimized?'optimized':'baseline'}_${randomBytes(6).toString('hex')}`;
const conn={host:'/tmp/sps-stop-native-pg',port:65439,user:'postgres',database:dbname};
const sql=async path=>readFile(new URL(path,root),'utf8');
const admin=new Client({...conn,database:'postgres'});await admin.connect();
const identity=(await admin.query("select current_setting('data_directory') path,current_setting('server_version_num') version")).rows[0];
if(identity.path!=='/tmp/sps-stop-native-pg/data'||!String(identity.version).startsWith('17')){await admin.end();throw Error('Refusing to run outside the isolated /tmp/sps-stop-native-pg PostgreSQL17 cluster.');}
await admin.query(`create database ${dbname}`);await admin.end();
const setup=new Client(conn);await setup.connect();
await setup.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$;
 create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
 create function auth.uid() returns uuid language sql stable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select '{"email":"fixture@example.invalid","app_metadata":{"sps_role":"owner"}}'::jsonb $$;
 grant usage on schema auth to anon,authenticated,service_role;
 create table app_state(key text primary key,value jsonb not null,updated_at timestamptz default now());grant select,insert,update,delete on app_state to anon,authenticated,service_role;`);
await setup.query(await sql('APP-STATE-CONCURRENCY-MIGRATION.sql'));await setup.query(await sql('APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql'));
const clients=Array.from({length:269},(_,i)=>({id:`native-${i}`,name:`Synthetic ${i}`,history:i<164?[{sid:`old-${i}`,completionReceiptId:`old-receipt-${i}`,notes:'Saved report',photos:[randomBytes(i===0?2_745_000:71_500).toString('base64')]}]:[]}));
const cid='native-0',sid='new-stop',rid='new-receipt',catalog={treatments:[],parts:[],products:[]};
for(const [key,value]of Object.entries({sps_clients:clients,sps_completed:{},sps_catalog:catalog,sps_schedule:[],sps_billing_reviews:[],sps_invoices:[]})) await setup.query('insert into app_state(key,value) values($1,$2::jsonb)',[key,JSON.stringify(JSON.stringify(value))]);
await setup.query(await sql('supabase/migrations/20261012213546_stop_report_authority.sql'));
if(optimized)await setup.query(await sql('supabase/migrations/20261012215154_stop_report_memory_bound.sql'));

await setup.query("select set_config('request.jwt.claim.role','service_role',false)");await setup.query('select sps_activate_stop_report_guard()');await setup.end();
let completion=applyStopCompletion({clients,completed:{},catalog,clientId:cid,sid,receiptId:rid,idempotencyKey:'native-completion-key',completedAt:'2026-10-12T20:00:00.000Z',entry:{sid,notes:'New accepted report',invoice:'$0',photos:[]},postBalance:false});if(!completion.ok)throw Error(completion.code);
const measurements=[];
async function measure(name,operation,reuse){
 const c=reuse||new Client(conn);if(!reuse)await c.connect();await c.query("select set_config('request.jwt.claim.role','service_role',false)");
 const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;
 let peak=0,samples=0,busy=false;const sample=async()=>{if(busy)return;busy=true;try{const{stdout}=await exec('/bin/ps',['-o','rss=','-p',String(pid)]);peak=Math.max(peak,Number(stdout.trim())*1024);samples++;}finally{busy=false;}};
 await sample();const baseline=peak;const timer=setInterval(()=>void sample(),5);const started=performance.now();
 try{await operation(c);await sample();}finally{clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,5));if(!reuse)await c.end();}
 const row={name,ms:Math.round(performance.now()-started),baselineMiB:+(baseline/1048576).toFixed(1),peakRssMiB:+(peak/1048576).toFixed(1),samples};measurements.push(row);console.log(JSON.stringify(row));
}
async function rpc(c,mode,nextClients,nextCompleted,receipt=rid){const rows=(await c.query("select key,version from app_state where key in ('sps_clients','sps_completed')")).rows;const versions=Object.fromEntries(rows.map(r=>[r.key,Number(r.version)]));const operations=[{key:'sps_clients',expected_version:versions.sps_clients,value:JSON.stringify(optimized?nextClients[0]:nextClients)},{key:'sps_completed',expected_version:versions.sps_completed,...(mode==='edit'?{check_only:true}:{value:JSON.stringify(nextCompleted)})}];const r=(await c.query(optimized?'select * from sps_stop_completion_delta_cas($1::jsonb,$2,$3,$4,$5)':'select * from sps_stop_completion_batch_cas($1::jsonb,$2,$3,$4)',optimized?[JSON.stringify(operations),mode,sid,receipt,cid]:[JSON.stringify(operations),mode,sid,receipt])).rows[0];if(!r.applied)throw Error(JSON.stringify(r));}
await measure('complete',c=>rpc(c,'complete',completion.clients,completion.completed));
const edited=structuredClone(completion.clients);edited[0].history[0].notes='Corrected report';
await measure('edit',c=>rpc(c,'edit',edited));
const generic=structuredClone(edited);generic[0].notes='Ordinary profile change';
await measure('generic-profile',c=>c.query("update app_state set value=$1::jsonb where key='sps_clients'",[JSON.stringify(JSON.stringify(generic))]));
const stale=structuredClone(generic);stale[1].history=[];
await measure('generic-stale-report',c=>c.query("update app_state set value=$1::jsonb where key='sps_clients'",[JSON.stringify(JSON.stringify(stale))]));
const reverse=reverseStopCompletion({clients:generic,completed:completion.completed,catalog,clientId:cid,sid});if(!reverse.ok)throw Error(reverse.code);
reverse.completed.__stopReversedRequests={[rid]:{sid,clientId:cid,receiptId:rid,idempotencyKey:'native-completion-key',reversedAt:'2026-10-12T23:00:00.000Z'}};
await measure('reverse',c=>rpc(c,'reverse',reverse.clients,reverse.completed));
if(process.env.SPS_MEMORY_REUSE){
 const reuse=new Client(conn);await reuse.connect();
 const fresh=applyStopCompletion({clients:reverse.clients,completed:reverse.completed,catalog,clientId:cid,sid,receiptId:'next-receipt',idempotencyKey:'native-next-key',completedAt:'2026-10-13T20:00:00.000Z',entry:{sid,notes:'Repeated-save report',invoice:'$0',photos:[]},postBalance:false});if(!fresh.ok)throw Error(fresh.code);
 await measure('reused-complete',c=>rpc(c,'complete',fresh.clients,fresh.completed,'next-receipt'),reuse);
 for(let i=0;i<8;i++){fresh.clients[0].history[0].notes=`Repeated edit ${i}`;await measure(`reused-edit-${i+1}`,c=>rpc(c,'edit',fresh.clients,null,'next-receipt'),reuse);}
 await reuse.end();
}
const result={allocator:process.env.SPS_MEMORY_ALLOCATOR||'default',optimized,payloadBytes:Buffer.byteLength(JSON.stringify(clients)),targetClientBytes:Buffer.byteLength(JSON.stringify(clients[0])),server:'native PostgreSQL17',connection:{host:conn.host,port:conn.port,database:dbname},measurements};
await mkdir(new URL('../.sps-review/',import.meta.url),{recursive:true});
await writeFile(new URL(`../.sps-review/stop-native-memory-${optimized?'optimized':'baseline'}-${process.env.SPS_MEMORY_ALLOCATOR||'default'}${process.env.SPS_MEMORY_REUSE?'-reused':''}.json`,import.meta.url),JSON.stringify(result,null,2));

// Drop only the uniquely named synthetic database this invocation created.
const cleanup=new Client({...conn,database:'postgres'});await cleanup.connect();await cleanup.query(`drop database ${dbname}`);await cleanup.end();
