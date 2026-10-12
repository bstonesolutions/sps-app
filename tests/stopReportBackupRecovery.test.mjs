import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { applyStopCompletion } from '../stopCompletion.js';
const runtime=process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite=runtime?(await import(pathToFileURL(runtime).href)).PGlite:null;
const sqlTest=(name,fn)=>test(name,{skip:!PGlite&&'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL'},fn);
async function setup({competing=false,duplicate=false,large=false,depth=1,empty=false}={}){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
 create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
 create table public.app_state(key text primary key,value jsonb,updated_at timestamptz default now());
 create table public.sps_backups(key text,value text,created_at timestamptz default now());`);
 for(const path of ['APP-STATE-CONCURRENCY-MIGRATION.sql','APP-STATE-BATCH-CHECK-ONLY-MIGRATION.sql'])await db.exec(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
 await db.query("select set_config('request.jwt.claim.role','service_role',false)");
 const base=[{id:'c1',name:'Synthetic Client',phone:'latest-phone',history:[]}],catalog={locations:[],treatments:[],products:[],parts:[]};
 if(large){base[0].history=[{sid:'legacy-primary',photos:[{src:`data:image/jpeg;base64,${randomBytes(2700000).toString('base64')}`}]}];for(let i=1;i<269;i++)base.push({id:`padding-${i}`,name:`Synthetic ${i}`,history:i<=163?[{sid:`legacy-${i}`,photos:[{src:`data:image/jpeg;base64,${randomBytes(73650).toString('base64')}`}]}]:[]});}
 let saved={clients:base,completed:{}};
 for(let i=1;i<=(large?8:2);i++)saved=applyStopCompletion({...saved,catalog,clientId:'c1',sid:`s${i}`,receiptId:`r${i}`,idempotencyKey:`original-request-${i}`,completedAt:`2026-10-0${i}T12:00:00.000Z`,entry:{invoice:'$0',notes:`Original ${i}`,photos:[{src:`fixture://${i}`}],customArchiveField:{keep:true}},postBalance:false});
 assert.equal(saved.ok,true);
 const archive=structuredClone(saved.clients);archive[0].phone='old-phone';
 if(empty)Object.assign(archive[0].history[1],{notes:'',photos:null,readings:{}});
 if(duplicate)archive[0].history.push(structuredClone(archive[0].history[0]));
 const current=structuredClone(base);if(competing)current[0].history=[{sid:'s1',notes:'Competing report'}];
 for(const [key,value] of Object.entries({sps_clients:current,sps_completed:saved.completed,sps_catalog:catalog,sps_schedule:[]}))await db.query('insert into app_state(key,value) values($1,$2::jsonb)',[key,JSON.stringify(Array.from({length:depth}).reduce(v=>JSON.stringify(v),value))]);
 await db.query('insert into sps_backups(key,value) values($1,$2)',['fixture-backup',JSON.stringify(archive)]);
 await db.exec(await readFile(new URL('../supabase/migrations/20261012213546_stop_report_authority.sql',import.meta.url),'utf8'));
 for(const path of ['supabase/migrations/20261012215154_stop_report_memory_bound.sql','supabase/migrations/20261012215738_stop_report_restore_cas.sql','supabase/migrations/20261012222135_stop_report_linear_replace.sql'])await db.exec(await readFile(new URL(`../${path}`,import.meta.url),'utf8'));
 await db.query('select sps_activate_stop_report_guard()');
 await db.exec(await readFile(new URL('../scripts/recover-stop-reports-from-backup.sql',import.meta.url),'utf8'));
 const rows=async()=>(await db.query("select key,value,version from app_state where key in ('sps_clients','sps_completed') order by key")).rows;
 const recovery=async(apply,receiptId=null)=>{const q=apply===undefined?'select pg_temp.sps_recover_stop_reports_from_backup($1) result':'select pg_temp.sps_recover_stop_reports_from_backup($1,$2,$3) result';return(await db.query(q,apply===undefined?['fixture-backup']:['fixture-backup',apply,receiptId])).rows[0].result};
 const backups=async()=>(await db.query("select rows from sps_stop_report_guard_backups where reason like 'missing-report-recovery:%'")).rows;
 const baselines=async()=>(await db.query("select rows from sps_stop_report_guard_backups where reason like 'missing-report-recovery-baseline:%'")).rows;
 return{db,archive,current,rows,recovery,backups,baselines};
}
sqlTest('backup recovery defaults to dry run and applies exactly one selected report per transaction',async()=>{
 const f=await setup();try{
 const before=await f.rows();const dry=await f.recovery();assert.equal(dry.dry_run,true);assert.equal(dry.eligible_reports,2);assert.deepEqual(dry.eligible_receipts,[{clientId:'c1',sid:'s2',receiptId:'r2'},{clientId:'c1',sid:'s1',receiptId:'r1'}]);assert.equal(dry.recovered_reports,0);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);
 assert.equal((await f.recovery(null)).dry_run,true);assert.deepEqual(await f.rows(),before);
 await assert.rejects(f.recovery(true),/requires_one_receipt_id/);assert.deepEqual(await f.rows(),before);
 const first=await f.recovery(true,'r1');assert.equal(first.recovered_reports,1);const one=await f.rows();assert.equal(JSON.parse(one[0].value)[0].history.length,1);assert.equal(JSON.parse(one[0].value)[0].history[0].completionReceiptId,'r1');assert.equal((await f.recovery()).eligible_reports,1);
 const applied=await f.recovery(true,'r2');assert.equal(applied.recovered_reports,1);const after=await f.rows();const current=JSON.parse(after[0].value);assert.equal(current[0].phone,'latest-phone');assert.deepEqual(current[0].history,f.archive[0].history);assert.deepEqual(after[1],before[1]);
 const backups=await f.backups();assert.equal(backups.length,2);const baselines=await f.baselines();assert.equal(baselines.length,1);assert.deepEqual(baselines[0].rows.map(({key,value,version})=>({key,value,version})),before);for(const backup of backups){assert.ok(JSON.stringify(backup).length<1000);assert.equal(backup.rows[0].recovery.priorReport,null);assert.match(backup.rows[0].recovery.addedReportDigest,/^[a-f0-9]{32}$/);assert.match(backup.rows[0].recovery.activeReceiptDigest,/^[a-f0-9]{32}$/);}
 assert.equal((await f.recovery(true,'r1')).recovered_reports,0);assert.deepEqual(await f.rows(),after);assert.equal((await f.backups()).length,2);
 }finally{await f.db.close()}
});
sqlTest('backup recovery skips competing current stop reports and duplicate source receipt identities',async()=>{
 for(const opts of [{competing:true},{duplicate:true}]){const f=await setup(opts);try{const dry=await f.recovery();assert.equal(dry.eligible_reports,1);if(opts.duplicate)await assert.rejects(f.recovery(true,'r2'),/selected_receipt_missing_or_ambiguous/);else assert.equal((await f.recovery(true,'r1')).recovered_reports,0);const applied=await f.recovery(true,opts.competing?'r2':'r1');assert.equal(applied.recovered_reports,1);const rows=await f.rows();assert.equal(JSON.parse(rows[0].value)[0].history.length,opts.competing?2:1);}finally{await f.db.close()}}
});
sqlTest('one-report recovery failure rolls back its report and backup without undoing an earlier transaction',async()=>{
 const f=await setup();try{assert.equal((await f.recovery(true,'r1')).recovered_reports,1);const before=await f.rows();await f.db.exec(`create function reject_second_recovery() returns trigger language plpgsql as $$begin if new.key='sps_clients' and jsonb_array_length(public.sps_stop_state_decode(new.value)->0->'history')=2 then raise exception 'injected_second_recovery_failure';end if;return new;end$$;create trigger zz_reject_second_recovery before update on app_state for each row execute function reject_second_recovery();`);
 await assert.rejects(f.recovery(true,'r2'),/injected_second_recovery_failure/);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,1);assert.equal((await f.baselines()).length,1);
 }finally{await f.db.close()}
});
sqlTest('backup recovery apply fails until authority guard is active',async()=>{const f=await setup();try{await f.db.query('update sps_stop_report_guard_config set enabled=false');assert.equal((await f.recovery()).eligible_reports,2);await assert.rejects(f.recovery(true,'r1'),/requires_active_guard/);assert.equal((await f.backups()).length,0);}finally{await f.db.close()}});

sqlTest('anonymous recovery transaction has no DDL and refuses apply without one exact receipt ID',async()=>{
 const {buildStopReportRecoverySQL}=await import('../scripts/run-stop-report-backup-recovery.mjs');
 const f=await setup();try{
 const before=await f.rows();
 await assert.rejects(buildStopReportRecoverySQL({sourceBackupKey:'fixture-backup',apply:true}),/one explicit receipt/);
 const run=async(apply,receiptId)=>{const sql=await buildStopReportRecoverySQL({sourceBackupKey:'fixture-backup',apply,receiptId});assert.doesNotMatch(sql,/create\s+(or\s+replace\s+)?(function|table)/i);const results=await f.db.exec(sql);return results.flatMap(result=>result.rows).find(row=>row.report_recovery)?.report_recovery;};
 const dry=await run(false);assert.equal(dry.eligible_reports,2);assert.equal(dry.recovered_reports,0);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);
 const applied=await run(true,'r1');assert.equal(applied.recovered_reports,1);const after=await f.rows();assert.equal(JSON.parse(after[0].value)[0].phone,'latest-phone');assert.deepEqual(JSON.parse(after[0].value)[0].history,[f.archive[0].history[1]]);assert.deepEqual(after[1],before[1]);assert.equal((await f.backups()).length,1);assert.equal((await run(true,'r1')).recovered_reports,0);
 }finally{await f.db.close()}
});

test('19 MB 269-client recovery handles eight exact reports in eight independent transactions',{skip:!PGlite||process.env.SPS_SQL_LARGE_RECOVERY!=='1'},async()=>{
 const {buildStopReportRecoverySQL}=await import('../scripts/run-stop-report-backup-recovery.mjs');
 const f=await setup({large:true});
 try{
   const rawBytes=(await f.db.query("select octet_length(value::text)::int bytes from app_state where key='sps_clients'")).rows[0].bytes;
   assert.ok(rawBytes>=19_000_000);
   const completedBefore=(await f.db.query("select value,version from app_state where key='sps_completed'")).rows[0];
   const metrics=[];
   for(let i=1;i<=8;i++){
     const before=performance.now();
     const results=await f.db.exec(await buildStopReportRecoverySQL({sourceBackupKey:'fixture-backup',receiptId:`r${i}`,apply:true}));
     const summary=results.flatMap(result=>result.rows).find(row=>row.report_recovery)?.report_recovery;
     assert.equal(summary.recovered_reports,1);assert.equal(summary.outcome,'restored');
     const found=(await f.db.query("select count(*)::int count from app_state a cross join lateral jsonb_array_elements(public.sps_stop_state_decode(a.value)->0->'history') h where a.key='sps_clients' and h->>'completionReceiptId'=$1",[`r${i}`])).rows[0].count;
     assert.equal(found,1);
     const sqlMemory=(await f.db.query('select sum(total_bytes)::bigint total from pg_backend_memory_contexts')).rows[0].total;
     metrics.push({report:i,milliseconds:Math.round(performance.now()-before),rssBytes:process.memoryUsage().rss,maxRssKb:process.resourceUsage().maxRSS,sqlContextBytes:Number(sqlMemory)});
   }
   assert.deepEqual((await f.db.query("select value,version from app_state where key='sps_completed'")).rows[0],completedBefore);
   const count=(await f.db.query("select count(*)::int count from sps_stop_report_guard_backups where reason like 'missing-report-recovery:%'")).rows[0].count;assert.equal(count,8);
   console.log('LARGE_RECOVERY_METRICS',JSON.stringify({rawBytes,metrics}));
 }finally{await f.db.close()}
});

sqlTest('targeted restore rejects unprivileged callers and stale versions without writes',async()=>{
 const f=await setup();try{
 const before=await f.rows();
 const versions=[before[0].version,before[1].version];
 const rpc=(cv=versions[0],dv=versions[1])=>f.db.query('select * from sps_restore_stop_report_cas($1,$2,$3,$4)',['fixture-backup','r1',cv,dv]);
 for(const role of ['anon','authenticated']){await f.db.exec(`set role ${role}`);await assert.rejects(rpc(),/permission denied/);await f.db.exec('reset role');}
 await f.db.query("select set_config('request.jwt.claim.role','authenticated',false)");await assert.rejects(rpc(),/service_only/);await f.db.query("select set_config('request.jwt.claim.role','service_role',false)");
 for(const pair of [[0,versions[1]],[versions[0],0]])await assert.rejects(rpc(...pair),/identity_invalid/);
 for(const pair of [[Number(versions[0])+1,versions[1]],[versions[0],Number(versions[1])+1]]){const result=(await rpc(...pair)).rows[0];assert.equal(result.applied,false);assert.equal(result.outcome,'conflict');}
 assert.deepEqual(await f.rows(),before);assert.equal((await f.baselines()).length,0);assert.equal((await f.backups()).length,0);
 const privileges=(await f.db.query("select has_function_privilege('service_role','sps_restore_stop_report_cas(text,text,bigint,bigint)','execute') allowed")).rows[0];assert.equal(privileges.allowed,true);
 }finally{await f.db.close()}
});

sqlTest('targeted restore preserves all supported wire encodings and works through service-only grant',async()=>{
 for(const depth of [0,1,2]){const f=await setup({depth});try{const before=await f.rows();await f.db.exec('set role service_role');const saved=(await f.db.query('select * from sps_restore_stop_report_cas($1,$2,$3,$4)',['fixture-backup','r1',before[0].version,before[1].version])).rows[0];assert.equal(saved.applied,true);await f.db.exec('reset role');const after=await f.rows();let clients=after[0].value;for(let i=0;i<depth;i++){assert.equal(typeof clients,'string');clients=JSON.parse(clients);}assert.equal(Array.isArray(clients),true);assert.deepEqual(clients[0].history,[f.archive[0].history[1]]);assert.equal(clients[0].phone,'latest-phone');assert.deepEqual(after[1],before[1]);}finally{await f.db.close()}}
});
sqlTest('targeted restore refuses an archive record with no genuine report content',async()=>{const f=await setup({empty:true});try{const before=await f.rows();assert.equal((await f.recovery()).eligible_reports,1);await assert.rejects(f.recovery(true,'r1'),/selected_receipt_missing_or_ambiguous/);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);}finally{await f.db.close()}});
