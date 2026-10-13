import { completedVisitSource } from "./invoiceVisitImport.js";

const text = value => value == null ? "" : String(value).trim();
const list = value => Array.isArray(value) ? value : [];
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const unique = values => [...new Set(values.map(text).filter(Boolean))];
const stableJSON = value => JSON.stringify(value, (_key, item) => (
  record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
));
const values = (item, singular, plural) => unique([item?.[singular], ...list(item?.[plural])]);
const dateKey = value => {
  const raw = text(value);
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return mdy ? `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}` : raw.slice(0, 10);
};

function sourceGroup(item, match, allowReportFields = false) {
  const stopIds = values(item, "sourceStopId", "sourceStopIds");
  const receiptIds = values(item, "sourceCompletionReceiptId", "sourceCompletionReceiptIds");
  if (allowReportFields) {
    stopIds.push(...unique([item?.sid, item?.stopId, item?.visitId]));
    receiptIds.push(...unique([item?.completionReceiptId, item?.receiptId]));
  }
  return { stopIds: unique(stopIds), receiptIds: unique(receiptIds), match };
}

function nestedLineSources(item) {
  if (Array.isArray(item?.lineSources)) return item.lineSources.filter(record);
  if (!record(item?.lineSources)) return [];
  const direct = sourceGroup(item.lineSources, "line-source", true);
  if (direct.stopIds.length || direct.receiptIds.length) return [item.lineSources];
  return Object.values(item.lineSources).flatMap(value => list(value).length ? value : [value]).filter(record);
}

function hasReverseLink(entry, invoice) {
  const invoiceId = text(invoice?.id);
  const qbId = text(invoice?.qbId);
  return (!!invoiceId && [entry?.linkedInvoiceId, entry?.invoiceId, entry?.linkedBillingReviewId].some(value => text(value) === invoiceId))
    || (!!qbId && text(entry?.qbInvoiceId) === qbId);
}

function clientMatches(invoice, client) {
  if (!text(client?.id)) return false;
  // A conflicting SPS id cannot be excused by an old name or QuickBooks snapshot.
  if (text(invoice?.clientId)) return text(invoice.clientId) === text(client.id);
  const qbId = text(invoice?.qbCustomerId);
  return !!qbId && unique([client?.qbId, client?.qbCustomerId]).includes(qbId);
}

/**
 * Read-only evidence for the invoice review UI. Only saved identities establish a
 * linked visit. Dates, prices and descriptions never do. The original report is
 * returned intact so included materials and office notes remain visible.
 */
export function invoiceVisitDetails({ invoice = {}, client, schedule = [] } = {}) {
  invoice = record(invoice) ? invoice : {};
  const provenance = [invoice, ...list(invoice.lineItems)];
  const lineSources = provenance.flatMap(nestedLineSources);
  const groups = [
    ...provenance.map(item => sourceGroup(item, "source")),
    ...lineSources.map(item => sourceGroup(item, "line-source", true)),
  ].filter(group => group.stopIds.length || group.receiptIds.length);
  const sourceClients = unique([...provenance, ...lineSources].flatMap(item => [
    item?.sourceVisitClientId, ...list(item?.sourceVisitClientIds),
  ]).concat(lineSources.map(item => item?.clientId)));
  const hasRecordedSource = groups.length > 0 || !!text(invoice.autoDraftKey);
  const empty = { visits: [], missing: [], candidates: [], hasSources: hasRecordedSource, clientMismatch: false, ambiguous: false };
  if (!client && !text(invoice.clientId) && !text(invoice.qbCustomerId) && !hasRecordedSource) return empty;
  if (!clientMatches(invoice, client) || sourceClients.some(id => id !== text(client?.id))) {
    return { ...empty, clientMismatch: true, missing: [{ key: "client", code: "client-mismatch", message: "The client for these visit records could not be verified." }] };
  }

  const history = [];
  const fingerprints = new Set();
  for (const entry of list(client.history).filter(record)) {
    if (text(entry.clientId) && text(entry.clientId) !== text(client.id)) continue;
    // Exact duplicate copies are one report. Different versions of the same
    // receipt stay separate and must be reviewed instead of choosing silently.
    const fingerprint = stableJSON(entry);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    const source = completedVisitSource(entry, { clientId: client.id });
    history.push({ key: `${source.key}:${history.length}`, entry, source });
  }
  const byStop = new Map();
  const byReceipt = new Map();
  for (const row of history) {
    const { sourceStopId, sourceCompletionReceiptId } = row.source;
    if (sourceStopId) byStop.set(sourceStopId, [...(byStop.get(sourceStopId) || []), row]);
    if (sourceCompletionReceiptId) byReceipt.set(sourceCompletionReceiptId, [...(byReceipt.get(sourceCompletionReceiptId) || []), row]);
  }

  for (const row of history) {
    if (hasReverseLink(row.entry, invoice)) groups.push({ stopIds: [row.source.sourceStopId], receiptIds: row.source.sourceCompletionReceiptId ? [row.source.sourceCompletionReceiptId] : [], match: "report-link" });
  }
  for (const day of list(schedule)) {
    for (const stop of list(day?.stops)) {
      if (text(stop?.clientId ?? stop?.id) !== text(client.id) || !hasReverseLink(stop, invoice)) continue;
      const group = sourceGroup(stop, "scheduled-link", true);
      // Schedule rows only locate a saved report; planned work is never shown as
      // the completed report when the client history is absent.
      if (group.stopIds.length || group.receiptIds.length) groups.push(group);
    }
  }

  const autoDraftKey = text(invoice.autoDraftKey);
  if (autoDraftKey && !groups.length) {
    const matching = history.filter(row => (
      text(row.entry.autoDraftKey) === autoDraftKey
      || [row.source.sourceStopId, `stop:${row.source.sourceStopId}`, `${row.source.sourceStopId}:completion`].includes(autoDraftKey)
    ));
    if (matching.length === 1) {
      const row = matching[0];
      groups.push({ stopIds: [row.source.sourceStopId], receiptIds: row.source.sourceCompletionReceiptId ? [row.source.sourceCompletionReceiptId] : [], match: "legacy-key" });
    } else {
      empty.missing.push({ key: "legacy-key", code: matching.length ? "ambiguous-report" : "missing-report", message: matching.length ? "More than one saved report matches this visit link." : "The saved report for this visit link is not available." });
    }
  }

  const selected = new Map();
  const missing = [...empty.missing];
  const issueKeys = new Set();
  const conflicted = new Set();
  const addIssue = (code, id, kind, rows = []) => {
    const key = `${kind}:${id}`;
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      missing.push({ key, code, ...(kind === "stop" ? { sourceStopId: id } : { sourceCompletionReceiptId: id }), message: code === "ambiguous-report"
        ? "There are different saved versions of this visit report. Review the client reports below."
        : code === "source-mismatch"
          ? "The visit and saved report links do not agree. Review the client reports below."
          : "The linked visit report is not available in the saved client history." });
    }
    rows.forEach(row => conflicted.add(row.key));
  };
  const select = (row, match) => selected.set(row.key, { key: row.key, entry: row.entry, match });
  const uniqueGroups = new Map(groups.map(group => [stableJSON({ stopIds: group.stopIds.slice().sort(), receiptIds: group.receiptIds.slice().sort() }), group]));
  for (const group of uniqueGroups.values()) {
    for (const receiptId of group.receiptIds) {
      const rows = byReceipt.get(receiptId) || [];
      if (rows.length !== 1) {
        addIssue(rows.length ? "ambiguous-report" : "missing-report", receiptId, "receipt", rows);
      } else if (group.stopIds.length && !group.stopIds.includes(rows[0].source.sourceStopId)) {
        addIssue("source-mismatch", receiptId, "receipt", rows);
      } else select(rows[0], group.match);
    }
    for (const stopId of group.stopIds) {
      const rows = byStop.get(stopId) || [];
      const matching = group.receiptIds.length ? rows.filter(row => group.receiptIds.includes(row.source.sourceCompletionReceiptId)) : rows;
      if (matching.length !== 1) {
        addIssue(matching.length ? "ambiguous-report" : rows.length ? "source-mismatch" : "missing-report", stopId, "stop", rows);
      } else select(matching[0], group.match);
    }
  }
  for (const key of conflicted) selected.delete(key);
  const byRecentDate = (a, b) => dateKey(b.entry.date).localeCompare(dateKey(a.entry.date)) || a.key.localeCompare(b.key);
  const visits = [...selected.values()].sort(byRecentDate);
  const candidates = history.filter(row => !selected.has(row.key)).map(({ key, entry }) => ({ key, entry })).sort(byRecentDate);
  return {
    visits, missing, candidates,
    hasSources: hasRecordedSource || groups.length > 0,
    clientMismatch: false,
    ambiguous: missing.some(issue => ["ambiguous-report", "source-mismatch"].includes(issue.code)),
    // An old monthly period helps label/filter the unlinked browser, but cannot
    // prove which visits contributed to an invoice without saved source ids.
    period: /^\d{4}-\d{2}$/.test(text(invoice.autoPeriod)) ? text(invoice.autoPeriod) : "",
  };
}
