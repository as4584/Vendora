/** Price-drop math for the aging stock screen. */

/** New list price after dropping `percent`%, in dollars with cents, never below cost when known. */
export function markdownPrice(price: string | null, percent: number, cost?: string | null): string | null {
  const current = Number(price);
  if (!price || !Number.isFinite(current) || current <= 0) return null;
  let next = Math.round(current * (100 - percent)) / 100;
  const floor = Number(cost);
  if (cost && Number.isFinite(floor) && floor > 0 && next < floor) next = floor;
  return next >= current ? null : next.toFixed(2);
}
