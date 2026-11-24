/**
 * "Should I buy this?" — turn a comps price range into what the seller would
 * actually keep after marketplace fees, and, given what it costs, a profit
 * range and a plain verdict.
 */
import { estimateFeeCents } from "./platformFees";

export type BuyVerdict = "good" | "thin" | "pass";

export interface BuyCheck {
  netLowCents: number;
  netMedianCents: number;
  netHighCents: number;
  profitLowCents: number | null;
  profitMedianCents: number | null;
  profitHighCents: number | null;
  verdict: BuyVerdict | null;
}

const toCents = (v: string | number) => Math.round(Number(v) * 100);

/** Good: median profit at least $10 and 30% of cost. Thin: positive but less. Pass: none. */
export function verdictFor(profitMedianCents: number, costCents: number): BuyVerdict {
  if (profitMedianCents <= 0) return "pass";
  if (profitMedianCents >= Math.max(1000, Math.round(costCents * 0.3))) return "good";
  return "thin";
}

export function buyCheck(
  summary: { low: string; median: string; high: string },
  costText: string,
  platform = "ebay",
): BuyCheck {
  const net = (price: string) => {
    const cents = toCents(price);
    return cents - estimateFeeCents(platform, cents);
  };
  const netLowCents = net(summary.low);
  const netMedianCents = net(summary.median);
  const netHighCents = net(summary.high);
  const cost = Number(costText.replace(/[$,\s]/g, ""));
  if (!costText.trim() || !Number.isFinite(cost) || cost < 0) {
    return { netLowCents, netMedianCents, netHighCents, profitLowCents: null, profitMedianCents: null, profitHighCents: null, verdict: null };
  }
  const costCents = toCents(cost);
  const profitMedianCents = netMedianCents - costCents;
  return {
    netLowCents,
    netMedianCents,
    netHighCents,
    profitLowCents: netLowCents - costCents,
    profitMedianCents,
    profitHighCents: netHighCents - costCents,
    verdict: verdictFor(profitMedianCents, costCents),
  };
}

export const VERDICT_LABELS: Record<BuyVerdict, string> = {
  good: "Good buy",
  thin: "Thin margin",
  pass: "Pass — no profit",
};

export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(0)}`;
}
