const text = (value) => String(value == null ? "" : value).trim();

const scheduleStops = (schedule) => (
  Array.isArray(schedule)
    ? schedule.flatMap((day) => (Array.isArray(day?.stops) ? day.stops : []))
    : []
);

export function findInvoiceDeletionReferences(invoice, estimates = [], schedule = []) {
  const invoiceId = text(invoice?.id);
  if (!invoiceId) return { estimates: [], stops: [], blocked: false };

  const sourceEstimateId = text(invoice?.sourceEstimateId);
  const linkedEstimates = (Array.isArray(estimates) ? estimates : []).filter((estimate) => (
    text(estimate?.linkedInvoiceId) === invoiceId
    || (!!sourceEstimateId && text(estimate?.id) === sourceEstimateId)
  ));
  const linkedStops = scheduleStops(schedule).filter((stop) => (
    text(stop?.linkedInvoiceId) === invoiceId
    || (!!sourceEstimateId && text(stop?.sourceEstimateId) === sourceEstimateId)
  ));

  return {
    estimates: linkedEstimates,
    stops: linkedStops,
    blocked: linkedEstimates.length > 0 || linkedStops.length > 0,
  };
}

export function invoiceDeletionBlockedMessage(invoice, references) {
  const number = text(invoice?.number) || "This invoice";
  const estimateCount = Array.isArray(references?.estimates) ? references.estimates.length : 0;
  const stopCount = Array.isArray(references?.stops) ? references.stops.length : 0;
  const links = [
    estimateCount ? `${estimateCount} estimate${estimateCount === 1 ? "" : "s"}` : "",
    stopCount ? `${stopCount} scheduled stop${stopCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");

  return `${number} is linked to ${links || "scheduled or estimated work"}. Keep the invoice as the billing record, or remove the job link before deleting it.`;
}
