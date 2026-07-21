const DEFAULT_ORIGIN = "https://spsway.app";
const CLIENT_TARGETS = new Set(["home", "track", "reports", "property", "history", "invoices", "estimates", "messages", "schedule"]);
const MAX_CLIENT_URL_LENGTH = 800;

function safeTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  if (!CLIENT_TARGETS.has(target)) throw new Error(`Unsupported client link target: ${target || "(empty)"}`);
  return target;
}

function safeHttpUrl(value, fallback) {
  try {
    const url = new URL(String(value || fallback));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.toString();
  } catch (_) {
    return fallback;
  }
}

function safeSlice(value, maxLength) {
  if (value.length <= maxLength) return value;
  let sliced = value.slice(0, Math.max(0, maxLength));
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) sliced = sliced.slice(0, -1);
  return sliced.trimEnd();
}

function removeLegacyDestinationPhrases(message, tokens = []) {
  let body = String(message || "");
  for (const value of tokens.filter(Boolean)) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body
      .replace(new RegExp(`Track my live location here:\\s*${escaped}\\s*[—-]\\s*`, "gi"), "")
      .replace(new RegExp(`See the live update here:\\s*${escaped}\\s*`, "gi"), "")
      .replace(new RegExp(`View your full report and photos here:\\s*${escaped}\\s*`, "gi"), "")
      .replace(new RegExp(`Pay in the app:\\s*${escaped}\\s*`, "gi"), "");
  }
  return body;
}

function removeManagedText(message, { exactLines = [], tokens = [] } = {}) {
  const exact = new Set(exactLines.filter(Boolean).map(value => String(value).trim()));
  let body = String(message || "")
    .split(/\r?\n/)
    .filter(line => !exact.has(line.trim()))
    .join("\n");
  // Remove only the managed text itself, never the whole line. A customer may have written a
  // long one-line template with useful copy before the URL; dropping that entire line would erase
  // the message just to refit the footer.
  tokens.filter(Boolean).forEach(value => {
    body = body.split(String(value)).join("");
  });
  return body
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => {
      const clean = line.trim().toLowerCase();
      return clean && !["open in app:", "browser:", "pay in the app:"].includes(clean);
    })
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function clientDestinationLinks(target, { origin = DEFAULT_ORIGIN, browserUrl = "" } = {}) {
  const cleanTarget = safeTarget(target);
  const base = safeHttpUrl(origin, DEFAULT_ORIGIN);
  const app = new URL(base);
  app.pathname = "/";
  app.search = "";
  app.hash = "";
  // The HTTPS form is an iOS Universal Link. It remains clickable in Messages and opens the
  // installed app, while still falling back safely to the website when the app is unavailable.
  app.searchParams.set("open", cleanTarget);
  const fallback = new URL(base);
  fallback.pathname = "/";
  fallback.search = "";
  // Keep the browser choice in the browser. iOS universal links match `?open=...`, so the browser
  // fallback uses a hash that the web app consumes without handing the tap back to the app.
  fallback.hash = `open=${cleanTarget}`;
  return {
    target: cleanTarget,
    appUrl: app.toString(),
    browserUrl: safeHttpUrl(browserUrl, fallback.toString()),
  };
}

export function clientLinkFooter(target, { origin = DEFAULT_ORIGIN, browserUrl = "", heading = "Open SPS Way" } = {}) {
  const links = clientDestinationLinks(target, { origin, browserUrl });
  return [
    String(heading || "").trim(),
    `Open in app: ${links.appUrl}`,
    `Browser: ${links.browserUrl}`,
  ].filter(Boolean).join("\n");
}

export function withoutClientLinks(message, {
  target,
  origin = DEFAULT_ORIGIN,
  browserUrl = "",
  heading = "Open SPS Way",
} = {}) {
  const links = clientDestinationLinks(target, { origin, browserUrl });
  const legacyAppUrl = `spsway://${links.target}`;
  return removeManagedText(message, {
    exactLines: [
      String(heading || "").trim(),
      `Open in app: ${links.appUrl}`,
      `Browser: ${links.browserUrl}`,
    ],
    tokens: [links.appUrl, legacyAppUrl, links.browserUrl],
  });
}

// Guarantees that both destinations survive editable templates and the 1,600-character Quo
// limit. We reserve 100 characters for the server's Test Mode label; human wording is shortened
// first and app/browser URLs are never cut in half.
export function appendClientLinks(message, {
  target,
  origin = DEFAULT_ORIGIN,
  browserUrl = "",
  heading = "Open SPS Way",
  protectedLines = [],
  managedUrls = [],
  maxLength = 1500,
} = {}) {
  const links = clientDestinationLinks(target, { origin, browserUrl });
  const legacyAppUrl = `spsway://${links.target}`;
  const cleanHeading = String(heading || "").trim();
  const fixedLines = (Array.isArray(protectedLines) ? protectedLines : [protectedLines])
    .map(line => String(line || "").trim())
    .filter(Boolean);
  const fixedUrls = fixedLines.flatMap(line => line.match(/https?:\/\/\S+/g) || []);
  const extraManagedUrls = (Array.isArray(managedUrls) ? managedUrls : [managedUrls])
    .map(value => String(value || "").trim())
    .filter(Boolean);
  const appLine = `Open in app: ${links.appUrl}`;
  const browserLine = `Browser: ${links.browserUrl}`;
  // Always rebuild one canonical footer. This is idempotent, keeps every managed URL intact, and
  // lets callers protect an external payment URL from being truncated with the editable prose.
  const body = removeManagedText(removeLegacyDestinationPhrases(message, [legacyAppUrl, links.browserUrl, ...extraManagedUrls]), {
    exactLines: [cleanHeading, ...fixedLines, appLine, browserLine],
    tokens: [links.appUrl, legacyAppUrl, links.browserUrl, ...extraManagedUrls, ...fixedUrls],
  });
  const footer = [cleanHeading, ...fixedLines, appLine, browserLine].filter(Boolean).join("\n");
  if (footer.length > maxLength) throw new Error("Client link footer exceeds the text-message limit.");
  const separator = body ? "\n\n" : "";
  const bodyLimit = Math.max(0, maxLength - separator.length - footer.length);
  let fitted = safeSlice(body, bodyLimit);
  if (fitted.length < body.length && bodyLimit > 0) {
    fitted = safeSlice(fitted, Math.max(0, bodyLimit - 1)).trimEnd() + "…";
  }
  return `${fitted}${fitted ? separator : ""}${footer}`;
}

function trimUrlToken(value) {
  return String(value || "").replace(/[),.;!?]+$/g, "");
}

function targetFromMessageType(messageType = "") {
  const explicit = String(messageType || "").trim().toLowerCase();
  if (/service report|completed report/.test(explicit)) return "reports";
  if (/on my way|on site|arrival|tracking/.test(explicit)) return "track";
  if (/estimate|quote|proposal/.test(explicit)) return "estimates";
  if (/invoice|payment/.test(explicit)) return "invoices";
  if (/reminder|seasonal/.test(explicit)) return "schedule";
  if (/win.?back/.test(explicit)) return "home";
  return "";
}

function inferClientLinkTarget(message, messageType = "") {
  const explicit = targetFromMessageType(messageType);
  if (explicit) return explicit;
  const hint = String(message || "").toLowerCase();
  // Strong field-flow wording wins over incidental billing words in customized copy.
  if (/\b(full report|service report|report and photos?|report.*photos?|visit complete|service complete)\b/.test(hint)) return "reports";
  if (/\b(track|live location|live update|on my way|on site|arriv(?:e|ed|al))\b/.test(hint)) return "track";
  if (/\b(estimate|quote|proposal)\b/.test(hint)) return "estimates";
  if (/\b(invoice|payment|pay online|past due)\b/.test(hint)) return "invoices";
  if (/\b(message|conversation|chat)\b/.test(hint)) return "messages";
  if (/\b(schedule|scheduled|appointment)\b/.test(hint)) return "schedule";
  if (/\bhistory\b/.test(hint)) return "history";
  if (/\bproperty\b/.test(hint)) return "property";
  return "home";
}

function clientLinkContext(message, messageType = "") {
  const raw = String(message || "");
  const httpTokens = (raw.match(/https?:\/\/[^\s<>"']+/gi) || []).map(trimUrlToken);
  // Older templates sometimes stored only `spsway.app`. Detect that exact bare domain too, but
  // never a subdomain/lookalike, an email address, or the host portion of a URL already captured.
  const bareTokens = [];
  const barePattern = /\b(?:www\.)?spsway\.app(?:[/?#][^\s<>"']*)?/gi;
  for (const match of raw.matchAll(barePattern)) {
    const before = match.index > 0 ? raw[match.index - 1] : "";
    const prefix = raw.slice(0, match.index);
    if (/[a-z0-9@._-]/i.test(before) || prefix.endsWith("://")) continue;
    bareTokens.push(trimUrlToken(match[0]));
  }
  const schemeTokens = (raw.match(/spsway:\/\/[a-z0-9_-]+/gi) || []).filter((token) => {
    const candidate = String(token.split("://")[1] || "").toLowerCase();
    return CLIENT_TARGETS.has(candidate);
  });
  const acceptedHttpTokens = [];
  const explicitTargets = [];
  const hashBrowsers = new Map();
  let trackingBrowser = "";
  for (const token of [...httpTokens, ...bareTokens]) {
    try {
      const url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
      if (!/^(?:www\.)?spsway\.app$/i.test(url.hostname)) continue;
      // Apply the SPS-specific limit only after validating the exact host. A long unrelated or
      // lookalike URL must never block an otherwise valid staff message.
      if (token.length > MAX_CLIENT_URL_LENGTH) throw new Error("client_link_too_long");
      acceptedHttpTokens.push(token);
      // Tracking tokens are private bearer values. Never preserve an old plaintext HTTP form.
      url.protocol = "https:";
      url.hostname = "spsway.app";
      url.port = "";
      const canonicalUrl = url.toString();
      if (url.searchParams.get("track")) {
        trackingBrowser = canonicalUrl;
        continue;
      }
      const hash = new URLSearchParams(String(url.hash || "").replace(/^#/, ""));
      const open = String(url.searchParams.get("open") || hash.get("open") || "").toLowerCase();
      if (CLIENT_TARGETS.has(open)) {
        explicitTargets.push(open);
        if (hash.get("open") && !hashBrowsers.has(open)) hashBrowsers.set(open, canonicalUrl);
      }
    } catch (error) {
      if (error?.message === "client_link_too_long") throw error;
      // Ignore malformed and unrelated links; only verified SPS destinations are managed here.
    }
  }
  if (!acceptedHttpTokens.length && !schemeTokens.length) return null;
  const schemeTargets = schemeTokens
    .map((token) => String(token.split("://")[1] || "").toLowerCase())
    .filter((target) => CLIENT_TARGETS.has(target));
  const target = trackingBrowser
    ? "track"
    : targetFromMessageType(messageType) || explicitTargets[0] || schemeTargets[0] || inferClientLinkTarget(raw);
  return {
    target,
    // A tokenized tracking URL wins. Otherwise retain only a browser URL that matches the chosen
    // target; conflicting legacy links are removed and rebuilt as one consistent pair.
    browserUrl: trackingBrowser || hashBrowsers.get(target) || "",
    managedUrls: [...acceptedHttpTokens, ...schemeTokens],
  };
}

// Upgrade any client text that already contains an SPS Way destination. New callers get a stable
// app/browser pair; old installed clients and scheduled automations are repaired at send time.
export function ensureClientLinkChoices(message, { messageType = "", origin = DEFAULT_ORIGIN } = {}) {
  const context = clientLinkContext(message, messageType);
  if (!context) return String(message || "");
  const links = clientDestinationLinks(context.target, { origin, browserUrl: context.browserUrl });
  const headings = {
    track: "Live tracking",
    reports: "View your full report and photos",
    estimates: "Review your estimate",
    invoices: "View and pay in SPS Way",
    messages: "Open SPS Way messages",
    schedule: "View your SPS Way schedule",
  };
  const lines = String(message || "").split(/\r?\n/);
  const appLineIndex = lines.findIndex((line) => line.trim() === `Open in app: ${links.appUrl}`);
  const headingCandidate = appLineIndex > 0 ? lines[appLineIndex - 1].trim() : "";
  const knownHeadings = new Set(["Open SPS Way", "Live update", ...Object.values(headings)]);
  const existingHeading = knownHeadings.has(headingCandidate) ? headingCandidate : "";
  const protectedLines = lines
    .map((line) => line.trim())
    .filter((line) => /^Pay online:\s+https?:\/\//i.test(line))
    .slice(0, 1);
  return appendClientLinks(message, {
    target: context.target,
    origin,
    browserUrl: context.browserUrl,
    heading: existingHeading || headings[context.target] || "Open SPS Way",
    protectedLines,
    managedUrls: context.managedUrls,
  });
}
