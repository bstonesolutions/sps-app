import assert from "node:assert/strict";
import { applySharedStateIntent } from "../../sharedStateIntent.js";
import { stableInvoiceReviewJSON } from "../../invoiceReviewIdentity.js";
import { createSharedStatePatchHandler } from "../../api/shared-state-patch.js";

// Store tests retain their in-memory database and CAS race hooks, but protected
// writes exercise the actual original-field hash interpreter over HTTP rather
// than accidentally calling a real endpoint or treating a fresh version as a
// permission to replace the complete collection.
export function installSharedStateEndpointFixture({ store, supabase, readRow, commit = (key, version, value) => supabase.rpc("sps_app_state_cas", {
  p_key: key, p_expected_version: version, p_value: JSON.stringify(value),
}) }) {
  const original = { fetch: globalThis.fetch, getSession: supabase.auth.getSession };
  supabase.auth.getSession = async () => ({ data: { session: { user: { id: store.captureIdentity().uid }, access_token: "test-session" } }, error: null });
  const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/shared-state-patch$/);
    const intent = JSON.parse(init.body), actorId = store.captureIdentity().uid;
    if (intent.mode === "batch") {
      const decode = row => ({ exists: !!row, version: row?.version || 0, value: typeof row?.value === "string" ? JSON.parse(row.value) : row?.value });
      const handler = createSharedStatePatchHandler({
        authorize: async () => ({ id: actorId, teamRole: "owner", teamMember: { role: "owner" } }),
        readMany: async keys => Object.fromEntries(await Promise.all(keys.map(async key => [key, decode(await readRow(key))]))),
        batch: async operations => {
          const result = await supabase.rpc("sps_app_state_batch_cas", { p_operations: operations.map(operation => ({
            key: operation.key, expected_version: operation.expectedVersion, value: JSON.stringify(operation.value),
          })) });
          if (result.error) throw result.error;
          const row = result.data?.[0];
          return { applied: row?.applied, currentVersions: row?.current_versions,
            values: Object.fromEntries(await Promise.all(operations.map(async operation => [operation.key, decode(await readRow(operation.key)).value]))) };
        },
      });
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
      await handler({ method: "POST", body: intent }, res);
      return reply(res.statusCode, res.body);
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = structuredClone(await readRow(intent.key));
      if (!before) return reply(503, { ok: false, error: "Snapshot unavailable" });
      const value = typeof before.value === "string" ? JSON.parse(before.value) : before.value;
      const result = await applySharedStateIntent(intent, value);
      if (!result.applied) return reply(409, { ok: false, actorId, key: intent.key, operationId: intent.operationId,
        code: "shared-state-field-conflict", currentVersion: before.version, conflicts: result.conflicts });
      if (!result.changed) return reply(200, { ok: true, actorId, key: intent.key, operationId: intent.operationId, complete: true,
        beforeVersion: before.version, afterVersion: before.version, value, replayed: true });
      const saved = await commit(intent.key, before.version, result.value);
      if (saved.error) return reply(saved.error.status || 503, { ok: false, code: saved.error.code, error: saved.error.message });
      const row = Array.isArray(saved.data) ? saved.data[0] : saved.data;
      if (!row?.applied) continue;
      const after = structuredClone(await readRow(intent.key));
      const actual = typeof after.value === "string" ? JSON.parse(after.value) : after.value;
      if (stableInvoiceReviewJSON(actual) !== stableInvoiceReviewJSON(result.value)) return reply(409, { ok: false,
        code: "shared-state-protected-change", error: "A protected record could not accept part of this change. Original work is preserved." });
      return reply(200, { ok: true, actorId, key: intent.key, operationId: intent.operationId, complete: true,
        beforeVersion: before.version, afterVersion: after.version, value: actual, replayed: false });
    }
    return reply(409, { ok: false, code: "shared-state-contention", error: "Concurrent writes did not settle" });
  };
  return () => { globalThis.fetch = original.fetch; supabase.auth.getSession = original.getSession; };
}
