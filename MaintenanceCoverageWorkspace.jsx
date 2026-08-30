import { useEffect, useMemo, useState } from "react";

import {
  buildMaintenancePaymentLedgerRows,
  maintenancePaymentDisplayStatus,
  moneyToCents,
} from "./maintenancePaymentLedger.js";

const MONTHS = [
  ["01", "Jan", "January"], ["02", "Feb", "February"], ["03", "Mar", "March"],
  ["04", "Apr", "April"], ["05", "May", "May"], ["06", "Jun", "June"],
  ["07", "Jul", "July"], ["08", "Aug", "August"], ["09", "Sep", "September"],
  ["10", "Oct", "October"], ["11", "Nov", "November"], ["12", "Dec", "December"],
];

const STATUS = {
  paid: { label: "Paid", short: "Paid" },
  prepaid: { label: "Prepaid", short: "Pre" },
  due: { label: "Invoice open", short: "Open" },
  partial: { label: "Partly paid", short: "Part" },
  missing: { label: "No matching payment", short: "No match" },
  review: { label: "Unallocated history", short: "Review" },
  waived: { label: "Waived", short: "Waived" },
  refunded: { label: "Refunded", short: "Refund" },
  upcoming: { label: "Upcoming", short: "Upcoming" },
  plan_history_needed: { label: "Plan history needed", short: "Plan history" },
  not_expected: { label: "Not expected", short: "" },
};

const text = (value) => String(value == null ? "" : value).trim();
const normalizedName = (value) => text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const hexA = (hex, alpha) => {
  const raw = String(hex || "").replace("#", "");
  if (raw.length !== 6) return `rgba(175,1,26,${alpha})`;
  return `rgba(${parseInt(raw.slice(0, 2), 16)},${parseInt(raw.slice(2, 4), 16)},${parseInt(raw.slice(4, 6), 16)},${alpha})`;
};
const formatMoney = (cents, hidden = false) => hidden
  ? "Hidden"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
const invoiceAmountCents = (invoice) => moneyToCents(invoice?.total ?? invoice?.amount ?? invoice?.subtotal ?? invoice?.TotalAmt);
const invoiceLinkIdentity = (invoice) => {
  const spsInvoiceId = text(invoice?.id);
  if (spsInvoiceId) return `sps:${spsInvoiceId}`;
  const qbInvoiceId = text(invoice?.qbId || invoice?.Id);
  return qbInvoiceId ? `qb:${qbInvoiceId}` : "";
};
const invoiceEvidenceIdentity = (invoice, index = 0) => {
  const spsInvoiceId = text(invoice?.invoiceId);
  if (spsInvoiceId) return `sps:${spsInvoiceId}`;
  const qbInvoiceId = text(invoice?.qbInvoiceId);
  if (qbInvoiceId) return `qb:${qbInvoiceId}`;
  return `number:${text(invoice?.invoiceNumber) || "unnumbered"}:${text(invoice?.invoiceMonth) || "unknown"}:${index}`;
};
const invoiceEvidenceSourceLabel = (invoice) => (
  invoice?.qbInvoiceId ? "QuickBooks" : (invoice?.invoiceId ? "SPS record" : "Invoice record")
);
const displayStatusForMonth = (cell, monthKey) => maintenancePaymentDisplayStatus(cell?.payment?.status, monthKey);
const coverageLabel = (status) => STATUS[status]?.label || status;
const invoiceEvidenceLabel = (cell, compact = false) => {
  const monthInvoiceEvidence = Array.isArray(cell?.invoiceEvidence) ? cell.invoiceEvidence : [];
  if (monthInvoiceEvidence.length) {
    const linkedEvidence = monthInvoiceEvidence.filter((invoice) => invoice?.linkedToCoverage);
    const statusEvidence = linkedEvidence.length ? linkedEvidence : monthInvoiceEvidence;
    const statuses = new Set(statusEvidence.map((invoice) => invoice?.status).filter(Boolean));
    const hasPaid = statusEvidence.some((invoice) => invoice?.status === "paid");
    const hasPartial = statusEvidence.some((invoice) => invoice?.status === "partial");
    const hasOpen = statusEvidence.some((invoice) => invoice?.status === "due");
    const unlinkedEvidence = monthInvoiceEvidence.filter((invoice) => !invoice?.linkedToCoverage);
    const hasReview = unlinkedEvidence.some((invoice) => invoice?.coverageKind === "review");
    const onlyOtherWork = unlinkedEvidence.length === monthInvoiceEvidence.length
      && unlinkedEvidence.every((invoice) => invoice?.coverageKind === "other_work");
    if (statuses.size > 1) {
      const evidenceCount = statusEvidence.length;
      return `${evidenceCount} ${linkedEvidence.length ? "linked invoices" : "invoices"} · mixed status`;
    }
    const base = hasPaid ? "Paid invoice" : hasPartial ? "Partly paid invoice" : hasOpen ? "Open invoice" : "Invoice found";
    if (hasReview) return compact ? `${base} · needs match` : `${base} · needs maintenance match`;
    if (onlyOtherWork) return compact ? `${base} · other work` : `${base} · other work, not maintenance`;
    return monthInvoiceEvidence.length > 1 ? `${base} · ${monthInvoiceEvidence.length} records` : base;
  }
  const hasPrepayment = (cell?.payment?.sources || []).some((source) => source?.kind === "prepaid");
  const hasLinkedInvoice = (cell?.payment?.sources || []).some((source) => (
    source?.kind === "invoice" || source?.invoiceId || source?.qbInvoiceId || source?.invoiceNumber
  ));
  if (hasPrepayment) return "Prepayment coverage";
  if (hasLinkedInvoice) return "Linked invoice";
  return compact ? "No invoice" : "No invoice evidence";
};
const visitEvidenceLabel = (cell, compact = false) => {
  if (!cell?.schedule) return compact ? "Visit data unavailable" : "SPS visit data unavailable";
  const visitCount = Number(cell.schedule.visitCount || 0);
  const completedCount = Number(cell.schedule.completedCount || 0);
  if (!visitCount) return "No SPS visit data";
  return compact
    ? `${completedCount}/${visitCount} SPS visits`
    : `${completedCount} of ${visitCount} SPS visits complete`;
};
const statusMatchesView = (status, view) => {
  if (view === "all") return true;
  if (view === "covered") return ["paid", "prepaid", "waived"].includes(status);
  if (view === "missing") return status === "missing";
  if (view === "review") return ["review", "partial", "refunded"].includes(status);
  if (view === "open") return status === "due";
  return ["missing", "review", "partial", "refunded", "due"].includes(status);
};
const formatReceiptTimestamp = (value) => {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
};

function Icon({ name, size = 18 }) {
  const common = { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (name === "search") return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>;
  if (name === "check") return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
  if (name === "alert") return <svg {...common}><path d="M12 3 2.7 20h18.6L12 3Z"/><path d="M12 9v4M12 17h.01"/></svg>;
  if (name === "close") return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  if (name === "chevron") return <svg {...common}><path d="m9 18 6-6-6-6"/></svg>;
  if (name === "link") return <svg {...common}><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg>;
  return <svg {...common}><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>;
}

function statusTone(status, T) {
  const primary = T?.primary || "#AF011A";
  if (["missing", "review", "partial", "refunded"].includes(status)) {
    return { color: primary, background: hexA(primary, status === "missing" ? 0.07 : 0.04), line: primary };
  }
  if (["paid", "prepaid", "waived"].includes(status)) {
    return { color: T?.text || "#15171A", background: T?.surface || "#fff", line: T?.text || "#15171A" };
  }
  if (status === "upcoming") return { color: T?.textMuted || "#71757D", background: T?.surface || "#fff", line: T?.border || "#D9DCE1" };
  if (status === "due") return { color: T?.text || "#15171A", background: T?.surfaceAlt || "#F4F5F7", line: T?.textMuted || "#71757D" };
  return { color: T?.textMuted || "#71757D", background: "transparent", line: T?.border || "#D9DCE1" };
}

function clientInvoicesFor(row, invoices, clients) {
  const client = clients.find((candidate) => String(candidate?.id) === String(row.clientId));
  const clientName = normalizedName(row.clientName);
  return (invoices || []).filter((invoice) => {
    if (String(invoice?.clientId || invoice?.customerId || "") === String(row.clientId)) return true;
    if (client?.qbId && String(invoice?.qbCustomerId || invoice?.CustomerRef?.value || "") === String(client.qbId)) return true;
    return normalizedName(invoice?.clientName || invoice?.customerName || invoice?.CustomerRef?.name) === clientName;
  }).sort((left, right) => String(right?.date || right?.createdAt || right?.TxnDate || "").localeCompare(String(left?.date || left?.createdAt || left?.TxnDate || "")));
}

function sourceInvoiceForCell(cell, invoices) {
  const sources = cell?.payment?.sources || [];
  for (const source of sources) {
    const spsInvoiceId = text(source?.invoiceId);
    const qbInvoiceId = text(source?.qbInvoiceId);
    if (spsInvoiceId || qbInvoiceId) {
      if (spsInvoiceId) {
        const spsMatch = (invoices || []).find((invoice) => text(invoice?.id) === spsInvoiceId);
        if (spsMatch) return spsMatch;
      }
      if (qbInvoiceId) {
        const qbMatch = (invoices || []).find((invoice) => text(invoice?.qbId || invoice?.Id) === qbInvoiceId);
        if (qbMatch) return qbMatch;
      }
      continue;
    }
    const invoiceNumber = text(source?.invoiceNumber);
    if (!invoiceNumber) continue;
    const numberMatches = (invoices || []).filter((invoice) => text(invoice?.number || invoice?.DocNumber) === invoiceNumber);
    if (numberMatches.length === 1) return numberMatches[0];
  }
  return null;
}

function CoverageCell({ cell, monthKey, monthLabel, selected, T, onClick }) {
  const status = displayStatusForMonth(cell, monthKey);
  const tone = statusTone(status, T);
  const paymentLabel = coverageLabel(status);
  const compactInvoiceLabel = invoiceEvidenceLabel(cell, true);
  const compactVisitLabel = visitEvidenceLabel(cell, true);
  return (
    <button
      type="button"
      aria-label={`${monthLabel}: ${paymentLabel}. ${invoiceEvidenceLabel(cell)}. ${visitEvidenceLabel(cell)}.`}
      title={`${paymentLabel} · ${invoiceEvidenceLabel(cell)} · ${visitEvidenceLabel(cell)}`}
      onClick={onClick}
      style={{
        width: "100%", minHeight: 68, border: "none", borderLeft: `2px solid ${selected ? (T.primary || "#AF011A") : tone.line}`,
        background: selected ? hexA(T.primary || "#AF011A", 0.08) : (status === "missing" ? T.surface : tone.background),
        color: tone.color, padding: "8px 7px 7px", textAlign: "left", cursor: "pointer", fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 11.5, lineHeight: 1.15, fontWeight: 780 }}>{paymentLabel}</div>
      <div style={{ marginTop: 4, fontSize: 9.5, lineHeight: 1.2, color: T.textMuted }}>{compactInvoiceLabel}</div>
      <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, color: T.textMuted }}>
        {status === "paid" || status === "prepaid" || status === "waived" ? <Icon name="check" size={11} /> : null}
        {compactVisitLabel}
      </div>
    </button>
  );
}

function DetailPanel({ selection, rows, invoices, clients, year, hiddenAmounts, T, busy, onClose, onAssign, onClear }) {
  const row = rows.find((candidate) => candidate.clientId === selection?.clientId);
  const initialMonth = selection?.monthKey;
  const [months, setMonths] = useState(() => initialMonth ? [initialMonth] : []);
  const [invoiceId, setInvoiceId] = useState("");
  const [mode, setMode] = useState("invoice");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setMonths(initialMonth ? [initialMonth] : []);
    const invoice = sourceInvoiceForCell(row?.byMonth?.[initialMonth], invoices);
    setInvoiceId(invoiceLinkIdentity(invoice));
    setMode(row?.byMonth?.[initialMonth]?.payment?.status === "waived" ? "waived" : "invoice");
    setNote("");
    setError("");
  }, [row?.clientId, initialMonth, invoices]);

  if (!row || !initialMonth || !initialMonth.startsWith(`${year}-`)) return null;
  const candidates = clientInvoicesFor(row, invoices, clients);
  const cell = row.byMonth[initialMonth];
  const status = displayStatusForMonth(cell, initialMonth);
  const paymentLabel = coverageLabel(status);
  const invoiceLabel = invoiceEvidenceLabel(cell);
  const visitLabel = visitEvidenceLabel(cell);
  const monthInvoiceEvidence = Array.isArray(cell?.invoiceEvidence) ? cell.invoiceEvidence : [];
  const selectedInvoice = candidates.find((invoice) => invoiceLinkIdentity(invoice) === invoiceId);
  const monthMeta = MONTHS.find(([number]) => initialMonth.endsWith(`-${number}`));
  const toggleMonth = (monthKey) => setMonths((current) => current.includes(monthKey)
    ? (current.length === 1 ? current : current.filter((value) => value !== monthKey))
    : [...current, monthKey].sort());
  const save = async () => {
    setError("");
    if (mode === "invoice" && !invoiceId) {
      setError("Choose the QuickBooks or SPS invoice that covers the selected month.");
      return;
    }
    try {
      await onAssign({
        clientId: row.clientId,
        monthKeys: months,
        actionType: mode,
        invoiceId: mode === "invoice" ? invoiceId : undefined,
        note,
      });
    } catch (saveError) {
      setError(saveError?.message || "Coverage could not be saved.");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${row.clientName} maintenance coverage`}
      style={{
        position: "fixed", zIndex: 2200, right: 0, top: 0, bottom: 0, width: "min(520px, 100vw)",
        background: T.surface, color: T.text, borderLeft: `1px solid ${T.border}`,
        boxShadow: "-18px 0 44px rgba(20,22,27,.14)", overflowY: "auto", fontFamily: "inherit",
      }}
    >
      <div style={{ position: "sticky", top: 0, zIndex: 2, background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "22px 24px 18px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: T.primary }}>{monthMeta?.[2]} {year}</div>
          <h3 style={{ margin: "5px 0 0", fontSize: 27, lineHeight: 1.05, letterSpacing: "-.035em", color: T.text }}>{row.clientName}</h3>
          <div style={{ marginTop: 7, fontSize: 13, color: T.textMuted }}>{paymentLabel} · {formatMoney(cell.expectedCents, hiddenAmounts)} expected</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={{ width: 38, height: 38, border: `1px solid ${T.border}`, borderRadius: "50%", background: T.surface, color: T.textMuted, display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="close" size={17}/></button>
      </div>

      <div style={{ padding: "22px 24px 38px" }}>
        <section style={{ borderTop: `3px solid ${T.text}`, borderBottom: `1px solid ${T.border}`, padding: "15px 0 17px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 18 }}>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Coverage</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{paymentLabel}</div></div>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Invoice evidence</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{invoiceLabel}</div></div>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>SPS visits</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{visitLabel}</div></div>
          </div>
          {status === "review" ? <div style={{ marginTop: 13, padding: "10px 11px", borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .045), color: T.text, fontSize: 12.5, lineHeight: 1.45 }}>Invoice evidence exists, but this month is not counted as maintenance coverage until the invoice is safely linked.</div> : null}
          {cell.payment?.reasons?.length ? <div style={{ marginTop: 13, paddingLeft: 11, borderLeft: `2px solid ${T.primary}`, color: T.textMuted, fontSize: 12.5, lineHeight: 1.45 }}>{cell.payment.reasons.join(" ")}</div> : null}
          {monthInvoiceEvidence.length ? (
            <div data-maintenance-month-invoice-evidence style={{ marginTop: 15, borderTop: `1px solid ${T.border}` }}>
              {monthInvoiceEvidence.map((invoice, index) => (
                <div key={invoiceEvidenceIdentity(invoice, index)} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, padding: "11px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 820 }}>Invoice #{invoice.invoiceNumber || "Unnumbered"} · {invoiceEvidenceSourceLabel(invoice)}</div>
                    <div style={{ marginTop: 3, color: T.textMuted, fontSize: 11.5 }}>{invoice.linkedToCoverage ? "Linked maintenance coverage" : invoice.coverageKind === "maintenance" ? "Maintenance evidence" : invoice.coverageKind === "review" ? "Needs maintenance match" : "Other work, not maintenance"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 820 }}>{formatMoney(invoice.amountCents, hiddenAmounts)}</div>
                    <div style={{ marginTop: 3, color: T.textMuted, fontSize: 11.5 }}>{invoice.status === "paid" ? "Paid" : invoice.status === "due" ? "Open" : invoice.status === "partial" ? "Partly paid" : "Review"}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section style={{ marginTop: 25 }}>
          <div style={{ fontSize: 11, fontWeight: 850, letterSpacing: ".075em", textTransform: "uppercase", color: T.textMuted }}>Months covered by this choice</div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", borderTop: `1px solid ${T.border}`, borderLeft: `1px solid ${T.border}` }}>
            {MONTHS.map(([number, short]) => {
              const key = `${year}-${number}`;
              const active = months.includes(key);
              return <button key={key} type="button" onClick={() => toggleMonth(key)} style={{ minHeight: 44, border: "none", borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: active ? T.text : T.surface, color: active ? T.surface : T.textMuted, fontFamily: "inherit", fontSize: 11.5, fontWeight: 780, cursor: "pointer" }}>{short}</button>;
            })}
          </div>
        </section>

        <section style={{ marginTop: 25 }}>
          <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${T.border}` }}>
            {[['invoice', 'Link invoice'], ['waived', 'Waive charge']].map(([value, label]) => (
              <button key={value} type="button" onClick={() => setMode(value)} style={{ border: "none", borderBottom: `3px solid ${mode === value ? T.primary : "transparent"}`, background: "transparent", color: mode === value ? T.text : T.textMuted, padding: "10px 15px 9px 0", marginRight: 18, fontSize: 12.5, fontWeight: 800, fontFamily: "inherit", cursor: "pointer" }}>{label}</button>
            ))}
          </div>

          {mode === "invoice" ? (
            <div style={{ marginTop: 17 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 850, letterSpacing: ".06em", textTransform: "uppercase", color: T.textMuted }}>Invoice evidence</label>
                <span style={{ fontSize: 11, color: T.textMuted }}>{candidates.length} matching record{candidates.length === 1 ? "" : "s"}</span>
              </div>
              <div data-maintenance-invoice-evidence style={{ maxHeight: 236, overflowY: "auto", borderTop: `1px solid ${T.border}` }}>
                {candidates.map((invoice) => {
                  const value = invoiceLinkIdentity(invoice);
                  const active = value === invoiceId;
                  return (
                    <button
                      key={value || `number:${text(invoice.number || invoice.DocNumber)}`}
                      type="button"
                      onClick={() => setInvoiceId(value)}
                      disabled={!value}
                      aria-pressed={active}
                      style={{
                        width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 14,
                        border: "none", borderBottom: `1px solid ${T.border}`, borderLeft: `3px solid ${active ? T.primary : "transparent"}`,
                        background: active ? hexA(T.primary, .055) : T.surface, color: T.text,
                        padding: "12px 10px 12px 12px", textAlign: "left", fontFamily: "inherit", cursor: value ? "pointer" : "default", opacity: value ? 1 : 0.55,
                      }}
                    >
                      <span>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 850 }}>Invoice #{invoice.number || invoice.DocNumber || "Unnumbered"}</span>
                        <span style={{ display: "block", marginTop: 4, color: T.textMuted, fontSize: 11.5 }}>{invoice.date || invoice.TxnDate || "No issue date"} · {invoice.qbId || invoice.Id ? "QuickBooks confirmed" : "SPS record"}</span>
                      </span>
                      <span style={{ textAlign: "right" }}>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 850 }}>{formatMoney(invoiceAmountCents(invoice), hiddenAmounts)}</span>
                        <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 5, marginTop: 4, color: active ? T.primary : T.textMuted, fontSize: 11.5 }}>{active ? <Icon name="check" size={12}/> : null}{invoice.status || "Unknown"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedInvoice ? <div style={{ marginTop: 9, color: T.textMuted, fontSize: 11.5 }}>Selected invoice will cover {months.length} month{months.length === 1 ? "" : "s"}. Nothing in QuickBooks is edited.</div> : null}
              {!candidates.length ? <div style={{ marginTop: 10, color: T.primary, fontSize: 12.5 }}>No matching invoice was found for this client. Refresh QuickBooks before creating a manual exception.</div> : null}
            </div>
          ) : (
            <div style={{ marginTop: 17, padding: "13px 0 13px 13px", borderLeft: `3px solid ${T.primary}`, color: T.textMuted, fontSize: 12.5, lineHeight: 1.5 }}>Waiving a month records an owner decision. It does not edit or delete anything in QuickBooks.</div>
          )}
        </section>

        <section style={{ marginTop: 22 }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 850, letterSpacing: ".06em", textTransform: "uppercase", color: T.textMuted, marginBottom: 7 }}>Internal note</label>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why these months are covered" rows={3} style={{ width: "100%", resize: "vertical", boxSizing: "border-box", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.text, padding: 12, fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.45 }} />
        </section>

        {error ? <div role="alert" style={{ marginTop: 14, color: T.primary, fontSize: 12.5, fontWeight: 750 }}>{error}</div> : null}
        <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" disabled={busy} onClick={save} style={{ flex: 1, minHeight: 48, border: "none", borderRadius: 8, background: T.primary, color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 850, cursor: busy ? "wait" : "pointer", opacity: busy ? .65 : 1 }}>{busy ? "Saving coverage" : mode === "waived" ? "Waive selected months" : "Save invoice coverage"}</button>
          {cell?.payment?.manual ? <button type="button" disabled={busy} onClick={() => onClear({ clientId: row.clientId, monthKeys: months })} style={{ minHeight: 48, border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.textMuted, padding: "0 14px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Clear</button> : null}
        </div>
      </div>
    </div>
  );
}

export default function MaintenanceCoverageWorkspace({
  clients = [], invoices = [], payments = [], schedule = [], ledger = null,
  T, vp = {}, loading = false, saving = false, error = "", onReload, onReconcile,
  reconciliationReceipt = null, onAssign, onClear,
  canSeeAmounts = true,
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("attention");
  const [fullYear, setFullYear] = useState(false);
  const [selection, setSelection] = useState(null);
  const [receiptExpanded, setReceiptExpanded] = useState(false);
  const compactControls = !!(vp.isPhone || vp.isTablet);
  const historyRange = useMemo(() => {
    const evidenceYears = [...(invoices || []), ...(schedule || [])].map((entry) => {
      const raw = text(entry?.date || entry?.issueDate || entry?.issuedDate || entry?.createdAt || entry?.scheduledDate);
      const match = raw.match(/^(\d{4})[-/]/);
      return match ? Number(match[1]) : null;
    }).filter((candidate) => Number.isSafeInteger(candidate) && candidate >= 2000 && candidate <= currentYear + 1);
    const earliest = evidenceYears.length ? Math.min(...evidenceYears) : currentYear;
    return {
      fromYear: Math.max(2000, currentYear - 24, Math.min(earliest, year)),
      toYear: Math.min(currentYear + 1, Math.max(currentYear, year)),
    };
  }, [currentYear, invoices, schedule, year]);
  const monthMeta = fullYear ? MONTHS : MONTHS.slice(3);
  const visibleRangeLabel = fullYear ? "January to December" : "April to December";
  const rows = useMemo(() => buildMaintenancePaymentLedgerRows({
    clients, invoices, payments, ledger, schedule, year,
  }), [clients, invoices, payments, ledger, schedule, year]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    const matches = !search || row.clientName.toLowerCase().includes(search.toLowerCase());
    if (!matches) return false;
    const statuses = monthMeta.map(([number]) => displayStatusForMonth(row.byMonth[`${year}-${number}`], `${year}-${number}`));
    return statuses.some((status) => statusMatchesView(status, view));
  }), [rows, search, view, monthMeta, year]);
  const counts = useMemo(() => {
    const result = { missing: 0, review: 0, open: 0, covered: 0, attention: 0 };
    for (const row of rows) for (const [number] of monthMeta) {
      const status = displayStatusForMonth(row.byMonth[`${year}-${number}`], `${year}-${number}`);
      if (status === "missing") { result.missing += 1; result.attention += 1; }
      else if (["review", "partial", "refunded"].includes(status)) { result.review += 1; result.attention += 1; }
      else if (status === "due") { result.open += 1; result.attention += 1; }
      else if (["paid", "prepaid", "waived"].includes(status)) result.covered += 1;
    }
    return result;
  }, [rows, monthMeta, year]);
  const receiptEvidence = useMemo(() => {
    if (!reconciliationReceipt?.counts) return null;
    const receiptCounts = reconciliationReceipt.counts;
    const ambiguousInvoices = Array.isArray(reconciliationReceipt.ambiguousInvoices) ? reconciliationReceipt.ambiguousInvoices : [];
    const unmatchedClientInvoices = Array.isArray(reconciliationReceipt.unmatchedClientInvoices) ? reconciliationReceipt.unmatchedClientInvoices : [];
    const skippedInvoices = Array.isArray(reconciliationReceipt.skippedNonMaintenance) ? reconciliationReceipt.skippedNonMaintenance : [];
    const details = [
      ...ambiguousInvoices.map((invoice) => ({ ...invoice, evidenceType: "Needs allocation", fallbackReason: "invoice evidence could not be assigned safely" })),
      ...unmatchedClientInvoices.map((invoice) => ({ ...invoice, evidenceType: "Client not matched", fallbackReason: "invoice client could not be matched to an SPS client" })),
      ...skippedInvoices.map((invoice) => ({ ...invoice, evidenceType: "Excluded", fallbackReason: "invoice is not counted as maintenance coverage" })),
    ];
    return {
      matched: Number(receiptCounts.assignedMonths || 0) + Number(receiptCounts.alreadyAssigned || 0),
      assigned: Number(receiptCounts.assignedMonths || 0),
      alreadyAssigned: Number(receiptCounts.alreadyAssigned || 0),
      ambiguous: Number(receiptCounts.ambiguousInvoices || 0) + Number(receiptCounts.unmatchedClientInvoices || 0),
      excluded: Number(receiptCounts.skippedNonMaintenance || 0),
      fromYear: Number(reconciliationReceipt.fromYear || historyRange.fromYear),
      toYear: Number(reconciliationReceipt.toYear || historyRange.toYear),
      changed: reconciliationReceipt.changed !== false,
      updatedAt: reconciliationReceipt.updatedAt || "",
      details,
    };
  }, [historyRange, reconciliationReceipt]);
  useEffect(() => setReceiptExpanded(false), [reconciliationReceipt]);

  const openCell = (row, monthKey) => setSelection({ clientId: row.clientId, monthKey });
  const changeYear = (nextYear) => {
    setSelection(null);
    setYear(nextYear);
  };
  const toggleYearRange = () => {
    setSelection(null);
    setFullYear((value) => !value);
  };
  const openReceiptDetail = (detail) => {
    const monthKey = (Array.isArray(detail?.months) ? detail.months[0] : "") || detail?.invoiceMonth || "";
    const monthMatch = String(monthKey).match(/^(\d{4})-(\d{2})$/);
    if (!detail?.clientId || !monthMatch) return;
    const targetYear = Number(monthMatch[1]);
    if (Number(monthMatch[2]) < 4) setFullYear(true);
    setYear(targetYear);
    setSelection({ clientId: detail.clientId, monthKey });
  };
  return (
    <div data-maintenance-payment-ledger style={{ color: T.text, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: "inherit" }}>
      <div style={{ display: "grid", gridTemplateColumns: compactControls ? "1fr" : "minmax(260px, 1fr) auto", alignItems: "end", gap: 18, padding: vp.isPhone ? "18px 0 16px" : "24px 0 20px", borderBottom: `3px solid ${T.text}` }}>
        <div>
          <div style={{ color: T.primary, fontSize: 11, fontWeight: 900, letterSpacing: ".09em", textTransform: "uppercase" }}>Maintenance accounting</div>
          <h3 style={{ margin: "5px 0 0", fontSize: vp.isPhone ? 28 : 34, lineHeight: 1, letterSpacing: "-.045em" }}>Payment calendar</h3>
          <div style={{ marginTop: 9, color: T.textMuted, fontSize: 13, lineHeight: 1.4 }}>QuickBooks payments, prepayments, and expected service shown together before another invoice is created.</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: compactControls ? "1fr 1fr" : "auto auto auto auto", alignItems: "center", justifyContent: compactControls ? "stretch" : "end", gap: 8, width: compactControls ? "100%" : "auto" }}>
          <div style={{ gridColumn: compactControls ? "1 / -1" : "auto", display: "grid", gridTemplateColumns: "38px minmax(58px, 1fr) 38px", alignItems: "center", border: `1px solid ${T.border}`, background: T.surface }}>
            <button type="button" aria-label="Previous year" onClick={() => changeYear(year - 1)} style={{ width: 38, height: 38, border: "none", borderRight: `1px solid ${T.border}`, background: "transparent", color: T.text, fontFamily: "inherit", cursor: "pointer" }}>‹</button>
            <div style={{ minWidth: 58, textAlign: "center", fontWeight: 850, fontSize: 14 }}>{year}</div>
            <button type="button" aria-label="Next year" onClick={() => changeYear(year + 1)} style={{ width: 38, height: 38, border: "none", borderLeft: `1px solid ${T.border}`, background: "transparent", color: T.text, fontFamily: "inherit", cursor: "pointer" }}>›</button>
          </div>
          <button type="button" aria-pressed={fullYear} onClick={toggleYearRange} style={{ minHeight: 40, border: `1px solid ${T.border}`, background: T.surface, color: T.textMuted, padding: "0 12px", fontFamily: "inherit", fontWeight: 750, cursor: "pointer" }}>{fullYear ? "Show Apr to Dec" : "Show full year"}</button>
          <button type="button" onClick={onReload} disabled={loading || saving} style={{ minHeight: 40, border: `1px solid ${T.border}`, background: T.surface, color: T.text, padding: "0 13px", fontFamily: "inherit", fontSize: 12, fontWeight: 820, cursor: loading || saving ? "wait" : "pointer", opacity: loading || saving ? .68 : 1 }}>{loading ? "Checking" : "Refresh QuickBooks"}</button>
          <button
            type="button"
            data-maintenance-reconcile-history
            onClick={() => onReconcile?.(historyRange)}
            disabled={loading || saving || !onReconcile}
            title={`Check ${historyRange.fromYear} to ${historyRange.toYear} against confirmed QuickBooks history`}
            style={{ minHeight: 40, gridColumn: compactControls ? "1 / -1" : "auto", border: "none", background: T.primary, color: "#fff", padding: "0 13px", fontFamily: "inherit", fontSize: 12, fontWeight: 840, cursor: loading || saving ? "wait" : "pointer", opacity: loading || saving ? .68 : 1 }}
          >
            {saving ? "Reconciling" : "Reconcile history"}
          </button>
        </div>
      </div>

      {receiptEvidence ? (
        <div data-maintenance-reconciliation-receipt style={{ borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <div style={{ display: "grid", gridTemplateColumns: compactControls ? "1fr 1fr" : "minmax(230px, 1.35fr) repeat(4, minmax(92px, .55fr))" }}>
            <div style={{ gridColumn: compactControls ? "1 / -1" : "auto", padding: "11px 12px 10px", borderLeft: `3px solid ${T.primary}`, borderRight: compactControls ? "none" : `1px solid ${T.border}` }}>
              <div style={{ fontSize: 16, lineHeight: 1.05, fontWeight: 880, color: T.text }}>{receiptEvidence.matched} months matched</div>
              <div style={{ marginTop: 5, fontSize: 10.5, fontWeight: 760, letterSpacing: ".035em", textTransform: "uppercase", color: T.textMuted }}>{receiptEvidence.fromYear} to {receiptEvidence.toYear} · {receiptEvidence.changed ? "ledger updated" : "no new allocations"}</div>
              <div style={{ marginTop: 4, fontSize: 10.5, color: T.textMuted }}>Run {formatReceiptTimestamp(receiptEvidence.updatedAt)}</div>
            </div>
            {[
              ["Assigned", receiptEvidence.assigned],
              ["Already tied", receiptEvidence.alreadyAssigned],
              ["Needs review", receiptEvidence.ambiguous],
              ["Excluded", receiptEvidence.excluded],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: "10px 11px", borderRight: `1px solid ${T.border}`, borderTop: compactControls ? `1px solid ${T.border}` : "none" }}>
                <div style={{ fontSize: 16, lineHeight: 1, fontWeight: 880, color: label === "Needs review" && value ? T.primary : T.text }}>{value}</div>
                <div style={{ marginTop: 4, fontSize: 10.5, color: T.textMuted }}>{label}</div>
              </div>
            ))}
          </div>
          {receiptEvidence.details.length ? (
            <>
              <button
                type="button"
                data-maintenance-reconciliation-details-toggle
                aria-expanded={receiptExpanded}
                onClick={() => setReceiptExpanded((value) => !value)}
                style={{ width: "100%", minHeight: 38, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: "none", borderTop: `1px solid ${T.border}`, background: T.surface, color: T.text, padding: "7px 12px", fontFamily: "inherit", fontSize: 11.5, fontWeight: 820, textAlign: "left", cursor: "pointer" }}
              >
                <span>Review {receiptEvidence.details.length} invoice detail{receiptEvidence.details.length === 1 ? "" : "s"}</span>
                <span style={{ color: T.textMuted }}>{receiptExpanded ? "Hide details" : "Show invoice, client, and reason"}</span>
              </button>
              {receiptExpanded ? (
                <div data-maintenance-reconciliation-details style={{ maxHeight: 290, overflowY: "auto", borderTop: `1px solid ${T.border}` }}>
                  {receiptEvidence.details.map((detail, index) => {
                    const invoiceIdentity = detail.invoiceNumber ? `Invoice #${detail.invoiceNumber}` : detail.qbInvoiceId ? `QuickBooks ${detail.qbInvoiceId}` : detail.invoiceId ? `SPS ${detail.invoiceId}` : "Invoice identity unavailable";
                    const targetMonth = (Array.isArray(detail.months) ? detail.months[0] : "") || detail.invoiceMonth || "";
                    const canOpenMonth = !!(detail.clientId && /^\d{4}-\d{2}$/.test(String(targetMonth)));
                    const content = (
                      <>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 12.5, fontWeight: 850, color: T.text }}>{invoiceIdentity} · {detail.clientName || "Client not matched"}</span>
                          <span style={{ display: "block", marginTop: 3, fontSize: 11.5, lineHeight: 1.4, color: T.textMuted }}>{detail.reason || detail.fallbackReason}</span>
                        </span>
                        <span style={{ textAlign: "right", fontSize: 10.5, color: detail.evidenceType === "Excluded" ? T.textMuted : T.primary, fontWeight: 820 }}>
                          <span style={{ display: "block" }}>{detail.evidenceType}</span>
                          {targetMonth ? <span style={{ display: "block", marginTop: 3 }}>{targetMonth}</span> : null}
                        </span>
                      </>
                    );
                    const sharedStyle = { width: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 14, border: "none", borderBottom: `1px solid ${T.border}`, background: T.surface, padding: "10px 12px", textAlign: "left", fontFamily: "inherit" };
                    return canOpenMonth
                      ? <button key={`${detail.evidenceType}-${invoiceIdentity}-${index}`} type="button" onClick={() => openReceiptDetail(detail)} aria-label={`Open ${targetMonth} coverage for ${detail.clientName || "client"}`} style={{ ...sharedStyle, cursor: "pointer" }}>{content}</button>
                      : <div key={`${detail.evidenceType}-${invoiceIdentity}-${index}`} style={sharedStyle}>{content}</div>;
                  })}
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ borderTop: `1px solid ${T.border}`, padding: "8px 12px", fontSize: 11.5, color: T.textMuted }}>No invoices need owner review from this run.</div>
          )}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: compactControls ? "1fr" : "1fr auto", gap: 10, alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ gridColumn: "1 / -1", color: T.textMuted, fontSize: 11.5 }}>
          Showing {visibleRangeLabel} {year}. Counts below represent client months.
        </div>
        <div style={{ display: "flex", gap: vp.isPhone ? 14 : 24, alignItems: "baseline", flexWrap: "wrap" }}>
          {[
            ["attention", counts.attention, "needs attention"],
            ["missing", counts.missing, "no matching payment"],
            ["review", counts.review, "unallocated history"],
            ["open", counts.open, "invoice open"],
            ["covered", counts.covered, "covered"],
            ["all", rows.length, "clients"],
          ].map(([value, count, label]) => (
            <button key={value} type="button" onClick={() => setView(value)} aria-pressed={view === value} style={{ border: "none", borderBottom: `2px solid ${view === value ? T.primary : "transparent"}`, background: "transparent", color: T.text, padding: "3px 0 5px", fontFamily: "inherit", cursor: "pointer" }}>
              <strong style={{ fontSize: 18, color: count && ["attention", "missing", "review"].includes(value) ? T.primary : T.text }}>{count}</strong>
              <span style={{ marginLeft: 5, fontSize: 11.5, color: T.textMuted }}>{label}</span>
            </button>
          ))}
        </div>
        <div style={{ justifySelf: compactControls ? "start" : "end", color: T.textMuted, fontSize: 11.5 }}>Future months stay visible without counting as missing.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", alignItems: "center", gap: 12, padding: "15px 0" }}>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}><Icon name="search" size={16}/></span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find maintenance client" style={{ width: "100%", height: 43, boxSizing: "border-box", padding: "0 12px 0 35px", border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface, color: T.text, fontFamily: "inherit", fontSize: 13.5 }} />
        </div>
      </div>

      {error ? <div role="alert" style={{ padding: "10px 12px", borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .06), color: T.primary, fontSize: 12.5, fontWeight: 750, marginBottom: 12 }}>{error}</div> : null}

      {vp.isPhone ? (
        <div style={{ borderTop: `1px solid ${T.border}` }}>
          {visibleRows.map((row) => {
            const statusEntries = monthMeta.map(([number, short, long]) => {
              const cell = row.byMonth[`${year}-${number}`];
              return { number, short, long, cell, status: displayStatusForMonth(cell, `${year}-${number}`) };
            });
            const issueCount = statusEntries.filter(({ status }) => statusMatchesView(status, "attention")).length;
            const currentNumber = String(new Date().getMonth() + 1).padStart(2, "0");
            const fallbackEntry = statusEntries.find(({ number }) => number === currentNumber) || statusEntries[0];
            const preferredEntry = view === "all" ? fallbackEntry : (statusEntries.find(({ status }) => statusMatchesView(status, view)) || fallbackEntry);
            return <button key={row.clientId} type="button" onClick={() => openCell(row, `${year}-${preferredEntry.number}`)} style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, border: "none", borderBottom: `1px solid ${T.border}`, background: T.surface, color: T.text, textAlign: "left", padding: "14px 2px", fontFamily: "inherit", cursor: "pointer" }}><div><div style={{ fontSize: 14, fontWeight: 850 }}>{row.clientName}</div><div style={{ marginTop: 4, fontSize: 11.5, color: issueCount ? T.primary : T.textMuted }}>{preferredEntry.long}: {coverageLabel(preferredEntry.status)} · {invoiceEvidenceLabel(preferredEntry.cell)} · {visitEvidenceLabel(preferredEntry.cell)}{issueCount ? ` · ${issueCount} need attention` : ""}</div></div><div style={{ display: "flex", alignItems: "center", gap: 7 }}><div style={{ fontSize: 12, fontWeight: 800 }}>{formatMoney(row.expectedMonthlyCents, !canSeeAmounts)}</div><Icon name="chevron" size={14}/></div></button>;
          })}
        </div>
      ) : (
        <div style={{ overflowX: "auto", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ minWidth: 900 }}>
            <div style={{ display: "grid", gridTemplateColumns: `minmax(210px, 1.8fr) repeat(${monthMeta.length}, minmax(72px, .72fr))`, borderBottom: `1px solid ${T.border}`, background: T.surfaceAlt }}>
              <div style={{ padding: "10px 13px", fontSize: 10.5, fontWeight: 850, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Client · expected</div>
              {monthMeta.map(([number, short]) => <div key={number} style={{ padding: "10px 7px", fontSize: 10.5, textAlign: "left", fontWeight: 850, color: T.textMuted }}>{short}</div>)}
            </div>
            {visibleRows.map((row) => (
              <div key={row.clientId} style={{ display: "grid", gridTemplateColumns: `minmax(210px, 1.8fr) repeat(${monthMeta.length}, minmax(72px, .72fr))`, borderBottom: `1px solid ${T.border}`, background: T.surface }}>
                <button type="button" onClick={() => openCell(row, `${year}-${monthMeta[0][0]}`)} style={{ border: "none", background: "transparent", color: T.text, padding: "10px 13px", textAlign: "left", fontFamily: "inherit", cursor: "pointer" }}><div style={{ fontSize: 13.5, fontWeight: 850, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.clientName}</div><div style={{ marginTop: 3, fontSize: 10.5, color: T.textMuted }}>{formatMoney(row.expectedMonthlyCents, !canSeeAmounts)} monthly</div></button>
                {monthMeta.map(([number, , long]) => {
                  const monthKey = `${year}-${number}`;
                  return <CoverageCell key={monthKey} cell={row.byMonth[monthKey]} monthKey={monthKey} monthLabel={`${long} ${year}`} selected={selection?.clientId === row.clientId && selection?.monthKey === monthKey} T={T} onClick={() => openCell(row, monthKey)} />;
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && visibleRows.length === 0 ? <div style={{ padding: "50px 12px", textAlign: "center", color: T.textMuted }}><div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>No maintenance clients match this view</div><div style={{ marginTop: 6, fontSize: 12.5 }}>Try All clients or clear the search.</div></div> : null}
      {selection ? <DetailPanel selection={selection} rows={rows} invoices={invoices} clients={clients} year={year} hiddenAmounts={!canSeeAmounts} T={T} busy={saving} onClose={() => setSelection(null)} onAssign={onAssign} onClear={onClear} /> : null}
    </div>
  );
}
