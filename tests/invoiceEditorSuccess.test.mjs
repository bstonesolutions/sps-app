import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { invoiceSpsMetadata, mergeInvoiceSpsMetadataResult } from "../invoiceMetadata.js";
import { stableInvoiceReviewJSON } from "../invoiceReviewIdentity.js";

const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const editorStart = app.indexOf("function InvoiceEditor");
const finishStart = app.indexOf("  const finishSave = ", editorStart) + "  const finishSave = ".length;
const finishEnd = app.indexOf("\n\n  // QuickBooks errors", finishStart);
assert.ok(editorStart >= 0 && finishStart > editorStart && finishEnd > finishStart);
const finishSource = app.slice(finishStart, finishEnd).trim().replace(/;$/, "");
const sendBranch = app.slice(finishEnd).match(/if \(([^\n]+)\) return <InvoiceSendStep invoice=\{sendStep\}/);
assert.ok(sendBranch, "the real editor must expose its post-save notification step");
const showsSendStep = new Function("sendStep", "sendClient", "coverageIssue", "billingReview = false", `return Boolean(${sendBranch[1]});`);

const draft = { id: "sample-invoice", clientId: "sample-client", number: "SAMPLE-1", status: "Sent", lineItems: [{ id: "service", desc: "Monthly service", serviceMonth: "2026-08", qty: 1, unitPrice: 350 }] };
const synced = { ...draft, qbId: "sample-qb", qbSyncStatus: "synced", qbAuthoritative: true, total: 350, balance: 350,
  lineItems: [{ ...draft.lineItems[0], desc: "Monthly service - August 2026", qbLineId: "1" }] };

function finishHarness(overrides = {}) {
  const state = { inv: draft, persisted: false, qbState: "sending", qbMsg: "Previous attempt failed", coverageError: "Previous coverage check failed", sendStep: null, saved: [], closed: 0, requests: 0 };
  const deps = {
    client: { id: draft.clientId, name: "Sample client" },
    progressBaselineRef: { current: JSON.stringify(draft) },
    pendingSpsSaveRef: { current: null },
    pendingSpsReceiptRef: { current: null },
    pendingQuickBooksWriteRef: { current: null },
    store: {captureIdentity: () => ({uid:"owner",generation:1}), isCurrentIdentity: identity => identity?.uid === "owner" && identity?.generation === 1},
    invoiceSpsMetadata, mergeInvoiceSpsMetadataResult, stableInvoiceReviewJSON,
    saveQuickBooksRecovery: () => true, clearQuickBooksRecovery: () => {},
    QB_API: "/api/quickbooks", authHeaders: async () => ({}),
    setSpsSavePending: value => { state.spsSavePending = value; },
    onSave: async invoice => { state.saved.push(invoice); return invoice; },
    setInv: invoice => { state.inv = invoice; },
    setIsPersisted: value => { state.persisted = value; },
    setQbState: value => { state.qbState = value; },
    setQbMsg: value => { state.qbMsg = value; },
    setCoverageError: value => { state.coverageError = value; },
    setSendStep: invoice => { state.sendStep = invoice; },
    onClose: () => { state.closed++; },
    fetch: () => { state.requests++; throw new Error("Completion must not send any request"); },
    ...overrides,
  };
  return { state, deps, finish: new Function(...Object.keys(deps), `return (${finishSource});`)(...Object.values(deps)) };
}

test("a successful QB save adopts normalized lines and exits sending despite a stale coverage warning", async () => {
  const { state, deps, finish } = finishHarness();
  await finish(synced);
  assert.deepEqual(state.saved, [synced]);
  assert.equal(state.inv, synced, "the editor must retain the returned QB id and normalized accounting content");
  assert.equal(state.persisted, true);
  assert.equal(state.qbState, "done");
  assert.equal(state.qbMsg, "");
  assert.equal(state.coverageError, "");
  assert.equal(state.sendStep, synced);
  assert.equal(showsSendStep(state.sendStep, deps.client, { code: "maintenance-coverage-review" }), true,
    "an old advisory must not hide completion after QB has already accepted this invoice");
  assert.equal(state.requests, 0, "showing optional delivery controls must not notify a client");
  assert.equal(state.closed, 0);
});

test("a local save with no invoice lines exits the busy editor without a notification step", async () => {
  const { state, finish } = finishHarness();
  await finish({ ...draft, lineItems: [] });
  assert.equal(state.qbState, "done");
  assert.equal(state.sendStep, null);
  assert.equal(state.closed, 1);
  assert.equal(state.requests, 0);
  assert.equal(showsSendStep(null, { id: draft.clientId }, null), false);
});

test("a failed SPS save retains the confirmed QuickBooks identity without exposing delivery controls", async () => {
  const { state, finish } = finishHarness({ onSave: () => { throw new Error("Save rejected"); } });
  const result = await finish(synced);
  assert.equal(result.ok, false);
  assert.equal(state.inv, synced);
  assert.match(state.qbMsg, /QuickBooks saved this invoice/);
  assert.match(state.qbMsg, /Save rejected/);
  assert.equal(state.sendStep, null);
  assert.equal(state.persisted, false);
  assert.equal(state.closed, 0);
  assert.equal(state.requests, 0);
});

test("a current maintenance preflight rejection still prevents QB creation and the success step", async () => {
  const saveStart = app.indexOf("  const save = async () => {", editorStart) + "  const save = ".length;
  const saveEnd = app.indexOf("\n\n  const field =", saveStart);
  assert.ok(saveStart > editorStart && saveEnd > saveStart);
  const saveSource = app.slice(saveStart, saveEnd).trim().replace(/;$/, "");
  const state = { qbState: "idle", qbMsg: "", finishes: 0, requests: 0 };
  const deps = {
    invoiceSaveBusyRef: { current: false },
    store: {captureIdentity: () => ({uid:"owner",generation:1})},
    pendingSpsSaveRef: { current: null },
    pendingSpsReceiptRef: { current: null },
    progressState: "idle", qbState: "idle", selectedClientSnapshot: () => draft,
    editRevisionRef: { current: 0 }, needsCoverageCheck: true,
    setQbState: value => { state.qbState = value; }, setQbMsg: value => { state.qbMsg = value; },
    loadInvoiceCoverage: async () => ({ version: 2, policies: {}, allocations: {} }),
    withMatchedMaintenanceServiceMonths: ({ invoice }) => invoice,
    invoiceMaintenanceCoverageIssue: () => ({ code: "maintenance-coverage-review", message: "Review the current month first." }),
    client: { id: draft.clientId }, clients: [], invoices: [draft], schedule: [],
    finishSave: () => { state.finishes++; },
    fetch: () => { state.requests++; throw new Error("A blocked invoice must not reach QB"); },
  };
  await new Function(...Object.keys(deps), `return (${saveSource});`)(...Object.values(deps))();
  assert.equal(state.qbState, "error");
  assert.match(state.qbMsg, /Review the current month first/);
  assert.equal(state.finishes, 0);
  assert.equal(state.requests, 0);
});

test("invoice success waits for the SPS receipt and passes the editor's original baseline", async () => {
  let finishReceipt;
  let request;
  const { state, finish } = finishHarness({ onSave: async (invoice, options) => {
    request = { invoice, options };
    return new Promise(resolve => { finishReceipt = resolve; });
  } });
  const pending = finish(synced);
  assert.equal(state.inv.qbId, synced.qbId);
  assert.equal(state.persisted, false);
  assert.equal(state.sendStep, null);
  assert.equal(state.qbState, "sending");
  assert.deepEqual(request, { invoice: synced, options: { confirmedSave: true, invoiceRefresh: null, baselineJson: JSON.stringify(draft) } });
  finishReceipt(synced);
  assert.equal((await pending).ok, true);
  assert.equal(state.persisted, true);
  assert.equal(state.sendStep, synced);
});

test("a rejected or missing asynchronous SPS receipt cannot mark the invoice saved", async () => {
  for (const receipt of [undefined, { ok: false, queued: true }, { id: "different-invoice" }]) {
    const { state, finish } = finishHarness({ onSave: async () => receipt });
    const result = await finish(draft);
    assert.equal(result.ok, false);
    assert.equal(state.persisted, false);
    assert.equal(state.sendStep, null);
    assert.equal(state.closed, 0);
    assert.equal(state.qbState, "error");
  }
});

test("Retry Save after either local save failure or QuickBooks success retries only the frozen SPS checkpoint", async () => {
  const saveStart = app.indexOf("  const save = async () => {", editorStart) + "  const save = ".length;
  const saveEnd = app.indexOf("\n\n  const field =", saveStart);
  const saveSource = app.slice(saveStart, saveEnd).trim().replace(/;$/, "");
  for (const checkpoint of [synced, draft]) {
  const pendingSpsSaveRef = { current: checkpoint };
  const checkpoints = [];
  const dependencies = {
    invoiceSaveBusyRef: { current: false }, store: {captureIdentity: () => ({uid:"owner",generation:1})}, pendingSpsSaveRef, progressState: "idle", qbState: "error",
    selectedClientSnapshot() { assert.fail("Keep the confirmed accounting snapshot"); },
    setQbState() {}, setQbMsg() {},
    finishSave: async invoice => { checkpoints.push(invoice); },
    fetch() { assert.fail("Retrying an SPS save must not call QuickBooks again"); },
  };
  await new Function(...Object.keys(dependencies), `return (${saveSource});`)(...Object.values(dependencies))();
  assert.deepEqual(checkpoints, [checkpoint]);
  assert.equal(dependencies.invoiceSaveBusyRef.current, false);
  }
});

const saveIdentity = {uid:"owner",generation:1};
const refreshed = invoice => ({ok:true, actorId:"owner", key:"sps_invoices", complete:true, beforeVersion:3,afterVersion:4,invoices:[invoice]});

test("QB success without an SPS receipt freezes its identity and retries only GET sync", async () => {
  const calls = []; let available = false;
  const canonical = {...synced, id:"qb_sample-qb"};
  const {state,deps,finish} = finishHarness({
    fetch: async (url,options) => { calls.push([url,options.method]); return {ok:available,json:async()=>available ? {invoiceRefresh:refreshed(canonical)} : {error:"SPS unavailable"}}; },
    onSave: async (invoice,options) => { assert.ok(options.invoiceRefresh); state.saved.push(invoice); return invoice; },
  });
  assert.equal((await finish(synced,null,{confirmed:true,identity:saveIdentity})).ok,false);
  assert.equal(state.saved.length,0,"no generic ledger save may follow a known QB success");
  assert.equal(state.inv.qbId,synced.qbId);
  assert.equal(state.spsSavePending,true);
  assert.equal(state.sendStep,null);
  available = true;
  assert.equal((await finish(deps.pendingSpsSaveRef.current)).ok,true);
  assert.deepEqual(calls,[["/api/quickbooks/sync","GET"],["/api/quickbooks/sync","GET"]]);
  assert.equal(state.inv.id,canonical.id,"follow the unique imported identity rather than duplicate it");
  assert.equal(state.spsSavePending,false);
  assert.equal(deps.pendingQuickBooksWriteRef.current,null);
});

test("known QB success with a receipt never performs a second accounting request", async () => {
  const receipt=refreshed(synced);
  const {state,finish}=finishHarness({onSave: async (invoice,options)=>{assert.equal(options.invoiceRefresh,receipt);return invoice;}});
  assert.equal((await finish(synced,receipt,{confirmed:true,identity:saveIdentity})).ok,true);
  assert.equal(state.requests,0);
  assert.equal(state.inv,synced);
});

test("missing receipt recovery preserves notes and line cost using only an SPS checkpoint", async () => {
  const canonical={...synced, notes:"Old note"};
  const edited={...synced, notes:"Work completed at the pond",lineItems:synced.lineItems.map(line=>({...line,unitCost:25,costKnown:true}))};
  const writes=[];
  const {state,finish}=finishHarness({
    progressBaselineRef:{current:JSON.stringify({...draft,notes:"Old note"})},
    fetch:async(url,options)=>{assert.equal(options.method,"GET");return {ok:true,json:async()=>({invoiceRefresh:refreshed(canonical)})};},
    onSave:async()=>canonical,
    onPersistProgress:async(invoice,options)=>{writes.push([invoice,options]);return invoice;},
  });
  assert.equal((await finish(edited,null,{confirmed:true,identity:saveIdentity})).ok,true);
  assert.equal(writes.length,1);
  assert.equal(writes[0][0].notes,edited.notes);
  assert.equal(writes[0][0].lineItems[0].unitCost,25);
  assert.equal(writes[0][0].total,canonical.total);
  assert.equal(writes[0][1].baselineJson,JSON.stringify(canonical));
  assert.equal(state.inv.notes,edited.notes);
});

test("missing receipt recovery cannot adopt a different account or ambiguous QB identity", async () => {
  for(const kind of ["account","duplicate","missing"]) {
    const canonical=kind==="duplicate"?[synced,{...synced,id:"alias"}]:[];
    const {state,finish}=finishHarness({
      fetch:async()=>({ok:true,json:async()=>({invoiceRefresh:{...refreshed(synced),invoices:canonical}})}),
      ...(kind==="account"?{store:{isCurrentIdentity:()=>false}}:{}),
    });
    assert.equal((await finish(synced,null,{confirmed:true,identity:saveIdentity})).ok,false);
    assert.equal(state.saved.length,0);
    assert.equal(state.sendStep,null);
  }
});

test("a remaining saved proposal stays in review after QB confirmation", async () => {
  const canonical={...synced,qbWriteReview:{candidateId:"12",reason:"unconfirmed-accounting-change"}};
  const {state,finish}=finishHarness({onSave:async()=>canonical});
  const result=await finish(synced,refreshed(canonical),{confirmed:true,identity:saveIdentity});
  assert.equal(result.reviewRequired,true);
  assert.equal(state.sendStep,null);
  assert.equal(state.closed,0);
  assert.equal(state.inv.qbWriteReview.candidateId,"12");
  assert.match(state.qbMsg,/separate saved SPS change/);
});

test("a confirmed accounting recovery remains journaled until its SPS save is verified", async () => {
  let journal=null; let clears=0;
  const {deps,finish}=finishHarness({
    saveQuickBooksRecovery:value=>{journal=structuredClone(value);return true;},
    clearQuickBooksRecovery:()=>{clears++;},
    fetch:async()=>({ok:false,json:async()=>({error:"Offline"})}),
  });
  assert.equal((await finish(synced,null,{confirmed:true,identity:saveIdentity})).ok,false);
  assert.equal(journal.invoice.qbId,synced.qbId);
  assert.equal(journal.baselineJson,JSON.stringify(draft));
  assert.equal(clears,0);
  assert.equal(deps.pendingQuickBooksWriteRef.current.durable,true);
});

test("a recovery journal failure tells the owner to keep the editor open", async () => {
  const {state,finish}=finishHarness({saveQuickBooksRecovery:()=>false,fetch:async()=>{throw new Error("Offline");}});
  await finish(synced,null,{confirmed:true,identity:saveIdentity});
  assert.match(state.qbMsg,/Keep this editor open/);
  assert.equal(state.sendStep,null);
});

test("reopening a recovered imported invoice finds only its own account's exact QB journal", () => {
  const start=app.indexOf("  useEffect(() => {",app.indexOf("  const clearQuickBooksRecovery =",editorStart));
  const end=app.indexOf("  const loadReviewInvoiceNumbers",start);
  const effect=app.slice(start,end);
  const ownKey="sps_invoice_editor_qb_recovery:owner:new:all";
  const records=new Map([[ownKey,JSON.stringify({uid:"owner",invoice:synced,baselineJson:JSON.stringify(draft)})],
    ["sps_invoice_editor_qb_recovery:other:new:all",JSON.stringify({uid:"other",invoice:{...synced,notes:"other account"}})]]);
  const storage={get length(){return records.size;},key:index=>[...records.keys()][index],getItem:key=>records.get(key)||null};
  const state={};
  const deps={billingReview:false,invoice:{...synced,id:"qb_sample-qb"},store:{captureIdentity:()=>saveIdentity},
    quickBooksRecoveryKeyRef:{current:"sps_invoice_editor_qb_recovery:owner:qb_sample-qb"},localStorage:storage,
    pendingQuickBooksWriteRef:{current:null},pendingSpsSaveRef:{current:null},useEffect:fn=>fn(),
    setInv:value=>{state.inv=value;},setSpsSavePending:value=>{state.pending=value;},setQbState(){},setQbMsg(){}};
  new Function(...Object.keys(deps),effect)(...Object.values(deps));
  assert.equal(deps.quickBooksRecoveryKeyRef.current,ownKey);
  assert.equal(deps.pendingQuickBooksWriteRef.current.needsRefresh,true);
  assert.deepEqual(state.inv,synced);
  assert.equal(state.pending,true);
  records.delete(ownKey);state.inv=null;
  deps.quickBooksRecoveryKeyRef.current="sps_invoice_editor_qb_recovery:owner:qb_sample-qb";
  new Function(...Object.keys(deps),effect)(...Object.values(deps));
  assert.equal(state.inv,null,"another account's journal is never restored");
});
