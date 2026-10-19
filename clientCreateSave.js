import { canonicalizeNewClientProfile } from "./clientCreateProfile.js";

function newClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === "x" ? random : (random & 3) | 8).toString(16);
  });
}

// The same open form always retries one server-owned creation request.
export function createNewClientAttempt() {
  return { id: newClientId(), submittedClient: null, identity: null };
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function assertIdentity(isCurrentIdentity) {
  if (typeof isCurrentIdentity !== "function" || !isCurrentIdentity()) {
    throw new Error("The signed-in account changed. Reopen Add Client in your current account before saving.");
  }
}

function assertReceipt(receipt, requested) {
  const client = receipt?.client;
  const requestId = requested.id;
  if (receipt?.ok !== true || !client || typeof client !== "object" || Array.isArray(client)
    || String(client.id) !== requested.id || receipt.requestId !== requestId
    || typeof receipt.replayed !== "boolean"
    || !Number.isSafeInteger(receipt.beforeVersion) || receipt.beforeVersion < 0
    || !Number.isSafeInteger(receipt.afterVersion) || receipt.afterVersion < 1
    || (receipt.replayed ? receipt.afterVersion !== receipt.beforeVersion : receipt.afterVersion !== receipt.beforeVersion + 1)) {
    throw new Error("The server did not return a valid client save receipt. Your form is still here. Try Create Client again.");
  }
  // A first commit must confirm every submitted profile field. An idempotent replay
  // returns the current saved client, which may already include another device's edits.
  if (!receipt.replayed && Object.keys(requested).some(key => !sameValue(requested[key], client[key]))) {
    throw new Error("The server did not confirm all of this client's details. Your form is still here. Try Create Client again.");
  }
  if (typeof client.name !== "string" || !client.name.trim()) {
    throw new Error("The server did not confirm this client's name. Your form is still here. Try Create Client again.");
  }
}

export async function saveNewClientChanges({ form, attempt, createClient, acceptClient, isCurrentIdentity }) {
  if (typeof form?.name !== "string" || !form.name.trim()) throw new Error("Enter the client's full name before saving.");
  if (!attempt?.id) throw new Error("This client form has no save identity. Reopen Add Client before saving.");
  assertIdentity(isCurrentIdentity);
  const requested = canonicalizeNewClientProfile({ ...form, id: attempt.id });
  attempt.submittedClient = structuredClone(requested);
  // This compact request is independent of unrelated pending client edits or conflicts.
  // The server records the original payload under this ID and rejects changed replays.
  const receipt = await createClient({ client: requested });
  assertIdentity(isCurrentIdentity);
  assertReceipt(receipt, requested);
  const accepted = await acceptClient(receipt);
  assertIdentity(isCurrentIdentity);
  if (!accepted?.ok) {
    throw new Error(`The client was saved, but this device could not display the confirmed copy. ${accepted?.error?.message || "Your form is still here. Try Create Client again."}`);
  }
  return receipt.client;
}
