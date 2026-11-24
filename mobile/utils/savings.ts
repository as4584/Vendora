/** Copy for the "Resqlo saved you" card. */
import type { Savings } from "../services/api";

export function hoursLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 6) / 10; // one decimal
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)} hr${hours === 1 ? "" : "s"}`;
}

export function savingsLines(s: Savings): string[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [];
  if (s.items_imported) lines.push(`${plural(s.items_imported, "item", "items")} imported for you`);
  if (s.sales_imported) lines.push(`${plural(s.sales_imported, "sale", "sales")} logged automatically`);
  if (s.stock_updates) lines.push(`${plural(s.stock_updates, "stock count", "stock counts")} kept in sync`);
  const fees = Number(s.fees_tracked);
  if (fees > 0) lines.push(`$${fees.toFixed(0)} in fees counted, so profit is real`);
  return lines;
}

export function hasSavings(s: Savings | null | undefined): s is Savings {
  return !!s && (s.minutes_saved > 0 || Number(s.fees_tracked) > 0);
}
