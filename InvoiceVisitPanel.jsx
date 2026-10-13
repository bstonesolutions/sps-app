import React, { useMemo, useState } from "react";
import { invoiceVisitDetails } from "./invoiceVisitDetails.js";
import "./invoiceVisitPanel.css";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const nameOf = value => typeof value === "string" ? value : text(value?.name || value?.description || value?.desc);
const dateLabel = value => {
  const raw = text(value);
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const parts = mdy ? [mdy[3], mdy[1], mdy[2]] : iso ? [iso[1], iso[2], iso[3]] : null;
  if (!parts) return raw || "Date not recorded";
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const Chevron = () => <svg className="iv-visit-chevron" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg>;

function VisitReport({ entry, linked, defaultOpen = false, renderPhotos }) {
  const notes = text(entry.notes);
  const officeNotes = text(entry.officeNotes);
  const services = list(entry.services).map(nameOf).filter(Boolean);
  const materialGroups = [
    ...list(entry.treatmentsUsed).map(item => ({ item, kind: "Treatment", quantity: item?.oz ?? item?.qty, unit: item?.unit || "oz" })),
    ...list(entry.partsUsed).map(item => ({ item, kind: "Part", quantity: item?.qty, unit: item?.unit || "" })),
    ...list(entry.productsPurchased).map(item => ({ item, kind: "Product", quantity: item?.qty, unit: item?.unit || "" })),
  ].filter(row => row.item && nameOf(row.item));
  const materialNames = new Set(materialGroups.map(row => nameOf(row.item).toLowerCase()));
  const recordedProducts = [...new Set([...list(entry.productsUsed), ...list(entry.products)].map(nameOf).filter(Boolean))].filter(name => !materialNames.has(name.toLowerCase()));
  const checklist = list(entry.checklist).filter(task => typeof task === "string" || task && nameOf(task.text || task.name));
  const readings = entry.readings && typeof entry.readings === "object" ? Object.entries(entry.readings).filter(([, value]) => text(value) && value !== "—") : [];
  const photos = list(entry.photos).filter(photo => typeof photo === "string" ? !!photo : photo && text(photo.src)).map(photo => typeof photo === "string" ? photo : { ...photo, label: text(photo.label), caption: text(photo.caption), takenAt: typeof photo.takenAt === "number" && Number.isFinite(photo.takenAt) ? photo.takenAt : text(photo.takenAt) });
  const hours = Number.parseFloat(entry.actual_hours);
  const crew = text(entry.tech || entry.technician);
  return <details className="iv-visit-report" open={defaultOpen}>
    <summary>
      <span className="iv-visit-date">{dateLabel(entry.date)}</span>
      <span className="iv-visit-summary"><strong>{text(entry.type) || "Service visit"}</strong><span>{crew || "Crew not recorded"}{Number.isFinite(hours) && hours > 0 ? ` · ${hours} hr` : ""}</span></span>
      <span className="iv-visit-link-state">{linked ? "Linked visit" : "Not linked"}</span>
      <Chevron />
    </summary>
    <div className="iv-visit-report-body">
      {!linked && <p className="iv-visit-unlinked-note">Client history only • This visit is not linked to this invoice</p>}
      <div className="iv-visit-narrative">
        <section><h4>What the crew reported</h4>{notes ? <p className="iv-visit-notes">{notes}</p> : <p className="iv-visit-muted">No work notes were saved for this visit</p>}
          {services.length > 0 && <div className="iv-visit-services"><span>Services recorded</span><p>{services.join(" · ")}</p></div>}
        </section>
        {officeNotes && <section className="iv-visit-office"><h4>Office notes</h4><p className="iv-visit-notes">{officeNotes}</p></section>}
      </div>
      <section className="iv-visit-materials"><h4>Materials and products</h4>
        {materialGroups.length || recordedProducts.length ? <>
          <ul>{materialGroups.map(({ item, kind, quantity, unit }, index) => <li key={`${kind}-${index}`}>
            <div><strong>{nameOf(item)}</strong><span>{kind}{text(quantity) ? ` · ${text(quantity)}${unit ? ` ${unit}` : ""}` : ""}</span></div>
            <span className={item.bill === true ? "iv-visit-billable" : "iv-visit-billing-note"}>{item.bill === false ? "Do not charge" : item.bill === true ? "Marked billable" : kind === "Treatment" ? "Usage recorded" : "Billing not recorded"}</span>
          </li>)}{recordedProducts.map(name => <li key={name}><div><strong>{name}</strong><span>Recorded product</span></div><span className="iv-visit-billing-note">Billing not recorded</span></li>)}</ul>
          <p className="iv-visit-caption">These are the crew’s saved entries • Check the invoice lines before charging</p>
        </> : <p className="iv-visit-muted">No materials or products were recorded</p>}
      </section>
      {photos.length > 0 && <section className="iv-visit-photos"><h4>Visit photos <span>{photos.length}</span></h4>{renderPhotos?.(photos)}</section>}
      {(checklist.length > 0 || readings.length > 0) && <details className="iv-visit-more"><summary>Checklist and readings <Chevron /></summary><div>
        {checklist.length > 0 && <ul>{checklist.map((task, index) => <li key={index}><span>{typeof task === "string" ? task : text(task.text || task.name)}</span><span>{typeof task === "string" || task.done === true ? "Done" : "Not completed"}</span></li>)}</ul>}
        {readings.length > 0 && <dl>{readings.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{text(value)}</dd></div>)}</dl>}
      </div></details>}
    </div>
  </details>;
}

// Staff-only inspection. Never render this in InvoiceDocument, customer email, or PDF.
// Opening a report does not import charges, alter links, or save invoice changes.
export default function InvoiceVisitPanel({ invoice, client, schedule = [], T, renderPhotos }) {
  const source = useMemo(() => invoiceVisitDetails({ invoice, client, schedule }), [invoice, client, schedule]);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const candidates = source.candidates.filter(({ entry }) => [dateLabel(entry.date), entry.date, entry.type, entry.tech, entry.notes, ...list(entry.productsUsed).map(nameOf), ...list(entry.treatmentsUsed).map(nameOf), ...list(entry.partsUsed).map(nameOf), ...list(entry.productsPurchased).map(nameOf)].join(" ").toLowerCase().includes(query.toLowerCase()));
  return <section className="iv-visit-panel" aria-label="Visit details for this invoice" style={{ "--visit-accent": T.primary, "--visit-text": T.text, "--visit-muted": T.textMuted, "--visit-border": T.border, "--visit-surface": T.surface, "--visit-subtle": T.surfaceAlt }}>
    <header><div><h3>Visit details</h3><p className="iv-visit-client">{text(client?.name) || "Saved crew reports"}</p></div><span className="iv-visit-private">Internal only</span></header>
    {source.visits.map(({ key, entry }) => <VisitReport key={key} entry={entry} linked defaultOpen={source.visits.length === 1} renderPhotos={renderPhotos} />)}
    {source.missing.length > 0 && <div className="iv-visit-missing" role="status"><strong>Linked report needs checking</strong>{source.missing.map(issue => <p key={issue.key}>{issue.message}</p>)}</div>}
    {!source.visits.length && !source.missing.length && <div className="iv-visit-empty"><strong>No visit linked</strong><p>{client ? "Browse this client’s saved visits below to check the work" : "Choose the invoice client to see their saved visits"}</p></div>}
    {source.candidates.length > 0 && <details className="iv-visit-browse"><summary><span>Browse client visits <span className="iv-visit-count">{source.candidates.length}</span></span><Chevron /></summary><div>
      <p className="iv-visit-caption">Opening a visit here does not add it or its charges to the invoice</p>
      <input aria-label="Search client visits" placeholder="Date or work performed" type="search" value={query} onChange={event => { setQuery(event.target.value); setShowAll(false); }} />
      {(showAll ? candidates : candidates.slice(0, 8)).map(({ key, entry }) => <VisitReport key={key} entry={entry} renderPhotos={renderPhotos} />)}
      {!candidates.length && <p className="iv-visit-muted">No visits match your search</p>}
      {!showAll && candidates.length > 8 && <button type="button" onClick={() => setShowAll(true)}>Show all {candidates.length} visits</button>}
    </div></details>}
    {client && !source.visits.length && !source.candidates.length && !source.missing.length && <p className="iv-visit-muted">No saved visits were found for this client</p>}
  </section>;
}
