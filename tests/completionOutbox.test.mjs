import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCompletionFailure,
  completionOutboxSummary,
  completionReviewItems,
  dismissCompletionIntent,
  enqueueCompletionIntent,
  persistStopDraft,
  readCompletionOutbox,
  readStopDraft,
  removeStopDraft,
  retryCompletionIntent,
  updateCompletionIntent,
} from "../completionOutbox.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  async set(key, value) { this.values.set(key, structuredClone(value)); return key; }
  async del(key) { this.values.delete(key); }
}

const intent = (overrides = {}) => ({
  uid: "user-1",
  clientId: "client-9",
  sid: "stop-42",
  entry: {
    notes: "Replaced the GFI.",
    photos: [{ src: "sps-storage://client-media/photo.jpg", label: "After" }],
    breakdown: { revenue: 175, equipment: 12, profit: 163 },
  },
  idempotencyKey: "complete-stop-42-key",
  delivery: { plan: { text: true, email: false, app: true }, textMessage: "Your report is ready." },
  ...overrides,
});

test("completion intent is verified in durable storage before enqueue resolves", async () => {
  const storage = new MemoryStorage();
  const saved = await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  assert.equal(saved.state, "queued");
  assert.equal(saved.idempotencyKey, "complete-stop-42-key");
  assert.deepEqual(saved.request.entry.breakdown, { revenue: 175, equipment: 12, profit: 163 });

  const rows = await readCompletionOutbox("user-1", { storage, now: 1000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request.idempotencyKey, saved.idempotencyKey);
  assert.equal(rows[0].request.entry.photos[0].src, "sps-storage://client-media/photo.jpg");
});

test("a retry update cannot replace the original request or idempotency key", async () => {
  const storage = new MemoryStorage();
  const saved = await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  const updated = await updateCompletionIntent("user-1", saved.id, {
    state: "syncing",
    idempotencyKey: "different-key",
    request: { mode: "complete", sid: "wrong-stop" },
  }, { storage });
  assert.equal(updated.state, "syncing");
  assert.equal(updated.idempotencyKey, "complete-stop-42-key");
  assert.equal(updated.request.sid, "stop-42");
  assert.equal(updated.request.entry.notes, "Replaced the GFI.");
});

test("enqueueing the exact same completion is idempotent on-device", async () => {
  const storage = new MemoryStorage();
  await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  await enqueueCompletionIntent(intent({ entry: { ...intent().entry, notes: "Latest local copy" } }), { storage, now: 2000 });
  const rows = await readCompletionOutbox("user-1", { storage, now: 2000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request.entry.notes, "Latest local copy");
  assert.equal(rows[0].createdAt, 1000);
});

test("network, 5xx, and safe CAS contention retry while business conflicts are held for review", () => {
  assert.equal(classifyCompletionFailure(new TypeError("Failed to fetch")).retryable, true);
  assert.equal(classifyCompletionFailure(Object.assign(new Error("upstream unavailable"), { status: 502 })).retryable, true);
  const contention = classifyCompletionFailure(Object.assign(new Error("another write won"), { status: 409, code: "contention" }));
  assert.equal(contention.retryable, true);
  assert.equal(contention.needsReview, false);
  const conflict = classifyCompletionFailure(Object.assign(new Error("another employee completed it"), { status: 409, code: "completion-already-owned" }));
  assert.equal(conflict.retryable, false);
  assert.equal(conflict.needsReview, true);
  assert.equal(conflict.code, "completion-already-owned");
});

test("summary separates background work from review items", () => {
  const summary = completionOutboxSummary([
    { state: "queued", retryAt: 0 },
    { state: "queued", retryAt: 5000 },
    { state: "syncing", retryAt: 0 },
    { state: "needs_review" },
    { state: "saved", deliveryNeedsReview: true },
  ], 1000);
  assert.deepEqual(summary, { queued: 2, waiting: 1, needsReview: 2, saved: 1 });
});

test("review items preserve exact report identity and separate save from delivery problems", () => {
  const rows = completionReviewItems([
    {
      id: "delivery-1", sid: "stop-2", clientId: "client-2", state: "saved", createdAt: 200,
      deliveryNeedsReview: true,
      delivery: { channels: { email: { status: "needs_review", error: "Email provider timed out." }, text: { status: "delivered" } } },
      request: { entry: { date: "08/03/2026", notes: "Safe delivery report" } },
    },
    {
      id: "save-1", sid: "stop-1", clientId: "client-1", state: "needs_review", createdAt: 100,
      lastError: "Another device changed this stop.", errorCode: "completion-already-owned",
      request: { entry: { date: "08/02/2026", notes: "Safe completion report" } },
    },
    { id: "queued", sid: "stop-3", state: "queued", createdAt: 50 },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.reviewKind]), [["save-1", "report"], ["delivery-1", "delivery"]]);
  assert.equal(rows[0].request.entry.notes, "Safe completion report");
  assert.equal(rows[0].reviewError, "Another device changed this stop.");
  assert.deepEqual(rows[1].reviewChannels, [{ key: "email", error: "Email provider timed out." }]);
});

test("explicit retry preserves the original report request and idempotency key", async () => {
  const storage = new MemoryStorage();
  const saved = await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  await updateCompletionIntent("user-1", saved.id, {
    state: "needs_review",
    lastError: "Shared stop changed.",
    errorCode: "app-state-conflict",
    errorStatus: 409,
  }, { storage });
  const retried = await retryCompletionIntent("user-1", saved.id, { storage, now: 2500 });
  assert.equal(retried.state, "queued");
  assert.equal(retried.retryAt, 0);
  assert.equal(retried.lastError, "");
  assert.equal(retried.idempotencyKey, "complete-stop-42-key");
  assert.deepEqual(retried.request, saved.request);
});

test("dismiss review hides the alert while retaining the exact saved report", async () => {
  const storage = new MemoryStorage();
  const saved = await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  await updateCompletionIntent("user-1", saved.id, {
    state: "needs_review",
    lastError: "This stop was already completed elsewhere.",
  }, { storage });
  const dismissed = await dismissCompletionIntent("user-1", saved.id, { storage, now: 3000 });
  assert.equal(dismissed.state, "dismissed");
  assert.equal(dismissed.dismissedAt, 3000);
  assert.equal(dismissed.idempotencyKey, "complete-stop-42-key");
  assert.deepEqual(dismissed.request, saved.request);
  assert.equal(completionOutboxSummary([dismissed]).needsReview, 0);
  assert.equal((await readCompletionOutbox("user-1", { storage, now: 4000 })).length, 1);
});

test("expired saved completions are removed from the persisted outbox", async () => {
  const storage = new MemoryStorage();
  const saved = await enqueueCompletionIntent(intent(), { storage, now: 1000 });
  await updateCompletionIntent("user-1", saved.id, { state: "saved", savedAt: 1000 }, { storage });
  const afterRetention = 1000 + (25 * 60 * 60 * 1000);
  assert.deepEqual(await readCompletionOutbox("user-1", { storage, now: afterRetention }), []);
  const snapshot = await storage.get("sps-completion-outbox:v1:user-1");
  assert.deepEqual(snapshot.items, []);
});

test("full stop draft round-trips in a UID and stop scoped record", async () => {
  const storage = new MemoryStorage();
  const payload = {
    assigneeId: "tech-2",
    revenue: "175",
    hourlyRate: "59",
    gas: "4.50",
    insurance: "1.25",
    equipment: "12.00",
    overhead: "8.00",
    svcList: [{ name: "Repair Visit", price: "175" }],
    actualHours: "1.25",
    notesOffice: "Replace one GFI.",
  };
  await persistStopDraft("user-1", "stop-42", payload, { storage, now: 1234 });
  const restored = await readStopDraft("user-1", "stop-42", { storage });
  assert.equal(restored.updatedAt, 1234);
  assert.deepEqual(restored.payload, payload);
  await removeStopDraft("user-1", "stop-42", { storage });
  assert.equal(await readStopDraft("user-1", "stop-42", { storage }), null);
});

test("enqueue fails closed when durable storage silently drops the write", async () => {
  const storage = { get: async () => null, set: async () => null, del: async () => null };
  await assert.rejects(
    enqueueCompletionIntent(intent(), { storage }),
    /could not be saved safely on this device/i,
  );
});
