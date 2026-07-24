const PHONE_FIELDS = [
  "phone",
  "mobile",
  "cell",
  "phone2",
  "alternatePhone",
  "workPhone",
  "businessPhone",
];

export function normalizeSmsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export function parseSmsTestRedirect(body) {
  const text = String(body || "");
  const match = text.match(/^\s*\[TEST\s*(?:→|->)\s*([^\]]+)\]\s*/i);
  if (!match) return null;
  const phone = normalizeSmsPhone(match[1]);
  if (phone.length !== 10) return null;
  return {
    phone,
    body: text.slice(match[0].length).trim(),
  };
}

export function smsLineForRow(row, lineNumbers = {}) {
  if (parseSmsTestRedirect(row?.body_text)) {
    const sender = normalizeSmsPhone(row?.from_phone);
    if (sender && sender === normalizeSmsPhone(lineNumbers.automation)) return "automation";
    if (sender && sender === normalizeSmsPhone(lineNumbers.main)) return "main";
  }
  const value = String(row?.sms_line || row?.ai?.quoLine || "").trim().toLowerCase();
  return value === "main" ? "main" : "automation";
}

export function smsDirectionForRow(row) {
  if (parseSmsTestRedirect(row?.body_text)) return "outgoing";
  const value = String(row?.sms_direction || row?.direction || "").trim().toLowerCase();
  return ["outgoing", "sent", "delivered"].includes(value) ? "outgoing" : "incoming";
}

export function smsPeerPhoneForRow(row) {
  const redirected = parseSmsTestRedirect(row?.body_text);
  if (redirected) return redirected.phone;
  const explicit = normalizeSmsPhone(row?.sms_peer_phone);
  if (explicit) return explicit;
  if (smsDirectionForRow(row) === "outgoing") {
    return normalizeSmsPhone(row?.to_phone || row?.recipient_phone || row?.from_phone);
  }
  return normalizeSmsPhone(row?.from_phone || row?.sender_phone);
}

function clientPhones(client) {
  const values = PHONE_FIELDS.flatMap((field) => {
    const value = client?.[field];
    return Array.isArray(value) ? value : [value];
  });
  if (Array.isArray(client?.phones)) values.push(...client.phones);
  return values.map(normalizeSmsPhone).filter(Boolean);
}

export function findSmsContact(clients, phone) {
  const needle = normalizeSmsPhone(phone);
  if (!needle) return null;
  const matches = (Array.isArray(clients) ? clients : []).filter((client) => clientPhones(client).includes(needle));
  return matches.length === 1 ? matches[0] : null;
}

function conversationKeyForRow(row, lineNumbers) {
  const line = smsLineForRow(row, lineNumbers);
  const testRedirect = !!parseSmsTestRedirect(row?.body_text)
    || String(row?.sms_status || "").toLowerCase().includes("test_redirect")
    || row?.ai?.testRedirected === true;
  const provider = String(row?.quo_conversation_id || "").trim();
  const peer = smsPeerPhoneForRow(row);
  // A user-facing thread is one SPS line + one outside phone number. Quo conversation ids are
  // useful provider metadata, but imports, transfers, and provider-side thread replacements can
  // change that id for the same person. Using it first would split ordinary replies into separate
  // inbox/lead-style cards. The normalized peer also prevents one reused provider id from joining
  // two people's private histories. Test Mode already resolves `peer` to the intended customer.
  if (peer) return `${line}|phone:${peer}`;
  // Only malformed/legacy rows without a usable phone fall back to the provider id. In Test Mode
  // that id belongs to the redirect device and must never be used as a customer conversation key.
  if (provider && !testRedirect) return `${line}|quo:${provider}`;
  return `${line}|unknown:${String(row?.id || "")}`;
}

function messageBody(row) {
  const redirected = parseSmsTestRedirect(row?.body_text);
  return redirected ? redirected.body : String(row?.body_text || "");
}

function createdTime(row) {
  const value = new Date(row?.created_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function contactNameFromMessages(messages) {
  const newestFirst = [...messages].reverse();
  // Quo/SPS contact names are authoritative. Search all messages before considering from_name:
  // a newer webhook commonly stores the raw phone in from_name and used to hide a valid name
  // cached on an older message in the same conversation.
  const explicit = newestFirst
    .map((row) => String(row?.sms_contact_name || row?.quo_contact_name || "").trim())
    .find(Boolean);
  if (explicit) return explicit;
  return newestFirst
    .map((row) => String(row?.from_name || "").trim())
    .find((name) => name && normalizeSmsPhone(name).length !== 10) || "";
}

function contactPhotoFromMessages(messages) {
  return [...messages].reverse()
    .map((row) => row?.sms_contact_avatar_url || row?.quo_contact_photo_url || row?.quo_contact_photo_path || "")
    .find(Boolean) || "";
}

function contactIdFromMessages(messages) {
  return [...messages].reverse()
    .map((row) => row?.quo_contact_id || row?.contact_id || null)
    .find(Boolean) || null;
}

export function groupSmsConversations(rows, clients = [], lineNumbers = {}, threadMetadata = {}) {
  const groups = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || raw.channel !== "sms") continue;
    const line = smsLineForRow(raw, lineNumbers);
    const peerPhone = smsPeerPhoneForRow(raw);
    const direction = smsDirectionForRow(raw);
    const message = {
      ...raw,
      body_text: messageBody(raw),
      sms_line: line,
      sms_peer_phone: peerPhone,
      sms_direction: direction,
      _smsDirection: direction,
      _isTestRedirect: !!parseSmsTestRedirect(raw.body_text),
    };
    const key = conversationKeyForRow(raw, lineNumbers);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }

  return [...groups.entries()].map(([key, messages]) => {
    messages.sort((a, b) => createdTime(a) - createdTime(b));
    const latest = messages[messages.length - 1];
    const peerPhone = latest.sms_peer_phone || "";
    const contact = findSmsContact(clients, peerPhone);
    const providerName = contactNameFromMessages(messages);
    const displayName = contact?.name || providerName || "";
    const linkedLeadId = [...messages].reverse().map((row) => String(row?.lead_id || "").trim()).find(Boolean) || "";
    const savedThread = threadMetadata && typeof threadMetadata === "object" && !Array.isArray(threadMetadata)
      ? threadMetadata[key]
      : null;
    const savedKind = ["lead", "bill", "client", "other"].includes(String(savedThread?.kind || "").toLowerCase())
      ? String(savedThread.kind).toLowerCase()
      : "";
    const savedLeadId = String(savedThread?.leadId || "").trim();
    const unreadCount = messages.filter((message) => !message.read && message.sms_direction !== "outgoing").length;
    const latestBody = String(latest.body_text || "").trim();
    return {
      ...latest,
      id: latest.id,
      channel: "sms",
      from_phone: peerPhone,
      from_name: displayName,
      subject: `${latest.sms_direction === "outgoing" ? "You: " : ""}${latestBody || (latest.sms_media?.length ? "Photo attachment" : "Text message")}`,
      body_text: latestBody,
      read: unreadCount === 0,
      replied: messages.some((message) => !!message.replied) || latest.sms_direction === "outgoing",
      // A later ordinary reply must not make an already-created lead appear unlinked. The durable
      // lead marker lives on the message that created it; surface it at conversation level while
      // retaining all raw per-message records below.
      kind: savedKind || (linkedLeadId ? "lead" : (latest.kind || "other")),
      lead_id: savedLeadId || linkedLeadId || latest.lead_id || "",
      _smsThreadMetadata: savedThread || null,
      sms_line: latest.sms_line,
      sms_peer_phone: peerPhone,
      _smsConversation: true,
      _smsConversationKey: key,
      _smsMessages: messages,
      _messageIds: messages.map((message) => message.id).filter((id) => id != null),
      _unreadCount: unreadCount,
      _messageCount: messages.length,
      _contactId: contact?.id || contactIdFromMessages(messages),
      _contactPhoto: contact?.photo || contact?.photoUrl || contact?.avatarUrl || contactPhotoFromMessages(messages),
      _lastDirection: latest.sms_direction,
    };
  }).sort((a, b) => createdTime(b) - createdTime(a));
}

export function mergeInboxConversationRows(rows, clients = [], lineNumbers = {}, threadMetadata = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const emails = source.filter((row) => row && row.channel !== "sms");
  return [...emails, ...groupSmsConversations(source, clients, lineNumbers, threadMetadata)]
    .sort((a, b) => createdTime(b) - createdTime(a));
}

export function inboxRowMessageIds(row) {
  const ids = Array.isArray(row?._messageIds) ? row._messageIds : [row?.id];
  return [...new Set(ids.filter((id) => id != null))];
}
