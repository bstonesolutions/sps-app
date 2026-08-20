const finiteNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

// iOS moves visualViewport.offsetTop while the caret and prediction bar update. That is a
// viewport pan, not a keyboard-height change, so composer padding must depend on height only.
export function stableKeyboardInset({
  baselineHeight,
  viewportHeight,
  previousInset = 0,
  openThreshold = 120,
  hysteresis = 8,
} = {}) {
  const baseline = finiteNumber(baselineHeight);
  const viewport = finiteNumber(viewportHeight);
  const previous = Math.max(0, Math.round(finiteNumber(previousInset)));
  if (baseline <= 0 || viewport <= 0) return 0;

  const measured = Math.max(0, Math.round(baseline - viewport));
  const next = measured >= Math.max(0, finiteNumber(openThreshold)) ? measured : 0;
  return Math.abs(next - previous) >= Math.max(1, finiteNumber(hysteresis)) ? next : previous;
}
