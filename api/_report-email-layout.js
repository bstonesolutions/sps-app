const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const safeAccent = (value) => {
  const raw = String(value || "").trim();
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(raw)) return "#B81D24";
  return raw.startsWith("#") ? raw : `#${raw}`;
};
const safeWebsite = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { return /^https?:$/.test(new URL(href).protocol) ? href : ""; } catch (_) { return ""; }
};

const photoCard = (photo, { centered = false } = {}) => {
  const label = String(photo?.label || "").trim();
  const at = String(photo?.at || "").trim();
  const labelColor = label === "Before" ? "#B45309" : label === "After" ? "#15803D" : "#475569";
  return `<div style="max-width:246px;${centered ? "margin:0 auto;" : ""}border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#fff;page-break-inside:avoid;break-inside:avoid">
    <img src="cid:${escapeHtml(photo?.cid || "")}" alt="${escapeHtml(label || "Service photo")}" width="246" style="width:100%;max-width:246px;height:auto;display:block;border:0" />
    ${(label || at) ? `<div style="padding:7px 9px 8px;font-size:11px;line-height:1.35;color:#64748b;border-top:1px solid #eef0f2"><strong style="color:${labelColor};font-size:11px">${escapeHtml(label || "Photo")}</strong>${at ? ` &middot; ${escapeHtml(at)}` : ""}</div>` : ""}
  </div>`;
};

export function buildServicePhotoGallery(photos = [], { accent = "#B81D24" } = {}) {
  const items = (Array.isArray(photos) ? photos : []).filter(photo => photo?.cid);
  if (!items.length) return "";
  const rows = [];
  for (let index = 0; index < items.length; index += 2) {
    const pair = items.slice(index, index + 2);
    if (pair.length === 1) {
      rows.push(`<tr><td colspan="2" align="center" valign="top" style="padding:6px">${photoCard(pair[0], { centered: true })}</td></tr>`);
    } else {
      rows.push(`<tr>${pair.map(photo => `<td width="50%" valign="top" style="width:50%;padding:6px">${photoCard(photo)}</td>`).join("")}</tr>`);
    }
  }
  return `<div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:16px">
    <div style="font-size:14px;font-weight:800;color:#111827">Visit gallery <span style="color:${safeAccent(accent)}">&middot;</span> ${items.length} photo${items.length === 1 ? "" : "s"}</div>
    <div style="font-size:11px;color:#64748b;line-height:1.4;margin-top:3px">Photos captured during this completed service visit.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:8px"><tbody>${rows.join("")}</tbody></table>
  </div>`;
}

export function buildServiceReportFooter({ branding = {}, report = {}, logoSrc = "" } = {}) {
  if (report?.kind !== "service") return "";
  const company = escapeHtml(branding.companyName || "Stone Property Solutions");
  const website = safeWebsite(branding.companyWebsite);
  const phone = String(branding.companyPhone || "").trim();
  const email = String(branding.companyEmail || "").trim();
  const address = String(branding.companyAddress || "").trim();
  const contact = [
    phone ? `<a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ""))}" style="color:#374151;text-decoration:none">${escapeHtml(phone)}</a>` : "",
    email ? `<a href="mailto:${escapeHtml(email)}" style="color:#374151;text-decoration:none">${escapeHtml(email)}</a>` : "",
    website ? `<a href="${escapeHtml(website)}" style="color:#374151;text-decoration:none">${escapeHtml(String(branding.companyWebsite || "").replace(/^https?:\/\//i, ""))}</a>` : "",
  ].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  const reportMeta = [report.date, report.serviceType].filter(Boolean).map(escapeHtml).join(" &middot; ");
  const configuredNote = String(report.footerNote || "").trim();
  const logo = logoSrc ? `<td width="38" valign="middle" style="width:38px;padding-right:10px"><img src="${escapeHtml(logoSrc)}" alt="" width="32" height="32" style="width:32px;height:32px;border-radius:9px;object-fit:contain;display:block" /></td>` : "";
  return `<div style="margin-top:20px;padding-top:16px;border-top:2px solid #e5e7eb;page-break-inside:avoid;break-inside:avoid">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse"><tbody><tr>${logo}<td valign="middle">
      <div style="font-size:13px;font-weight:800;color:#111827">Thank you for trusting ${company}.</div>
      <div style="font-size:11px;color:#64748b;line-height:1.45;margin-top:2px">Questions about this visit? Reply to this email and we'll help.</div>
    </td></tr></tbody></table>
    ${contact ? `<div style="font-size:10.5px;color:#64748b;line-height:1.55;margin-top:10px">${contact}</div>` : ""}
    ${address ? `<div style="font-size:10px;color:#94a3b8;line-height:1.45;margin-top:2px">${escapeHtml(address)}</div>` : ""}
    ${configuredNote ? `<div style="font-size:10px;color:#94a3b8;line-height:1.45;margin-top:7px">${escapeHtml(configuredNote).replace(/\r?\n/g, "<br />")}</div>` : ""}
    ${(reportMeta || report.reportId) ? `<div style="font-size:9px;color:#c0c7d1;line-height:1.4;margin-top:8px">${reportMeta}${reportMeta && report.reportId ? " &middot; " : ""}${report.reportId ? `Report ${escapeHtml(report.reportId)}` : ""}</div>` : ""}
  </div>`;
}

export function buildServiceReportTextFooter({ branding = {}, report = {} } = {}) {
  if (report?.kind !== "service") return [];
  const company = String(branding.companyName || "Stone Property Solutions");
  const contact = [branding.companyPhone, branding.companyEmail, branding.companyWebsite].filter(Boolean).join(" · ");
  return ["", `Thank you for trusting ${company}.`, ...(contact ? [contact] : []), ...(report.footerNote ? [String(report.footerNote)] : [])];
}
