/**
 * Checkout math in integer cents, mirroring backend/app/services/checkout.py
 * so the totals the seller sees are exactly what the server records.
 *
 *   subtotal = sum(unit price x qty)
 *   discount = fixed $ or % of subtotal (never more than subtotal)
 *   gross    = subtotal - discount        (revenue, profit is based on it)
 *   tax      = gross x rate%              (collected, never profit)
 *   total    = gross + tax                (what the customer pays)
 */

export type DiscountMode = "amount" | "percent";

/** Parse a typed money/percent string ("12", "12.5", "12,50") into an integer of 10^-places units. */
export function parseScaled(value: string | number | null | undefined, places: number): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return null;
  const whole = match[1] || "0";
  const frac = (match[2] ?? "").padEnd(places + 1, "0");
  let scaled = Number(whole) * 10 ** places + Number(frac.slice(0, places) || "0");
  // Round half up on the first dropped digit.
  if (Number(frac[places] ?? "0") >= 5) scaled += 1;
  return Number.isSafeInteger(scaled) ? scaled : null;
}

/** "12.34" -> 1234 cents. Invalid or blank -> 0. */
export function toCents(value: string | number | null | undefined): number {
  return parseScaled(value, 2) ?? 0;
}

/** 1234 -> "12.34" (wire format). */
export function centsToString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1234 -> "$12.34". */
export function formatCents(cents: number): string {
  const s = centsToString(cents);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
}

/** Round a non-negative (numerator / denominator) half up, all integers. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/** Split `amount` cents by weight; parts sum exactly, remainder on the last weighted line. */
export function allocateCents(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount === 0 || total === 0) return weights.map(() => 0);
  let last = -1;
  weights.forEach((w, i) => {
    if (w > 0) last = i;
  });
  const parts = weights.map((w, i) => (i === last ? 0 : divRound(amount * w, total)));
  parts[last] = amount - parts.reduce((a, b) => a + b, 0);
  return parts;
}

export interface CheckoutInput {
  lines: { priceCents: number; qty: number }[];
  discountMode: DiscountMode;
  /** As typed: dollars for "amount", percent for "percent". */
  discountValue: string;
  /** Percent as typed, e.g. "6.625". Blank/0 = no tax. */
  taxRate: string;
}

export interface CheckoutTotals {
  subtotal: number;
  discount: number;
  gross: number;
  tax: number;
  total: number;
  lineSubtotals: number[];
  /** Error to show instead of letting the sale through. */
  error: string | null;
}

export function computeCheckout(input: CheckoutInput): CheckoutTotals {
  const lineSubtotals = input.lines.map((l) => l.priceCents * l.qty);
  const subtotal = lineSubtotals.reduce((a, b) => a + b, 0);
  let error: string | null = null;
  let discount = 0;
  if (input.discountMode === "percent") {
    const pct = parseScaled(input.discountValue, 2); // hundredths of a percent
    if (input.discountValue.trim() && pct === null) error = "Enter the discount as a number.";
    else if ((pct ?? 0) > 10000) error = "A discount can't be more than 100%.";
    else discount = divRound(subtotal * (pct ?? 0), 10000);
  } else {
    const amount = parseScaled(input.discountValue, 2);
    if (input.discountValue.trim() && amount === null) error = "Enter the discount as a number.";
    else discount = amount ?? 0;
  }
  if (!error && discount > subtotal) error = "The discount can't be more than the subtotal.";
  if (error) discount = 0;
  const gross = subtotal - discount;
  const rate = parseScaled(input.taxRate, 3) ?? 0; // thousandths of a percent
  if (!error && rate > 30000) error = "Sales tax can't be more than 30%.";
  const tax = error ? 0 : divRound(gross * rate, 100000);
  return { subtotal, discount, gross, tax, total: gross + tax, lineSubtotals, error };
}

export const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
  zelle: "Zelle",
  stripe: "Stripe",
  other: "Other",
  split: "Split",
};

export const paymentLabel = (method: string) => PAYMENT_LABELS[method] ?? method;

export interface ReceiptLine {
  name: string;
  size?: string | null;
  qty: number;
  unitCents: number;
}

export interface ReceiptData {
  businessName?: string | null;
  date: Date;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  tax: number;
  taxRate?: string;
  total: number;
  payments: { method: string; cents: number }[];
  pending?: boolean;
}

/** Plain-text receipt for the native share sheet (Messages, mail, notes). */
export function buildReceiptText(r: ReceiptData): string {
  const out: string[] = [];
  out.push(r.businessName?.trim() || "Receipt");
  out.push(r.date.toLocaleString());
  out.push("");
  for (const line of r.lines) {
    const size = line.size ? ` (Size ${line.size})` : "";
    const qty = line.qty > 1 ? `${line.qty} x ${formatCents(line.unitCents)}` : formatCents(line.unitCents);
    out.push(`${line.name}${size}`);
    out.push(`  ${qty}  ${formatCents(line.unitCents * line.qty)}`);
  }
  out.push("");
  out.push(`Subtotal  ${formatCents(r.subtotal)}`);
  if (r.discount > 0) out.push(`Discount  -${formatCents(r.discount)}`);
  if (r.tax > 0) out.push(`Tax${r.taxRate ? ` (${r.taxRate}%)` : ""}  ${formatCents(r.tax)}`);
  out.push(`Total  ${formatCents(r.total)}`);
  for (const p of r.payments) out.push(`Paid ${paymentLabel(p.method)}  ${formatCents(p.cents)}`);
  if (r.pending) out.push("", "Recorded offline; syncs when back online.");
  out.push("", "Thank you!");
  return out.join("\n");
}

/** Item variants (`custom_attributes.variants`) with stock, for the size picker. */
export function sizeOptions(item: { custom_attributes?: Record<string, any> | null }): { size: string; quantity: number }[] {
  const variants = item.custom_attributes?.variants;
  if (!Array.isArray(variants)) return [];
  return variants
    .map((v: any) => ({ size: String(v?.size ?? "").trim(), quantity: Math.max(0, Number(v?.quantity) || 0) }))
    .filter((v) => v.size);
}

export interface ShowSummaryLike {
  orders: number;
  units_sold: number;
  units_refunded: number;
  subtotal: string;
  discounts: string;
  net_sales: string;
  tax_collected: string;
  fees: string;
  refunds: string;
  refunded_tax: string;
  refund_count: number;
  cost_of_goods: string;
  sales_missing_cost: number;
  profit: string;
  collected: string;
  payments: { method: string; net: string; count: number }[];
  top_items: { name: string; units: number; revenue: string }[];
}

/** "-12.50" -> -1250 (toCents only reads unsigned input). */
export function toSignedCents(value: string | null | undefined): number {
  const text = String(value ?? "").trim();
  return text.startsWith("-") ? -toCents(text.slice(1)) : toCents(text);
}

const money = (value: string) => formatCents(toSignedCents(value));

/** Plain-text end-of-show report for the share sheet. */
export function buildShowSummaryText(s: ShowSummaryLike, title: string): string {
  const out = [title, ""];
  out.push(`Orders  ${s.orders}`);
  out.push(`Units sold  ${s.units_sold}`);
  out.push(`Sales  ${money(s.subtotal)}`);
  if (toCents(s.discounts) > 0) out.push(`Discounts  -${money(s.discounts)}`);
  out.push(`Net sales  ${money(s.net_sales)}`);
  if (s.refund_count > 0) out.push(`Refunds (${s.refund_count})  -${money(s.refunds)}`);
  out.push(`Fees  -${money(s.fees)}`);
  out.push(`Cost of goods  -${money(s.cost_of_goods)}`);
  out.push(`Profit  ${money(s.profit)}`);
  out.push(`Sales tax collected  ${money(s.tax_collected)}`);
  if (s.sales_missing_cost > 0) out.push(`(${s.sales_missing_cost} sale(s) had no cost recorded)`);
  out.push("", "Money by payment");
  for (const p of s.payments) out.push(`${paymentLabel(p.method)}  ${money(p.net)}`);
  out.push(`Total taken in  ${money(s.collected)}`);
  if (s.top_items.length) {
    out.push("", "Top items");
    for (const item of s.top_items) out.push(`${item.name}  ${item.units} sold · ${money(item.revenue)}`);
  }
  return out.join("\n");
}

/** Barcode scanners report UPC-A as EAN-13 with a leading 0 (and vice versa). */
export function sameBarcode(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.trim().replace(/^0+/, "");
  return norm(a) !== "" && norm(a) === norm(b);
}
