import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { default: inboxHandler } = await import("../api/inbox.js");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function post(body) {
  return {
    method: "POST",
    query: {},
    headers: { authorization: "Bearer owner-token" },
    body,
  };
}

function idsFromFilter(target) {
  const raw = new URL(target).searchParams.get("id") || "";
  if (raw.startsWith("eq.")) return [raw.slice(3)];
  if (raw.startsWith("in.(") && raw.endsWith(")")) {
    return raw.slice(4, -1).split(",").map(decodeURIComponent).filter(Boolean);
  }
  return [];
}

function installHarness({
  leads = [],
  inbox = [],
  patchOutcomes = [],
  casOutcomes = [],
  leadReadOutcomes = [],
} = {}) {
  let state = { value: structuredClone(leads), version: 1 };
  const rows = new Map(inbox.map((row) => [String(row.id), structuredClone(row)]));
  const events = [];
  const patchQueue = [...patchOutcomes];
  const casQueue = [...casOutcomes];
  const leadReadQueue = [...leadReadOutcomes];

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();

    if (target.endsWith("/auth/v1/user")) {
      events.push("auth");
      return response({ id: "owner-auth-id", email: "owner@example.test" });
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_team")) {
      events.push("team:read");
      return response([{ value: JSON.stringify([{ id: "owner-1", email: "owner@example.test", role: "owner" }]) }]);
    }
    if (target.includes("/rest/v1/app_state?") && target.includes("key=eq.sps_leads")) {
      const outcome = leadReadQueue.shift() || "success";
      events.push(`leads:read${outcome === "success" ? "" : `:${outcome}`}`);
      if (outcome === "failure") return response({ error: "lead read unavailable" }, { ok: false, status: 503 });
      return response([{
        key: "sps_leads",
        value: JSON.stringify(state.value),
        version: state.version,
        updated_at: null,
      }]);
    }
    if (target.endsWith("/rest/v1/rpc/sps_app_state_cas")) {
      const body = JSON.parse(options.body);
      const queuedOutcome = casQueue.shift() || "success";
      const outcome = typeof queuedOutcome === "string" ? queuedOutcome : (queuedOutcome.outcome || "success");
      events.push(`leads:cas:${outcome}`);
      if (outcome === "failure") {
        return response({ error: "database unavailable" }, { ok: false, status: 503 });
      }
      assert.equal(body.p_key, "sps_leads");
      assert.equal(body.p_expected_version, state.version);
      state = { value: JSON.parse(body.p_value), version: state.version + 1 };
      if (outcome === "applied_failure") {
        return response({ error: "response lost after commit" }, { ok: false, status: 503 });
      }
      return response([{
        applied: true,
        outcome: "updated",
        current_version: state.version,
        changed_at: null,
      }]);
    }
    if (target.includes("/rest/v1/sps_inbox?") && method === "GET") {
      const ids = idsFromFilter(target);
      events.push(`inbox:read:${ids.join(",")}`);
      return response(ids.map((id) => rows.get(id)).filter(Boolean).map((row) => structuredClone(row)));
    }
    if (target.includes("/rest/v1/sps_inbox?") && method === "PATCH") {
      const ids = idsFromFilter(target);
      const fields = JSON.parse(options.body);
      const queuedOutcome = patchQueue.shift() || "success";
      const outcome = typeof queuedOutcome === "string" ? queuedOutcome : (queuedOutcome.outcome || "success");
      events.push(`inbox:patch:${ids.join(",")}:${fields.kind || ""}:${outcome}`);
      for (const external of (Array.isArray(queuedOutcome.externalRows) ? queuedOutcome.externalRows : [])) {
        if (external && external.id) rows.set(String(external.id), structuredClone(external));
      }
      for (const edit of (Array.isArray(queuedOutcome.externalLeadPatches) ? queuedOutcome.externalLeadPatches : [])) {
        state = {
          value: state.value.map((lead) => String((lead && lead.id) || "") === String(edit.id) ? { ...lead, ...(edit.fields || {}) } : lead),
          version: state.version + 1,
        };
        events.push(`leads:external-edit:${edit.id}`);
      }
      for (const id of (Array.isArray(queuedOutcome.externalLeadDeletes) ? queuedOutcome.externalLeadDeletes : [])) {
        state = { value: state.value.filter((lead) => String((lead && lead.id) || "") !== String(id)), version: state.version + 1 };
        events.push(`leads:external-delete:${id}`);
      }
      if (outcome === "failure") {
        return response({ error: "database unavailable" }, { ok: false, status: 503 });
      }
      if (outcome === "zero") return response([]);
      const params = new URL(target).searchParams;
      const matchesExpected = (row, field) => {
        const condition = params.get(field);
        if (condition == null) return true;
        if (condition === "is.null") return row[field] == null;
        if (condition.startsWith("eq.")) return String(row[field] == null ? "" : row[field]) === condition.slice(3);
        return false;
      };
      const updated = [];
      for (const id of ids) {
        const current = rows.get(id);
        if (!current || !matchesExpected(current, "kind") || !matchesExpected(current, "lead_id")) continue;
        const next = { ...current, ...fields };
        rows.set(id, next);
        updated.push(structuredClone(next));
      }
      return response(updated);
    }
    throw new Error(`Unexpected fetch: ${method} ${target}`);
  };

  return {
    events,
    leadValue() { return structuredClone(state.value); },
    inboxRow(id) { return structuredClone(rows.get(String(id))); },
  };
}

const linkedLead = (id, messageId) => ({
  id,
  srcId: `em_${messageId}`,
  name: `Lead ${id}`,
  source: "email",
  status: "new",
});

test("repair updates every Inbox row before removing linked leads through CAS", async () => {
  const leadOne = linkedLead("lead-1", "message-1");
  const leadTwo = linkedLead("lead-2", "message-2");
  const keep = { id: "keep", name: "Manual lead", source: "manual" };
  const harness = installHarness({
    leads: [leadOne, keep, leadTwo],
    inbox: [
      { id: "message-1", kind: "lead", lead_id: "lead-1" },
      { id: "message-2", kind: "lead", lead_id: "lead-2" },
    ],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [
      { id: "message-1", kind: "client", leadId: "lead-1" },
      { id: "message-2", kind: "other", leadId: "lead-2" },
    ],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.removed.map((lead) => lead.id), ["lead-1", "lead-2"]);
  assert.deepEqual(harness.leadValue(), [keep]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
  assert.deepEqual(harness.inboxRow("message-2"), { id: "message-2", kind: "other", lead_id: "" });
  const leadReads = harness.events.map((event, index) => event === "leads:read" ? index : -1).filter((index) => index >= 0);
  assert.ok(leadReads[0] < harness.events.indexOf("inbox:patch:message-1:client:success"));
  assert.ok(leadReads[0] < harness.events.indexOf("inbox:patch:message-2:other:success"));
  assert.equal(harness.events.filter((event) => event === "leads:cas:success").length, 2);
});

test("repair treats a zero-row PATCH as failure and leaves leads intact", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const harness = installHarness({
    leads: [lead],
    inbox: [originalInbox],
    patchOutcomes: ["zero", "success"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.unchanged, true);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.filter((event) => event === "leads:cas:success").length, 2);
});

test("repair completes from the desired Inbox state written by a concurrent request", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const concurrentResult = { id: "message-1", kind: "client", lead_id: "" };
  const harness = installHarness({
    leads: [lead],
    inbox: [originalInbox],
    patchOutcomes: [{ outcome: "zero", externalRows: [concurrentResult] }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), concurrentResult);
  assert.equal(harness.events.filter((event) => event.startsWith("inbox:patch:")).length, 1);
  assert.equal(harness.events.filter((event) => event.startsWith("leads:cas:success")).length, 2);
});

test("repair preserves safe Inbox progress when a later PATCH fails", async () => {
  const leadOne = linkedLead("lead-1", "message-1");
  const leadTwo = linkedLead("lead-2", "message-2");
  const originalOne = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const originalTwo = { id: "message-2", kind: "lead", lead_id: "lead-2" };
  const harness = installHarness({
    leads: [leadOne, leadTwo],
    inbox: [originalOne, originalTwo],
    patchOutcomes: ["success", "failure"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [
      { id: "message-1", kind: "client", leadId: "lead-1" },
      { id: "message-2", kind: "other", leadId: "lead-2" },
    ],
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.partial, true);
  assert.deepEqual(harness.leadValue(), [leadOne, leadTwo]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
  assert.deepEqual(harness.inboxRow("message-2"), originalTwo);
  assert.equal(harness.events.filter((event) => event === "leads:cas:success").length, 2);
});

test("a second repair safely finishes the first repair's partial Inbox progress", async () => {
  const leadOne = linkedLead("lead-1", "message-1");
  const leadTwo = linkedLead("lead-2", "message-2");
  const harness = installHarness({
    leads: [leadOne, leadTwo],
    inbox: [
      { id: "message-1", kind: "lead", lead_id: "lead-1" },
      { id: "message-2", kind: "lead", lead_id: "lead-2" },
    ],
    patchOutcomes: ["success", "failure", "success", "success"],
  });
  const request = post({
    action: "repairImportedLeads",
    repairs: [
      { id: "message-1", kind: "client", leadId: "lead-1" },
      { id: "message-2", kind: "other", leadId: "lead-2" },
    ],
  });
  const first = makeRes();
  const second = makeRes();

  await inboxHandler(request, first);
  await inboxHandler(request, second);

  assert.equal(first.statusCode, 500);
  assert.equal(first.body.partial, true);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
  assert.deepEqual(harness.inboxRow("message-2"), { id: "message-2", kind: "other", lead_id: "" });
});

test("repair keeps its safe Inbox label when the lead CAS write fails", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const harness = installHarness({
    leads: [lead],
    inbox: [originalInbox],
    patchOutcomes: ["success"],
    casOutcomes: ["success", "failure", "success"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.partial, true);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
  assert.deepEqual(harness.events.filter((event) => event.startsWith("leads:cas:")), ["leads:cas:success", "leads:cas:failure", "leads:cas:success"]);
});

test("repair returns the real removed snapshot when the final CAS response is lost", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [lead],
    inbox: [{ id: "message-1", kind: "lead", lead_id: "lead-1" }],
    casOutcomes: ["success", "applied_failure"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recovered, true);
  assert.equal(res.body.removedCount, 1);
  assert.deepEqual(res.body.removed, [lead]);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
});

test("repair continues when its initial marker CAS committed but the response was lost", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [lead],
    inbox: [{ id: "message-1", kind: "lead", lead_id: "lead-1" }],
    casOutcomes: ["applied_failure", "success"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removedCount, 1);
  assert.deepEqual(res.body.removed, [lead]);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
});

test("repair recovers Undo data when its first post-commit verification read fails", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [lead],
    inbox: [{ id: "message-1", kind: "lead", lead_id: "lead-1" }],
    casOutcomes: ["success", "applied_failure"],
    leadReadOutcomes: ["success", "success", "failure", "success"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recovered, true);
  assert.equal(res.body.removedCount, 1);
  assert.deepEqual(res.body.removed, [lead]);
  assert.deepEqual(harness.leadValue(), []);
});

test("repair never removes a lead edited after its operation lock was acquired", async () => {
  const lead = { ...linkedLead("lead-1", "message-1"), service: "Original" };
  const harness = installHarness({
    leads: [lead],
    inbox: [{ id: "message-1", kind: "lead", lead_id: "lead-1" }],
    patchOutcomes: [{
      outcome: "success",
      externalLeadPatches: [{ id: "lead-1", fields: { service: "Changed on another device" } }],
    }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.partial, true);
  assert.deepEqual(harness.leadValue(), [{ ...lead, service: "Changed on another device" }]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
});

test("a fresh Undo operation marker blocks an opposing stale Fix", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const undoInFlight = {
    ...lead,
    _spsInboxOperation: { id: "undo_other", type: "undo", startedAt: Date.now() },
  };
  const harness = installHarness({
    leads: [undoInFlight],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already finishing/i);
  assert.deepEqual(harness.leadValue(), [undoInFlight]);
  assert.equal(harness.events.some((event) => event.startsWith("inbox:patch:")), false);
  assert.equal(harness.events.some((event) => event.startsWith("leads:cas:")), false);
});

test("repair rejects an Inbox row now linked to a different lead", async () => {
  const lead = linkedLead("lead-old", "message-1");
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-new" };
  const harness = installHarness({ leads: [lead], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-old" }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reclassified|linked somewhere else/i);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.some((event) => event.startsWith("leads:cas:") || event.startsWith("inbox:patch:")), false);
});

test("repair rejects an Inbox row reclassified as a bill", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "bill", lead_id: "" };
  const harness = installHarness({ leads: [lead], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "other", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
});

test("repair preserves an existing safe Client classification while finishing lead cleanup", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [lead],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "other", leadId: "lead-1" }],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
});

test("repair refuses a lead that was converted after review", async () => {
  const lead = { ...linkedLead("lead-1", "message-1"), convertedClientId: "client-1", updatedAt: "newer" };
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const harness = installHarness({ leads: [lead], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{
      id: "message-1",
      kind: "client",
      leadId: "lead-1",
      expectedUpdatedAt: "older",
      expectedStatus: "new",
      expectedConvertedClientId: "",
    }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.partial, undefined);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.some((event) => event.startsWith("inbox:patch:")), false);
});

test("repair refuses a lead edited after the review snapshot", async () => {
  const lead = { ...linkedLead("lead-1", "message-1"), updatedAt: "newer", service: "Owner corrected this" };
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const harness = installHarness({ leads: [lead], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({
    action: "repairImportedLeads",
    repairs: [{ id: "message-1", kind: "client", leadId: "lead-1", expectedUpdatedAt: "older", expectedStatus: "new", expectedConvertedClientId: "" }],
  }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.some((event) => event.startsWith("inbox:patch:")), false);
});

test("Undo keeps its additive lead when the Inbox relink PATCH fails", async () => {
  const repairedLead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "client", lead_id: "" };
  const harness = installHarness({
    leads: [],
    inbox: [originalInbox],
    patchOutcomes: ["zero"],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "restoreImportedLeads",
    records: [repairedLead],
  }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.partial, true);
  assert.deepEqual(harness.leadValue(), [repairedLead]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.filter((event) => event.startsWith("leads:cas:success")).length, 2);
});

test("Undo does not claim restoration when a partial Inbox PATCH coincides with lead deletion", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
    patchOutcomes: [{ outcome: "failure", externalLeadDeletes: ["lead-1"] }],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.inboxUpdated, false);
  assert.doesNotMatch(res.body.error, /lead was restored/i);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "client", lead_id: "" });
});

test("a second Undo can safely finish the link created by a partial first Undo", async () => {
  const repairedLead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
    patchOutcomes: ["failure", "success"],
  });
  const first = makeRes();
  const second = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [repairedLead] }), first);
  await inboxHandler(post({ action: "restoreImportedLeads", records: [repairedLead] }), second);

  assert.equal(first.statusCode, 500);
  assert.equal(first.body.partial, true);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(harness.leadValue(), [repairedLead]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "lead", lead_id: "lead-1" });
  assert.equal(harness.events.filter((event) => event.startsWith("leads:cas:success")).length, 4);
});

test("Undo accepts a concurrent relink and never compensates its restored lead", async () => {
  const repairedLead = linkedLead("lead-1", "message-1");
  const originalInbox = { id: "message-1", kind: "client", lead_id: "" };
  const concurrentResult = { id: "message-1", kind: "lead", lead_id: "lead-1" };
  const harness = installHarness({
    leads: [],
    inbox: [originalInbox],
    patchOutcomes: [{ outcome: "zero", externalRows: [concurrentResult] }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "restoreImportedLeads",
    records: [repairedLead],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.inboxUpdated, true);
  assert.deepEqual(harness.leadValue(), [repairedLead]);
  assert.deepEqual(harness.inboxRow("message-1"), concurrentResult);
  assert.equal(harness.events.filter((event) => event.startsWith("leads:cas:success")).length, 2);
  assert.equal(harness.events.filter((event) => event.startsWith("inbox:patch:")).length, 1);
});

test("Undo confirms durable success when its marker-clear CAS response is lost", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
    casOutcomes: ["success", "applied_failure"],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recovered, true);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "lead", lead_id: "lead-1" });
});

test("Undo never reports success if the restored lead disappears before finalization", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
    patchOutcomes: [{ outcome: "success", externalLeadDeletes: ["lead-1"] }],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.partial, true);
  assert.equal(res.body.inboxUpdated, true);
  assert.match(res.body.error, /Inbox link saved/i);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "lead", lead_id: "lead-1" });
});

test("Undo continues when its initial marker CAS committed but the response was lost", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const harness = installHarness({
    leads: [],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
    casOutcomes: ["applied_failure", "success"],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "lead", lead_id: "lead-1" });
});

test("a fresh Fix operation marker blocks an opposing Undo", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const fixInFlight = {
    ...lead,
    _spsInboxOperation: { id: "repair_other", type: "repair", startedAt: Date.now() },
  };
  const harness = installHarness({
    leads: [fixInFlight],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /already finishing/i);
  assert.deepEqual(harness.leadValue(), [fixInFlight]);
  assert.equal(harness.events.some((event) => event.startsWith("inbox:patch:")), false);
  assert.equal(harness.events.some((event) => event.startsWith("leads:cas:")), false);
});

test("Undo rejects an Inbox row linked to a different lead", async () => {
  const requested = linkedLead("lead-old", "message-1");
  const current = linkedLead("lead-new", "message-1");
  const originalInbox = { id: "message-1", kind: "lead", lead_id: "lead-new" };
  const harness = installHarness({ leads: [current], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [requested] }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /reclassified|linked somewhere else/i);
  assert.deepEqual(harness.leadValue(), [current]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.some((event) => event.startsWith("leads:cas:") || event.startsWith("inbox:patch:")), false);
});

test("Undo rejects an Inbox row reclassified as a bill", async () => {
  const requested = linkedLead("lead-old", "message-1");
  const originalInbox = { id: "message-1", kind: "bill", lead_id: "" };
  const harness = installHarness({ leads: [], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [requested] }), res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(harness.leadValue(), []);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
});

test("Undo safely takes over an expired operation marker", async () => {
  const lead = linkedLead("lead-1", "message-1");
  const stale = {
    ...lead,
    _spsInboxOperation: { id: "repair_stale", type: "repair", startedAt: 0 },
  };
  const harness = installHarness({
    leads: [stale],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
  });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [lead] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.leadValue(), [lead]);
  assert.deepEqual(harness.inboxRow("message-1"), { id: "message-1", kind: "lead", lead_id: "lead-1" });
});

test("Undo deduplicates duplicate srcId records before restoring or patching", async () => {
  const first = linkedLead("lead-first", "message-1");
  const duplicate = { ...linkedLead("lead-duplicate", "message-1"), name: "Duplicate payload" };
  const harness = installHarness({
    leads: [{ id: "keep", source: "manual" }],
    inbox: [{ id: "message-1", kind: "client", lead_id: "" }],
  });
  const res = makeRes();

  await inboxHandler(post({
    action: "restoreImportedLeads",
    records: [first, duplicate],
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.restoredCount, 1);
  assert.deepEqual(harness.leadValue().map((lead) => lead.id), ["lead-first", "keep"]);
  assert.equal(harness.inboxRow("message-1").lead_id, "lead-first");
  assert.equal(harness.events.filter((event) => event.startsWith("inbox:patch:message-1:lead:")).length, 1);
});

test("Undo refuses to relink a source now owned by a different lead", async () => {
  const requested = linkedLead("lead-old", "message-1");
  const current = linkedLead("lead-new", "message-1");
  const originalInbox = { id: "message-1", kind: "client", lead_id: "" };
  const harness = installHarness({ leads: [current], inbox: [originalInbox] });
  const res = makeRes();

  await inboxHandler(post({ action: "restoreImportedLeads", records: [requested] }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /different lead/i);
  assert.deepEqual(harness.leadValue(), [current]);
  assert.deepEqual(harness.inboxRow("message-1"), originalInbox);
  assert.equal(harness.events.some((event) => event.startsWith("inbox:patch:")), false);
});
