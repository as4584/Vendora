/**
 * Batch Smart Scan: scan box after box, review once, save all.
 * Pure tray logic lives here so the screen stays thin and this stays testable.
 */
import type { CreateItemPayload, InventoryItem, SizeVariant } from "./api";
import type { ScanFields } from "./smartScan";

/** The camera reports the same code many times a second; ignore repeats this close together. */
export const REPEAT_COOLDOWN_MS = 1500;

export interface TrayEntry {
  key: string;
  barcode: string;
  fields: ScanFields;
  qty: number;
  /** Matched by memory or existing inventory: the seller doesn't need to type anything. */
  known: boolean;
  /** Same barcode already in stock: default is to add to it instead of a duplicate item. */
  existing?: Pick<InventoryItem, "id" | "name" | "quantity" | "size" | "custom_attributes"> | null;
  addToExisting: boolean;
  lastScanAt: number;
}

export function addScan(
  tray: TrayEntry[],
  barcode: string,
  fields: ScanFields,
  known: boolean,
  now: number,
  existing?: TrayEntry["existing"],
): { tray: TrayEntry[]; added: boolean } {
  const code = barcode.trim();
  if (!code) return { tray, added: false };
  const i = tray.findIndex((e) => e.barcode === code && (e.fields.size ?? "") === (fields.size ?? ""));
  if (i >= 0) {
    if (now - tray[i].lastScanAt < REPEAT_COOLDOWN_MS) return { tray, added: false };
    const next = [...tray];
    next[i] = { ...next[i], qty: next[i].qty + 1, lastScanAt: now };
    // Most recent box on top.
    next.unshift(next.splice(i, 1)[0]);
    return { tray: next, added: true };
  }
  const entry: TrayEntry = {
    key: `${code}:${fields.size ?? ""}:${now}`,
    barcode: code,
    fields,
    qty: 1,
    known,
    existing: existing ?? null,
    addToExisting: !!existing,
    lastScanAt: now,
  };
  return { tray: [entry, ...tray], added: true };
}

export function updateEntry(tray: TrayEntry[], key: string, patch: Partial<TrayEntry> & { fields?: Partial<ScanFields> }): TrayEntry[] {
  return tray.map((e) =>
    e.key === key ? { ...e, ...patch, fields: { ...e.fields, ...(patch.fields ?? {}) } } : e,
  );
}

export function setQty(tray: TrayEntry[], key: string, qty: number): TrayEntry[] {
  return qty <= 0 ? tray.filter((e) => e.key !== key) : tray.map((e) => (e.key === key ? { ...e, qty } : e));
}

/** Same cost on every box (a retail run): fills only entries without a cost. */
export function applyCostToAll(tray: TrayEntry[], cost: string, overwrite = false): TrayEntry[] {
  const c = cost.trim();
  if (!c) return tray;
  return tray.map((e) => (overwrite || !e.fields.buy_price ? { ...e, fields: { ...e.fields, buy_price: c } } : e));
}

export const totalUnits = (tray: TrayEntry[]) => tray.reduce((n, e) => n + e.qty, 0);
export const missingNames = (tray: TrayEntry[]) => tray.filter((e) => !(e.addToExisting && e.existing) && !e.fields.name?.trim());

export type SaveAction =
  | { kind: "create"; entry: TrayEntry; payload: CreateItemPayload }
  | { kind: "increment"; entry: TrayEntry; itemId: string; quantity: number; expected: number; variants?: SizeVariant[] };

export function planSave(tray: TrayEntry[]): SaveAction[] {
  return tray.map((entry) => {
    const ex = entry.existing;
    if (entry.addToExisting && ex) {
      const variants = (ex.custom_attributes as { variants?: SizeVariant[] } | null | undefined)?.variants;
      const size = entry.fields.size;
      if (variants?.length && size) {
        const has = variants.some((v) => v.size === size);
        const next = has
          ? variants.map((v) => (v.size === size ? { ...v, quantity: v.quantity + entry.qty } : v))
          : [...variants, { size, quantity: entry.qty }];
        return { kind: "increment", entry, itemId: ex.id, quantity: ex.quantity + entry.qty, expected: ex.quantity, variants: next };
      }
      return { kind: "increment", entry, itemId: ex.id, quantity: ex.quantity + entry.qty, expected: ex.quantity };
    }
    const f = entry.fields;
    const sizeCategory = /sneaker|shoe|apparel|cloth/i.test(f.category ?? "");
    const payload: CreateItemPayload = {
      name: (f.name ?? "").trim(),
      category: f.category || undefined,
      sku: f.sku ?? f.style_code ?? undefined,
      upc: entry.barcode,
      color: f.color || undefined,
      condition: f.condition || undefined,
      buy_price: f.buy_price || undefined,
      expected_sell_price: f.expected_sell_price || undefined,
      platform: f.platform || undefined,
      quantity: entry.qty,
      ...(f.size && sizeCategory
        ? { custom_attributes: { variants: [{ size: f.size, quantity: entry.qty }] } }
        : { size: f.size || undefined }),
    };
    return { kind: "create", entry, payload };
  });
}
