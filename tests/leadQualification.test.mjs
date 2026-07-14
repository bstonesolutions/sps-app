import test from "node:test";
import assert from "node:assert/strict";

import {
  assessInboundLead,
  findMisfiledImportedLead,
  hasExplicitNewBusinessIntent,
  isAutomatedLeadSender,
} from "../leadQualification.js";

const clients = [
  { id: "c1", name: "Mike Melillo", email: "mike@example.com", phone: "(484) 555-1000" },
  { id: "c2", name: "Ray Michele Ibarguen", email: "ray@example.com", phone: "484-555-2000" },
];

test("recognizes automated service-platform and notification senders", () => {
  assert.equal(isAutomatedLeadSender("messages@appmail.getskimmer.com"), true);
  assert.equal(isAutomatedLeadSender("notifications@github.com"), true);
  assert.equal(isAutomatedLeadSender("person@gmail.com"), false);
});

test("requires high-confidence, explicit new-business intent", () => {
  const qualified = assessInboundLead({
    from_email: "prospect@gmail.com",
    subject: "Pond cleaning estimate",
    body_text: "Could you provide an estimate to clean our pond?",
    ai: { kind: "lead", confidence: 0.94, intent: "new_business", automated: false, evidence: "provide an estimate", summary: "A prospect wants an estimate.", lead: { name: "Pat", service: "Pond cleaning" } },
  }, clients);
  assert.equal(qualified.eligible, true);

  const lowConfidence = assessInboundLead({
    from_email: "prospect@gmail.com",
    subject: "Quote",
    body_text: "Can you quote this?",
    ai: { kind: "lead", confidence: 0.55, intent: "new_business", automated: false, evidence: "quote", lead: {} },
  }, clients);
  assert.equal(lowConfidence.eligible, false);
  assert.equal(lowConfidence.reason, "low_confidence");

  assert.equal(hasExplicitNewBusinessIntent("Leak check + maintenance service"), false);

  const existingService = assessInboundLead({
    from_email: "unknown-address@gmail.com",
    subject: "Schedule change",
    body_text: "Can you reschedule my existing service?",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: false, evidence: "reschedule my existing service", summary: "They want pool service.", lead: { name: "Pat", service: "Pool service" } },
  }, clients);
  assert.equal(existingService.eligible, false);
  assert.equal(existingService.reason, "no_explicit_new_business_intent");

  const hallucinatedSummary = assessInboundLead({
    from_email: "unknown-address@gmail.com",
    subject: "Hello",
    body_text: "Hello there",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: false, evidence: "Hello", summary: "They would like a quote for pool service.", lead: { service: "Pool service" } },
  }, clients);
  assert.equal(hallucinatedSummary.eligible, false);
  assert.equal(hallucinatedSummary.reason, "no_explicit_new_business_intent");

  const paraphrasedEvidence = assessInboundLead({
    from_email: "unknown-address@gmail.com",
    subject: "Pool quote",
    body_text: "Could you provide an estimate to clean our pool?",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: false, evidence: "wants pool pricing", lead: {} },
  }, clients);
  assert.equal(paraphrasedEvidence.eligible, false);
  assert.equal(paraphrasedEvidence.reason, "incomplete_lead_evidence");

  const aiMarkedAutomated = assessInboundLead({
    from_email: "person@gmail.com",
    subject: "Pool quote",
    body_text: "Could you provide an estimate to clean our pool?",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: true, evidence: "provide an estimate", lead: {} },
  }, clients);
  assert.equal(aiMarkedAutomated.eligible, false);
  assert.equal(aiMarkedAutomated.reason, "incomplete_lead_evidence");
});

test("never auto-imports automated service notices as leads", () => {
  const result = assessInboundLead({
    from_email: "messages@appmail.getskimmer.com",
    subject: "New Repair added for Mike Melillo",
    body_text: "Leak check + maintenance service",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: false, evidence: "Leak check", summary: "Mike needs maintenance.", lead: { name: "Mike Melillo", service: "Pool" } },
  }, clients);
  assert.equal(result.eligible, false);
  assert.equal(result.kind, "client");
  assert.equal(result.client.id, "c1");
});

test("exact client contacts cannot become automatic email or SMS leads", () => {
  const email = assessInboundLead({
    from_email: "mike@example.com",
    subject: "Need service",
    body_text: "Can you schedule service?",
    ai: { kind: "lead", confidence: 0.98, intent: "new_business", automated: false, evidence: "schedule service", lead: { name: "Mike Melillo" } },
  }, clients);
  assert.equal(email.eligible, false);
  assert.equal(email.kind, "client");

  const sms = assessInboundLead({
    channel: "sms",
    from_phone: "4845552000",
    body_text: "Can you repair the lights?",
    ai: { kind: "lead", confidence: 0.98, intent: "new_business", automated: false, evidence: "repair the lights", lead: {} },
  }, clients);
  assert.equal(sms.eligible, false);
  assert.equal(sms.client.id, "c2");
});

test("flags old AppMail imports for linked cleanup but leaves genuine prospects alone", () => {
  const falseLead = findMisfiledImportedLead({
    id: "lead_e123",
    srcId: "em_123",
    source: "email",
    sourceDetail: "messages@appmail.getskimmer.com",
    email: "messages@appmail.getskimmer.com",
    name: "Ray Michele Ibarguen",
    message: "Drain and repair lights",
    timeline: [],
  }, clients);
  assert.equal(falseLead.kind, "client");
  assert.equal(falseLead.client.id, "c2");

  const realLead = findMisfiledImportedLead({
    id: "lead_e456",
    srcId: "em_456",
    source: "email",
    sourceDetail: "prospect@gmail.com",
    email: "prospect@gmail.com",
    name: "New Prospect",
    message: "Could you provide an estimate for a new pond?",
    timeline: [],
  }, clients);
  assert.equal(realLead, null);

  const ambiguousAutomatedLead = findMisfiledImportedLead({
    id: "lead_e789",
    srcId: "em_789",
    source: "email",
    sourceDetail: "notifications@forms.example.com",
    email: "notifications@forms.example.com",
    name: "New Prospect",
    message: "Could you provide an estimate for a new pond?",
    timeline: [],
  }, clients);
  assert.equal(ambiguousAutomatedLead, null);

  const sameNameContactFormLead = findMisfiledImportedLead({
    id: "lead_e790",
    srcId: "em_790",
    source: "email",
    sourceDetail: "notifications@forms.example.com",
    email: "notifications@forms.example.com",
    name: "Mike Melillo",
    message: "Could you provide an estimate for a new pond?",
    timeline: [],
  }, clients);
  assert.equal(sameNameContactFormLead, null);

  const legacyMixedCase = findMisfiledImportedLead({
    id: "lead_e999",
    srcId: "em_999",
    source: "Email",
    sourceDetail: "messages@appmail.getskimmer.com",
    email: "messages@appmail.getskimmer.com",
    name: "Mike Melillo",
    message: "New repair added",
    timeline: [],
  }, clients);
  assert.equal(legacyMixedCase.kind, "client");
});

test("shared client contact details never auto-attach or become a lead", () => {
  const sharedClients = [
    ...clients,
    { id: "c3", name: "Another Household", email: "shared@example.com", phone: "484-555-3000" },
    { id: "c4", name: "Second Household", email: "shared@example.com", phone: "484-555-4000" },
  ];
  const result = assessInboundLead({
    from_email: "shared@example.com",
    subject: "Pool estimate",
    body_text: "Could you provide an estimate for our pool?",
    ai: { kind: "lead", confidence: 0.99, intent: "new_business", automated: false, evidence: "provide an estimate", lead: {} },
  }, sharedClients);
  assert.equal(result.eligible, false);
  assert.equal(result.kind, "other");
  assert.equal(result.reason, "ambiguous_existing_client_contact");
});
