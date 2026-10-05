import { mergeStoredState } from "./stateMerge.js";
import { normalizeMaintenanceBillingPolicy } from "./maintenanceBilling.js";

const sameId = (left, right) => left != null && right != null && String(left) === String(right);
const withoutBilling = (client) => {
  const copy = { ...client };
  delete copy.maintenanceBilling;
  return copy;
};
const withBilling = (client, policy) => {
  const copy = withoutBilling(client);
  if (policy) copy.maintenanceBilling = policy;
  return copy;
};
const samePolicy = (left, right) => JSON.stringify(normalizeMaintenanceBillingPolicy(left)) === JSON.stringify(normalizeMaintenanceBillingPolicy(right));

function uniqueClient(clients, id) {
  const matches = Array.isArray(clients) ? clients.filter(client => sameId(client?.id, id)) : [];
  if (matches.length !== 1) throw new Error("The client could not be identified uniquely. Reopen the client before saving.");
  return matches[0];
}

// The billing endpoint already saved its protected policy and client mirror atomically.
// A billing-only edit must adopt that receipt without uploading the whole client roster again.
export async function saveClientEditorChanges({ clients, updated, baselineClient, billingConfirmed, hasBillingReceipt = false, refreshClients, persistClients }) {
  uniqueClient(clients, updated?.id);
  if (!sameId(baselineClient?.id, updated?.id)) throw new Error("The client changed while this editor was open. Reopen it before saving.");
  // The caller's roster was captured before its billing request. A background
  // sync can advance the storage hook's baseline during that await, so using
  // the captured roster as the next value could delete those newer changes.
  const refreshed = await refreshClients();
  if (!refreshed?.ok || refreshed.pending) {
    throw new Error(`${hasBillingReceipt ? "Billing was saved, but this device could not reload the client. " : "The latest client details could not be loaded. "}Your choices are still here. Retry Save Changes to confirm the client view.`);
  }
  const current = uniqueClient(refreshed.clients, updated.id);
  if (hasBillingReceipt && !samePolicy(current.maintenanceBilling, billingConfirmed)) {
    throw new Error("This client's billing changed again after your save. Reopen the client to review the latest plan.");
  }
  const profileChanged = JSON.stringify(withoutBilling(baselineClient)) !== JSON.stringify(withoutBilling(updated));
  if (hasBillingReceipt && !profileChanged) {
    return current;
  }

  // Merge only edits made in this form. Background updates to contact details, history,
  // or another service plan must survive; overlapping edits require an explicit review.
  const versions = [baselineClient, updated, current].map(client => hasBillingReceipt ? withBilling(client, billingConfirmed) : client);
  const merged = mergeStoredState("sps_clients", [versions[0]], [versions[1]], [versions[2]]);
  if (merged.conflicts.length) throw new Error("This client has overlapping changes. Your edits are still here; review the latest client details before saving.");
  const nextClient = uniqueClient(JSON.parse(merged.value), updated.id);
  const receipt = await persistClients(refreshed.clients.map(client => sameId(client.id, updated.id) ? nextClient : client));
  if (!receipt?.ok) {
    const detail = receipt?.error?.message || (typeof receipt?.error === "string" ? receipt.error : "The client save was not confirmed.");
    throw new Error(`${hasBillingReceipt ? "Billing was saved, but the other client changes were not confirmed. " : ""}${detail}`);
  }
  const savedClients = receipt.parsedValue || (typeof receipt.value === "string" ? JSON.parse(receipt.value) : receipt.value);
  const saved = uniqueClient(savedClients, updated.id);
  if (hasBillingReceipt && !samePolicy(saved.maintenanceBilling, billingConfirmed)) {
    throw new Error("The saved billing differs from your selection. Reopen this client to review the latest plan.");
  }
  return saved;
}
