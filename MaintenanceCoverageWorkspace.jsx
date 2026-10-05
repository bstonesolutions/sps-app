import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildMaintenanceCalendarRows,
  maintenancePaymentDisplayStatus,
} from "./maintenancePaymentLedger.js";
import {
  filterMaintenanceCalendarRows,
  MAINTENANCE_CALENDAR_SERVICE_OPTIONS,
  MAINTENANCE_CALENDAR_PAYMENT_OPTIONS,
} from "./maintenanceCalendarView.js";
import { maintenanceCoverageInvoiceChoices, maintenanceCoverageInvoicePreview, maintenanceCoverageSavedMessage } from "./maintenanceCoverageActions.js";

const MONTHS = [
  ["01", "Jan", "January"], ["02", "Feb", "February"], ["03", "Mar", "March"],
  ["04", "Apr", "April"], ["05", "May", "May"], ["06", "Jun", "June"],
  ["07", "Jul", "July"], ["08", "Aug", "August"], ["09", "Sep", "September"],
  ["10", "Oct", "October"], ["11", "Nov", "November"], ["12", "Dec", "December"],
];

const STATUS = {
  paid: { label: "Paid", short: "Paid" },
  prepaid: { label: "Prepaid", short: "Prepaid" },
  due: { label: "Invoice open", short: "Open" },
  partial: { label: "Partly paid", short: "Part" },
  missing: { label: "No matching payment", short: "No match" },
  review: { label: "Unallocated history", short: "Review" },
  waived: { label: "Waived", short: "Waived" },
  refunded: { label: "Refunded", short: "Refund" },
  upcoming: { label: "Upcoming", short: "Upcoming" },
  plan_history_needed: { label: "Plan history needed", short: "Plan history" },
  not_expected: { label: "Not expected", short: "·" },
};

const text = (value) => String(value == null ? "" : value).trim();
const hexA = (hex, alpha) => {
  const raw = String(hex || "").replace("#", "");
  if (raw.length !== 6) return `rgba(175,1,26,${alpha})`;
  return `rgba(${parseInt(raw.slice(0, 2), 16)},${parseInt(raw.slice(2, 4), 16)},${parseInt(raw.slice(4, 6), 16)},${alpha})`;
};
const formatMoney = (cents, hidden = false) => hidden
  ? "Hidden"
  : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
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
const coverageLabel = (status, cell) => {
  const manual = (cell?.payment?.sources || []).find(source => source.kind === "manual");
  if (manual?.decision === "unpaid" && status === "due") return "Unpaid";
  if (manual?.decision === "paid" && status === "paid") return "Paid, recorded by you";
  return STATUS[status]?.label || status;
};
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
    const hasReview = !linkedEvidence.length && unlinkedEvidence.some((invoice) => invoice?.coverageKind === "review");
    const onlyOtherWork = unlinkedEvidence.length === monthInvoiceEvidence.length
      && unlinkedEvidence.every((invoice) => invoice?.coverageKind === "other_work");
    if (statuses.size > 1) {
      const evidenceCount = statusEvidence.length;
      return `${evidenceCount} ${linkedEvidence.length ? "linked invoices" : "invoices"} · mixed status`;
    }
    const base = hasPaid ? "Paid invoice" : hasPartial ? "Partly paid invoice" : hasOpen ? "Open invoice" : "Invoice found";
    if (hasReview) return compact ? `${base} · needs match` : `${base} · needs maintenance match`;
    if (onlyOtherWork) return compact ? `${base} · other work` : `${base} · other work, not maintenance`;
    return statusEvidence.length > 1 ? `${base} · ${statusEvidence.length} records` : base;
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
  return maintenanceCoverageInvoiceChoices(row.clientId, clients, invoices);
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

function CoverageCell({ cell, monthKey, monthLabel, clientName, selected, T, onClick }) {
  const status = displayStatusForMonth(cell, monthKey);
  const tone = statusTone(status, T);
  const paymentLabel = coverageLabel(status, cell);
  return (
    <button
      type="button"
      aria-label={`${clientName}, ${monthLabel}: ${paymentLabel}. ${invoiceEvidenceLabel(cell)}. ${visitEvidenceLabel(cell)}.`}
      title={`${paymentLabel} · ${invoiceEvidenceLabel(cell)} · ${visitEvidenceLabel(cell)}`}
      onClick={onClick}
      style={{
        width: "100%", minHeight: 54, border: "none", boxShadow: selected ? `inset 0 0 0 2px ${T.primary}` : "none",
        background: selected ? hexA(T.primary || "#AF011A", 0.08) : (status === "missing" ? T.surface : tone.background),
        color: tone.color, padding: "8px", textAlign: "center", cursor: "pointer", fontFamily: "inherit",
      }}
    >
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11.5, lineHeight: 1.25, fontWeight: 730 }}>
        {["paid", "prepaid", "waived"].includes(status) ? <Icon name="check" size={12} /> : null}
        {paymentLabel === "Unpaid" ? "Unpaid" : STATUS[status]?.short || paymentLabel}
      </span>
    </button>
  );
}

function DetailPanel({ selection, rows, invoices, clients, year, hiddenAmounts, T, busy, onClose, onAssign, onClear, onCreateInvoice }) {
  const row = rows.find((candidate) => candidate.clientId === selection?.clientId);
  const initialMonth = selection?.monthKey;
  const [months, setMonths] = useState(() => initialMonth ? [initialMonth] : []);
  const [invoiceId, setInvoiceId] = useState("");
  const [mode, setMode] = useState("invoice");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [createdSelectionKey, setCreatedSelectionKey] = useState("");
  const pendingRef = useRef(false);
  const disabled = busy || working;

  useEffect(() => {
    setMonths(initialMonth ? [initialMonth] : []);
    const invoice = sourceInvoiceForCell(row?.byMonth?.[initialMonth], invoices);
    setInvoiceId(invoiceLinkIdentity(invoice));
    const payment = row?.byMonth?.[initialMonth]?.payment;
    const manual = (payment?.sources || []).find(source => source.kind === "manual");
    setMode(manual?.decision || (payment?.status === "waived" ? "waived" : "invoice"));
    setNote(payment?.note || "");
    setError("");
    setSavedMessage("");
    setInvoiceSearch("");
    setCreatedSelectionKey("");
  }, [row?.clientId, initialMonth]);

  useEffect(() => {
    const closeOnEscape = event => { if (event.key === "Escape" && !pendingRef.current) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  if (!row || !initialMonth || !initialMonth.startsWith(`${year}-`)) return null;
  const candidates = clientInvoicesFor(row, invoices, clients);
  const cell = row.byMonth[initialMonth];
  const status = displayStatusForMonth(cell, initialMonth);
  const paymentLabel = coverageLabel(status, cell);
  const invoiceLabel = invoiceEvidenceLabel(cell);
  const visitLabel = visitEvidenceLabel(cell);
  const monthInvoiceEvidence = Array.isArray(cell?.invoiceEvidence) ? cell.invoiceEvidence : [];
  const selectedInvoice = candidates.find((invoice) => invoiceLinkIdentity(invoice) === invoiceId);
  const preview = maintenanceCoverageInvoicePreview(selectedInvoice, months);
  const visibleCandidates = candidates.filter(invoice => !invoiceSearch || [invoice.number, invoice.DocNumber, invoice.date, invoice.TxnDate, ...(invoice.lineItems || []).map(line => line.desc || line.description)].some(value => text(value).toLowerCase().includes(invoiceSearch.toLowerCase())));
  const requiresNote = mode === "paid" || mode === "waived";
  const createTotalCents = row.maintenancePriceCents > 0 ? row.maintenancePriceCents * months.length : null;
  const createSelectionKey = [row.clientId, ...months].join("|");
  const createMonthLabels = months.map(key => `${MONTHS.find(([number]) => key.endsWith(`-${number}`))?.[1]} ${year}`).join(", ");
  const monthMeta = MONTHS.find(([number]) => initialMonth.endsWith(`-${number}`));
  const toggleMonth = (monthKey) => { setSavedMessage(""); setMonths((current) => current.includes(monthKey)
    ? (current.length === 1 ? current : current.filter((value) => value !== monthKey))
    : [...current, monthKey].sort()); };
  const save = async () => {
    if (pendingRef.current || disabled) return;
    setError("");
    setSavedMessage("");
    if (mode === "invoice" && !selectedInvoice) {
      setError("Choose the QuickBooks or SPS invoice that covers the selected month.");
      return;
    }
    if (mode === "invoice" && !(preview?.totalCents > 0)) { setError("Save or sync this invoice first so its total can be confirmed."); return; }
    if (requiresNote && !note.trim()) { setError(mode === "paid" ? "Add how and when the payment was received." : "Add a reason for waiving this charge."); return; }
    pendingRef.current = true;
    setWorking(true);
    try {
      const saved = await onAssign({
        clientId: row.clientId,
        monthKeys: months,
        actionType: mode,
        invoiceId: mode === "invoice" ? invoiceId : undefined,
        note,
      });
      setSavedMessage(maintenanceCoverageSavedMessage(saved?.maintenancePaymentLedger || saved?.ledger || saved, row.clientId, months));
    } catch (saveError) {
      setError(saveError?.message || "Coverage could not be saved.");
    } finally {
      pendingRef.current = false;
      setWorking(false);
    }
  };
  const clear = async () => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true; setWorking(true); setError(""); setSavedMessage("");
    try { await onClear({ clientId: row.clientId, monthKeys: months }); setSavedMessage("Saved choice cleared. The calendar now shows the available payment history."); }
    catch (saveError) { setError(saveError?.message || "The saved choice could not be cleared."); }
    finally { pendingRef.current = false; setWorking(false); }
  };
  const createInvoice = async () => {
    if (!onCreateInvoice || pendingRef.current || disabled || createdSelectionKey === createSelectionKey) return;
    pendingRef.current = true; setWorking(true); setError(""); setSavedMessage("");
    try {
      const result = await onCreateInvoice({ clientId: row.clientId, monthKeys: [...months], returnToMaintenance: true });
      const invoice = result?.invoice || result;
      if (invoiceLinkIdentity(invoice)) { setCreatedSelectionKey(createSelectionKey); setInvoiceId(invoiceLinkIdentity(invoice)); setInvoiceSearch(""); setMode("invoice"); setSavedMessage("Draft invoice created. Review it below, then link it to these months. It has not been sent."); }
    } catch (createError) { setError(createError?.message || "The invoice could not be opened."); }
    finally { pendingRef.current = false; setWorking(false); }
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
        <button type="button" disabled={disabled} onClick={onClose} aria-label="Close" style={{ width: 38, height: 38, border: `1px solid ${T.border}`, borderRadius: "50%", background: T.surface, color: T.textMuted, display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="close" size={17}/></button>
      </div>

      <div style={{ padding: "22px 24px 38px" }}>
        {savedMessage ? <div role="status" data-maintenance-saved-result style={{ display: "flex", gap: 9, alignItems: "flex-start", borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .045), padding: "12px 13px", marginBottom: 18, fontSize: 13, fontWeight: 700, lineHeight: 1.45 }}><span style={{ color: T.primary, paddingTop: 1 }}><Icon name="check" size={16}/></span>{savedMessage}</div> : null}
        <section style={{ borderTop: `3px solid ${T.text}`, borderBottom: `1px solid ${T.border}`, padding: "15px 0 17px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 18 }}>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Coverage</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{paymentLabel}</div></div>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Invoice evidence</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{invoiceLabel}</div></div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: T.textMuted }}>{visitLabel}</div>
          {status === "review" ? <div style={{ marginTop: 13, color: T.text, fontSize: 12.5, lineHeight: 1.45 }}>Link the correct invoice below, or record this month's payment status.</div> : null}
          {cell.payment?.note ? <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.45 }}><strong>Saved note:</strong> {cell.payment.note}{cell.payment.updatedAt ? <div style={{ marginTop: 4, color: T.textMuted, fontSize: 11 }}>{formatReceiptTimestamp(cell.payment.updatedAt)}{cell.payment.updatedBy ? ` · ${cell.payment.updatedBy}` : ""}</div> : null}</div> : null}
          {cell.payment?.reasons?.length ? <div style={{ marginTop: 13, paddingLeft: 11, borderLeft: `2px solid ${T.primary}`, color: T.textMuted, fontSize: 12.5, lineHeight: 1.45 }}>{cell.payment.reasons.join(" ")}</div> : null}
          {monthInvoiceEvidence.length ? (
            <details data-maintenance-month-invoice-evidence style={{ marginTop: 15, borderTop: `1px solid ${T.border}` }}>
              <summary style={{ padding: "10px 0", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Invoice history for this month ({monthInvoiceEvidence.length})</summary>
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
            </details>
          ) : null}
        </section>

        <section style={{ marginTop: 25 }}>
          <div style={{ fontSize: 11, fontWeight: 850, letterSpacing: ".075em", textTransform: "uppercase", color: T.textMuted }}>Months to update</div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", borderTop: `1px solid ${T.border}`, borderLeft: `1px solid ${T.border}` }}>
            {MONTHS.map(([number, short]) => {
              const key = `${year}-${number}`;
              const active = months.includes(key);
              return <button key={key} type="button" disabled={disabled} aria-pressed={active} aria-label={`${short} ${year}`} onClick={() => toggleMonth(key)} style={{ minHeight: 44, border: "none", borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, background: active ? T.text : T.surface, color: active ? T.surface : T.textMuted, fontFamily: "inherit", fontSize: 11.5, fontWeight: 780, cursor: "pointer" }}>{short}</button>;
            })}
          </div>
        </section>

        <section style={{ marginTop: 25 }}>
          <div role="group" aria-label="Update payment status" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 20, rowGap: 3, borderBottom: `1px solid ${T.border}` }}>
            {[["invoice", "Link invoice"], ["paid", "Record paid"], ["unpaid", "Mark unpaid"], ["waived", "Waive"]].map(([value, label]) => (
              <button key={value} type="button" disabled={disabled} aria-pressed={mode === value} onClick={() => { setMode(value); setError(""); setSavedMessage(""); }} style={{ border: "none", borderBottom: `2px solid ${mode === value ? T.primary : "transparent"}`, borderRadius: 0, background: "transparent", color: mode === value ? T.primary : T.textMuted, minHeight: 42, padding: "9px 0", fontSize: 12.5, fontWeight: 750, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>{label}</button>
            ))}
          </div>

          {mode === "invoice" ? (
            <div style={{ marginTop: 17 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <label htmlFor="maintenance-invoice-search" style={{ fontSize: 11, fontWeight: 850, letterSpacing: ".06em", textTransform: "uppercase", color: T.textMuted }}>Choose an invoice</label>
                <span style={{ fontSize: 11, color: T.textMuted }}>{candidates.length} matching record{candidates.length === 1 ? "" : "s"}</span>
              </div>
              {!!candidates.length && <input id="maintenance-invoice-search" type="search" value={invoiceSearch} disabled={disabled} onChange={event => setInvoiceSearch(event.target.value)} placeholder="Find invoice number or service" style={{ width: "100%", boxSizing: "border-box", minHeight: 42, border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface, color: T.text, padding: "9px 11px", fontFamily: "inherit", fontSize: 13, marginBottom: 10 }} />}
              <div data-maintenance-invoice-evidence style={{ maxHeight: 236, overflowY: "auto", borderTop: `1px solid ${T.border}` }}>
                {visibleCandidates.map((invoice) => {
                  const value = invoiceLinkIdentity(invoice);
                  const active = value === invoiceId;
                  const candidatePreview = maintenanceCoverageInvoicePreview(invoice, months);
                  return (
                    <button
                      key={value || `number:${text(invoice.number || invoice.DocNumber)}`}
                      type="button"
                      onClick={() => { setInvoiceId(value); setSavedMessage(""); setError(""); }}
                      disabled={!value || disabled}
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
                        <span style={{ display: "block", fontSize: 13, fontWeight: 850 }}>{candidatePreview.totalCents == null ? "Total not saved" : formatMoney(candidatePreview.totalCents, hiddenAmounts)}</span>
                        <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 5, marginTop: 4, color: active ? T.primary : T.textMuted, fontSize: 11.5 }}>{active ? <Icon name="check" size={12}/> : null}{candidatePreview.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {preview ? <div data-maintenance-match-preview style={{ marginTop: 12, borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .035), padding: "11px 12px", fontSize: 12.5, lineHeight: 1.5 }}><strong>After linking: {preview.label}</strong><div>{months.length} selected month{months.length === 1 ? "" : "s"} will use invoice #{selectedInvoice.number || selectedInvoice.DocNumber || "Unnumbered"}.</div>{preview.status === "due" || preview.status === "partial" ? <div style={{ marginTop: 5, color: T.textMuted }}>This invoice still has an unpaid balance{preview.balanceCents != null && !hiddenAmounts ? ` of ${formatMoney(preview.balanceCents)}` : ""}.</div> : null}<div style={{ marginTop: 5, color: T.textMuted }}>The selected match replaces the previous choice for these months. QuickBooks is unchanged.</div></div> : null}
              {!visibleCandidates.length ? <div style={{ marginTop: 10, color: T.textMuted, fontSize: 12.5 }}>{candidates.length ? "No invoices match this search." : "No invoice is saved for this client. Create one, or record paid or unpaid without an invoice."}</div> : null}
            </div>
          ) : (
            <div style={{ marginTop: 17, padding: "13px 0 13px 13px", borderLeft: `3px solid ${T.primary}`, color: T.textMuted, fontSize: 12.5, lineHeight: 1.5 }}>{mode === "paid" ? "Record a payment received outside an invoice, such as cash or check. These months will be marked paid in SPS; no QuickBooks payment is created." : mode === "unpaid" ? "Mark these months unpaid, even if no invoice exists yet. You can create and link an invoice later." : "Waive these months when no payment is owed. Add a reason for the record. QuickBooks is unchanged."}</div>
          )}
          {onCreateInvoice && ["invoice", "unpaid"].includes(mode) && createdSelectionKey !== createSelectionKey ? <div style={{ marginTop: 17, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: T.textMuted }}>{createTotalCents != null ? <>Create an unsent draft for <strong style={{ color: T.text }}>{createMonthLabels}</strong>{hiddenAmounts ? "." : <> at {formatMoney(row.maintenancePriceCents)} per month, <strong style={{ color: T.text }}>{formatMoney(createTotalCents)} total</strong>.</>}</> : "Set this client's maintenance price before creating a draft from the calendar."}</div>
            <button type="button" disabled={disabled || createTotalCents == null} onClick={createInvoice} style={{ marginTop: 9, minHeight: 42, border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface, color: T.primary, padding: "9px 13px", fontFamily: "inherit", fontWeight: 750, fontSize: 12.5, cursor: "pointer", opacity: disabled || createTotalCents == null ? .55 : 1 }}>Create draft invoice</button>
          </div> : null}
        </section>

        <section style={{ marginTop: 22 }}>
          <label htmlFor="maintenance-status-note" style={{ display: "block", fontSize: 11, fontWeight: 850, letterSpacing: ".06em", textTransform: "uppercase", color: T.textMuted, marginBottom: 7 }}>{mode === "paid" ? "Payment details" : mode === "waived" ? "Reason" : mode === "unpaid" ? "Unpaid note" : "Matching note"}{requiresNote ? " (required)" : " (optional)"}</label>
          <textarea id="maintenance-status-note" value={note} disabled={disabled} required={requiresNote} onChange={(event) => { setNote(event.target.value); setSavedMessage(""); }} placeholder={mode === "paid" ? "Payment method, date received, and receipt or check number" : mode === "waived" ? "Why no payment is owed" : mode === "unpaid" ? "Why does this month still need an invoice?" : "Which service dates does this invoice cover?"} rows={3} style={{ width: "100%", resize: "vertical", boxSizing: "border-box", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.text, padding: 12, fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.45 }} />
        </section>

        {error ? <div role="alert" style={{ marginTop: 14, color: T.primary, fontSize: 12.5, fontWeight: 750 }}>{error}</div> : null}
        <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" disabled={disabled || !onAssign || (mode === "invoice" && !selectedInvoice)} onClick={save} style={{ flex: 1, minHeight: 48, border: "none", borderRadius: 8, background: T.primary, color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 850, cursor: disabled ? "wait" : "pointer", opacity: disabled || (mode === "invoice" && !selectedInvoice) ? .55 : 1 }}>{disabled ? "Saving" : mode === "waived" ? "Waive selected months" : mode === "paid" ? "Save as paid" : mode === "unpaid" ? "Save as unpaid" : "Link selected invoice"}</button>
          {cell?.payment?.manual && onClear ? <button type="button" disabled={disabled} onClick={clear} style={{ minHeight: 48, border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.textMuted, padding: "0 14px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>Clear choice</button> : null}
        </div>
      </div>
    </div>
  );
}

export default function MaintenanceCoverageWorkspace({
  clients = [], invoices = [], payments = [], schedule = [], ledger = null,
  T, vp = {}, loading = false, saving = false, error = "", onReload, onReconcile,
  reconciliationReceipt = null, onAssign, onClear, onCreateInvoice,
  canSeeAmounts = true, autoRefreshConnected = false, lastCheckedAt = null,
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [search, setSearch] = useState("");
  const [serviceType, setServiceType] = useState("all");
  const [paymentStatus, setPaymentStatus] = useState("all");
  const [filterMonth, setFilterMonth] = useState("");
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [fullYear, setFullYear] = useState(false);
  const [selection, setSelection] = useState(null);
  const [receiptExpanded, setReceiptExpanded] = useState(false);
  const calendarRef = useRef(null);
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
  const monthMeta = useMemo(() => fullYear ? MONTHS : MONTHS.slice(3), [fullYear]);
  const monthKeys = useMemo(() => monthMeta.map(([number]) => `${year}-${number}`), [monthMeta, year]);
  const visibleRangeLabel = fullYear ? "January to December" : "April to December";
  useEffect(() => {
    const region = calendarRef.current;
    if (!region || !compactControls) return;
    const heading = filterMonth && region.querySelector(`[data-calendar-month="${filterMonth}"]`);
    const clientHeading = region.querySelector("thead th");
    region.scrollLeft = heading && clientHeading ? Math.max(0, heading.offsetLeft - clientHeading.offsetWidth) : 0;
  }, [filterMonth, monthMeta, compactControls]);
  const rows = useMemo(() => buildMaintenanceCalendarRows({
    clients, invoices, payments, ledger, schedule, year,
  }), [clients, invoices, payments, ledger, schedule, year]);
  const assignedClientIds = useMemo(() => new Set(rows.map((row) => String(row.clientId))), [rows]);
  const effectiveSortKey = !canSeeAmounts && sortKey === "price" ? "name" : sortKey;
  const visibleRows = useMemo(() => filterMaintenanceCalendarRows(rows, {
    search, serviceType, paymentStatus, monthKey: filterMonth, monthKeys,
    sortKey: effectiveSortKey, sortDirection,
  }), [rows, search, serviceType, paymentStatus, filterMonth, monthKeys, effectiveSortKey, sortDirection]);
  const filtersActive = !!(search || serviceType !== "all" || paymentStatus !== "all" || filterMonth);
  const resetFilters = () => {
    setSearch(""); setServiceType("all"); setPaymentStatus("all"); setFilterMonth("");
    setSelection(null);
  };
  const chooseMonth = (monthKey) => {
    setFilterMonth(monthKey);
    setSelection(null);
    if (/^\d{4}-\d{2}$/.test(sortKey)) setSortKey(monthKey || "name");
  };
  const sortColumn = (key) => {
    if (key === "price" && !canSeeAmounts) return;
    setSortDirection(effectiveSortKey === key && sortDirection === "asc" ? "desc" : "asc");
    setSortKey(key);
    if (/^\d{4}-\d{2}$/.test(key)) setFilterMonth(key);
  };
  const sortOptions = [
    ["name:asc", "Client: A to Z"], ["name:desc", "Client: Z to A"],
    ...(canSeeAmounts ? [["price:asc", "Price: low to high"], ["price:desc", "Price: high to low"]] : []),
    ["prepaid:desc", "Prepaid: most months"], ["prepaid:asc", "Prepaid: fewest months"],
    ...monthMeta.flatMap(([number, , long]) => [[`${year}-${number}:asc`, `${long}: unpaid first`], [`${year}-${number}:desc`, `${long}: covered first`]]),
  ];
  const fieldStyle = { width: "100%", height: 40, minWidth: 0, boxSizing: "border-box", border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface, color: T.text, padding: "0 10px", fontFamily: "inherit", fontSize: 12.5 };
  const activeFieldStyle = (active) => ({ ...fieldStyle, ...(active ? { borderColor: hexA(T.primary, .45), background: hexA(T.primary, .035), color: T.primary, fontWeight: 700 } : {}) });
  const filterSummary = [serviceType !== "all" ? MAINTENANCE_CALENDAR_SERVICE_OPTIONS.find(({ value }) => value === serviceType)?.label : "", filterMonth ? `${MONTHS.find(([number]) => filterMonth.endsWith(`-${number}`))?.[2]} ${year}` : "", paymentStatus !== "all" ? MAINTENANCE_CALENDAR_PAYMENT_OPTIONS.find(({ value }) => value === paymentStatus)?.label : ""].filter(Boolean).join(" · ");
  const filterLabelStyle = { display: "grid", gap: 6, minWidth: 0, color: T.textMuted, fontSize: 11.5, fontWeight: 650 };
  const sortHeader = (key, label, sticky = false) => (
    <th key={key} scope="col" data-calendar-month={key.includes("-") ? key : undefined} aria-sort={effectiveSortKey === key ? sortDirection === "asc" ? "ascending" : "descending" : "none"} style={{ ...(sticky ? { position: "sticky", left: 0, zIndex: 4, borderRight: `1px solid ${T.border}` } : {}), background: filterMonth === key ? hexA(T.primary, .09) : T.surfaceAlt, padding: 0, textAlign: sticky ? "left" : "center", borderBottom: `2px solid ${filterMonth === key ? T.primary : T.text}` }}>
      <button type="button" disabled={key === "price" && !canSeeAmounts} onClick={() => sortColumn(key)} aria-label={`Sort by ${label}`} title={key.includes("-") ? `Filter ${label} and sort unpaid or covered first` : `Sort by ${label}`} style={{ width: "100%", minHeight: 44, display: "inline-flex", alignItems: "center", justifyContent: sticky ? "flex-start" : "center", gap: 5, border: "none", background: "transparent", padding: sticky ? "10px 12px" : "10px 5px", color: effectiveSortKey === key ? T.primary : T.text, fontFamily: "inherit", fontSize: 11.5, fontWeight: 750, cursor: key === "price" && !canSeeAmounts ? "default" : "pointer" }}>
        {label}<span aria-hidden="true" style={{ opacity: effectiveSortKey === key ? 1 : .35 }}>{effectiveSortKey === key ? sortDirection === "asc" ? "↑" : "↓" : "↕"}</span>
      </button>
    </th>
  );
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
    if (filterMonth) setFilterMonth(`${nextYear}-${filterMonth.slice(-2)}`);
    if (/^\d{4}-\d{2}$/.test(sortKey)) setSortKey(`${nextYear}-${sortKey.slice(-2)}`);
  };
  const toggleYearRange = () => {
    setSelection(null);
    if (fullYear && filterMonth && Number(filterMonth.slice(-2)) < 4) setFilterMonth("");
    if (fullYear && /^\d{4}-0[1-3]$/.test(sortKey)) setSortKey("name");
    setFullYear((value) => !value);
  };
  const openReceiptDetail = (detail) => {
    const monthKey = (Array.isArray(detail?.months) ? detail.months[0] : "") || detail?.invoiceMonth || "";
    const monthMatch = String(monthKey).match(/^(\d{4})-(\d{2})$/);
    if (!detail?.clientId || !assignedClientIds.has(String(detail.clientId)) || !monthMatch) return;
    const targetYear = Number(monthMatch[1]);
    if (Number(monthMatch[2]) < 4) setFullYear(true);
    changeYear(targetYear);
    setSelection({ clientId: detail.clientId, monthKey });
  };
  return (
    <div data-maintenance-payment-ledger style={{ color: T.text, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: "inherit" }}>
      <div style={{ display: "grid", gridTemplateColumns: compactControls ? "1fr" : "minmax(260px, 1fr) auto", alignItems: "end", gap: 18, padding: vp.isPhone ? "18px 0 16px" : "24px 0 20px", borderBottom: `3px solid ${T.text}` }}>
        <div>
          <div style={{ color: T.primary, fontSize: 11, fontWeight: 900, letterSpacing: ".09em", textTransform: "uppercase" }}>Maintenance accounting</div>
          <h3 style={{ margin: "5px 0 0", fontSize: vp.isPhone ? 28 : 34, lineHeight: 1, letterSpacing: "-.045em" }}>Payment calendar</h3>
          <div style={{ marginTop: 9, color: T.textMuted, fontSize: 13, lineHeight: 1.4 }}>Assigned pool, pond, and leaf maintenance. Payments and prepayments by month.</div>
          <div role="status" data-maintenance-refresh-status style={{ marginTop: 7, fontSize: 11.5, color: T.textMuted }}>{autoRefreshConnected ? loading || saving ? "Updating from QuickBooks…" : `${lastCheckedAt ? `QuickBooks checked ${new Date(lastCheckedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ` : ""}Updates automatically while this calendar is open.` : "Connect QuickBooks to keep payment status up to date."}</div>
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
            style={{ minHeight: 32, gridColumn: compactControls ? "1 / -1" : "auto", justifySelf: "end", border: "none", background: "transparent", color: T.textMuted, padding: "0 3px", textDecoration: "underline", textUnderlineOffset: 3, fontFamily: "inherit", fontSize: 11.5, fontWeight: 650, cursor: loading || saving ? "wait" : "pointer", opacity: loading || saving ? .68 : 1 }}
          >
            {saving ? "Reconciling" : "Reconcile history"}
          </button>
        </div>
      </div>

      {receiptEvidence && (!reconciliationReceipt?.automatic || receiptEvidence.details.length > 0) ? (
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
                    const canOpenMonth = !!(assignedClientIds.has(String(detail.clientId)) && /^\d{4}-\d{2}$/.test(String(targetMonth)));
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

      <div aria-label="Calendar filters" style={{ padding: "17px 0 14px", borderBottom: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: vp.isPhone ? "1fr 1fr" : compactControls ? "1fr 1fr 1fr" : "minmax(200px, 1.5fr) repeat(3, minmax(140px, 1fr))", alignItems: "end", gap: 12 }}>
        <label style={{ ...filterLabelStyle, gridColumn: vp.isPhone || compactControls ? "1 / -1" : "auto" }}>
          Client name
          <span style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}><Icon name="search" size={15}/></span>
            <input type="search" aria-label="Filter maintenance clients" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a maintenance client" style={{ ...fieldStyle, paddingLeft: 33 }} />
          </span>
        </label>
        <label style={filterLabelStyle}>Service
          <select aria-label="Maintenance service" value={serviceType} onChange={(event) => { setServiceType(event.target.value); setSelection(null); }} style={activeFieldStyle(serviceType !== "all")}>
            {MAINTENANCE_CALENDAR_SERVICE_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label style={filterLabelStyle}>Month
          <select aria-label="Payment month" value={filterMonth} onChange={(event) => chooseMonth(event.target.value)} style={activeFieldStyle(!!filterMonth)}>
            <option value="">All shown months</option>
            {monthMeta.map(([number, , long]) => <option key={number} value={`${year}-${number}`}>{long}</option>)}
          </select>
        </label>
        <label style={{ ...filterLabelStyle, gridColumn: vp.isPhone ? "1 / -1" : "auto" }}>Payment status
          <select aria-label="Payment status" value={paymentStatus} onChange={(event) => { setPaymentStatus(event.target.value); setSelection(null); }} style={activeFieldStyle(paymentStatus !== "all")}>
            {MAINTENANCE_CALENDAR_PAYMENT_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 0" }}>
        <div style={{ minWidth: 160 }}>
          <div role="status" data-maintenance-filter-summary style={{ fontSize: 12, fontWeight: 700 }}>{filtersActive ? `${visibleRows.length} of ${rows.length} assigned clients` : `${rows.length} assigned maintenance clients`}{filterSummary ? <span style={{ color: T.primary, fontWeight: 650 }}> · {filterSummary}</span> : null}</div>
          <div style={{ marginTop: 4, fontSize: 11, color: T.textMuted }}>Showing {visibleRangeLabel} {year}. {compactControls ? "Swipe across for more months." : "Click a column to sort."}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", width: vp.isPhone ? "100%" : "auto" }}>
          {filtersActive ? <button type="button" onClick={resetFilters} style={{ border: "none", background: "transparent", color: T.primary, fontFamily: "inherit", fontSize: 12, fontWeight: 750, padding: "8px 0", cursor: "pointer" }}>Clear filters</button> : null}
          <label style={{ display: "flex", alignItems: "center", gap: 8, flex: vp.isPhone ? 1 : "initial", color: T.textMuted, fontSize: 11.5 }}>Sort
            <select aria-label="Sort maintenance clients" value={`${effectiveSortKey}:${sortDirection}`} onChange={(event) => {
              const [key, direction] = event.target.value.split(":");
              setSortKey(key); setSortDirection(direction);
              if (/^\d{4}-\d{2}$/.test(key)) setFilterMonth(key);
            }} style={{ ...fieldStyle, width: vp.isPhone ? "100%" : 196, height: 36 }}>
              {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      </div>
      {paymentStatus !== "all" ? <div style={{ marginBottom: 12, fontSize: 11.5, color: T.textMuted }}>
        {paymentStatus === "paid" ? "Paid includes prepaid coverage. Waived months are separate." : paymentStatus === "unpaid" ? "Unpaid includes open invoices, partial payments, refunds, and expected months with no payment. Future months stay visible without counting as missing." : "Only clients with a matching status in the selected month or shown period appear."}
        {!filterMonth ? " Select one month to check that month's payments." : ""}
      </div> : null}

      {error ? <div role="alert" style={{ padding: "10px 12px", borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .06), color: T.primary, fontSize: 12.5, fontWeight: 750, marginBottom: 12 }}>{error}</div> : null}

      <div ref={calendarRef} role="region" aria-label="Maintenance payment calendar" tabIndex={0} style={{ overflow: "auto", maxHeight: "68vh", border: `1px solid ${T.border}`, background: T.surface }}>
        <table data-maintenance-calendar-grid style={{ width: "100%", minWidth: 390 + monthMeta.length * 90, borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed" }}>
          <colgroup><col style={{ width: vp.isPhone ? 154 : 210 }} /><col style={{ width: 88 }} /><col style={{ width: 100 }} />{monthMeta.map(([number]) => <col key={number} style={{ width: 90 }} />)}</colgroup>
          <thead style={{ position: "sticky", top: 0, zIndex: 3 }}>
            <tr>
              {sortHeader("name", "Client", true)}
              {sortHeader("price", "Price")}
              {sortHeader("prepaid", "Prepaid")}
              {monthMeta.map(([number, short]) => sortHeader(`${year}-${number}`, short))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const prepaidMonths = monthMeta.filter(([number]) => row.byMonth[`${year}-${number}`]?.payment?.status === "prepaid");
              return (
                <tr key={row.clientId}>
                  <th scope="row" style={{ position: "sticky", left: 0, zIndex: 2, background: T.surface, textAlign: "left", padding: "10px 12px", fontSize: 13, fontWeight: 750, borderBottom: `1px solid ${T.border}`, borderRight: `1px solid ${T.border}`, overflowWrap: "anywhere" }}>{row.clientName}<span style={{ display: "block", marginTop: 4, color: T.textMuted, fontSize: 10.5, fontWeight: 500 }}>{(row.maintenanceTypes || []).map((type) => ({ pool: "Pool", pond: "Pond", leaf: "Leaf" }[type])).join(" · ")}</span></th>
                  <td style={{ padding: "8px", textAlign: "center", fontSize: 12, fontVariantNumeric: "tabular-nums", borderBottom: `1px solid ${T.border}` }}>{!canSeeAmounts ? "Hidden" : row.maintenancePriceCents == null ? <span title="Complete the assigned service rates in this client's profile" style={{ color: T.textMuted }}>Not set</span> : formatMoney(row.maintenancePriceCents)}</td>
                  <td style={{ padding: "8px", textAlign: "center", fontSize: 11.5, color: prepaidMonths.length ? T.text : T.textMuted, borderBottom: `1px solid ${T.border}` }} title={prepaidMonths.map(([, short]) => short).join(", ") || "No prepaid months recorded"}>{prepaidMonths.length ? <><strong>{prepaidMonths.length} / {monthMeta.length}</strong><span style={{ display: "block", marginTop: 3, fontSize: 10 }}>months prepaid</span></> : <span aria-label="No prepaid months">0</span>}</td>
                  {monthMeta.map(([number, , long]) => {
                    const monthKey = `${year}-${number}`;
                    return <td key={monthKey} style={{ padding: 0, borderBottom: `1px solid ${T.border}`, borderLeft: `1px solid ${T.border}` }}><CoverageCell cell={row.byMonth[monthKey]} monthKey={monthKey} monthLabel={`${long} ${year}`} clientName={row.clientName} selected={selection?.clientId === row.clientId && selection?.monthKey === monthKey} T={T} onClick={() => openCell(row, monthKey)} /></td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && visibleRows.length === 0 ? <div style={{ padding: "50px 12px", textAlign: "center", color: T.textMuted }}><div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>No maintenance clients match this view</div><div style={{ marginTop: 6, fontSize: 12.5 }}>Change the service, month, or payment filters, or clear the search.</div></div> : null}
      {selection ? <DetailPanel selection={selection} rows={rows} invoices={invoices} clients={clients} year={year} hiddenAmounts={!canSeeAmounts} T={T} busy={saving} onClose={() => setSelection(null)} onAssign={onAssign} onClear={onClear} onCreateInvoice={onCreateInvoice} /> : null}
    </div>
  );
}
