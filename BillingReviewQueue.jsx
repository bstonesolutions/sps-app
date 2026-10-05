import React from "react";
import { invoiceDescription, invoiceListDate, invoiceMatchesSearch } from "./invoiceListView.js";

const text = value => String(value == null ? "" : value).trim();
const theme = value => ({ primary: "#AF011A", surface: "#FFFFFF", surfaceAlt: "#F4F5F7", text: "#15171A", textMuted: "#71757D", border: "#D9DCE1", ...value });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthDate = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

function serviceDate(review) {
  const month = text(review?.serviceMonth || review?.autoPeriod);
  if (/^\d{4}-\d{2}$/.test(month)) {
    const date = invoiceListDate(`${month}-01`);
    if (date) return monthDate.format(date);
  }
  const sourceDates = [review?.serviceDate, ...(Array.isArray(review?.sourceVisitDates) ? review.sourceVisitDates : [])];
  for (const line of Array.isArray(review?.lineItems) ? review.lineItems : []) {
    sourceDates.push(line.serviceDate, ...(Array.isArray(line.sourceVisitDates) ? line.sourceVisitDates : []));
  }
  const dates = [...new Set(sourceDates.map(value => invoiceListDate(value)?.getTime()).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!dates.length) return "Service date not set";
  const first = shortDate.format(new Date(dates[0]));
  return dates.length === 1 ? first : `${first} to ${shortDate.format(new Date(dates.at(-1)))}`;
}

function amountLabel(review, totalOf) {
  const result = typeof totalOf === "function" ? totalOf(review) : review?.total;
  const amount = result && typeof result === "object" ? result.total : result;
  return amount != null && text(amount) !== "" && Number.isFinite(Number(amount))
    ? money.format(Number(amount)) : "Amount not set";
}

function migrationMessage(summary) {
  if (typeof summary === "string") return summary;
  if (!summary || typeof summary !== "object") return "";
  if (text(summary.message)) return text(summary.message);
  const count = values => {
    for (const value of values) {
      if (Array.isArray(value)) return value.length;
      if (value != null && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };
  const moved = count([summary.movedCount, summary.migratedCount, summary.moved, summary.migrated, summary.migratedIds]);
  const kept = count([summary.skippedCount, summary.keptCount, summary.skipped, summary.kept]);
  if (moved == null) return "";
  return `${moved ? `${moved} job draft${moved === 1 ? "" : "s"} moved to billing review.` : "No unsynced job drafts were moved."}${kept ? ` ${kept} invoice${kept === 1 ? "" : "s"} kept.` : ""}`;
}

function RefreshIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0-2.2 5.5M20 7l-2.5-2.2" /></svg>;
}

function Chevron() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
}

export default function BillingReviewQueue({
  reviews = [], loading = false, error = "", T: rawTheme, vp = {}, onEdit, onRefresh,
  onMigrate, migrationBusy = false, migrationSummary = null, search = "", totalOf,
}) {
  const T = theme(rawTheme);
  const compact = !!vp.isPhone || (Number(vp.width) > 0 && Number(vp.width) < 680);
  const active = (Array.isArray(reviews) ? reviews : []).filter(review => review?.recordType === "billing-review" && ["pending", "approving"].includes(review?.reviewState || "pending"));
  const visible = active.filter(review => invoiceMatchesSearch(review, search));
  const summary = migrationMessage(migrationSummary);
  const button = { minHeight: 42, padding: "9px 12px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.text, fontFamily: "inherit", fontSize: 12.5, fontWeight: 750, lineHeight: 1.35, cursor: "pointer" };
  const columns = "minmax(130px, 1.05fr) minmax(160px, 1.6fr) minmax(130px, .9fr) minmax(105px, .65fr) 16px";

  return <section data-billing-review-queue aria-label="Billing review" aria-busy={loading || migrationBusy || undefined} style={{ color: T.text }}>
    <style>{`[data-billing-review-queue] button:focus-visible{outline:2px solid ${T.primary};outline-offset:3px}[data-billing-review-queue] button[data-review-row]:hover:not(:disabled){background:${T.surfaceAlt}!important}[data-billing-review-queue] button:disabled{cursor:default;opacity:.6}`}</style>
    <div style={{ display: "flex", alignItems: compact ? "stretch" : "flex-start", justifyContent: "space-between", flexDirection: compact ? "column" : "row", gap: compact ? 13 : 24, marginBottom: 20 }}>
      <div style={{ minWidth: 0, maxWidth: 550, paddingLeft: 12, borderLeft: `3px solid ${T.primary}` }}>
        <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.2, letterSpacing: "-.025em", fontWeight: 820 }}>Work ready to review</h2>
        <p style={{ margin: "6px 0 0", color: T.textMuted, fontSize: 12.5, lineHeight: 1.55 }}>Check the work and charges here. An invoice number is assigned when you confirm.</p>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: compact ? "flex-start" : "flex-end", flexShrink: 0 }}>
        {onMigrate && <button type="button" onClick={onMigrate} disabled={loading || migrationBusy} style={button}>{migrationBusy ? "Moving job drafts…" : "Move unsynced job drafts"}</button>}
        {onRefresh && <button type="button" aria-label="Refresh billing reviews" onClick={onRefresh} disabled={loading || migrationBusy} style={{ ...button, display: "inline-flex", alignItems: "center", gap: 6 }}><RefreshIcon />{loading ? "Refreshing…" : "Refresh"}</button>}
      </div>
    </div>

    {error && <div role="alert" style={{ marginBottom: 14, padding: "10px 12px", borderLeft: `3px solid ${T.primary}`, background: T.surfaceAlt, fontSize: 12.5, lineHeight: 1.5, color: T.text }}>{text(error?.message || error)}</div>}
    {summary && <div role="status" style={{ marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, color: T.text }}>{summary}</div>}

    {!visible.length ? <div role="status" style={{ padding: "30px 0 34px", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
      <div style={{ fontSize: 16, fontWeight: 750, letterSpacing: "-.015em" }}>{loading ? "Loading billing reviews…" : text(search) ? "No billing reviews match your search" : "No work waiting for billing review"}</div>
      {!loading && <p style={{ margin: "7px 0 0", maxWidth: 490, color: T.textMuted, fontSize: 13, lineHeight: 1.5 }}>{text(search) ? "Search by client or work description." : "New job charges will appear here before an invoice is created."}</p>}
    </div> : <>
      {!compact && <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: columns, alignItems: "center", gap: 16, padding: "10px 12px", borderBottom: `1px solid ${T.border}`, color: T.textMuted, fontSize: 10.5, fontWeight: 750, letterSpacing: ".045em", textTransform: "uppercase" }}>
        <span>Client</span><span>Work to review</span><span>Service date</span><span style={{ textAlign: "right" }}>Amount</span><span />
      </div>}
      <ul aria-label="Pending billing reviews" style={{ listStyle: "none", padding: 0, margin: 0, borderTop: compact ? `1px solid ${T.border}` : undefined }}>
        {visible.map(review => {
          const client = text(review._client?.name || review.clientName) || "Choose a client";
          const description = invoiceDescription(review) || "Add a work description";
          const needsAttention = review.reviewState === "approving" || (!!review.approval && review.approval.state !== "rejected");
          const status = needsAttention ? "Sync needs attention" : "Awaiting review";
          const amount = amountLabel(review, totalOf);
          const date = serviceDate(review);
          return <li key={review.id} style={{ borderBottom: `1px solid ${T.border}` }}>
            <button type="button" data-review-row data-review-id={review.id} onClick={() => onEdit?.(review)} disabled={!onEdit || migrationBusy} aria-label={`Review ${client}: ${description}. ${status}. ${amount}.`} style={{ display: "grid", gridTemplateColumns: compact ? "minmax(0, 1fr) auto" : columns, alignItems: "center", gap: compact ? "6px 14px" : 16, width: "100%", padding: compact ? "16px 2px" : "17px 12px", border: 0, background: "transparent", color: T.text, fontFamily: "inherit", textAlign: "left", cursor: "pointer" }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: compact ? 15 : 13.5, lineHeight: 1.4, fontWeight: 800, overflowWrap: "anywhere" }}>{client}</span>
                {!compact && needsAttention && <span style={{ display: "block", marginTop: 4, fontSize: 11, lineHeight: 1.35, color: T.primary, fontWeight: 750 }}>{status}</span>}
              </span>
              {compact && <span style={{ fontSize: 14, fontWeight: 800, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{amount}</span>}
              <span title={description} style={{ minWidth: 0, gridColumn: compact ? "1 / -1" : undefined, fontSize: compact ? 13 : 12.5, lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere", color: compact ? T.textMuted : T.text }}>{description}</span>
              <span style={{ fontSize: 11.5, lineHeight: 1.4, color: T.textMuted }}>{date}</span>
              {compact ? <span style={{ fontSize: 11, fontWeight: 750, lineHeight: 1.35, color: T.primary, textAlign: "right" }}>{needsAttention ? status : "Review work"}</span> : <><span style={{ fontSize: 13, fontWeight: 800, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{amount}</span><span style={{ color: T.textMuted }}><Chevron /></span></>}
            </button>
          </li>;
        })}
      </ul>
    </>}
  </section>;
}
