// Fail-closed qualification for messages that may become sales leads.
//
// AI triage is useful for organizing the Inbox, but it is not enough evidence to create a
// pipeline record by itself. Automated service-platform notices routinely contain words such as
// "repair", "maintenance", and a client's name, which can look like a new inquiry out of context.
// These helpers keep those notices in Inbox while preserving the owner's manual "Add to Leads"
// action for anything the conservative gate does not auto-import.

const text = (value) => String(value == null ? "" : value).trim();

export const normalizeLeadEmail = (value) => text(value).toLowerCase();
export const normalizeLeadPhone = (value) => text(value).replace(/\D/g, "").slice(-10);
export const normalizeLeadName = (value) => text(value)
  .toLowerCase()
  .replace(/\b(?:mr|mrs|ms|miss|dr)\.?\s+/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const AUTOMATED_LOCAL_PART = /^(?:no-?reply|do-?not-?reply|notifications?|alerts?|automated?|automation|system|mailer-daemon|postmaster)(?:[+._-]|$)/i;
const AUTOMATED_DOMAIN = /(^|\.)(?:appmail|getskimmer|skimmer|getjobber|jobber|housecallpro|servicetitan|servicefusion|fieldedge|poolbrain|github|vercel)\./i;
const SERVICE_PLATFORM_DOMAIN = /(^|\.)(?:appmail|getskimmer|skimmer|getjobber|jobber|housecallpro|servicetitan|servicefusion|fieldedge|poolbrain)\./i;

export function isAutomatedLeadSender(value) {
  const email = normalizeLeadEmail(value);
  if (!email || !email.includes("@")) return false;
  const [local, domain] = email.split("@");
  return AUTOMATED_LOCAL_PART.test(local || "") || AUTOMATED_DOMAIN.test(`${domain || ""}.`);
}

function isServicePlatformSender(value) {
  const email = normalizeLeadEmail(value);
  const domain = email.includes("@") ? email.split("@").pop() : "";
  return SERVICE_PLATFORM_DOMAIN.test(`${domain || ""}.`);
}

export function looksLikeOperationalNotice(...values) {
  const value = values.map(text).join(" \n ").toLowerCase();
  return /\b(?:service (?:report|visit|completed|complete|summary)|your service report|new repair(?: was)? added|repair (?:was )?(?:added|updated|completed)|work order|job (?:created|updated|completed)|technician (?:assigned|arrived|completed)|route update|appointment (?:scheduled|updated|completed)|maintenance (?:report|visit)|client portal notification)\b/i.test(value);
}

export function hasExplicitNewBusinessIntent(...values) {
  const value = values.map(text).join(" \n ").toLowerCase();
  if (!value) return false;
  // Existing-service requests often contain the same verbs as a prospect inquiry. Automatic lead
  // creation is deliberately conservative; staff can still use "Add to Leads" for an edge case.
  if (/\b(?:reschedul(?:e|ed|ing)|existing (?:service|customer|appointment)|current (?:service|customer|appointment)|already (?:a )?(?:client|customer)|my (?:regular|weekly|monthly) service|service report|work order|technician|appointment (?:change|update|reminder))\b/i.test(value)) return false;
  if (/\b(?:quote|estimate|pricing|price range|how much|consultation|new customer|first[- ]time customer|looking for|seeking|hire (?:you|someone)|request(?:ing)? (?:new )?service)\b/i.test(value)) return true;
  if (/\binterested in\b.{0,70}\b(?:service|clean(?:ing)?|maintenance|repair|install(?:ation)?|pond|pool|water feature)\b/i.test(value)) return true;
  if (/\b(?:can|could|would) you\b.{0,55}\b(?:clean|repair|install|build|replace|remove|maintain|open|close|winteriz(?:e|ing)|inspect|service)\b/i.test(value)) return true;
  if (/\b(?:need|want|would like)\b.{0,65}\b(?:a quote|an estimate|someone to|service for|clean(?:ed|ing)?|repair(?:ed)?|install(?:ed|ation)?|maintenance for|help with)\b/i.test(value)) return true;
  if (/\bdo you (?:offer|provide|service|install|clean|maintain|repair)\b/i.test(value)) return true;
  return false;
}

function uniqueMatch(clients, predicate) {
  const matches = (Array.isArray(clients) ? clients : []).filter((client) => client && predicate(client));
  return matches.length === 1 ? matches[0] : null;
}

function contactClientMatch(input, clients) {
  const aiLead = input && input.ai && input.ai.lead ? input.ai.lead : {};
  const emails = [...new Set([input && (input.from_email || input.fromEmail), aiLead.email]
    .map(normalizeLeadEmail).filter(Boolean))];
  for (const email of emails) {
    const matches = (Array.isArray(clients) ? clients : []).filter((client) => client && normalizeLeadEmail(client.email) === email);
    if (matches.length === 1) return { client: matches[0], basis: "email" };
    if (matches.length > 1) return { client: null, basis: "email", ambiguous: true };
  }
  const phones = [...new Set([input && (input.from_phone || input.fromPhone), aiLead.phone]
    .map(normalizeLeadPhone).filter((phone) => phone.length === 10))];
  for (const phone of phones) {
    const matches = (Array.isArray(clients) ? clients : []).filter((client) => client && normalizeLeadPhone(client.phone) === phone);
    if (matches.length === 1) return { client: matches[0], basis: "phone" };
    if (matches.length > 1) return { client: null, basis: "phone", ambiguous: true };
  }
  return null;
}

function nameClientMatch(input, clients) {
  const aiLead = input && input.ai && input.ai.lead ? input.ai.lead : {};
  const name = normalizeLeadName(aiLead.name || (input && (input.from_name || input.fromName)));
  if (name.length < 4) return null;
  const client = uniqueMatch(clients, (candidate) => normalizeLeadName(candidate.name) === name);
  return client ? { client, basis: "name" } : null;
}

// Returns the only decision the automatic importer should trust. Rejected messages remain visible
// in Inbox and can still be added manually by the owner.
export function assessInboundLead(input = {}, clients = []) {
  const ai = input.ai && typeof input.ai === "object" ? input.ai : {};
  const aiLead = ai.lead && typeof ai.lead === "object" ? ai.lead : {};
  const senderEmail = input.from_email || input.fromEmail || "";
  const subject = input.subject || "";
  const body = input.body_text || input.bodyText || "";
  const operational = looksLikeOperationalNotice(subject, body, ai.summary, aiLead.message);
  const automated = String(input.channel || "email").toLowerCase() !== "sms" && isAutomatedLeadSender(senderEmail);
  const contactMatch = contactClientMatch({ ...input, ai }, clients);
  const nameMatch = nameClientMatch({ ...input, ai }, clients);
  if (contactMatch && contactMatch.ambiguous) {
    return { eligible: false, reason: "ambiguous_existing_client_contact", kind: "other", client: null };
  }
  const matched = contactMatch || ((automated || operational) ? nameMatch : null);

  if (matched) return { eligible: false, reason: "existing_client_activity", kind: "client", client: matched.client };
  if (automated) return { eligible: false, reason: "automated_notice", kind: "other", client: null };
  if (operational) return { eligible: false, reason: "operational_notice", kind: "other", client: null };
  if (String(ai.kind || input.kind || "").toLowerCase() !== "lead") {
    return { eligible: false, reason: "not_classified_as_lead", kind: "other", client: null };
  }

  const confidence = Number(ai.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.92) {
    return { eligible: false, reason: "low_confidence", kind: "other", client: null };
  }
  const evidence = text(ai.evidence);
  const source = `${text(subject)}\n${text(body)}`.toLowerCase();
  if (ai.intent !== "new_business" || ai.automated !== false || evidence.length < 4 || !source.includes(evidence.toLowerCase())) {
    return { eligible: false, reason: "incomplete_lead_evidence", kind: "other", client: null };
  }
  // Only the sender's original words count as intent. AI summaries/extracted service fields are
  // useful display metadata, but they can never manufacture the evidence required to make a lead.
  if (!hasExplicitNewBusinessIntent(subject, body.slice(0, 2000)) || !hasExplicitNewBusinessIntent(evidence)) {
    return { eligible: false, reason: "no_explicit_new_business_intent", kind: "other", client: null };
  }
  return { eligible: true, reason: "qualified", kind: "lead", client: null };
}

// Strong-evidence detector for already-imported records. It intentionally ignores ambiguous
// name-only matches; cleanup is limited to automated notices, exact contact matches, or an exact
// client name paired with unmistakable operational language.
export function findMisfiledImportedLead(lead, clients = []) {
  const source = String((lead && lead.source) || "").toLowerCase();
  if (!lead || !["email", "sms"].includes(source)) return null;
  const sourceEmail = source === "email" ? (lead.sourceDetail || lead.email || "") : "";
  const automated = isAutomatedLeadSender(sourceEmail);
  const servicePlatform = isServicePlatformSender(sourceEmail);
  const contact = contactClientMatch({
    channel: source,
    from_email: source === "email" ? sourceEmail : "",
    from_phone: source === "sms" ? (lead.sourceDetail || lead.phone || "") : "",
    ai: { lead: { email: lead.email, phone: lead.phone, name: lead.name } },
  }, clients);
  const operational = looksLikeOperationalNotice(lead.message, lead.service, ...(lead.timeline || []).map((entry) => entry && entry.text));
  const named = nameClientMatch({ ai: { lead: { name: lead.name } } }, clients);
  if (contact && contact.ambiguous) return { reason: "ambiguous_existing_client_contact", kind: "other", client: null };
  // Name-only cleanup needs unmistakable service context. A generic no-reply contact form can
  // carry the same name as an existing client and still be a legitimate new-business inquiry.
  const matched = contact || ((operational || servicePlatform) ? named : null);
  if (matched) return { reason: "existing_client_activity", kind: "client", client: matched.client };
  // Do not retroactively remove an ambiguous no-reply/contact-form lead just because its sender
  // is automated. Existing cleanup requires an existing-client match or operational wording; all
  // future automated mail is still held in Inbox by assessInboundLead above.
  if (automated && operational) return { reason: "automated_notice", kind: "other", client: null };
  return null;
}
