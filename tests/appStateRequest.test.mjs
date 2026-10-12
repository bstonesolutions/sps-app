import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAppState } from '../appStateRequest.js';
import { isTransientAppStateError } from '../appStateBackoff.js';

function clock() {
  const callbacks = new Map(); let id = 0;
  return { setTimer(fn) { callbacks.set(++id, fn); return id; }, clearTimer(id) { callbacks.delete(id); }, expire() { for (const [id, fn] of [...callbacks]) { callbacks.delete(id); fn(); } }, get size() { return callbacks.size; } };
}

test('a hung request returns a retryable timeout and aborts the native request', async () => {
  const timer = clock(); let signal;
  const pending = requestAppState('cas', () => ({ abortSignal(value) { signal = value; return new Promise(() => {}); } }), timer);
  await Promise.resolve();
  timer.expire();
  const result = await pending;
  assert.equal(result.error.code, 'APP_STATE_REQUEST_TIMEOUT');
  assert.equal(result.error.operation, 'cas');
  assert.equal(isTransientAppStateError(result.error), true);
  assert.equal(signal.aborted, true);
  assert.equal(timer.size, 0);
});

test('a late response cannot turn the timed-out request into a saved receipt', async () => {
  const timer = clock(); let finish;
  const pending = requestAppState('cas', () => new Promise(resolve => { finish = resolve; }), timer);
  await Promise.resolve(); timer.expire();
  const result = await pending;
  finish({ data: [{ applied: true }], error: null });
  await Promise.resolve();
  assert.equal(result.data, null);
  assert.equal(result.error.code, 'APP_STATE_REQUEST_TIMEOUT');
  const recovered = await requestAppState('read', () => Promise.resolve({ data: { version: 2 }, error: null }), timer);
  assert.equal(recovered.data.version, 2);
  assert.equal(timer.size, 0);
});

test('thrown network errors return through the durable retry path instead of rejecting the queue', async () => {
  const timer = clock();
  const result = await requestAppState('read', () => { throw new Error('network unavailable'); }, timer);
  assert.match(result.error.message, /network unavailable/);
  assert.equal(timer.size, 0);
});
