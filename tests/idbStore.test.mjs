import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDbStore } from '../idbStore.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let id = 0;
  const timers = new Map(), values = new Map([['pending', { edit: 'retained' }]]), requests = [], connections = [], transactions = [];
  const state = { openMode: 'normal', transactionMode: 'normal' };
  const options = {
    setTimer(fn) { timers.set(++id, fn); return id; }, clearTimer(id) { timers.delete(id); },
    getIndexedDB: () => ({ open() {
      const req = {}; requests.push(req);
      const db = { closed: false, objectStoreNames: { contains: () => true }, close() { this.closed = true; }, transaction() {
        if (state.transactionMode === 'throw') throw new Error('connection closed');
        const tx = { aborted: false, abort() { this.aborted = true; this.onabort?.(); }, objectStore() {
          return Object.fromEntries(['get', 'put', 'delete', 'clear'].map(method => [method, (value, key) => {
            const op = { result: method === 'get' ? values.get(value) : key };
            if (state.transactionMode === 'normal') queueMicrotask(() => {
              if (tx.aborted) return;
              if (method === 'put') values.set(key, value);
              if (method === 'delete') values.delete(value);
              if (method === 'clear') values.clear();
              tx.oncomplete?.();
            });
            return op;
          }]));
        } };
        transactions.push(tx); return tx;
      } };
      connections.push(db); req.result = db;
      if (state.openMode === 'normal') queueMicrotask(() => req.onsuccess?.());
      return req;
    } }),
  };
  return { store: createIndexedDbStore(options), state, requests, connections, transactions, values,
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

test('stalled IndexedDB opening releases cache reads and a later request reconnects', async () => {
  const h = setup(); h.state.openMode = 'hang';
  const blocked = h.store.get('pending'); h.expire();
  assert.equal(await blocked, null);
  h.state.openMode = 'normal';
  assert.deepEqual(await h.store.get('pending'), { edit: 'retained' });
  h.requests[0].onsuccess();
  assert.equal(h.connections[0].closed, true, 'a late timed-out connection must not survive');
  assert.equal(h.connections[1].closed, false);
});

test('stalled write transaction aborts and later durable writes reconnect', async () => {
  const h = setup(); h.state.transactionMode = 'hang';
  const blocked = h.store.set('pending', { edit: 'new' }); await turn(); h.expire();
  assert.equal(await blocked, null);
  assert.equal(h.transactions[0].aborted, true);
  assert.deepEqual(h.values.get('pending'), { edit: 'retained' });
  h.state.transactionMode = 'normal';
  await h.store.set('pending', { edit: 'new' });
  assert.deepEqual(await h.store.getVerified('pending'), { edit: 'new' });
  assert.equal(h.connections.length, 2);
});

test('verified cleanup read distinguishes missing data from a stalled read', async () => {
  const h = setup();
  assert.equal(await h.store.getVerified('missing'), undefined);
  h.state.transactionMode = 'hang';
  const blocked = h.store.getVerified('pending'); const rejected = assert.rejects(blocked, { code: 'IDB_TIMEOUT' });
  await turn(); h.expire(); await rejected;
  assert.deepEqual(h.values.get('pending'), { edit: 'retained' });
});

test('version changes and closed connections are reopened instead of poisoning the session', async () => {
  const h = setup(); await h.store.get('pending');
  h.connections[0].onversionchange();
  assert.equal(h.connections[0].closed, true);
  await h.store.get('pending'); assert.equal(h.connections.length, 2);
  h.state.transactionMode = 'throw'; assert.equal(await h.store.get('pending'), null);
  h.state.transactionMode = 'normal'; assert.deepEqual(await h.store.get('pending'), { edit: 'retained' });
  assert.equal(h.connections.length, 3);
});

test('verified reads reject unavailable storage instead of treating it as an empty report queue', async () => {
  const store = createIndexedDbStore({ getIndexedDB: () => undefined });
  assert.equal(await store.get('pending'), undefined);
  await assert.rejects(store.getVerified('pending'), { code: 'IDB_UNAVAILABLE' });
});
