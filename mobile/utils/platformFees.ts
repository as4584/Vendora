/**
 * Typical seller fees per selling platform, used to pre-fill the fee on a
 * sale so profit is right without looking rates up. These are estimates of
 * each platform's standard US seller fees (category, promotions and seller
 * level change the real number), so the fee field always stays editable.
 * Rates ship over the air (expo-updates), so a change doesn't need a store
 * release.
 */
export interface PlatformFee {
  key: string;
  label: string;
  percent: number; // % of the sale total
  fixedCents: number; // per-order fixed fee
  note?: string;
}

export const PLATFORM_FEES_AS_OF = "2026-11";

export const PLATFORM_FEES: PlatformFee[] = [
  { key: "in_person", label: "In person", percent: 0, fixedCents: 0 },
  { key: "ebay", label: "eBay", percent: 13.6, fixedCents: 40, note: "Most categories" },
  { key: "poshmark", label: "Poshmark", percent: 20, fixedCents: 0, note: "$2.95 flat under $15" },
  { key: "mercari", label: "Mercari", percent: 12.9, fixedCents: 50, note: "Selling + payment fee" },
  { key: "whatnot", label: "Whatnot", percent: 10.9, fixedCents: 30, note: "Commission + processing" },
  { key: "stockx", label: "StockX", percent: 12, fixedCents: 0, note: "Level 1 + processing" },
  { key: "goat", label: "GOAT", percent: 12.4, fixedCents: 500, note: "Commission + seller fee + cash-out" },
  { key: "depop", label: "Depop", percent: 3.3, fixedCents: 45, note: "Payment processing" },
  { key: "etsy", label: "Etsy", percent: 9.5, fixedCents: 45, note: "Transaction + processing + listing" },
  { key: "fb_shipped", label: "FB shipped", percent: 10, fixedCents: 0, note: "Min $0.80" },
  { key: "paypal", label: "PayPal G&S", percent: 3.49, fixedCents: 49 },
  { key: "venmo", label: "Venmo G&S", percent: 2.99, fixedCents: 0 },
  { key: "square", label: "Card (Square)", percent: 2.6, fixedCents: 15 },
];

/** Estimated fee in cents for a sale of `totalCents` on `platformKey`. */
export function estimateFeeCents(platformKey: string, totalCents: number): number {
  const p = PLATFORM_FEES.find((f) => f.key === platformKey);
  if (!p || totalCents <= 0) return 0;
  if (p.key === "poshmark" && totalCents < 1500) return Math.min(295, totalCents);
  let fee = Math.round((totalCents * p.percent) / 100) + p.fixedCents;
  if (p.key === "fb_shipped") fee = Math.max(fee, 80);
  return Math.min(fee, totalCents);
}
