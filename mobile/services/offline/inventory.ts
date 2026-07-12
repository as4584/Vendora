/**
 * Offline inventory core: local mirror + write outbox + sync runner.
 *
 * The mirror and the outbox are deliberately in one module because they share
 * one invariant — a queued sale/edit must be reflected in the mirror
 * immediately, and a synced create must swap the temp record for the real one.
 * Keeping both here means that invariant lives in a single place.
 *
 * Flow:
 *  - Online reads upsert server items into the mirror (so they're there offline).
 *  - Offline reads filter/paginate the mirror client-side.
 *  - Offline writes mutate the mirror optimistically AND append to the outbox.
 *  - On reconnect, flushOutbox() replays the outbox FIFO, remapping the temp
 *    ids of offline-created items to their real server ids as it goes.
 */
import type {
  InventoryItem,
  PaginatedItems,
  ListItemsParams,
  CreateItemPayload,
  CreateTransactionPayload,
  Transaction,
  Dashboard,
} from "../api";
import { isOnline } from "./net";
import { getSender } from "./sender";
import {
  KEYS,
  readJSON,
  writeJSON,
  tempId,
  isTempId,
} from "./store";

// ─── Mirror types ────────────────────────────────────
// A mirror item is a normal InventoryItem plus optional local-only markers.
type MirrorItem = InventoryItem & { _pending?: boolean };
type Mirror = Record<string, MirrorItem>;

type OutboxKind = "create_item" | "update_item" | "quick_sale";
interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  path: string; // may embed a temp id to remap at flush time
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body: any; // may embed item_id referencing a temp id
  tempId?: string; // create_item: the temp id being created
  createdAt: string;
  attempts: number;
  lastError?: string;
}

// ─── Change notification (for pending-count UI) ──────
type SyncListener = () => void;
const syncListeners = new Set<SyncListener>();
export function subscribeSync(cb: SyncListener): () => void {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
function notifySync() {
  syncListeners.forEach((l) => l());
}

// ─── Mirror persistence ──────────────────────────────
async function readMirror(): Promise<Mirror> {
  return readJSON<Mirror>(KEYS.inventoryMirror, {});
}
async function writeMirror(m: Mirror): Promise<void> {
  await writeJSON(KEYS.inventoryMirror, m);
}

/** Upsert server items into the mirror after a successful online read. */
export async function cacheItemsFromServer(items: InventoryItem[]): Promise<void> {
  if (!items.length) return;
  const m = await readMirror();
  for (const it of items) {
    // Don't clobber a locally-pending record with a stale server copy.
    if (m[it.id]?._pending) continue;
    m[it.id] = it;
  }
  await writeMirror(m);
  await writeJSON(KEYS.lastSync, new Date().toISOString());
}

export async function cacheItemFromServer(item: InventoryItem): Promise<void> {
  await cacheItemsFromServer([item]);
}

// ─── Offline reads ───────────────────────────────────
export async function offlineListItems(
  params: ListItemsParams,
): Promise<PaginatedItems> {
  const m = await readMirror();
  let items = Object.values(m);

  if (params.q) {
    const q = params.q.toLowerCase();
    items = items.filter(
      (i) =>
        i.name?.toLowerCase().includes(q) ||
        i.sku?.toLowerCase().includes(q) ||
        i.category?.toLowerCase().includes(q),
    );
  }
  if (params.status) items = items.filter((i) => i.status === params.status);
  if (params.source) items = items.filter((i) => i.source === params.source);
  if (params.availableOnly) items = items.filter((i) => i.quantity > 0);

  // Newest first, matching the server's default ordering.
  items.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));

  const page = params.page ?? 1;
  const perPage = params.perPage ?? 20;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return {
    items: slice,
    total: items.length,
    page,
    per_page: perPage,
    pages: Math.max(1, Math.ceil(items.length / perPage)),
  };
}

export async function offlineGetItem(id: string): Promise<InventoryItem | null> {
  const m = await readMirror();
  return m[id] ?? null;
}

// ─── Offline writes ──────────────────────────────────
async function enqueue(entry: OutboxEntry): Promise<void> {
  const q = await readJSON<OutboxEntry[]>(KEYS.outbox, []);
  q.push(entry);
  await writeJSON(KEYS.outbox, q);
  notifySync();
}

/** Create an item offline: mint a temp record, mirror it, queue the POST. */
export async function queueCreateItem(
  payload: CreateItemPayload,
): Promise<InventoryItem> {
  const id = tempId();
  const now = new Date().toISOString();
  const item: MirrorItem = {
    id,
    user_id: "",
    name: payload.name,
    category: payload.category ?? null,
    sku: payload.sku ?? null,
    upc: payload.upc ?? null,
    size: payload.size ?? null,
    color: payload.color ?? null,
    condition: payload.condition ?? null,
    serial_number: payload.serial_number ?? null,
    custom_attributes: payload.custom_attributes ?? null,
    buy_price: payload.buy_price ?? null,
    expected_sell_price: payload.expected_sell_price ?? null,
    actual_sell_price: payload.actual_sell_price ?? null,
    platform: payload.platform ?? null,
    status: "active",
    photo_front_url: null,
    photo_back_url: null,
    quantity: payload.quantity ?? 1,
    vendor_name: payload.vendor_name ?? null,
    notes: payload.notes ?? null,
    source: null,
    external_id: null,
    created_at: now,
    updated_at: now,
    _pending: true,
  };
  const m = await readMirror();
  m[id] = item;
  await writeMirror(m);
  await enqueue({
    id: tempId("ob"),
    kind: "create_item",
    path: "/inventory",
    method: "POST",
    body: payload,
    tempId: id,
    createdAt: now,
    attempts: 0,
  });
  return item;
}

/** Edit an item offline: patch the mirror, queue the PUT. */
export async function queueUpdateItem(
  id: string,
  payload: Partial<CreateItemPayload>,
): Promise<InventoryItem> {
  const m = await readMirror();
  const existing = m[id];
  const merged: MirrorItem = {
    ...(existing as MirrorItem),
    ...(payload as any),
    id,
    updated_at: new Date().toISOString(),
    _pending: true,
  };
  m[id] = merged;
  await writeMirror(m);
  await enqueue({
    id: tempId("ob"),
    kind: "update_item",
    path: `/inventory/${id}`,
    method: "PUT",
    body: payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  });
  return merged;
}

/** Log a quick sale offline: decrement stock in the mirror, queue the POST. */
export async function queueQuickSale(
  payload: CreateTransactionPayload,
): Promise<Transaction> {
  const now = new Date().toISOString();
  const qty = payload.quantity ?? 1;
  if (payload.item_id) {
    const m = await readMirror();
    const item = m[payload.item_id];
    if (item) {
      item.quantity = Math.max(0, item.quantity - qty);
      if (item.quantity === 0) item.status = "sold";
      item.updated_at = now;
      await writeMirror(m);
    }
  }
  await enqueue({
    id: tempId("ob"),
    kind: "quick_sale",
    path: "/transactions",
    method: "POST",
    body: payload,
    createdAt: now,
    attempts: 0,
  });
  const gross = payload.gross_amount ?? "0";
  const fee = payload.fee_amount ?? "0";
  return {
    id: tempId("txn"),
    user_id: "",
    item_id: payload.item_id ?? null,
    invoice_id: null,
    method: payload.method,
    status: "pending_sync",
    gross_amount: gross,
    fee_amount: fee,
    net_amount: String(Number(gross) - Number(fee)),
    quantity: qty,
    external_reference_id: payload.external_reference_id ?? null,
    notes: payload.notes ?? null,
    is_refund: false,
    original_transaction_id: null,
    created_at: now,
    updated_at: now,
  };
}

// ─── Sync runner ─────────────────────────────────────
let flushing = false;

/** Apply accumulated temp→real id remaps to an entry's path and body. */
function applyRemap(entry: OutboxEntry, remap: Record<string, string>): OutboxEntry {
  let path = entry.path;
  let body = entry.body;
  for (const [temp, real] of Object.entries(remap)) {
    if (path.includes(temp)) path = path.replace(temp, real);
    if (body && typeof body === "object" && body.item_id === temp) {
      body = { ...body, item_id: real };
    }
  }
  return { ...entry, path, body };
}

/** Should this failure block the queue (retry later) or be discarded (poison)? */
function isTransient(err: any): boolean {
  const status = err?.status;
  if (typeof status !== "number") return true; // network error → retry
  if (status === 401 || status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false; // 4xx validation/conflict → discard so the queue can drain
}

/**
 * Replay the outbox FIFO. Stops on the first transient failure (to preserve
 * order and retry later); discards poison entries (permanent 4xx) so one bad
 * record can't wedge the whole queue.
 */
export async function flushOutbox(): Promise<void> {
  if (flushing || !isOnline()) return;
  flushing = true;
  const remap: Record<string, string> = {};
  try {
    const send = getSender();
    let q = await readJSON<OutboxEntry[]>(KEYS.outbox, []);
    while (q.length) {
      const entry = applyRemap(q[0], remap);
      try {
        const res = await send(entry.path, entry.method, entry.body);
        if (entry.kind === "create_item" && entry.tempId && res?.id) {
          remap[entry.tempId] = res.id;
          await reconcileCreated(entry.tempId, res);
        } else if (entry.kind === "update_item" && res?.id) {
          await reconcileServerItem(res);
        }
        // quick_sale: server recomputes stock; nothing to reconcile in mirror.
        q = q.slice(1);
        await writeJSON(KEYS.outbox, q);
        notifySync();
      } catch (err) {
        if (isTransient(err)) {
          q[0].attempts += 1;
          q[0].lastError = String((err as any)?.message ?? err);
          await writeJSON(KEYS.outbox, q);
          break; // stop and retry on the next reconnect
        }
        // Poison entry: drop it and keep draining.
        q = q.slice(1);
        await writeJSON(KEYS.outbox, q);
        notifySync();
      }
    }
  } finally {
    flushing = false;
  }
}

/** Replace an offline-created temp record with the confirmed server item. */
async function reconcileCreated(tmp: string, serverItem: InventoryItem): Promise<void> {
  const m = await readMirror();
  delete m[tmp];
  m[serverItem.id] = serverItem;
  await writeMirror(m);
}

/** Overwrite a mirror record with a clean server copy (clears _pending). */
async function reconcileServerItem(serverItem: InventoryItem): Promise<void> {
  const m = await readMirror();
  m[serverItem.id] = serverItem;
  await writeMirror(m);
}

// ─── Dashboard cache (stale-but-visible when offline) ─
export async function cacheDashboard(d: Dashboard): Promise<void> {
  await writeJSON(KEYS.dashboardCache, d);
}
export async function readCachedDashboard(): Promise<Dashboard | null> {
  return readJSON<Dashboard | null>(KEYS.dashboardCache, null);
}

// ─── Sync state (for UI) ─────────────────────────────
export async function getSyncState(): Promise<{
  pending: number;
  lastSync: string | null;
}> {
  const q = await readJSON<OutboxEntry[]>(KEYS.outbox, []);
  const lastSync = await readJSON<string | null>(KEYS.lastSync, null);
  return { pending: q.length, lastSync };
}

export { isTempId };
