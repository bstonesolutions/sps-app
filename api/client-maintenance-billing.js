// Narrow accounting-authorized mutation for prepaid maintenance coverage.
// Ordinary client profile writes are operational and intentionally available
// to client-editing staff, so they cannot be the authority for suppressing an
// invoice. This route updates the UI mirror and the protected policy ledger in
// one version-checked transaction.

import { requireCapability } from "./_staff-auth.js";
import { compareAndSetAppStateBatch, readAppStateVersioned } from "./_app-state.js";
import {
  normalizeMaintenanceBillingPolicy,
} from "../maintenanceBilling.js";
import {
  emptyMaintenancePaymentLedger,
  normalizeMaintenancePaymentLedger,
} from "../maintenancePaymentLedger.js";

const MAX_ATTEMPTS = 6;
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const sameId = (left, right) => String(left) === String(right);

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

function cleanId(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, 220);
}

async function readBaseline() {
  const [clients, billing] = await Promise.all([
    readAppStateVersioned("sps_clients"),
    readAppStateVersioned("sps_maintenance_billing"),
  ]);
  if (!clients.exists || !Array.isArray(clients.value)) throw new Error("shared_clients_invalid");
  const billingValue = billing.exists
    ? normalizeMaintenancePaymentLedger(billing.value)
    : emptyMaintenancePaymentLedger();
  if (!billingValue) throw new Error("shared_maintenance_billing_invalid");
  return { clients, billing: { ...billing, value: billingValue } };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const staff = await requireCapability(
    req,
    res,
    "invoiceCreate",
    "changing prepaid maintenance billing",
  );
  if (!staff) return;

  const clientId = cleanId(req.body?.clientId);
  const hasPolicy = isRecord(req.body) && Object.prototype.hasOwnProperty.call(req.body, "maintenanceBilling");
  if (!clientId || !hasPolicy) {
    return res.status(400).json({ ok: false, error: "A client and maintenance billing choice are required." });
  }
  const requestedPolicy = req.body.maintenanceBilling == null
    ? null
    : normalizeMaintenanceBillingPolicy(req.body.maintenanceBilling);
  if (req.body.maintenanceBilling != null && !requestedPolicy) {
    return res.status(400).json({
      ok: false,
      error: "Prepaid coverage must start on the first day of a month and end on the last day of a month.",
    });
  }

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const baseline = await readBaseline();
      const matches = baseline.clients.value
        .map((client, index) => ({ client, index }))
        .filter(({ client }) => client && sameId(client.id, clientId));
      if (!matches.length) {
        return res.status(404).json({ ok: false, error: "The client no longer exists." });
      }
      if (matches.length !== 1) {
        return res.status(409).json({
          ok: false,
          error: "This client ID appears more than once. Merge the duplicate client records before changing billing.",
        });
      }

      const nextClients = baseline.clients.value.slice();
      const currentClient = matches[0].client;
      const nextClient = { ...currentClient };
      if (requestedPolicy) nextClient.maintenanceBilling = requestedPolicy;
      else delete nextClient.maintenanceBilling;
      nextClients[matches[0].index] = nextClient;

      const policies = { ...baseline.billing.value.policies };
      if (requestedPolicy) policies[clientId] = requestedPolicy;
      else delete policies[clientId];
      const nextBilling = normalizeMaintenancePaymentLedger({
        ...baseline.billing.value,
        policies,
      });
      if (!nextBilling) throw new Error("shared_maintenance_billing_invalid");

      const saved = await compareAndSetAppStateBatch([
        {
          key: "sps_clients",
          expectedVersion: baseline.clients.version,
          value: nextClients,
        },
        {
          key: "sps_maintenance_billing",
          expectedVersion: baseline.billing.exists ? baseline.billing.version : 0,
          value: nextBilling,
        },
      ]);
      if (saved.applied) {
        return res.status(200).json({
          ok: true,
          client: nextClient,
          maintenanceBilling: requestedPolicy,
        });
      }
      if (saved.outcome !== "conflict") throw new Error(`unexpected_batch_outcome:${saved.outcome || "unknown"}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 20)));
      }
    }
    return res.status(409).json({
      ok: false,
      error: "Another employee changed this client at the same time. Nothing was changed; please try again.",
    });
  } catch (error) {
    console.error("[client-maintenance-billing]", error && error.message ? error.message : error);
    return res.status(502).json({
      ok: false,
      error: "Maintenance billing could not be saved safely. Nothing was changed; please try again.",
    });
  }
}
