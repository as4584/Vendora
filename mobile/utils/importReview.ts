/**
 * Pure helpers for the import review screen: turning a previewed row into an
 * inventory-shaped item, counting, and validating edits with the same rules
 * the backend importer applies (name required, quantity a whole number,
 * prices numbers; "$" and "," allowed; nothing negative).
 */
import * as api from "../services/api";

export const EDIT_FIELDS: { key: api.ImportRowEditableField; label: string; numeric?: "int" | "money"; multiline?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "category", label: "Category" },
  { key: "sku", label: "SKU" },
  { key: "upc", label: "UPC" },
  { key: "size", label: "Size" },
  { key: "color", label: "Color" },
  { key: "condition", label: "Condition" },
  { key: "quantity", label: "Quantity", numeric: "int" },
  { key: "buy_price", label: "Buy price", numeric: "money" },
  { key: "expected_sell_price", label: "Sell price", numeric: "money" },
  { key: "notes", label: "Notes", multiline: true },
];

export type EditDraft = Partial<Record<api.ImportRowEditableField, string>>;

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export function rowToItem(row: api.ImportPreviewRow): api.InventoryItem {
  const d = row.mapped_data || {};
  const qty = Number.parseInt(String(d.quantity ?? ""), 10);
  return {
    id: row.id || `row-${row.row_number}`,
    user_id: "",
    name: str(d.name) || `Row ${row.row_number}`,
    category: str(d.category),
    sku: str(d.sku),
    upc: str(d.upc),
    size: str(d.size),
    color: str(d.color),
    condition: str(d.condition),
    serial_number: null,
    custom_attributes: null,
    buy_price: str(d.buy_price),
    expected_sell_price: str(d.expected_sell_price),
    actual_sell_price: str(d.actual_sell_price),
    platform: str(d.platform),
    status: "in_stock",
    photo_front_url: str(d.photo_front_url),
    photo_back_url: str(d.photo_back_url),
    quantity: Number.isNaN(qty) ? 1 : qty,
    vendor_name: str(d.vendor_name),
    notes: str(d.notes),
    source: "spreadsheet",
    external_id: null,
    created_at: "",
    updated_at: "",
  };
}

export function draftFromRow(row: api.ImportPreviewRow): EditDraft {
  const d = row.mapped_data || {};
  const draft: EditDraft = {};
  for (const f of EDIT_FIELDS) draft[f.key] = d[f.key] === null || d[f.key] === undefined ? "" : String(d[f.key]);
  return draft;
}

/** Same checks as the backend importer. Returns field → message. */
export function validateDraft(draft: EditDraft): Partial<Record<api.ImportRowEditableField, string>> {
  const errors: Partial<Record<api.ImportRowEditableField, string>> = {};
  if (!(draft.name || "").trim()) errors.name = "Name is required.";
  for (const f of EDIT_FIELDS) {
    const raw = (draft[f.key] || "").trim();
    if (!raw || !f.numeric) continue;
    if (f.numeric === "int") {
      if (!/^-?\d+$/.test(raw)) errors[f.key] = "Use a whole number.";
      else if (Number(raw) < 0) errors[f.key] = "Can't be negative.";
    } else {
      const n = Number(raw.replace(/[$,]/g, ""));
      if (!Number.isFinite(n) || raw.replace(/[$,]/g, "") === "") errors[f.key] = "Use a number like 120 or 120.50.";
      else if (n < 0) errors[f.key] = "Can't be negative.";
    }
  }
  return errors;
}

export function draftToPayload(draft: EditDraft): Partial<Record<api.ImportRowEditableField, string | null>> {
  const out: Partial<Record<api.ImportRowEditableField, string | null>> = {};
  for (const f of EDIT_FIELDS) {
    const v = (draft[f.key] || "").trim();
    out[f.key] = v === "" ? null : v;
  }
  return out;
}

export interface ReviewCounts {
  items: number;
  updates: number;
  needsFix: number;
  importable: number;
  removed: number;
}

export function reviewCounts(rows: api.ImportPreviewRow[]): ReviewCounts {
  const kept = rows.filter((r) => r.action !== "skip");
  const needsFix = kept.filter((r) => r.action === "error").length;
  return {
    items: kept.length,
    updates: kept.filter((r) => r.action === "update").length,
    needsFix,
    importable: kept.length - needsFix,
    removed: rows.length - kept.length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function reviewSummary(c: ReviewCounts): string {
  const parts = [plural(c.items, "item", "items")];
  if (c.updates) parts.push(plural(c.updates, "update", "updates"));
  if (c.needsFix) parts.push(`${c.needsFix} ${c.needsFix === 1 ? "needs" : "need"} a fix`);
  return parts.join(" · ");
}

export function commitLabel(c: ReviewCounts): string {
  if (c.importable === 0) return "Nothing to add yet";
  return `Add ${plural(c.importable, "item", "items")} to inventory`;
}
