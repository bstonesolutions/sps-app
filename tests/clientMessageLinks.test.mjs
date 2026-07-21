import test from "node:test";
import assert from "node:assert/strict";

import { appendClientLinks, clientDestinationLinks, clientLinkFooter, ensureClientLinkChoices, withoutClientLinks } from "../clientMessageLinks.js";

test("client destinations always include a supported app route and browser fallback", () => {
  assert.deepEqual(clientDestinationLinks("reports"), {
    target: "reports",
    appUrl: "https://spsway.app/?open=reports",
    browserUrl: "https://spsway.app/#open=reports",
  });
  assert.throws(() => clientDestinationLinks("https://evil.example"), /Unsupported client link target/);
});

test("live tracking keeps its tokenized browser URL and adds the native app route", () => {
  const footer = clientLinkFooter("track", {
    browserUrl: "https://spsway.app/?track=private-token",
    heading: "Live tracking",
  });
  assert.match(footer, /Open in app: https:\/\/spsway\.app\/\?open=track/);
  assert.match(footer, /Browser: https:\/\/spsway\.app\/\?track=private-token/);
});

test("links are appended once and remain intact at the Quo length limit", () => {
  const once = appendClientLinks("A".repeat(1900), { target: "invoices", heading: "View and pay" });
  const twice = appendClientLinks(once, { target: "invoices", heading: "View and pay" });
  assert.equal(once.length, 1500);
  assert.equal(twice, once);
  assert.equal((once.match(/https:\/\/spsway\.app\/\?open=invoices/g) || []).length, 1);
  assert.equal((once.match(/https:\/\/spsway\.app\/#open=invoices/g) || []).length, 1);
});

test("an editable body that retains one destination gets the missing destination back", () => {
  const message = appendClientLinks("Pay here: https://pay.example/123\nBrowser: https://spsway.app/#open=invoices", {
    target: "invoices",
    heading: "SPS Way invoice",
  });
  assert.match(message, /https:\/\/pay\.example\/123/);
  assert.match(message, /https:\/\/spsway\.app\/\?open=invoices/);
  assert.equal((message.match(/#open=invoices/g) || []).length, 1);
});

test("an oversized custom template cannot cut a link it already contained", () => {
  const message = appendClientLinks(`${"Long report copy ".repeat(140)}\nOpen in app: spsway://reports\nBrowser: https://spsway.app/#open=reports`, {
    target: "reports",
    heading: "Full report",
  });
  assert.equal(message.length, 1500);
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
  assert.match(message, /Browser: https:\/\/spsway\.app\/#open=reports$/);
});

test("an inline legacy app link is upgraded without losing the surrounding customer copy", () => {
  const original = `${"Important service details. ".repeat(64)}Open in app: spsway://reports`;
  const message = appendClientLinks(original, { target: "reports", heading: "Full report" });
  assert.match(message, /^Important service details/);
  assert.ok(message.length > 1200);
  assert.doesNotMatch(message, /spsway:\/\/reports/);
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
});

test("an external payment URL is protected while editable prose is shortened", () => {
  const payment = "https://payments.example/quickbooks/invoice/abc123?token=long-safe-token";
  const message = appendClientLinks("Reminder copy ".repeat(180), {
    target: "invoices",
    heading: "View and pay",
    protectedLines: [`Pay online: ${payment}`],
  });
  assert.equal(message.length, 1500);
  assert.match(message, new RegExp(`Pay online: ${payment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=invoices/);
  assert.match(message, /Browser: https:\/\/spsway\.app\/#open=invoices$/);
});

test("portal copy removes the redundant SMS app and browser footer", () => {
  const sms = appendClientLinks("Your technician is on the way.", {
    target: "track",
    browserUrl: "https://spsway.app/?track=private-token",
    heading: "Live tracking",
  });
  assert.equal(withoutClientLinks(sms, {
    target: "track",
    browserUrl: "https://spsway.app/?track=private-token",
    heading: "Live tracking",
  }), "Your technician is on the way.");
});

test("legacy browser-only copy can be removed cleanly before rebuilding the paired footer", () => {
  const legacyUrl = "https://spsway.app";
  const message = appendClientLinks(`Your service is complete.\n\nView your full report and photos here: ${legacyUrl}`, {
    target: "reports",
    browserUrl: legacyUrl,
    heading: "View your full report and photos",
    managedUrls: [legacyUrl],
  });
  assert.equal((message.match(/View your full report and photos/g) || []).length, 1);
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
  assert.match(message, /Browser: https:\/\/spsway\.app\/$/);
});

test("scheduled templates with an SPS Way URL receive the same app and browser choices", () => {
  const message = ensureClientLinkChoices("Hi Jordan, your service is scheduled tomorrow. Details: https://spsway.app", {
    messageType: "Reminder",
  });
  assert.match(message, /^Hi Jordan, your service is scheduled tomorrow\./);
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=schedule/);
  assert.match(message, /Browser: https:\/\/spsway\.app\/#open=schedule$/);
});

test("lookalike domains are never rewritten as SPS Way destinations", () => {
  const message = "Review this link: https://spsway.app.evil.example/?open=reports";
  assert.equal(ensureClientLinkChoices(message, { messageType: "ServiceReport" }), message);
});

test("tracking templates are normalized once even when their legacy URLs are reversed", () => {
  const message = ensureClientLinkChoices("Track here: https://spsway.app/?track=private-token\nOpen in app: https://spsway.app/?open=track", {
    messageType: "On my way",
  });
  assert.equal((message.match(/private-token/g) || []).length, 1);
  assert.equal((message.match(/\?open=track/g) || []).length, 1);
  assert.match(message, /Browser: https:\/\/spsway\.app\/\?track=private-token$/);
});

test("plain bare-domain links are upgraded without matching email addresses or lookalikes", () => {
  const message = ensureClientLinkChoices("View your report: spsway.app", { messageType: "Service report" });
  assert.match(message, /Open in app: https:\/\/spsway\.app\/\?open=reports/);
  assert.match(message, /Browser: https:\/\/spsway\.app\/#open=reports$/);
  assert.equal(ensureClientLinkChoices("Email help@spsway.app or visit evil.spsway.app", { messageType: "Service report" }), "Email help@spsway.app or visit evil.spsway.app");
});

test("conflicting legacy destinations are rebuilt as one consistent pair", () => {
  const message = ensureClientLinkChoices("Report ready: https://spsway.app/?open=reports\nBrowser: https://spsway.app/#open=messages", {
    messageType: "Service report",
  });
  assert.equal((message.match(/\?open=reports/g) || []).length, 1);
  assert.equal((message.match(/#open=reports/g) || []).length, 1);
  assert.doesNotMatch(message, /open=messages/);
});

test("tokenized tracking fallbacks are always upgraded to HTTPS", () => {
  const message = ensureClientLinkChoices("Track here: http://spsway.app/?track=private-token", { messageType: "On my way" });
  assert.doesNotMatch(message, /http:\/\//);
  assert.match(message, /Browser: https:\/\/spsway\.app\/\?track=private-token$/);
});

test("a long lookalike URL does not trigger SPS Way link validation", () => {
  const message = `Review: https://spsway.app.evil.example/${"x".repeat(900)}`;
  assert.equal(ensureClientLinkChoices(message, { messageType: "Service report" }), message);
});
