import { useEffect, useRef, useState } from "react";
import { invoiceClientChoices, resolveInvoiceClient } from "./invoiceClientSelection";

export default function InvoiceClientPicker({ clients, value, onChange, T, id, disabled = false, describedBy, error = "", fallbackName = "" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const selected = resolveInvoiceClient(clients, value);
  const options = invoiceClientChoices(clients, query);
  const listId = `${id}-options`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const expanded = open && !disabled;
  const highlighted = Math.min(activeIndex, Math.max(0, options.length - 1));
  const help = selected
    ? [selected.address, selected.email].filter(Boolean).join(" · ")
    : value != null && String(value).trim()
      ? "This invoice's client is unavailable. Choose an existing client before saving."
      : "Search by name, address, or email, then choose a client.";

  useEffect(() => {
    if (expanded) listRef.current?.children[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, expanded]);
  useEffect(() => {
    if (error && !disabled) inputRef.current?.focus();
  }, [error, disabled]);

  const choose = (client) => {
    if (disabled || !client) return;
    onChange(client.id);
    setOpen(false);
    setQuery("");
    inputRef.current?.focus();
  };
  const beginSearch = () => {
    if (disabled || expanded) return;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) { beginSearch(); return; }
      setActiveIndex(index => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && expanded) {
      event.preventDefault();
      choose(options[highlighted]);
    }
  };

  return (
    <div data-invoice-client-picker onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && options.length ? `${listId}-${highlighted}` : undefined}
          aria-describedby={[help ? helpId : "", describedBy, error ? errorId : ""].filter(Boolean).join(" ") || undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          disabled={disabled}
          value={expanded ? query : selected?.name || (value != null && String(value).trim() ? fallbackName : "") || ""}
          placeholder="Choose a client"
          onFocus={beginSearch}
          onClick={beginSearch}
          onChange={event => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); onChange(null); }}
          onKeyDown={onKeyDown}
          style={{ width: "100%", minHeight: 44, padding: "11px 13px", border: `1px solid ${error ? T.primary : T.border}`, borderRadius: 11, fontSize: 15, fontFamily: "inherit", color: T.text, background: T.surface, outline: "none", boxSizing: "border-box", opacity: disabled ? 0.72 : 1, cursor: disabled ? "not-allowed" : "text" }}
        />
        {expanded && <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Invoice clients"
          style={{ marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 11, background: T.surface, maxHeight: 236, overflowY: "auto", overscrollBehavior: "contain" }}
        >
          {options.map((client, index) => <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              key={client.id}
              tabIndex={-1}
              aria-selected={selected?.id != null && String(selected.id) === String(client.id)}
              onPointerDown={event => event.preventDefault()}
              onClick={() => choose(client)}
              style={{ display: "block", width: "100%", minHeight: 48, padding: "10px 12px", border: "none", borderBottom: index < options.length - 1 ? `1px solid ${T.border}` : "none", background: index === highlighted ? T.surfaceAlt : T.surface, color: T.text, textAlign: "left", fontFamily: "inherit", cursor: "pointer" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>{client.name}</span>
                {client.status === "Inactive" && <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, padding: "2px 6px", border: `1px solid ${T.border}`, borderRadius: 6 }}>Inactive</span>}
              </span>
              {(client.address || client.email) && <span style={{ display: "block", marginTop: 3, fontSize: 11.5, lineHeight: 1.35, color: T.textMuted }}>{client.address || client.email}</span>}
            </button>)}
          {!options.length && <div role="status" style={{ padding: "12px", color: T.textMuted, fontSize: 12.5, lineHeight: 1.45 }}>{query.trim() ? "No matching clients. Try a name, address, or email." : "No clients are available. Add a client in Clients, then return to this invoice."}</div>}
        </div>}
      </div>
      {help && <div id={helpId} style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.4, color: T.textMuted }}>{help}{selected?.status === "Inactive" ? " · Inactive client" : ""}</div>}
      {error && <div id={errorId} role="alert" style={{ marginTop: 6, color: T.primary, fontWeight: 700, fontSize: 12, lineHeight: 1.4 }}>{error}</div>}
    </div>
  );
}
