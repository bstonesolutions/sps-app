import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deleteScheduledStops, scheduleDeletionSelection, scheduleSelectionScope } from '../scheduleDeletion.js';
import { applySharedStateIntent } from '../sharedStateIntent.js';
const clone = value => structuredClone(value);
const a = {sid:'a',clientId:'client-a',client:'Client A',assigneeId:'david'};
const b = {sid:'b',clientId:'client-b',client:'Client B',assigneeId:'josh'};
const c = {sid:'c',clientId:'client-c',client:'Client C',assigneeId:'david'};
const base = () => [{date:'10/29/2026',stops:[a,b]},{date:'10/30/2026',stops:[c]}];
function harness() {
  const disk = new Map(), state = {value:base(), version:1, requests:[], current:true, fail:false, loseReply:false, refreshPending:false, project:null};
  const storage = {getVerified:async key=>clone(disk.get(key)),set:async(key,value)=>{disk.set(key,clone(value));},del:async key=>{disk.delete(key)}};
  const stateStore = {captureIdentity:()=>({uid:'owner',generation:1}),isCurrentIdentity:()=>state.current,
    refresh:async()=>({ok:true,version:state.version,pending:state.refreshPending}),get:async()=>({value:JSON.stringify(state.project || state.value)}),
    set:()=>{throw new Error('Explicit removal must never become a generic autosave')}};
  const send = async request => {
    assert.equal(disk.size,1,'the original request is durable before any network write');
    state.requests.push(clone(request));
    if(state.fail)return {data:null,error:new Error('Save unavailable')};
    const beforeVersion=state.version, applied=await applySharedStateIntent(request,state.value);
    if(!applied.applied)return {data:{ok:false,code:'shared-state-field-conflict',error:'A selected stop changed',conflicts:applied.conflicts}};
    if(applied.changed){state.value=applied.value;state.version++}
    if(state.loseReply){state.loseReply=false;return {data:null,error:new Error('Reply lost')}};
    return {data:{ok:true,key:'sps_schedule',actorId:'owner',operationId:request.operationId,beforeVersion,afterVersion:state.version,value:clone(state.value),complete:true}};
  };
  return {state,disk,storage,stateStore,send,options:{storage,stateStore,send}};
}

test('single Delete sends exact named deletion action while preserving independent remote work',async()=>{
  const h=harness(); h.state.value[1].stops.push({sid:'new',client:'New client'});
  const saved=await deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options);
  assert.equal(saved.ok,true);assert.equal(h.state.requests[0].action,'schedule-delete');
  assert.deepEqual(h.state.requests[0].deleteStopIds,['a']);
  assert.ok(h.state.requests[0].operations.every(op=>op.kind==='delete'));
  assert.deepEqual(h.state.value.flatMap(day=>day.stops.map(stop=>stop.sid)),['b','c','new']);assert.equal(h.disk.size,0);
});

test('bulk Delete removes only reviewed IDs and preserves unrelated pending display edits',async()=>{
  const h=harness();h.state.refreshPending=true;h.state.project=[{date:'10/30/2026',stops:[{...c,note:'Unsaved note'}]}];
  const saved=await deleteScheduledStops({schedule:base(),deleteStopIds:['b','a']},h.options);
  assert.deepEqual(h.state.requests[0].deleteStopIds,['a','b']);
  assert.deepEqual(saved.displaySchedule,h.state.project);assert.equal(saved.selected.length,2);
  assert.equal(h.state.value[0].stops[0].sid,'c');
});

test('failed removal retains original durable request and retries identical hashes',async()=>{
  const h=harness();h.state.fail=true;
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/Save unavailable/);
  const original=clone(h.state.requests[0]);assert.equal(h.disk.size,1);assert.deepEqual(h.state.value,base());
  h.state.fail=false;
  await deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options);
  assert.deepEqual(h.state.requests[1],original);assert.equal(h.disk.size,0);
});

test('lost response retries original removal without deleting unrelated later additions',async()=>{
  const h=harness();h.state.loseReply=true;
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/Reply lost/);
  h.state.value[0].stops.push({sid:'later',client:'Added after removal'});
  await deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options);
  assert.deepEqual(h.state.requests[1],h.state.requests[0]);
  assert.ok(h.state.value.flatMap(day=>day.stops).some(stop=>stop.sid==='later'));
});

test('a changed target requires actual review and a new explicit Delete before hashes advance',async()=>{
  const h=harness();h.state.value[0].stops[0]={...a,time:'10 AM'};
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/changed/);
  const first=clone(h.state.requests[0]);
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/Refresh the schedule/);
  assert.equal(h.state.requests.length,1);
  await deleteScheduledStops({schedule:clone(h.state.value),deleteStopIds:['a']},h.options);
  assert.notEqual(h.state.requests[1].operationId,first.operationId);
});

test('device storage failure prevents transmission and keeps stops',async()=>{
  const h=harness();h.storage.set=async()=>{};
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/could not be saved/);
  assert.equal(h.state.requests.length,0);assert.deepEqual(h.state.value,base());
});

test('account change during journal persistence cannot submit the old account removal',async()=>{
  const h=harness(), set=h.storage.set;h.storage.set=async(...args)=>{await set(...args);h.state.current=false};
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/account changed/);
  assert.equal(h.state.requests.length,0);assert.equal(h.disk.size,1);
});

test('malformed successful receipt cannot confirm deletion or remove original request',async()=>{
  const h=harness();h.options.send=async request=>({data:{ok:true,complete:true,key:'sps_schedule',actorId:'owner',operationId:request.operationId,beforeVersion:1,afterVersion:2,value:base()}});
  await assert.rejects(deleteScheduledStops({schedule:base(),deleteStopIds:['a']},h.options),/not confirmed/);
  assert.equal(h.disk.size,1);
});

test('Select all is limited to the displayed date and technician',()=>{
  assert.deepEqual(scheduleSelectionScope(base(),'10/29/2026','david')[0].stops,[a]);
  assert.deepEqual(scheduleSelectionScope(base(),'10/29/2026').flatMap(day=>day.stops),[a,b]);
  assert.throws(()=>scheduleDeletionSelection(base(),['missing']),/changed/);
  assert.throws(()=>scheduleDeletionSelection([{date:'10/29/2026',stops:[{...a,sourceEstimateId:'e'}]}],['a']),/approved estimate/);
});

test('single and bulk UI removal use the explicit awaited event path and keep selection on error',async()=>{
  const source=await readFile(new URL('../App.jsx',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf('  const removeReviewedStops ='),source.indexOf('  // Reschedule: move a stop',source.indexOf('  const removeReviewedStops =')));
  assert.match(handler,/await onDeleteStops/);assert.doesNotMatch(handler,/setSchedule\(/);
  assert.ok(handler.indexOf('await onDeleteStops')<handler.indexOf('writeTrackRecord'));
  const bulk=source.slice(source.indexOf('  const deleteSelected = async'),source.indexOf('  // Bulk-reassign',source.indexOf('  const deleteSelected = async')));
  assert.match(bulk,/if \(await removeReviewedStops\(ids\)\) exitSelect\(\)/);
  assert.match(bulk,/if \(!confirm/);assert.doesNotMatch(bulk,/setSchedule\(/);
  assert.match(source,/const selectableDays = scheduleSelectionScope\(schedule, selectedDate, viewTech, team \|\| \[\]\)/);
});

async function scheduleRemovalEvents(overrides={}) {
  const source=await readFile(new URL('../App.jsx',import.meta.url),'utf8');
  const single=source.slice(source.indexOf('  const removeReviewedStops ='),source.indexOf('  // Reschedule: move a stop',source.indexOf('  const removeReviewedStops =')));
  const bulk=source.slice(source.indexOf('  const deleteSelected = async'),source.indexOf('  // Bulk-reassign',source.indexOf('  const deleteSelected = async')));
  const observed={closed:0,tracked:0,alerts:[],requests:[],busy:[]};
  const context={schedule:base(),scheduleDeletionSelection,deletingStopsRef:{current:false},setDeletingStops:value=>observed.busy.push(value),
    onDeleteStops:async request=>{observed.requests.push(request);return {ok:true,selected:[{stop:{...a,trackToken:'safe-token'}}]}},
    writeTrackRecord:()=>{observed.tracked++},window:{alert:message=>observed.alerts.push(message)},
    allStops:['a','b'],selected:{a:true,b:true},selectableDays:[base()[0]],confirm:()=>true,exitSelect:()=>{observed.closed++},...overrides};
  const events=new Function('context',`const {schedule,scheduleDeletionSelection,deletingStopsRef,setDeletingStops,onDeleteStops,writeTrackRecord,window,allStops,selected,selectableDays,confirm,exitSelect}=context; ${single} ${bulk} return {deleteStop,deleteSelected};`)(context);
  return {events,observed};
}

test('actual single Delete event waits for receipt before changing tracking state',async()=>{
  let release;
  const response=new Promise(resolve=>{release=resolve});
  const h=await scheduleRemovalEvents({onDeleteStops:()=>response});
  const pending=h.events.deleteStop('10/29/2026','a');
  assert.equal(h.observed.tracked,0);assert.deepEqual(h.observed.busy,[true]);
  release({ok:true,selected:[{stop:{...a,trackToken:'safe-token'}}]});
  assert.equal(await pending,true);assert.equal(h.observed.tracked,1);assert.deepEqual(h.observed.busy,[true,false]);
});

test('actual bulk Delete failure keeps selection and tracking while cancellation never transmits',async()=>{
  const failed=await scheduleRemovalEvents({onDeleteStops:async()=>{throw new Error('Server unavailable')}});
  await failed.events.deleteSelected();
  assert.equal(failed.observed.closed,0);assert.equal(failed.observed.tracked,0);assert.equal(failed.observed.alerts[0],'Server unavailable');
  const cancelled=await scheduleRemovalEvents({confirm:()=>false});
  await cancelled.events.deleteSelected();
  assert.equal(cancelled.observed.requests.length,0);assert.equal(cancelled.observed.closed,0);
});

test('Unassigned selection includes orphaned staff IDs but excludes assigned routes and other dates',async()=>{
  const missing={sid:'missing',client:'No assignment'}, orphan={sid:'orphan',client:'Former staff',assigneeId:'former-staff'};
  const source=[{date:'10/29/2026',stops:[a,b,missing,orphan]},{date:'10/30/2026',stops:[{sid:'other-day',assigneeId:'former-staff'}]}];
  const scoped=scheduleSelectionScope(source,'10/29/2026','__un',[{id:'david'},{id:'josh'}]);
  assert.deepEqual(scoped.flatMap(day=>day.stops.map(stop=>stop.sid)),['missing','orphan']);
  const h=harness();h.state.value=clone(source);
  await deleteScheduledStops({schedule:source,deleteStopIds:scoped.flatMap(day=>day.stops.map(stop=>stop.sid))},h.options);
  assert.deepEqual(h.state.value.flatMap(day=>day.stops.map(stop=>stop.sid)),['a','b','other-day']);
});
