import test from "node:test";
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
const { compareAndSetSharedStatePatch, compareAndSetSharedStatePatchBatch, mutateSharedStatePatch } = await import("../api/_shared-state-patch.js");
const reply = value => ({ ok: true, status: 200, json: async () => value });
const before = [{ id: "c1", name: "Before" }], after = [{ id: "c1", name: "After" }];

test("single protected CAS sends exact current and retains legacy stored representation", async () => {
  const result = await compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async (url, options) => {
    assert.equal(url, "https://supabase.test/rest/v1/rpc/sps_shared_state_patch_cas");
    assert.equal(options.headers.Authorization, "Bearer test-service");
    assert.deepEqual(JSON.parse(options.body), { p_key: "sps_clients", p_expected_version: 7, p_expected_current: before, p_proposed: JSON.stringify(after), p_actor_id: "actor" });
    return reply([{ applied: true, outcome: "updated", current_version: 8, value: JSON.stringify(after) }]);
  } });
  assert.deepEqual(result.value, after); assert.equal(result.currentVersion, 8);
});

test("a malformed successful RPC cannot be treated as a saved canonical snapshot", async () => {
  for (const response of [{ applied: true, current_version: 8 }, { applied: true, current_version: 6, value: after }, { nonsense: true }]) {
    await assert.rejects(compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async () => reply(response) }), { code: "SHARED_STATE_PATCH_RECEIPT_INVALID" });
  }
});

test("protected report and deleted-identity refusals are actionable conflicts rather than retries forever", async () => {
  for (const [message, code] of [["shared_deleted_identity_reused", "SHARED_STATE_DELETED_IDENTITY"], ["shared_state_protected_change_rejected", "SHARED_STATE_PATCH_PROTECTED_CHANGE"]]) {
    await assert.rejects(compareAndSetSharedStatePatch("sps_clients", 7, before, after, { actorId: "actor", fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message }) }) }), { code, status: 409 });
  }
});

test("service transaction retains exact protected scope and the other atomic operations", async () => {
  const schedule = [{ date: "10/22/2026", stops: [{ sid: "s1", linkedBillingReviewId: "review" }] }];
  const next = [{ date: "10/22/2026", stops: [{ sid: "s1", linkedInvoiceId: "invoice" }] }];
  const operations = [{ key: "sps_schedule", expectedVersion: 2, value: next }, { key: "sps_invoices", expectedVersion: 9, value: [] }];
  const result = await compareAndSetSharedStatePatchBatch(operations, { actorId: "actor", expectedCurrent: { sps_schedule: schedule }, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith("/sps_shared_state_patch_batch_cas"));
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.p_expected_current, { sps_schedule: schedule });
    assert.deepEqual(payload.p_operations, [{ key: "sps_schedule", expected_version: 2, value: JSON.stringify(next) }, { key: "sps_invoices", expected_version: 9, value: "[]" }]);
    return reply([{ applied: true, outcome: "applied", current_versions: { sps_schedule: 3, sps_invoices: 10 }, values: { sps_schedule: JSON.stringify(next), sps_invoices: "[]" } }]);
  } });
  assert.deepEqual(result.values.sps_schedule, next);
  assert.equal(result.currentVersions.sps_invoices, 10);
});

test("batch scope cannot omit or add a protected baseline", async () => {
  const operations = [{ key: "sps_clients", expectedVersion: 7, value: after }, { key: "sps_officeAlerts", expectedVersion: 1, value: [] }];
  for (const expectedCurrent of [{}, { sps_clients: before, sps_schedule: [] }]) {
    await assert.rejects(compareAndSetSharedStatePatchBatch(operations, { actorId: "actor", expectedCurrent, fetchImpl: () => { throw new Error("must not call"); } }), { code: "SHARED_STATE_PATCH_SCOPE_INVALID" });
  }
});

test("a narrow portal mutation rechecks ownership inside updater on each CAS retry", async () => {
  let count = 0;
  const result = await mutateSharedStatePatch("sps_clients", (current) => current.map(client => ({ ...client, notifyPrefs: { onMyWay: true } })), {
    actorId: "portal-user", read: async () => ({ exists: true, version: ++count, value: [{ id: "c1", name: count === 1 ? "Before" : "Newer name" }] }),
    cas: async (_key, version, original, proposed, options) => {
      assert.equal(options.actorId, "portal-user");
      if (version === 1) return { applied: false, outcome: "conflict" };
      assert.equal(original[0].name, "Newer name");
      return { applied: true, currentVersion: 3, value: proposed };
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.value[0].name, "Newer name");
  assert.deepEqual(result.value[0].notifyPrefs, { onMyWay: true });
});

test('rejected-save telemetry identifies its section without leaking private records or database details', async () => {
  const events = [], original = console.error;
  console.error = (...args) => events.push(args);
  try {
    await assert.rejects(compareAndSetSharedStatePatch('sps_clients', 7,
      [{ id: 'private-client', name: 'PRIVATE NAME' }], [{ id: 'private-client', name: 'PRIVATE CHANGE' }], {
        actorId: 'PRIVATE ACTOR', fetchImpl: async () => ({ ok: false, status: 500,
          json: async () => ({ code: '40001', message: 'shared_state_protected_change_rejected', details: 'PRIVATE SQL CONTENT' }) }),
      }), { code: 'SHARED_STATE_PATCH_PROTECTED_CHANGE', status: 409 });
  } finally { console.error = original; }
  assert.equal(events.length, 1);
  const telemetry = JSON.parse(events[0][1]);
  assert.deepEqual(telemetry.keys, ['sps_clients']); assert.equal(telemetry.databaseCode, '40001');
  assert.equal(telemetry.databaseReason, 'shared_state_protected_change_rejected');
  assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.ok(!JSON.stringify(events).includes('test-service'));
});

test('exact protected rejections are briefly cached without sharing actors versions or changes', async () => {
  let clock=1000,calls=0;
  const options={actorId:'cache-owner',now:()=>clock,fetchImpl:async()=>{calls++;return{ok:false,status:500,json:async()=>({code:'40001',message:'shared_state_protected_change_rejected'})};}};
  const save=(version=7,extra={},proposed=after)=>compareAndSetSharedStatePatch('sps_clients',version,before,proposed,{...options,...extra});
  await assert.rejects(save(),{code:'SHARED_STATE_PATCH_PROTECTED_CHANGE'});
  await assert.rejects(save(),{code:'SHARED_STATE_PATCH_PROTECTED_CHANGE'});assert.equal(calls,1);
  await assert.rejects(save(8));assert.equal(calls,2,'fresh version gets a fresh database decision');
  await assert.rejects(save(7,{actorId:'another-cache-owner'}));assert.equal(calls,3,'another actor never inherits the cache');
  await assert.rejects(save(7,{},[{id:'c1',name:'Different proposal'}]));assert.equal(calls,4);
  clock=11001;await assert.rejects(save());assert.equal(calls,5,'the unchanged request is retried after ten seconds');
});

test('transient unknown and authentication errors and success receipts are never negatively cached', async () => {
  for(const [status,payload] of [[500,{code:'57014',message:'timeout'}],[503,{code:'40001',message:'shared_state_protected_change_rejected'}],[401,{code:'40001',message:'shared_state_protected_change_rejected'}],[500,{code:'XX000',message:'unknown'}]]){
    let calls=0;const options={actorId:`no-cache-${status}-${payload.code}`,fetchImpl:async()=>{calls++;return{ok:false,status,json:async()=>payload};}};
    await assert.rejects(compareAndSetSharedStatePatch('sps_clients',7,before,after,options));
    await assert.rejects(compareAndSetSharedStatePatch('sps_clients',7,before,after,options));assert.equal(calls,2);
  }
  let calls=0;const options={actorId:'no-cache-success',fetchImpl:async()=>{calls++;return reply({applied:true,current_version:8,value:after});}};
  await compareAndSetSharedStatePatch('sps_clients',7,before,after,options);await compareAndSetSharedStatePatch('sps_clients',7,before,after,options);assert.equal(calls,2);
});

test('negative cache retains at most 128 exact request hashes', async()=>{
  let calls=0;const options={actorId:'bounded-cache-owner',now:()=>20000,fetchImpl:async()=>{calls++;return{ok:false,status:409,json:async()=>({code:'40001',message:'shared_deleted_identity_reused'})};}};
  const original=console.error;console.error=()=>{};
  try{
    for(let version=1;version<=129;version++)await assert.rejects(compareAndSetSharedStatePatch('sps_clients',version,before,after,options));
    assert.equal(calls,129);await assert.rejects(compareAndSetSharedStatePatch('sps_clients',1,before,after,options));assert.equal(calls,130);
  }finally{console.error=original;}
});


test('PT409 business rejection returns once and exact retries reuse its bounded cache', async()=>{
  for(const reason of ['shared_state_protected_change_rejected','shared_deleted_identity_reused']){
    let calls=0;const options={actorId:`pt409-${reason}`,fetchImpl:async()=>{calls++;return{ok:false,status:409,json:async()=>({code:'PT409',message:reason})};}};
    for(let i=0;i<2;i++)await assert.rejects(compareAndSetSharedStatePatch('sps_clients',7,before,after,options),error=>error.status===409&&error.code.startsWith('SHARED_STATE_'));
    assert.equal(calls,1,'known permanent rejection is returned without another database transaction');
  }
});

test('genuine SQLSTATE40001 serialization errors never enter the permanent rejection cache', async()=>{
  let calls=0;const options={actorId:'actual-serialization-failure',fetchImpl:async()=>{calls++;return{ok:false,status:500,json:async()=>({code:'40001',message:'could not serialize access due to concurrent update'})};}};
  for(let i=0;i<2;i++)await assert.rejects(compareAndSetSharedStatePatch('sps_clients',7,before,after,options),{code:'SHARED_STATE_PATCH_SAVE_UNCONFIRMED'});
  assert.equal(calls,2);
});

test('explicit schedule removals use the event-scoped RPC and exact IDs operation and baseline', async () => {
  const schedule = [{ date: '10/29/2026', stops: [{ sid: 's1' }] }];
  const result = await compareAndSetSharedStatePatch('sps_schedule', 9, schedule, [], { actorId: 'owner', deleteStopIds: ['s1'], operationId: 'user-event', fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sps_schedule_delete_patch_batch_cas'));
    const body = JSON.parse(options.body);
    assert.deepEqual(body.p_stop_ids, ['s1']); assert.equal(body.p_operation_id, 'user-event'); assert.equal(body.p_actor_id, 'owner');
    assert.deepEqual(body.p_expected_current, { sps_schedule: schedule });
    assert.deepEqual(body.p_operations, [{ key: 'sps_schedule', expected_version: 9, value: '[]' }]);
    return reply([{ applied: true, outcome: 'applied', current_versions: { sps_schedule: 10 }, values: { sps_schedule: '[]' } }]);
  } });
  assert.equal(result.currentVersion, 10); assert.deepEqual(result.value, []);
});
