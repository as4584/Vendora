import * as api from "../services/api";

export const STATUS_LABELS: Record<string, string> = {
  in_stock: "In Stock",
  listed: "Listed",
  sold: "Sold",
  shipped: "Shipped",
  paid: "Paid",
  archived: "Archived",
};

export const SOURCE_LABELS: Record<string, string> = {
  lightspeed: "Lightspeed",
  square: "Square",
  clover: "Clover",
  manual: "Manual",
  spreadsheet: "Spreadsheet",
};

export function resolveQty(item: api.InventoryItem): number {
  const variants = item.custom_attributes?.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return variants.reduce((acc: number, variant: any) => acc + (variant.quantity ?? 0), 0);
  }
  return item.quantity ?? 0;
}

export function resolvedPhoto(item: api.InventoryItem, side: "front" | "back") {
  if (side === "front") {
    return item.photo_front_url || item.custom_attributes?.photo_front || null;
  }
  return item.photo_back_url || item.custom_attributes?.photo_back || null;
}

export function sizeBreakdown(item: api.InventoryItem): string {
  const variants = item.custom_attributes?.variants;
  if (Array.isArray(variants) && variants.length > 0) {
    return variants
      .filter((variant: any) => variant?.size)
      .map((variant: any) => `${variant.size} (${variant.quantity ?? 0})`)
      .join(", ");
  }
  if (item.size) {
    return `${item.size}${item.quantity ? ` (${item.quantity})` : ""}`;
  }
  return "No size data";
}

export function formatCurrency(value?: string | number | null) {
  if (!value) return "—";
  const parsed = parseFloat(String(value));
  if (Number.isNaN(parsed)) return "—";
  return `$${parsed.toFixed(2)}`;
}

export function formatCompactDate(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString();
}

/**
 * Short date + time for history rows, e.g. "Nov 3, 2:41 PM" (no seconds).
 * Adds the year only when it isn't the current one.
 */
export function formatShortDateTime(value?: string | null, now: Date = new Date()) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  const date = parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(parsed.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  const time = parsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}
