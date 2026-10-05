import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const app = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
const marker = '  const performReviewAction = ';
const start = app.indexOf(marker) + marker.length;
const end = app.indexOf('\n\n  // Save a confirmed SPS checkpoint', start);
const source = app.slice(start, end).trim().replace(/;$/, '');
const original = {id:'review-1',number:'',status:'Review',reviewState:'pending',reviewRevision:4,clientId:'sample',lineItems:[{id:'a',desc:'Completed repair',qty:1,unitPrice:250}]};
function harness(extra = {}) {
 const state = {inv:structuredClone(original), busy:'',message:'',error:false,closed:0,saved:0,confirmed:0,discarded:0};
 const deps={
  inv:state.inv,reviewBusyRef:{current:false},reviewLocked:false,reviewNumberMode:"automatic",reviewInvoiceNumber:"",
  selectedClientSnapshot:()=>state.inv,
  setReviewBusy:value=>state.busy=value,setReviewMessage:value=>state.message=value,setReviewError:value=>state.error=value,setInv:value=>state.inv=value,
  onSaveReview:async value=>{state.saved++;return {ok:true,review:{...value,reviewRevision:value.reviewRevision+1}};},
  onConfirmReview:async value=>{state.confirmed++;assert.equal(value.reviewRevision,5);return {ok:true,invoice:{id:value.id,number:'INV-1003',qbId:'qb-sample'}};},
  onDiscardReview:async ()=>{state.discarded++;return {ok:true};},onClose:()=>state.closed++, ...extra,
 };
 return {state,deps,action:new Function(...Object.keys(deps),`return (${source});`)(...Object.values(deps))};
}
test('review confirmation saves current edits first and never opens client delivery',async()=>{
 const {state,action}=harness();await action('confirm');assert.equal(state.saved,1);assert.equal(state.confirmed,1);assert.equal(state.closed,1);assert.equal(state.error,false);
});
test('save and discard reviews never enter the confirmation callback',async()=>{
 const save=harness();await save.action('save');assert.equal(save.state.saved,1);assert.equal(save.state.confirmed,0);assert.equal(save.state.closed,0);assert.equal(save.state.inv.number,'');
 const discard=harness();await discard.action('discard');assert.equal(discard.state.saved,0);assert.equal(discard.state.confirmed,0);assert.equal(discard.state.discarded,1);assert.equal(discard.state.closed,1);
});
test('failed review save cannot trigger QuickBooks confirmation',async()=>{
 const {state,action}=harness({onSaveReview:async()=>{throw new Error('Revision changed');}});await action('confirm');assert.equal(state.confirmed,0);assert.equal(state.error,true);assert.equal(state.inv.reviewState,'pending');assert.equal(state.closed,0);
});
test('a rapid second click cannot start another save or confirmation',async()=>{
 let release;let saves=0;const gate=new Promise(resolve=>release=resolve);
 const {state,action}=harness({onSaveReview:async value=>{saves++;await gate;return {review:{...value,reviewRevision:5}};}});
 const first=action('confirm');await action('confirm');assert.equal(saves,1);release();await first;assert.equal(state.confirmed,1);
});
test('unknown confirmation outcome locks editing until the same attempt is checked',async()=>{
 const {state,action}=harness({onConfirmReview:async()=>{throw new Error('Connection lost');}});await action('confirm');assert.equal(state.inv.reviewState,'approving');assert.equal(state.closed,0);assert.equal(state.error,true);
});
test('retry skips edit save and keeps the server pending approval intact',async()=>{
 const frozen={...original,reviewState:'approving',approval:{number:'INV-1003'}};
 const {state,action}=harness({inv:frozen,reviewLocked:true,onConfirmReview:async(value,options)=>{assert.equal(options.retry,true);assert.equal(value.approval.number,'INV-1003');return {pending:true,review:frozen,error:'Still checking'};}});
 await action('confirm');assert.equal(state.saved,0);assert.equal(state.closed,0);assert.equal(state.inv,frozen);assert.match(state.message,/Still checking/);
});
test('server rejection with canonical review restores editable pending state',async()=>{
 const {state,action}=harness({onConfirmReview:async()=>{throw Object.assign(new Error('Fix the service month'),{data:{review:original}});}});
 await action('confirm');assert.equal(state.inv.reviewState,'pending');assert.equal(state.error,true);
});

test('typed and selected numbers are preferences passed only after the review save is confirmed', async () => {
 for (const reviewNumberMode of ['custom', 'available']) {
  const calls=[];
  const {state,action}=harness({reviewNumberMode,reviewInvoiceNumber:'  SPS-2041  ',
   onSaveReview:async value=>{calls.push(['save',structuredClone(value)]);return {ok:true,review:{...value,reviewRevision:5}};},
   onConfirmReview:async (value,options)=>{calls.push(['confirm',structuredClone(value),options]);return {ok:true,invoice:{qbId:'qb-2041',number:'SPS-2041'}};},
  });
  await action('confirm');
  assert.equal(calls[0][0],'save');assert.equal(calls[0][1].number,'');assert.equal(calls[0][1].invoiceNumber,undefined);
  assert.equal(calls[1][1].number,'');assert.equal(calls[1][1].reviewRevision,5);
  assert.deepEqual(calls[1][2],{retry:false,invoiceNumber:'SPS-2041'});assert.equal(state.closed,1);
 }
});
test('Automatic uses server numbering and never sends a stale local preference', async () => {
 let options;
 const {action}=harness({reviewNumberMode:'automatic',reviewInvoiceNumber:'SPS-OLD',onConfirmReview:async(_value,selected)=>{options=selected;return {invoice:{qbId:'qb-auto'}};}});
 await action('confirm');assert.deepEqual(options,{retry:false});
});
test('save and discard do not assign or send a locally chosen number', async () => {
 for (const actionName of ['save','discard']) {
  const {state,action}=harness({reviewNumberMode:'custom',reviewInvoiceNumber:'SPS-2041'});
  await action(actionName);assert.equal(state.inv.number,'');assert.equal(state.confirmed,0);
 }
});
test('empty custom or available choice cannot save or confirm an invoice', async () => {
 for (const reviewNumberMode of ['custom','available']) {
  const {state,action}=harness({reviewNumberMode,reviewInvoiceNumber:'  '});await action('confirm');
  assert.equal(state.saved,0);assert.equal(state.confirmed,0);assert.equal(state.error,true);assert.match(state.message,/Automatic/);
 }
});
test('unknown approval retry ignores local number choices and keeps its frozen invoice number', async () => {
 const frozen={...original,reviewState:'approving',approval:{state:'unknown',number:'INV-1003'}};
 let options;
 const {state,action}=harness({inv:frozen,reviewLocked:true,reviewNumberMode:'custom',reviewInvoiceNumber:'SPS-9999',onConfirmReview:async(value,selected)=>{options=selected;assert.equal(value.approval.number,'INV-1003');return {pending:true,review:frozen};}});
 await action('confirm');assert.deepEqual(options,{retry:true});assert.equal(state.saved,0);
});
test('available number lookup only reads suggestions and never assigns the review number', async () => {
 const marker='  const loadReviewInvoiceNumbers = ';
 const start=app.indexOf(marker)+marker.length;
 const end=app.indexOf('\n  const clearSaveError =',start);
 const source=app.slice(start,end).trim().replace(/;$/,'');
 const state={loading:false,numbers:[],next:'',error:''};let loads=0;
 const deps={reviewLocked:false,reviewBusyRef:{current:false},reviewNumbersLoading:false,
  onLoadInvoiceNumbers:async()=>{loads++;return {nextNumber:'INV-1004',availableNumbers:['INV-1004','INV-1005','INV-1004']};},
  setReviewNumbersLoading:value=>state.loading=value,setReviewNumbersError:value=>state.error=value,
  setReviewAvailableNumbers:value=>state.numbers=value,setReviewNextNumber:value=>state.next=value,
 };
 const load=new Function(...Object.keys(deps),`return (${source});`)(...Object.values(deps));await load();
 assert.equal(loads,1);assert.deepEqual(state.numbers,['INV-1004','INV-1005']);assert.equal(state.next,'INV-1004');assert.equal(state.loading,false);
 assert.equal(original.number,'');assert.doesNotMatch(source,/setInv|onSaveReview|onConfirmReview|onDiscardReview/);
});
test('review numbering controls keep Automatic default and separate local choices from invoice fields', () => {
 assert.match(app,/\[reviewNumberMode, setReviewNumberMode\] = useState\("automatic"\)/);
 const numberUi=app.slice(app.indexOf('{billingReview && <div data-billing-review-number>'),app.indexOf('{needsCoverageCheck && !String(coverageIssue'));
 assert.match(numberUi,/>Enter a number</);assert.match(numberUi,/>Choose an available number</);assert.match(numberUi,/maxLength=\{21\}/);
 assert.match(numberUi,/inv\.approval\?\.number/);assert.match(numberUi,/readOnly disabled/);
 assert.doesNotMatch(numberUi,/set\("number"|setInv\(/);
 assert.equal((app.match(/onLoadInvoiceNumbers=\{\(\) => requestBillingReview\(\{ action: "available-numbers" \}\)\}/g)||[]).length,2);
});
