const finiteMoney = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const finiteCount = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
};

export function resolveInvoiceAccountingSummary(qbAccounting, fallback = {}) {
  const fetchedAt = Date.parse(qbAccounting?.fetchedAt || "");
  const snapshotExpired = Number.isFinite(fetchedAt)
    ? Date.now() - fetchedAt > 15 * 60 * 1000
    : false;
  const authoritative = qbAccounting?.complete === true
    && qbAccounting?.stale !== true
    && !snapshotExpired;
  const fallbackOutstanding = finiteMoney(fallback.outstandingTotal, 0);
  const fallbackOutstandingCount = finiteCount(fallback.outstandingCount, 0);
  const fallbackCollected = finiteMoney(fallback.collectedMonth, 0);
  const fallbackOverdueCount = finiteCount(fallback.overdueCount, 0);

  if (!authoritative) {
    return {
      authoritative: false,
      outstandingTotal: fallbackOutstanding,
      outstandingCount: fallbackOutstandingCount,
      collectedMonth: fallbackCollected,
      overdueCount: fallbackOverdueCount,
    };
  }

  return {
    authoritative: true,
    outstandingTotal: finiteMoney(qbAccounting.openInvoiceBalance, fallbackOutstanding),
    outstandingCount: finiteCount(qbAccounting.openInvoiceCount, fallbackOutstandingCount),
    collectedMonth: finiteMoney(qbAccounting.paymentsReceivedThisMonth, fallbackCollected),
    overdueCount: finiteCount(qbAccounting.overdueInvoiceCount, fallbackOverdueCount),
  };
}

export function formatAccountingCurrency(value) {
  return finiteMoney(value, 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
