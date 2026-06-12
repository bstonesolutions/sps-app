// api/quickbooks/qb-helpers.js
// Shared helpers for mapping app line items to real QuickBooks items and tax codes.

// App line "kind" → the QuickBooks item it should map to.
const KIND_TO_ITEM = {
  service:   "Services",
  product:   "Product Sales",
  treatment: "Materials",
  part:      "Materials",
  bundle:    "Materials",
};
const DEFAULT_ITEM_NAME = "Services";
// Universal fallback so a push never fails on a missing item reference.
const FALLBACK_REF = { value: "1", name: "Services" };

// Build an item resolver bound to one company/request. Finds an item by name,
// creates it once if missing, and caches the resulting ItemRef so each name is
// resolved at most once per request.
export function makeItemResolver(base, headers) {
  const cache = new Map();          // itemName -> { value, name }
  let incomeAccountId;              // undefined until looked up; null if none

  const q = (s) => encodeURIComponent(s);
  const esc = (s) => String(s).replace(/'/g, "\\'");

  async function getIncomeAccountId() {
    if (incomeAccountId !== undefined) return incomeAccountId;
    try {
      const r = await fetch(`${base}/query?query=${q("SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1")}&minorversion=65`, { headers });
      const d = await r.json();
      incomeAccountId = d?.QueryResponse?.Account?.[0]?.Id || null;
    } catch (_) {
      incomeAccountId = null;
    }
    return incomeAccountId;
  }

  async function findItem(name) {
    try {
      const r = await fetch(`${base}/query?query=${q(`SELECT * FROM Item WHERE Name = '${esc(name)}'`)}&minorversion=65`, { headers });
      if (!r.ok) return null;
      const d = await r.json();
      const it = d?.QueryResponse?.Item?.[0];
      return it ? { value: it.Id, name: it.Name } : null;
    } catch (_) {
      return null;
    }
  }

  async function createItem(name) {
    const acct = await getIncomeAccountId();
    if (!acct) return null;
    try {
      const r = await fetch(`${base}/item?minorversion=65`, {
        method: "POST",
        headers,
        body: JSON.stringify({ Name: name, Type: "Service", IncomeAccountRef: { value: acct } }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      const it = d?.Item;
      return it ? { value: it.Id, name: it.Name } : null;
    } catch (_) {
      return null;
    }
  }

  // Resolve a line "kind" to a usable QuickBooks ItemRef.
  return async function resolveItemRef(kind) {
    const name = KIND_TO_ITEM[kind] || DEFAULT_ITEM_NAME;
    if (cache.has(name)) return cache.get(name);
    const ref = (await findItem(name)) || (await createItem(name)) || FALLBACK_REF;
    cache.set(name, ref);
    return ref;
  };
}

// The line-level tax code for a taxable / non-taxable line. "TAX" and "NON" are
// QuickBooks' universal US sales-tax codes; with Automated Sales Tax enabled QB
// computes the actual rate from the customer's address.
export function lineTaxCodeRef(taxable) {
  return { value: taxable ? "TAX" : "NON" };
}
