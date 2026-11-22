/**
 * Trade math, in cents. Mirrors backend app/services/trades.py so the screen
 * shows exactly what will be recorded.
 *
 *   value out  = sum of agreed values of the pairs I give
 *   value in   = sum of agreed values of the pairs I get
 *   cash       = + they pay me, - I pay them   (suggested: out - in)
 *   cost basis of pairs in = out - cash        (split by their values)
 *   profit now = out - cost of the pairs I give
 */
import { toCents } from "./checkout";

export interface GiveLine { value: string; quantity?: number; cost?: string | null }
export interface GetLine { value: string }

export interface TradeSummary {
  outCents: number;
  inCents: number;
  /** Cash that balances the trade: + they owe me, - I owe them. */
  suggestedCashCents: number;
  /** What the received pairs cost me in total. */
  basisCents: number;
  /** Profit on the pairs given, or null when any of their costs is unknown. */
  profitCents: number | null;
  error: string | null;
}

export function summarizeTrade(give: GiveLine[], get: GetLine[], cashCents: number): TradeSummary {
  const outCents = give.reduce((sum, g) => sum + toCents(g.value) * (g.quantity ?? 1), 0);
  const inCents = get.reduce((sum, g) => sum + toCents(g.value), 0);
  const basisCents = outCents - cashCents;
  const costs = give.map((g) => (g.cost == null || g.cost === "" ? null : toCents(g.cost) * (g.quantity ?? 1)));
  const profitCents = costs.some((c) => c === null) ? null : outCents - costs.reduce<number>((s, c) => s + (c ?? 0), 0);
  let error: string | null = null;
  if (!give.length && !get.length) error = "Add a pair you're giving or getting.";
  else if (!get.length && basisCents !== 0) error = "Nothing coming back, so the cash must equal what you're giving.";
  else if (get.length && basisCents < 0) error = "Cash in is more than your pairs are worth.";
  return { outCents, inCents, suggestedCashCents: outCents - inCents, basisCents, profitCents, error };
}

/** Split the basis across received pairs by value (even split if all zero); last pair takes the rounding. */
export function splitBasis(basisCents: number, values: string[]): number[] {
  if (!values.length) return [];
  let weights = values.map((v) => toCents(v));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) {
    weights = values.map(() => 1);
    total = values.length;
  }
  const last = weights.reduce((idx, w, i) => (w > 0 ? i : idx), 0);
  const parts = weights.map((w, i) => (i === last ? 0 : Math.round((basisCents * w) / total)));
  parts[last] = basisCents - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** "They pay you $30" / "You pay $40" / "Even swap". */
export function cashLabel(cashCents: number): string {
  const dollars = (Math.abs(cashCents) / 100).toFixed(2);
  if (cashCents > 0) return `They pay you $${dollars}`;
  if (cashCents < 0) return `You pay $${dollars}`;
  return "Even swap";
}
