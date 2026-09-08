import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupSpsInbox, reconcileInboxRemoval, mergeInboxDetail } from '../inboxCleanup.js';
import { commsNavigationCount, actionableCommsReason } from '../commsPriority.js';
import { mergeInboxConversationRows } from '../smsConversations.js';

test('focused cleanup confirms exact IDs in bounded batches, including long text threads', async () => {
  const ids = Array.from({length: 451}, (_, index) => `message-${index}`);
  const calls = [];
  const result = await cleanupSpsInbox({ ids: [...ids, ids[0]], action: 'delete', request: async payload => {
    calls.push(payload);
    return {response: {ok: true}, receipt: {ok: true, deletedIds: payload.ids}};
  }});
  assert.deepEqual(calls.map(call => call.ids.length), [200, 200, 51]);
  assert.ok(calls.every(call => call.action === 'delete' && Object.keys(call).length === 2));
  assert.deepEqual(result, {ok: true, confirmedIds: ids, failedIds: []});
});

test('partial deletion and network failure keep every unconfirmed message', async () => {
  const ids = Array.from({length: 202}, (_, index) => String(index));
  let calls = 0;
  const result = await cleanupSpsInbox({ids, action: 'delete', request: async () => {
    if (++calls === 2) throw new Error('offline');
    return {response: {ok: false}, receipt: {ok: false, deletedIds: ['0', '1', 'unrequested']}};
  }});
  assert.equal(result.ok, false);
  assert.deepEqual(result.confirmedIds, ['0', '1']);
  assert.deepEqual(result.failedIds, ids.slice(2));
});

test('an ambiguous delete receipt does not claim that messages were removed', async () => {
  const result = await cleanupSpsInbox({ids: ['a'], action: 'delete', request: async () => ({response: {ok: true}, receipt: {ok: true, deleted: 1}})});
  assert.deepEqual(result, {ok: false, confirmedIds: [], failedIds: ['a']});
});

test('mark read requires success from SPS, and passes only the requested read state', async () => {
  let payload;
  const result = await cleanupSpsInbox({ids: ['a'], action: 'markRead', read: false, request: async body => {
    payload = body;
    return {response: {ok: false}, receipt: {ok: true}};
  }});
  assert.deepEqual(payload, {action: 'markRead', ids: ['a'], read: false});
  assert.deepEqual(result.failedIds, ['a']);
});

test('reading a text clears its attention item until a fresh incoming message arrives', () => {
  const first = {id:'1', channel:'sms', sms_line:'main', sms_peer_phone:'+15550100101', sms_direction:'incoming', body_text:'Could we change the service date?', read:true, created_at:'2026-09-07T12:00:00Z'};
  assert.equal(actionableCommsReason(mergeInboxConversationRows([first])[0]), '');
  const second = {...first, id:'2', body_text:'Would Thursday work?', read:false, created_at:'2026-09-07T13:00:00Z'};
  assert.equal(actionableCommsReason(mergeInboxConversationRows([first, second])[0]), 'text');
  assert.equal(actionableCommsReason({...first, sms_status:'failed'}), 'failure');
});

test('quiet badges count new leads and failures, not accumulated unread history', () => {
  const counts = {perms: {isAdmin:true}, leads:2, failures:1, chats:12, inbox:28, reminders:6};
  assert.equal(commsNavigationCount(counts), 3);
  assert.equal(commsNavigationCount({...counts, failures:0}), 2);
  assert.equal(commsNavigationCount({...counts, focused:false}), 48);
  assert.equal(commsNavigationCount({...counts, perms:{commsInbox:true}}), 2);
  assert.equal(commsNavigationCount({...counts, perms:{commsMainLine:true}}), 1);
  assert.equal(commsNavigationCount({...counts, perms:{}}), 0);
});

test('failed cleanup restores rows suppressed by a refresh and preserves fresh incoming rows', () => {
  const requested = [{id:'a', created_at:'2026-09-07T12:00Z'}, {id:'b', read:false, created_at:'2026-09-07T11:00Z'}];
  const receipt = {confirmedIds:['a'], failedIds:['b']};
  assert.deepEqual(reconcileInboxRemoval([{id:'c', created_at:'2026-09-07T13:00Z'}], requested, receipt).map(row => row.id), ['c','b']);
  assert.equal(reconcileInboxRemoval([{...requested[1], read:true}], requested, receipt)[0].read, true);
});

test('cached email body cannot undo a confirmed read or category update', () => {
  assert.deepEqual(mergeInboxDetail({id:'a',read:true,kind:'client'}, {id:'a',read:false,kind:'lead',body_html:'<p>Message</p>'}), {id:'a',read:true,kind:'client',body_html:'<p>Message</p>'});
});
