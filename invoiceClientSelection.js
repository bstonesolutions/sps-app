const clientIdKey = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  return String(value).trim();
};

const validClient = (client) => !!client && !!clientIdKey(client.id)
  && typeof client.name === "string" && !!client.name.trim();

// An invoice must point to one actual client. Never infer a client from its
// display order or a name snapshot, and never choose between duplicate IDs.
export function resolveInvoiceClient(clients, clientId) {
  const key = clientIdKey(clientId);
  if (!key) return null;
  const matches = (Array.isArray(clients) ? clients : [])
    .filter(client => validClient(client) && clientIdKey(client.id) === key);
  return matches.length === 1 ? matches[0] : null;
}

export function initialInvoiceClientId(clients, presetClientId) {
  return resolveInvoiceClient(clients, presetClientId)?.id ?? null;
}

// Inactive clients can still owe for prior work. Include them deliberately in
// the invoice picker, independently of the active-only route/schedule pickers.
export function invoiceClientChoices(clients, query = "") {
  const source = Array.isArray(clients) ? clients : [];
  const idCounts = new Map();
  source.filter(validClient).forEach(client => {
    const key = clientIdKey(client.id);
    idCounts.set(key, (idCounts.get(key) || 0) + 1);
  });
  const terms = String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return source.filter(client => {
    if (!validClient(client) || idCounts.get(clientIdKey(client.id)) !== 1) return false;
    const searchable = [client.name, client.address, client.email]
      .filter(value => typeof value === "string").join(" ").toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  }).slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function invoiceClientSnapshot(invoice, clients) {
  const client = resolveInvoiceClient(clients, invoice?.clientId);
  if (!client) return null;
  return {
    ...invoice,
    clientId: client.id,
    clientName: client.name,
    clientAddress: client.address || "",
    clientEmail: client.email || "",
  };
}
