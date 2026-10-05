import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sharedConflictReview } from "./sharedConflictNotice.js";
import {
  invoiceDeletionRelatedConflicts, invoiceDeletionReviewRequest, refreshInvoiceDeletionReview,
  resolveInvoiceDeletionConflict, snapshotInvoiceDeletionReview,
} from "./invoiceDeletionReview.js";

const text = value => String(value == null ? "" : value).trim();
const sectionNames = { sps_invoices: "Invoices", sps_estimates: "Estimates", sps_schedule: "Jobs and schedule", sps_maintenance_billing: "Maintenance payments" };
const theme = T => ({ primary: "#AF011A", surface: "#fff", surfaceAlt: "#F4F5F7", text: "#15171A", textMuted: "#71757D", border: "#D9DCE1", ...T });
const buttonStyle = T => ({ minHeight: 42, border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.text, padding: "10px 13px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, cursor: "pointer", lineHeight: 1.35 });

export function InvoiceDeletionConflicts({ conflicts = [], store, T: rawTheme, onResolved }) {
  const T = theme(rawTheme);
  const [current, setCurrent] = useState(conflicts);
  const [busyKey, setBusyKey] = useState("");
  const [errors, setErrors] = useState({});
  const pendingRef = useRef(false);
  useEffect(() => { setCurrent(conflicts); setErrors({}); }, [conflicts]);
  const resolve = async (conflict, strategy) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setBusyKey(conflict.key);
    setErrors(previous => ({ ...previous, [conflict.key]: "" }));
    try {
      const result = await resolveInvoiceDeletionConflict(store, conflict, strategy);
      setCurrent(result.conflicts);
      await onResolved?.(result);
    } catch (error) {
      const refreshed = invoiceDeletionRelatedConflicts(store);
      if (refreshed.length) setCurrent(refreshed);
      setErrors(previous => ({ ...previous, [conflict.key]: error?.message || "The saved changes could not be resolved." }));
    } finally { pendingRef.current = false; setBusyKey(""); }
  };
  const detachedErrors = Object.entries(errors).filter(([key, error]) => error && !current.some(conflict => conflict.key === key));
  if (!current.length && !detachedErrors.length) return null;
  return <section aria-label="Review invoice deletion conflicts" style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, color: T.text }}>
    <div style={{ padding: "14px 0 2px", fontSize: 14, fontWeight: 750 }}>Choose which changes to keep first</div>
    <p style={{ margin: "5px 0 0", fontSize: 12.5, lineHeight: 1.5, color: T.textMuted }}>After saving your choice, review the updated invoice before deleting it.</p>
    {detachedErrors.map(([key, error]) => <div key={key} role="alert" style={{ marginTop: 10, color: T.primary, fontSize: 12.5, lineHeight: 1.5 }}>{error}</div>)}
    {current.map(conflict => {
      const review = sharedConflictReview(conflict);
      return <div key={conflict.key} data-invoice-deletion-conflict={conflict.key} style={{ padding: "15px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 13, fontWeight: 750 }}>{sectionNames[conflict.key] || "Shared changes"}</div>
        <div style={{ marginTop: 5, fontSize: 12.5, lineHeight: 1.5, color: T.textMuted }}>{review.explanation}</div>
        {!!review.fields.length && <div style={{ marginTop: 7, fontSize: 12, color: T.textMuted }}>Review: {review.fields.join(", ")}</div>}
        <div style={{ marginTop: 11, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" disabled={!!busyKey || !store?.resolveConflict} onClick={() => resolve(conflict, "remote")} style={{ ...buttonStyle(T), opacity: busyKey ? .6 : 1 }}>Use saved changes</button>
          <button type="button" disabled={!!busyKey || !store?.resolveConflict} onClick={() => resolve(conflict, "local")} style={{ ...buttonStyle(T), opacity: busyKey ? .6 : 1 }}>Use this device's changes</button>
        </div>
        {busyKey === conflict.key && <div role="status" style={{ marginTop: 8, fontSize: 12, color: T.textMuted }}>Saving your choice</div>}
        {errors[conflict.key] && <div role="alert" style={{ marginTop: 9, color: T.primary, fontSize: 12.5, lineHeight: 1.5 }}>{errors[conflict.key]}</div>}
      </div>;
    })}
  </section>;
}

export default function InvoiceDeletionReview({ invoice, onDelete, onClose, T: rawTheme, store, totalOf, clientNameOf }) {
  const T = theme(rawTheme);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [reviewedInvoice, setReviewedInvoice] = useState(null);
  const [unlinkJobs, setUnlinkJobs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const pendingRef = useRef(false);
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const targetIdRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const heading = dialogRef.current?.querySelector("h3");
    heading?.focus();
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!pendingRef.current) setOpen(false);
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']") || []);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === heading)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); triggerRef.current?.focus(); };
  }, [open]);

  const beginReview = () => {
    targetIdRef.current = invoice?.id;
    setReviewedInvoice(snapshotInvoiceDeletionReview(invoice));
    setUnlinkJobs(false); setError(""); setNotice(""); setConflicts([]); setRefreshRequired(false); setOpen(true);
  };
  const refreshReview = async () => {
    const refreshed = await refreshInvoiceDeletionReview(store, targetIdRef.current);
    setReviewedInvoice(refreshed.invoice);
    setUnlinkJobs(false); setConflicts(refreshed.conflicts); setRefreshRequired(false); setError("");
    setNotice(refreshed.invoice
      ? "Review the updated invoice below. Nothing has been deleted."
      : "This invoice is no longer in SPS Way. Nothing was deleted by this review.");
  };
  const onConflictResolved = async () => {
    setRefreshRequired(true);
    try { await refreshReview(); }
    catch (refreshError) { setError(refreshError?.message || "Refresh the invoice details before trying to delete."); }
  };
  const refresh = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true; setBusy(true);
    try { await refreshReview(); }
    catch (refreshError) { setRefreshRequired(true); setError(refreshError?.message || "The invoice details could not be refreshed."); }
    finally { pendingRef.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (pendingRef.current || conflicts.length || refreshRequired || !reviewedInvoice) return;
    pendingRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const request = invoiceDeletionReviewRequest(reviewedInvoice, unlinkJobs);
      const receipt = await onDelete?.(request.id, request.options);
      if (receipt?.ok !== true) {
        setConflicts(Array.isArray(receipt?.conflicts) ? receipt.conflicts : []);
        setError(text(receipt?.error) || "Deletion was not confirmed. The invoice is still available.");
        return;
      }
      setOpen(false);
      onClose?.();
    } catch (deleteError) { setError(deleteError?.message || "The invoice was not deleted."); }
    finally { pendingRef.current = false; setBusy(false); }
  };

  let amount = null;
  let clientName = reviewedInvoice?.clientName || reviewedInvoice?.customerName || "";
  if (reviewedInvoice) {
    try {
      const raw = totalOf ? totalOf(reviewedInvoice) : reviewedInvoice.total ?? reviewedInvoice.TotalAmt;
      if (raw != null && text(raw) !== "" && Number.isFinite(Number(raw))) amount = Number(raw);
    } catch (_) {}
    try { if (clientNameOf) clientName = clientNameOf(reviewedInvoice) || clientName; } catch (_) {}
  }
  const dialog = open ? <div role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ position: "fixed", inset: 0, zIndex: 2300, background: "rgba(0,0,0,.48)", display: "flex", alignItems: "center", justifyContent: "center", padding: "max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))", boxSizing: "border-box", fontFamily: "inherit" }}>
    <div ref={dialogRef} style={{ width: "100%", maxWidth: 540, maxHeight: "calc(100dvh - 32px)", minHeight: 0, display: "flex", flexDirection: "column", border: `1px solid ${T.border}`, borderRadius: 16, background: T.surface, color: T.text, overflow: "hidden" }}>
      <div style={{ padding: "19px 20px 15px", borderBottom: `1px solid ${T.border}` }}>
        <h3 id={titleId} tabIndex={-1} style={{ margin: 0, fontSize: 22, lineHeight: 1.2, letterSpacing: "-.025em" }}>Review invoice deletion</h3>
      </div>
      <div style={{ padding: "18px 20px", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        {notice && <div role="status" style={{ marginBottom: 15, paddingLeft: 11, borderLeft: `3px solid ${T.primary}`, fontSize: 12.5, lineHeight: 1.5 }}>{notice}</div>}
        {reviewedInvoice && <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 16, alignItems: "start", paddingBottom: 16, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ minWidth: 0 }}><div style={{ fontSize: 17, fontWeight: 750, overflowWrap: "anywhere" }}>Invoice #{reviewedInvoice.number || "Unnumbered"}</div><div style={{ marginTop: 5, color: T.textMuted, fontSize: 13, overflowWrap: "anywhere" }}>{clientName || "Client not recorded"}</div><div style={{ marginTop: 6, color: T.textMuted, fontSize: 12 }}>{reviewedInvoice.status || "Status unavailable"}{reviewedInvoice.date ? ` · ${reviewedInvoice.date}` : ""}</div></div>
            <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: amount == null ? 12 : 19, fontWeight: 750 }}>{amount == null ? "Amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)}</div>
          </div>
          <div style={{ marginTop: 15, fontSize: 13, fontWeight: 750 }}>{reviewedInvoice.qbId ? "Deletes from SPS Way and QuickBooks" : "Deletes from SPS Way"}</div>
          <p style={{ margin: "6px 0 17px", fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>Deletion cannot be undone. Payment history and protected invoices are checked before anything is removed.</p>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "13px 12px", border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12.5, lineHeight: 1.5, cursor: busy ? "default" : "pointer" }}>
            <input type="checkbox" disabled={busy || !!conflicts.length || refreshRequired} checked={unlinkJobs} onChange={event => setUnlinkJobs(event.target.checked)} style={{ width: 18, height: 18, margin: "1px 0 0", flexShrink: 0, accentColor: T.primary }} />
            <span>Remove invoice links from unpaid maintenance months, jobs and estimates. Keep the jobs and estimates.</span>
          </label>
        </>}
        {error && <div role="alert" style={{ marginTop: 16, paddingLeft: 11, borderLeft: `3px solid ${T.primary}`, color: T.primary, fontSize: 12.5, lineHeight: 1.5 }}>{error}</div>}
        <InvoiceDeletionConflicts conflicts={conflicts} store={store} T={T} onResolved={onConflictResolved} />
        {store?.refresh && (error || notice) && <button type="button" disabled={busy} onClick={refresh} style={{ ...buttonStyle(T), marginTop: 14 }}>Refresh invoice details</button>}
      </div>
      <div style={{ flexShrink: 0, padding: "14px 20px 18px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} style={buttonStyle(T)}>Cancel</button>
        {reviewedInvoice ? <button type="button" disabled={busy || !!conflicts.length || refreshRequired || !onDelete} onClick={remove} style={{ ...buttonStyle(T), background: T.primary, borderColor: T.primary, color: "#fff", opacity: busy || conflicts.length || refreshRequired ? .55 : 1 }}>{busy ? "Checking and deleting" : "Delete invoice"}</button> : <button type="button" onClick={() => { setOpen(false); onClose?.(); }} style={buttonStyle(T)}>Close invoice</button>}
      </div>
    </div>
  </div> : null;
  return <><button ref={triggerRef} type="button" onClick={beginReview} disabled={!invoice?.id || !onDelete} style={{ border: "none", background: "transparent", color: T.primary, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "8px 6px", minHeight: 40, fontFamily: "inherit" }}>Delete this invoice</button>{dialog && typeof document !== "undefined" ? createPortal(dialog, document.body) : null}</>;
}
