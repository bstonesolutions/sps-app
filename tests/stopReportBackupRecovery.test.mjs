import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyStopCompletion } from '../stopCompletion.js';
const runtime=process.env.SPS_SQL_TEST_PGLITE_PATH;
const PGlite=runtime?(await import(pathToFileURL(runtime).href)).PGlite:null;
const sqlTest=(name,fn)=>test(name,{skip:!PGlite&&'Set SPS_SQL_TEST_PGLITE_PATH to run real SQL'},fn);
async function setup({competing=false,duplicate=false}={}){
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
 let saved={clients:base,completed:{}};
 for(let i=1;i<=2;i++)saved=applyStopCompletion({...saved,catalog,clientId:'c1',sid:`s${i}`,receiptId:`r${i}`,idempotencyKey:`original-request-${i}`,completedAt:`2026-10-0${i}T12:00:00.000Z`,entry:{invoice:'$0',notes:`Original ${i}`,photos:[{src:`fixture://${i}`}],customArchiveField:{keep:true}},postBalance:false});
 assert.equal(saved.ok,true);
 const archive=structuredClone(saved.clients);archive[0].phone='old-phone';
 if(duplicate)archive[0].history.push(structuredClone(archive[0].history[0]));
 const current=structuredClone(base);if(competing)current[0].history=[{sid:'s1',notes:'Competing report'}];
 for(const [key,value] of Object.entries({sps_clients:current,sps_completed:saved.completed,sps_catalog:catalog,sps_schedule:[]}))await db.query('insert into app_state(key,value) values($1,$2::jsonb)',[key,JSON.stringify(JSON.stringify(value))]);
 await db.query('insert into sps_backups(key,value) values($1,$2)',['fixture-backup',JSON.stringify(archive)]);
 await db.exec(await readFile(new URL('../supabase/migrations/20261012213546_stop_report_authority.sql',import.meta.url),'utf8'));
 await db.query('select sps_activate_stop_report_guard()');
 await db.exec(await readFile(new URL('../scripts/recover-stop-reports-from-backup.sql',import.meta.url),'utf8'));
 const rows=async()=>(await db.query("select key,value,version from app_state where key in ('sps_clients','sps_completed') order by key")).rows;
 const recovery=async(apply)=>{const q=apply===undefined?'select pg_temp.sps_recover_stop_reports_from_backup($1) result':'select pg_temp.sps_recover_stop_reports_from_backup($1,$2) result';return(await db.query(q,apply===undefined?['fixture-backup']:['fixture-backup',apply])).rows[0].result};
 const backups=async()=>(await db.query("select rows from sps_stop_report_guard_backups where reason like 'missing-report-recovery:%'")).rows;
 return{db,archive,current,rows,recovery,backups};
}
sqlTest('backup recovery defaults to dry run and restores exact entries without touching current profile or markers',async()=>{
 const f=await setup();try{
 const before=await f.rows();const dry=await f.recovery();assert.equal(dry.dry_run,true);assert.equal(dry.eligible_reports,2);assert.equal(dry.recovered_reports,0);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);
 const applied=await f.recovery(true);assert.equal(applied.recovered_reports,2);const after=await f.rows();const current=JSON.parse(after[0].value);assert.equal(current[0].phone,'latest-phone');assert.deepEqual(current[0].history,[...f.archive[0].history].reverse());assert.deepEqual(after[1],before[1]);
 const backups=await f.backups();assert.equal(backups.length,1);assert.deepEqual(backups[0].rows.map(({key,value,version})=>({key,value,version})),before);
 assert.equal((await f.recovery(true)).recovered_reports,0);assert.deepEqual(await f.rows(),after);assert.equal((await f.backups()).length,1);
 }finally{await f.db.close()}
});
sqlTest('backup recovery skips competing current stop reports and duplicate source receipt identities',async()=>{
 for(const opts of [{competing:true},{duplicate:true}]){const f=await setup(opts);try{const dry=await f.recovery();assert.equal(dry.eligible_reports,1);const applied=await f.recovery(true);assert.equal(applied.recovered_reports,1);const rows=await f.rows();assert.equal(JSON.parse(rows[0].value)[0].history.length,opts.competing?2:1);}finally{await f.db.close()}}
});
sqlTest('backup recovery failure rolls back earlier recovered entries and recovery backup',async()=>{
 const f=await setup();try{const before=await f.rows();await f.db.exec(`create function reject_second_recovery() returns trigger language plpgsql as $$begin if new.key='sps_clients' and jsonb_array_length(public.sps_stop_state_decode(new.value)->0->'history')=2 then raise exception 'injected_second_recovery_failure';end if;return new;end$$;create trigger zz_reject_second_recovery before update on app_state for each row execute function reject_second_recovery();`);
 await assert.rejects(f.recovery(true),/injected_second_recovery_failure/);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);
 }finally{await f.db.close()}
});
sqlTest('backup recovery apply fails until authority guard is active',async()=>{const f=await setup();try{await f.db.query('update sps_stop_report_guard_config set enabled=false');assert.equal((await f.recovery()).eligible_reports,2);await assert.rejects(f.recovery(true),/requires_active_guard/);assert.equal((await f.backups()).length,0);}finally{await f.db.close()}});

sqlTest('anonymous recovery transaction has no DDL and returns dry-run and exact apply counts',async()=>{
 const {buildStopReportRecoverySQL}=await import('../scripts/run-stop-report-backup-recovery.mjs');
 const f=await setup();try{
 const before=await f.rows();
 const run=async apply=>{const sql=await buildStopReportRecoverySQL({sourceBackupKey:'fixture-backup',apply});assert.doesNotMatch(sql,/create\s+(or\s+replace\s+)?(function|table)/i);const results=await f.db.exec(sql);return results.flatMap(result=>result.rows).find(row=>row.report_recovery)?.report_recovery;};
 const dry=await run(false);assert.equal(dry.eligible_reports,2);assert.equal(dry.recovered_reports,0);assert.deepEqual(await f.rows(),before);assert.equal((await f.backups()).length,0);
 const applied=await run(true);assert.equal(applied.recovered_reports,2);const after=await f.rows();assert.equal(JSON.parse(after[0].value)[0].phone,'latest-phone');assert.deepEqual(JSON.parse(after[0].value)[0].history,[...f.archive[0].history].reverse());assert.deepEqual(after[1],before[1]);assert.equal((await f.backups()).length,1);
 }finally{await f.db.close()}
});
