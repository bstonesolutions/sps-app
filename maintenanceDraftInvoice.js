import { maintenanceAssignedPriceCents, maintenanceClientAssignments } from "./maintenanceClientAssignment.js";

// Create an unsent draft for explicitly chosen service months. Dates on the
// invoice itself never stand in for the month in which work was performed.
export function maintenanceDraftInvoice({ client, monthKeys, id, number, date, dueDate, notes = "" }) {
  const months = [...new Set(monthKeys || [])].sort();
  const assignments = maintenanceClientAssignments(client);
  const rate = maintenanceAssignedPriceCents(client, assignments);
  if (!client?.id || !assignments.length) throw new Error("Choose an assigned maintenance client.");
  if (!months.length || months.some(month => !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))) throw new Error("Choose the service months for this invoice.");
  if (!(rate > 0)) throw new Error("Set this client's maintenance price before creating a draft.");
  const lineItems = months.map(month => ({
    id: `${id}-${month}`, kind: "service", serviceMonth: month,
    desc: `Monthly Service - ${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}`,
    qty: 1, unitPrice: rate / 100, taxable: false,
  }));
  return {
    id, number, clientId: client.id, clientName: client.name || "", clientEmail: client.email || "",
    date, dueDate, status: "Draft", taxRate: 0, notes, lineItems,
    total: rate * months.length / 100, createdAt: Date.now(),
  };
}
