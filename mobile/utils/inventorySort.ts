/**
 * Inventory sort menu. The server sorts paged results
 * (GET /inventory?sort=...); compareItems mirrors it for the offline list.
 */
import type { InventoryItem } from "../services/api";

export type SortKey = "newest" | "oldest" | "price_high" | "price_low" | "profit" | "qty" | "name";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Longest in stock" },
  { key: "price_high", label: "Price: high to low" },
  { key: "price_low", label: "Price: low to high" },
  { key: "profit", label: "Most profit" },
  { key: "qty", label: "Most units" },
  { key: "name", label: "Name A to Z" },
];

export function sortLabel(key: SortKey): string {
  return SORT_OPTIONS.find((o) => o.key === key)?.label ?? "Newest";
}

const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));

/** null sorts last regardless of direction, like the server's NULLS LAST. */
function byNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}

export function compareItems(sort: SortKey): (a: InventoryItem, b: InventoryItem) => number {
  const tie = (a: InventoryItem, b: InventoryItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const profit = (i: InventoryItem) => {
    const sell = num(i.expected_sell_price);
    const buy = num(i.buy_price);
    return sell == null || buy == null ? null : sell - buy;
  };
  const primary: Record<SortKey, (a: InventoryItem, b: InventoryItem) => number> = {
    newest: (a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0),
    oldest: (a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0),
    price_high: (a, b) => byNullable(num(a.expected_sell_price), num(b.expected_sell_price), -1),
    price_low: (a, b) => byNullable(num(a.expected_sell_price), num(b.expected_sell_price), 1),
    profit: (a, b) => byNullable(profit(a), profit(b), -1),
    qty: (a, b) => (b.quantity ?? 0) - (a.quantity ?? 0),
    name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  };
  return (a, b) => primary[sort](a, b) || tie(a, b);
}
