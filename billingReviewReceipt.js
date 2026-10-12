// One edit contract for the endpoint and interrupted-response recovery in the UI.
export const BILLING_REVIEW_EDIT_FIELDS = ["title", "date", "dueDate", "termsDays", "taxRate", "notes", "discountType", "discount", "serviceMonth", "lineItems"];
export const BILLING_REVIEW_LINE_EDIT_FIELDS = ["id", "desc", "qty", "unitPrice", "unitCost", "knownUnitCost", "costKnown", "taxable", "kind", "refId", "unit", "bundleNote", "bundleItems", "discountType", "discount", "serviceMonth", "serviceDate", "maintenanceService", "isLateFee"];

const text = value => String(value ?? "").trim();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]))
  : value;
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const projectedLine = line => Object.fromEntries(BILLING_REVIEW_LINE_EDIT_FIELDS
  .filter(key => Object.hasOwn(line, key) && line[key] !== undefined)
  .map(key => [key, key === "id" ? text(line[key]) : line[key]]));

// A failed HTTP response is not proof that a write failed. Recover only a newer,
// editable canonical row containing every requested edit. A true conflict keeps
// the owner's typed form intact instead of replacing it with an older server row.
export function billingReviewSaveReceiptMatches(requested, canonical) {
  if (!requested || !canonical || !text(requested.id) || text(requested.id) !== text(canonical.id)
    || !text(requested.clientId) || text(requested.clientId) !== text(canonical.clientId)
    || canonical.recordType !== "billing-review" || canonical.reviewState !== "pending"
    || (canonical.approval && canonical.approval.state !== "rejected")
    || !Number.isSafeInteger(Number(requested.reviewRevision)) || !Number.isSafeInteger(Number(canonical.reviewRevision))
    || Number(canonical.reviewRevision) <= Number(requested.reviewRevision)) return false;
  return BILLING_REVIEW_EDIT_FIELDS.every(key => {
    if (!Object.hasOwn(requested, key) || requested[key] === undefined) return true;
    if (key !== "lineItems") return same(requested[key], canonical[key]);
    if (!Array.isArray(requested.lineItems) || !Array.isArray(canonical.lineItems)
      || requested.lineItems.length !== canonical.lineItems.length) return false;
    return requested.lineItems.every((line, index) => {
      const saved = canonical.lineItems[index];
      if (!line || !saved || !text(line.id) || text(line.id) !== text(saved.id)) return false;
      return same(projectedLine(line), projectedLine(saved));
    });
  });
}
