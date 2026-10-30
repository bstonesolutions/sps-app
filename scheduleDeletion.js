import { idb } from "./idbStore.js";
import { store, supabase } from "./supabaseClient.js";
import { buildSharedStateIntent, validateSharedStateIntent } from "./sharedStateIntent.js";
import { invoiceReviewHash, stableInvoiceReviewJSON } from "./invoiceReviewIdentity.js";
import { sendSharedStateIntent } from "./sharedStateWriteClient.js";

const key = "sps_schedule";
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => stableInvoiceReviewJSON(a) === stableInvoiceReviewJSON(b);
const fail = message => new Error(message);
const readVerified = (storage, name) => storage.getVerified(name);
const idsOf = schedule => schedule.flatMap(day => day.stops || []).map(stop => String(stop.sid));

export function scheduleDeletionSelection(schedule, selectedIds) {
  if (!Array.isArray(schedule) || !Array.isArray(selectedIds) || !selectedIds.length) throw fail("Select the stops to remove first.");
  const ids = selectedIds.map(String);
  if (ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) throw fail("The selected stops could not be identified uniquely.");
  const selected = schedule.flatMap(day => (day.stops || []).filter(stop => ids.includes(String(stop.sid))).map(stop => ({ date: day.date, stop })));
  if (selected.length !== ids.length || new Set(selected.map(item => String(item.stop.sid))).size !== ids.length) throw fail("A selected stop changed. Reopen the schedule before removing it.");
  if (selected.some(item => item.stop.sourceEstimateId)) throw fail("A selected stop belongs to an approved estimate. Reschedule or cancel that work instead.");
  return clone(selected);
}

// This path is called only by a reviewed Delete event. It never stages a generic autosave,
// silently advances a target's original hash, or replays a deletion in the background.
export async function deleteScheduledStops({ schedule, deleteStopIds }, {
  storage = idb, stateStore = store, getSession = () => supabase.auth.getSession(),
  send = sendSharedStateIntent, cryptoImpl = globalThis.crypto,
} = {}) {
  const identity = stateStore.captureIdentity();
  const currentIdentity = () => stateStore.isCurrentIdentity(identity);
  if (!identity?.uid || !currentIdentity()) throw fail("Sign in before removing a scheduled stop.");
  if (!Array.isArray(deleteStopIds) || !deleteStopIds.length) throw fail("Select the stops to remove first.");
  const ids = deleteStopIds.map(String).sort();
  // The scope uses only IDs, never client names or contact details.
  const journalKey = `sps-schedule-delete:v1:${identity.uid}:${await invoiceReviewHash(ids, cryptoImpl)}`;
  let journal = await readVerified(storage, journalKey);
  if (!currentIdentity()) throw fail("The signed-in account changed. The removal request is kept with its original account.");
  if (journal != null) {
    if (journal.v !== 1 || journal.uid !== identity.uid || !equal(journal.request?.deleteStopIds, ids) || journal.request.action !== "schedule-delete" || journal.request.key !== key) throw fail("The saved removal request needs review before another removal can be prepared.");
    validateSharedStateIntent(journal.request);
    if (journal.needsReview) {
      const reviewed = scheduleDeletionSelection(schedule, ids);
      if (equal(reviewed, journal.selected)) throw fail("A selected stop changed on the server. Refresh the schedule and review it before removing it.");
      // This invocation is a new, explicit Delete with newly displayed details. Keep the
      // rejected request until the replacement has its own verified durable copy.
      journal = null;
    }
  }
  if (journal == null) {
    const selected = scheduleDeletionSelection(schedule, ids);
    const selectedDays = new Set(selected.map(item => item.date));
    const before = clone(schedule);
    const after = before.map(day => ({ ...day, stops: (day.stops || []).filter(stop => !ids.includes(String(stop.sid))) })).filter(day => day.stops.length || !selectedDays.has(day.date));
    const operationId = `schedule-delete-${cryptoImpl.randomUUID()}`;
    const intent = await buildSharedStateIntent(key, before, after, { operationId, cryptoImpl });
    journal = { v: 1, uid: identity.uid, selected, request: { ...intent, action: "schedule-delete", deleteStopIds: ids } };
    await storage.set(journalKey, journal);
    if (!equal(await readVerified(storage, journalKey), journal)) throw fail("This removal request could not be saved on the device. The stops are still on the schedule.");
  }
  if (!currentIdentity()) throw fail("The signed-in account changed. The original removal request is preserved.");
  const result = await send(journal.request, { getSession, expectedActorId: identity.uid, isCurrentIdentity: currentIdentity });
  if (!currentIdentity()) throw fail("The signed-in account changed before removal could be confirmed. The original request is preserved.");
  const receipt = result?.data;
  if (receipt?.code === "shared-state-field-conflict") {
    // A confirmed rejection cannot have applied part of this atomic removal. Require an
    // explicit new Delete after the user has actually reviewed changed target details.
    await storage.set(journalKey, { ...journal, needsReview: true });
  }
  if (result?.error || receipt?.ok !== true || receipt.complete !== true || receipt.actorId !== identity.uid || receipt.key !== key
    || receipt.operationId !== journal.request.operationId || !Number.isSafeInteger(receipt.beforeVersion) || receipt.beforeVersion < 1
    || !Number.isSafeInteger(receipt.afterVersion) || receipt.afterVersion < receipt.beforeVersion || !Array.isArray(receipt.value)
    || idsOf(receipt.value).some(id => ids.includes(id))) {
    throw result?.error || fail(receipt?.error || "Removal was not confirmed. Your selection is still here. Retry to check the same request.");
  }
  // Reload through the dirty-aware store. Unrelated pending edits remain in its cache; using
  // that projection for React cannot overwrite or clear their original durable intent.
  let displaySchedule = receipt.value;
  try {
    const refreshed = await stateStore.refresh(key);
    if (refreshed?.ok && Number(refreshed.version) >= receipt.afterVersion) {
      const displayed = await stateStore.get(key);
      const parsed = displayed?.value != null ? JSON.parse(displayed.value) : null;
      if (Array.isArray(parsed)) displaySchedule = parsed;
    }
  } catch (_) {}
  if (!currentIdentity()) throw fail("The signed-in account changed after removal. Reopen the schedule to see its saved state.");
  // A failed cleanup keeps the same original request. It is harmless to retry explicitly:
  // the server confirms already-absent IDs instead of creating a second destructive intent.
  await storage.del(journalKey).catch(() => {});
  return { ok: true, receipt, displaySchedule, selected: journal.selected, deletedStopIds: ids };
}

export function scheduleSelectionScope(schedule, date, tech = null, team = []) {
  return (schedule || []).filter(day => day.date === date).map(day => ({ ...day, stops: (day.stops || []).filter(stop => tech == null || tech === "__all"
    || (tech === "__un" ? !stop.assigneeId || !team.some(member => member.id === stop.assigneeId) : String(stop.assigneeId) === String(tech))) }));
}
