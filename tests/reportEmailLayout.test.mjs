import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildServicePhotoGallery, buildServiceReportFooter, buildServiceReportTextFooter } from "../api/_report-email-layout.js";

test("service gallery renders two email-safe columns and centers an odd final photo", () => {
  const html = buildServicePhotoGallery([
    { cid: "one@sps", label: "Before", at: "9:00 AM" },
    { cid: "two@sps", label: "After", at: "9:30 AM" },
    { cid: "three@sps", label: "Detail" },
  ]);
  assert.match(html, /role="presentation"/);
  assert.equal((html.match(/width="50%"/g) || []).length, 2);
  assert.match(html, /colspan="2"/);
  assert.equal((html.match(/width="246"/g) || []).length, 3);
  assert.doesNotMatch(html, /display:grid|display:flex/);
});

test("gallery escapes labels and captions", () => {
  const html = buildServicePhotoGallery([{ cid: "safe@sps", label: "<Before>", at: "10 & 11" }]);
  assert.match(html, /&lt;Before&gt;/);
  assert.match(html, /10 &amp; 11/);
  assert.doesNotMatch(html, /<Before>/);
});

test("service footer uses escaped branding, contact details, and report identity", () => {
  const html = buildServiceReportFooter({
    branding: { companyName: "SPS & Co", companyPhone: "484-555-0100", companyEmail: "service@example.com", companyWebsite: "example.com", companyAddress: "1 Main <Road>" },
    report: { kind: "service", date: "07/16/2026", serviceType: "Monthly", reportId: "r<1", footerNote: "Licensed & insured" },
    logoSrc: "cid:logo@sps",
  });
  assert.match(html, /Thank you for trusting SPS &amp; Co/);
  assert.match(html, /https:\/\/example\.com/);
  assert.match(html, /1 Main &lt;Road&gt;/);
  assert.match(html, /Report r&lt;1/);
  assert.match(html, /border-top:2px/);
});

test("non-service notifications do not receive the service footer", () => {
  assert.equal(buildServiceReportFooter({ report: {} }), "");
  assert.deepEqual(buildServiceReportTextFooter({ report: {} }), []);
});

test("service report sends wire the gallery, configured footer, and website into the endpoint", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const endpoint = readFileSync(new URL("../api/send-notification.js", import.meta.url), "utf8");
  assert.match(app, /footerNote: email\?\.footer \|\| ""/);
  assert.match(app, /companyWebsite: branding\?\.companyWebsite \|\| ""/);
  assert.match(endpoint, /buildServicePhotoGallery\(reportPhotos/);
  assert.match(endpoint, /buildServiceReportFooter\(\{ branding, report, logoSrc \}\)/);
  assert.doesNotMatch(endpoint, /photoBlocks\.join/);
});
