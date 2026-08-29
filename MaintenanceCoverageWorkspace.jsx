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
  missing: { label: "No coverage", short: "Missing" },
  review: { label: "Needs review", short: "Review" },
  waived: { label: "Waived", short: "Waived" },
  refunded: { label: "Refunded", short: "Refund" },
  upcoming: { label: "Upcoming", short: "Upcoming" },
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
const invoiceAmountCents = (invoice) => moneyToCents(invoice?.total ?? invoice?.amount ?? invoice?.subtotal);
const displayStatusForMonth = (cell, monthKey) => {
  return maintenancePaymentDisplayStatus(cell?.payment?.status, monthKey);
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
    if (String(invoice?.clientId || "") === String(row.clientId)) return true;
    if (client?.qbId && String(invoice?.qbCustomerId || "") === String(client.qbId)) return true;
    return normalizedName(invoice?.clientName || invoice?.customerName) === clientName;
  }).sort((left, right) => String(right?.date || right?.createdAt || "").localeCompare(String(left?.date || left?.createdAt || "")));
}

function sourceInvoiceForCell(cell, invoices) {
  const sources = cell?.payment?.sources || [];
  for (const source of sources) {
    const match = (invoices || []).find((invoice) => (
      (source.invoiceId && String(invoice?.id) === String(source.invoiceId))
      || (source.qbInvoiceId && String(invoice?.qbId) === String(source.qbInvoiceId))
      || (source.invoiceNumber && String(invoice?.number) === String(source.invoiceNumber))
    ));
    if (match) return match;
  }
  return null;
}

function CoverageCell({ cell, monthKey, monthLabel, selected, T, onClick }) {
  const status = displayStatusForMonth(cell, monthKey);
  const tone = statusTone(status, T);
  const hasVisits = Number(cell?.schedule?.visitCount || 0) > 0;
  return (
    <button
      type="button"
      aria-label={`${monthLabel}: ${STATUS[status]?.label || status}`}
      onClick={onClick}
      style={{
        width: "100%", minHeight: 58, border: "none", borderLeft: `2px solid ${selected ? (T.primary || "#AF011A") : tone.line}`,
        background: selected ? hexA(T.primary || "#AF011A", 0.08) : (status === "missing" ? T.surface : tone.background),
        color: tone.color, padding: "8px 7px 7px", textAlign: "left", cursor: "pointer", fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 11.5, lineHeight: 1.15, fontWeight: 780 }}>{STATUS[status]?.short || ""}</div>
      <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, color: T.textMuted }}>
        {status === "paid" || status === "prepaid" || status === "waived" ? <Icon name="check" size={11} /> : null}
        {hasVisits ? `${cell.schedule.completedCount}/${cell.schedule.visitCount} visits` : "No visits"}
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
    setInvoiceId(invoice?.id || invoice?.qbId ? String(invoice.id || invoice.qbId) : "");
    setMode(row?.byMonth?.[initialMonth]?.payment?.status === "waived" ? "waived" : "invoice");
    setNote("");
    setError("");
  }, [row?.clientId, initialMonth, invoices]);

  if (!row || !initialMonth) return null;
  const candidates = clientInvoicesFor(row, invoices, clients);
  const cell = row.byMonth[initialMonth];
  const status = displayStatusForMonth(cell, initialMonth);
  const selectedInvoice = candidates.find((invoice) => String(invoice?.id || invoice?.qbId) === String(invoiceId));
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
          <div style={{ marginTop: 7, fontSize: 13, color: T.textMuted }}>{STATUS[status]?.label} · {formatMoney(cell.expectedCents, hiddenAmounts)} expected</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={{ width: 38, height: 38, border: `1px solid ${T.border}`, borderRadius: "50%", background: T.surface, color: T.textMuted, display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="close" size={17}/></button>
      </div>

      <div style={{ padding: "22px 24px 38px" }}>
        <section style={{ borderTop: `3px solid ${T.text}`, borderBottom: `1px solid ${T.border}`, padding: "15px 0 17px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Payment</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{STATUS[status]?.label}</div></div>
            <div><div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".07em", textTransform: "uppercase", color: T.textMuted }}>Service visits</div><div style={{ marginTop: 5, fontSize: 17, fontWeight: 800 }}>{cell.schedule ? `${cell.schedule.completedCount} of ${cell.schedule.visitCount} complete` : "Schedule unavailable"}</div></div>
          </div>
          {cell.payment?.reasons?.length ? <div style={{ marginTop: 13, paddingLeft: 11, borderLeft: `2px solid ${T.primary}`, color: T.textMuted, fontSize: 12.5, lineHeight: 1.45 }}>{cell.payment.reasons.join(" ")}</div> : null}
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
                  const value = String(invoice.id || invoice.qbId || "");
                  const active = value === invoiceId;
                  return (
                    <button
                      key={invoice.id || invoice.qbId || invoice.number}
                      type="button"
                      onClick={() => setInvoiceId(value)}
                      aria-pressed={active}
                      style={{
                        width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 14,
                        border: "none", borderBottom: `1px solid ${T.border}`, borderLeft: `3px solid ${active ? T.primary : "transparent"}`,
                        background: active ? hexA(T.primary, .055) : T.surface, color: T.text,
                        padding: "12px 10px 12px 12px", textAlign: "left", fontFamily: "inherit", cursor: "pointer",
                      }}
                    >
                      <span>
                        <span style={{ display: "block", fontSize: 13, fontWeight: 850 }}>Invoice #{invoice.number || "Unnumbered"}</span>
                        <span style={{ display: "block", marginTop: 4, color: T.textMuted, fontSize: 11.5 }}>{invoice.date || "No issue date"} · {invoice.qbId ? "QuickBooks confirmed" : "SPS record"}</span>
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
  T, vp = {}, loading = false, saving = false, error = "", onReload, onAssign, onClear,
  canSeeAmounts = true,
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("attention");
  const [fullYear, setFullYear] = useState(false);
  const [selection, setSelection] = useState(null);
  const monthMeta = fullYear ? MONTHS : MONTHS.slice(3);
  const rows = useMemo(() => buildMaintenancePaymentLedgerRows({
    clients, invoices, payments, ledger, schedule, year,
  }), [clients, invoices, payments, ledger, schedule, year]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    const matches = !search || row.clientName.toLowerCase().includes(search.toLowerCase());
    if (!matches) return false;
    if (view === "all") return true;
    const statuses = monthMeta.map(([number]) => displayStatusForMonth(row.byMonth[`${year}-${number}`], `${year}-${number}`));
    if (view === "covered") return statuses.some((status) => ["paid", "prepaid", "waived"].includes(status));
    return statuses.some((status) => ["missing", "review", "partial", "refunded", "due"].includes(status));
  }), [rows, search, view, monthMeta, year]);
  const counts = useMemo(() => {
    const result = { missing: 0, review: 0, open: 0, covered: 0 };
    for (const row of rows) for (const [number] of monthMeta) {
      const status = displayStatusForMonth(row.byMonth[`${year}-${number}`], `${year}-${number}`);
      if (status === "missing") result.missing += 1;
      else if (["review", "partial", "refunded"].includes(status)) result.review += 1;
      else if (status === "due") result.open += 1;
      else if (["paid", "prepaid", "waived"].includes(status)) result.covered += 1;
    }
    return result;
  }, [rows, monthMeta, year]);

  const openCell = (row, monthKey) => setSelection({ clientId: row.clientId, monthKey });
  return (
    <div data-maintenance-payment-ledger style={{ color: T.text, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: "inherit" }}>
      <div style={{ display: "grid", gridTemplateColumns: vp.isPhone ? "1fr" : "minmax(260px, 1fr) auto", alignItems: "end", gap: 18, padding: vp.isPhone ? "18px 0 16px" : "24px 0 20px", borderBottom: `3px solid ${T.text}` }}>
        <div>
          <div style={{ color: T.primary, fontSize: 11, fontWeight: 900, letterSpacing: ".09em", textTransform: "uppercase" }}>Maintenance accounting</div>
          <h3 style={{ margin: "5px 0 0", fontSize: vp.isPhone ? 28 : 34, lineHeight: 1, letterSpacing: "-.045em" }}>Payment calendar</h3>
          <div style={{ marginTop: 9, color: T.textMuted, fontSize: 13, lineHeight: 1.4 }}>QuickBooks payments, prepayments, and expected service shown together before another invoice is created.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: vp.isPhone ? "space-between" : "flex-end", gap: 8 }}>
          <button type="button" onClick={() => setYear((value) => value - 1)} style={{ width: 38, height: 38, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: "inherit", cursor: "pointer" }}>‹</button>
          <div style={{ minWidth: 72, textAlign: "center", fontWeight: 850, fontSize: 14 }}>{year}</div>
          <button type="button" onClick={() => setYear((value) => value + 1)} style={{ width: 38, height: 38, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: "inherit", cursor: "pointer" }}>›</button>
          <button type="button" onClick={() => setFullYear((value) => !value)} style={{ minHeight: 38, border: `1px solid ${T.border}`, background: T.surface, color: T.textMuted, padding: "0 12px", fontFamily: "inherit", fontWeight: 750, cursor: "pointer" }}>{fullYear ? "Apr to Dec" : "Full year"}</button>
          <button type="button" onClick={onReload} disabled={loading} style={{ minHeight: 38, border: "none", background: T.primary, color: "#fff", padding: "0 13px", fontFamily: "inherit", fontSize: 12, fontWeight: 820, cursor: loading ? "wait" : "pointer", opacity: loading ? .68 : 1 }}>{loading ? "Checking" : "Refresh QuickBooks"}</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: vp.isPhone ? "1fr 1fr" : "1fr auto", gap: 12, alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", gap: vp.isPhone ? 13 : 24, alignItems: "baseline", flexWrap: "wrap" }}>
          <div><strong style={{ fontSize: 18, color: counts.missing ? T.primary : T.text }}>{counts.missing}</strong><span style={{ marginLeft: 5, fontSize: 11.5, color: T.textMuted }}>missing</span></div>
          <div><strong style={{ fontSize: 18, color: counts.review ? T.primary : T.text }}>{counts.review}</strong><span style={{ marginLeft: 5, fontSize: 11.5, color: T.textMuted }}>review</span></div>
          <div><strong style={{ fontSize: 18 }}>{counts.open}</strong><span style={{ marginLeft: 5, fontSize: 11.5, color: T.textMuted }}>open</span></div>
          <div><strong style={{ fontSize: 18 }}>{counts.covered}</strong><span style={{ marginLeft: 5, fontSize: 11.5, color: T.textMuted }}>covered</span></div>
        </div>
        <div style={{ justifySelf: "end", color: T.textMuted, fontSize: 11.5 }}>Future months stay visible without counting as missing.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: vp.isPhone ? "1fr" : "minmax(260px, 1fr) auto", alignItems: "center", gap: 12, padding: "15px 0" }}>
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: T.textMuted }}><Icon name="search" size={16}/></span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find maintenance client" style={{ width: "100%", height: 43, boxSizing: "border-box", padding: "0 12px 0 35px", border: `1px solid ${T.border}`, borderRadius: 7, background: T.surface, color: T.text, fontFamily: "inherit", fontSize: 13.5 }} />
        </div>
        <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${T.border}` }}>
          {[['attention', 'Attention'], ['covered', 'Covered'], ['all', `All ${rows.length}`]].map(([value, label]) => <button key={value} type="button" onClick={() => setView(value)} style={{ border: "none", borderBottom: `3px solid ${view === value ? T.primary : "transparent"}`, background: "transparent", color: view === value ? T.text : T.textMuted, padding: "9px 12px 8px", fontFamily: "inherit", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>{label}</button>)}
        </div>
      </div>

      {error ? <div role="alert" style={{ padding: "10px 12px", borderLeft: `3px solid ${T.primary}`, background: hexA(T.primary, .06), color: T.primary, fontSize: 12.5, fontWeight: 750, marginBottom: 12 }}>{error}</div> : null}

      {vp.isPhone ? (
        <div style={{ borderTop: `1px solid ${T.border}` }}>
          {visibleRows.map((row) => {
            const statuses = monthMeta.map(([number]) => displayStatusForMonth(row.byMonth[`${year}-${number}`], `${year}-${number}`));
            const issueCount = statuses.filter((status) => ["missing", "review", "partial", "refunded", "due"].includes(status)).length;
            const currentNumber = String(new Date().getMonth() + 1).padStart(2, "0");
            const preferredNumber = monthMeta.some(([number]) => number === currentNumber) ? currentNumber : monthMeta[0][0];
            return <button key={row.clientId} type="button" onClick={() => openCell(row, `${year}-${preferredNumber}`)} style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr auto", gap: 12, border: "none", borderBottom: `1px solid ${T.border}`, background: T.surface, color: T.text, textAlign: "left", padding: "14px 2px", fontFamily: "inherit", cursor: "pointer" }}><div><div style={{ fontSize: 14, fontWeight: 850 }}>{row.clientName}</div><div style={{ marginTop: 4, fontSize: 11.5, color: issueCount ? T.primary : T.textMuted }}>{issueCount ? `${issueCount} month${issueCount === 1 ? "" : "s"} need attention` : "Coverage is current"}</div></div><div style={{ display: "flex", alignItems: "center", gap: 7 }}><div style={{ fontSize: 12, fontWeight: 800 }}>{formatMoney(row.expectedMonthlyCents, !canSeeAmounts)}</div><Icon name="chevron" size={14}/></div></button>;
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
