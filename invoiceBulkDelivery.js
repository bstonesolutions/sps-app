const text = (value) => String(value == null ? "" : value).trim();
const list = (value) => (Array.isArray(value) ? value : []);

export async function deliverInvoiceThroughChannels(channels) {
  const result = { accepted: false, succeeded: [], protected: [], failed: [] };
  for (const channel of list(channels)) {
    if (!channel?.enabled || typeof channel.send !== "function") continue;
    try {
      const response = await channel.send();
      if (!response?.ok) {
        result.failed.push({ channel: text(channel.id), error: text(response?.error) || "Delivery failed" });
      } else if (response.acceptedForClient === false || response.held === true) {
        result.protected.push({ channel: text(channel.id), reason: text(response?.reason) || "Held by Test Mode" });
      } else {
        result.accepted = true;
        result.succeeded.push(text(channel.id));
      }
    } catch (error) {
      result.failed.push({ channel: text(channel.id), error: text(error?.message) || "Delivery failed" });
    }
  }
  return result;
}

export async function deliverSelectedInvoices({ invoices, buildChannels, onAccepted }) {
  const results = [];
  for (const invoice of list(invoices)) {
    const delivery = await deliverInvoiceThroughChannels(await buildChannels(invoice));
    if (delivery.accepted && typeof onAccepted === "function") await onAccepted(invoice, delivery);
    results.push({ invoiceId: text(invoice?.id), ...delivery });
  }
  return results;
}
