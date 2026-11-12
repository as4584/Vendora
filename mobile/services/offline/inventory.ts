/**
 * One journal per account: a local receipt is confirmed only after its queue
 * entry and optimistic state are durable. Network sends never hold the journal
 * lock; acknowledgments edit the latest version, including concurrent appends.
 */
import type {
  InventoryItem, PaginatedItems, ListItemsParams, CreateItemPayload,
  CreateTransactionPayload, CreateSaleOrderPayload, SaleOrder, Transaction,
  Dashboard, CreateInvoicePayload, InvoiceData,
} from "../api";
import { smartSearch } from "../smartSearch";
import { centsToString, computeCheckout, sameBarcode, toCents } from "../../utils/checkout";
import { assertSession, captureSession, isCurrentSession, requireAccount, subscribeSession, type AccountContext } from "../session";
import { isOnline } from "./net";
import { tryGetSender } from "./sender";
import { readAccountJSON, writeAccountJSON, updateAccountJSON, tempId, isTempId } from "./store";

type Mirror = Record<string, InventoryItem>;
type OutboxKind = "create_item" | "update_item" | "quick_sale" | "sale_order" | "create_invoice";
interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  path: string;
  method: "POST" | "PUT";
  body: any;
  tempId?: string;
  localItem?: InventoryItem;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface FailedSync {
  id: string;
  kind: OutboxKind;
  message: string;
  createdAt: string;
  failedAt: string;
}

interface Journal {
  /** Last confirmed copy; pending mutations are projected from the outbox. */
  mirror: Mirror;
  outbox: OutboxEntry[];
  remap: Record<string, string>;
  pendingInvoices: InvoiceData[];
  failed: FailedSync[];
  lastSync: string | null;
}

const JOURNAL = "offline:journal";
const DASHBOARD = "offline:dashboard";
const emptyJournal = (): Journal => ({
  mirror: {}, outbox: [], remap: {}, pendingInvoices: [], failed: [], lastSync: null,
});
const readJournal = (account: AccountContext) => readAccountJSON(account, JOURNAL, emptyJournal);
function updateJournal<T>(account: AccountContext, update: (journal: Journal) => T) {
  return updateAccountJSON(account, JOURNAL, emptyJournal, update);
}

const syncListeners = new Set<() => void>();
export function subscribeSync(cb: () => void): () => void {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
function notifySync() {
  syncListeners.forEach((listener) => listener());
}
subscribeSession(notifySync);

/** Apply temp→real ids after restart as well as within the current flush. */
function applyRemap(entry: OutboxEntry, remap: Record<string, string>): OutboxEntry {
  let { path, body } = entry;
  if (entry.kind === "update_item") {
    const id = path.slice("/inventory/".length);
    path = `/inventory/${remap[id] ?? id}`;
  }
  if (body?.item_id && remap[body.item_id]) body = { ...body, item_id: remap[body.item_id] };
  if (Array.isArray(body?.lines)) {
    body = {
      ...body,
      lines: body.lines.map((line: CreateSaleOrderPayload["lines"][number]) => ({
        ...line, item_id: remap[line.item_id] ?? line.item_id,
      })),
    };
  }
  if (Array.isArray(body?.items)) {
    body = {
      ...body,
      items: body.items.map((line: CreateInvoicePayload["items"][number]) =>
        line.inventory_item_id && remap[line.inventory_item_id]
          ? { ...line, inventory_item_id: remap[line.inventory_item_id] }
          : line,
      ),
    };
  }
  return { ...entry, path, body };
}

function applyStockChange(
  mirror: Mirror, entry: OutboxEntry, pending: boolean,
): void {
  const lines: { item_id?: string; quantity: number; size?: string }[] =
    entry.kind === "quick_sale"
      ? [{ item_id: entry.body.item_id, quantity: entry.body.quantity ?? 1 }]
      : entry.kind === "sale_order" ? entry.body.lines : [];
  for (const line of lines) {
    if (!line.item_id || !mirror[line.item_id]) continue;
    const item = { ...mirror[line.item_id] };
    item.quantity = Math.max(0, item.quantity - line.quantity);
    if (item.quantity === 0) item.status = "sold";
    item.updated_at = entry.createdAt;
    item._pending = pending;
    const variants = item.custom_attributes?.variants;
    if (line.size && Array.isArray(variants)) {
      const size = line.size.trim().toLowerCase();
      const next = variants.map((variant) =>
        String(variant?.size ?? "").trim().toLowerCase() === size
          ? { ...variant, quantity: Math.max(0, (Number(variant.quantity) || 0) - line.quantity) }
          : variant,
      );
      item.custom_attributes = { ...item.custom_attributes, variants: next };
    }
    mirror[line.item_id] = item;
  }
}

function projectMirror(journal: Journal): Mirror {
  const mirror = { ...journal.mirror };
  for (const raw of journal.outbox) {
    const entry = applyRemap(raw, journal.remap);
    if (entry.kind === "create_item" && entry.localItem) {
      mirror[entry.localItem.id] = entry.localItem;
    } else if (entry.kind === "update_item") {
      const id = entry.path.slice("/inventory/".length);
      const { expected_quantity: _expected, ...fields } = entry.body;
      mirror[id] = { ...mirror[id], ...fields, id, updated_at: entry.createdAt, _pending: true };
    } else {
      applyStockChange(mirror, entry, true);
    }
  }
  return mirror;
}

export async function cacheItemsFromServer(items: InventoryItem[], session = captureSession()): Promise<void> {
  assertSession(session);
  if (!session.ownerId || !Array.isArray(items) || !items.length) return;
  await updateJournal(requireAccount(session), (journal) => {
    const projected = projectMirror(journal);
    // A server read during an in-flight send may already include the sale.
    for (const item of items) if (!projected[item.id]?._pending) journal.mirror[item.id] = item;
    journal.lastSync = new Date().toISOString();
  });
}

export async function cacheItemFromServer(item: InventoryItem, session = captureSession()): Promise<void> {
  await cacheItemsFromServer([item], session);
}

export async function offlineListItems(params: ListItemsParams, session = captureSession()): Promise<PaginatedItems> {
  const journal = await readJournal(requireAccount(session));
  assertSession(session);
  let items = Object.values(projectMirror(journal));
  if (params.status) items = items.filter((i) => i.status === params.status);
  if (params.source) items = items.filter((i) => i.source === params.source);
  if (params.availableOnly) items = items.filter((i) => i.quantity > 0);
  if (params.upc) items = items.filter((i) => sameBarcode(i.upc, params.upc));
  items.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  if (params.q) items = smartSearch(items, params.q);
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 20;
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage), total: items.length, page,
    per_page: perPage, pages: Math.max(1, Math.ceil(items.length / perPage)),
  };
}

export async function offlineGetItem(id: string, session = captureSession()): Promise<InventoryItem | null> {
  const journal = await readJournal(requireAccount(session));
  assertSession(session);
  return projectMirror(journal)[journal.remap[id] ?? id] ?? null;
}

async function enqueue<T>(
  account: AccountContext, entry: OutboxEntry, result: (journal: Journal) => T,
): Promise<T> {
  const receipt = await updateJournal(account, (journal) => {
    journal.outbox.push(entry);
    return result(journal);
  });
  assertSession(account);
  notifySync();
  return receipt;
}

export async function queueCreateItem(payload: CreateItemPayload, session = captureSession()): Promise<InventoryItem> {
  const account = requireAccount(session);
  const id = tempId();
  const now = new Date().toISOString();
  const item: InventoryItem = {
    id, user_id: account.ownerId, name: payload.name, category: payload.category ?? null,
    sku: payload.sku ?? null, upc: payload.upc ?? null, size: payload.size ?? null,
    color: payload.color ?? null, condition: payload.condition ?? null, serial_number: payload.serial_number ?? null,
    custom_attributes: payload.custom_attributes ?? null, buy_price: payload.buy_price ?? null,
    expected_sell_price: payload.expected_sell_price ?? null, actual_sell_price: payload.actual_sell_price ?? null,
    platform: payload.platform ?? null, status: "active", photo_front_url: null, photo_back_url: null,
    quantity: payload.quantity ?? 1, vendor_name: payload.vendor_name ?? null, notes: payload.notes ?? null,
    source: null, external_id: null, created_at: now, updated_at: now, _pending: true,
  };
  return enqueue(account, {
    id: tempId("ob"), kind: "create_item", path: "/inventory", method: "POST",
    body: payload, tempId: id, localItem: item, createdAt: now, attempts: 0,
  }, () => item);
}

export async function queueUpdateItem(
  id: string, payload: Partial<CreateItemPayload> & { expected_quantity?: number }, session = captureSession(),
): Promise<InventoryItem> {
  return enqueue(requireAccount(session), {
    id: tempId("ob"), kind: "update_item", path: `/inventory/${id}`, method: "PUT",
    body: payload, createdAt: new Date().toISOString(), attempts: 0,
  }, (journal) => projectMirror(journal)[journal.remap[id] ?? id]);
}

export async function queueQuickSale(payload: CreateTransactionPayload, session = captureSession()): Promise<Transaction> {
  const account = requireAccount(session);
  const now = new Date().toISOString();
  const entryId = tempId("ob");
  const gross = payload.gross_amount ?? "0";
  const fee = payload.fee_amount ?? "0";
  return enqueue(account, {
    id: entryId, kind: "quick_sale", path: "/transactions", method: "POST",
    body: { ...payload, client_request_id: payload.client_request_id ?? entryId },
    createdAt: now, attempts: 0,
  }, () => ({
    id: tempId("txn"), user_id: account.ownerId, item_id: payload.item_id ?? null,
    invoice_id: null, method: payload.method, status: "pending_sync", gross_amount: gross,
    fee_amount: fee, net_amount: String(Number(gross) - Number(fee)), quantity: payload.quantity ?? 1,
    external_reference_id: payload.external_reference_id ?? null, notes: payload.notes ?? null,
    is_refund: false, original_transaction_id: null, created_at: now, updated_at: now,
  }));
}

/** One durable entry for the entire sale; never sync individual lines. */
export async function queueSaleOrder(payload: CreateSaleOrderPayload, session = captureSession()): Promise<SaleOrder> {
  const account = requireAccount(session);
  const now = new Date().toISOString();
  const entryId = tempId("ob");
  const totals = computeCheckout({
    lines: payload.lines.map((line) => ({ priceCents: toCents(line.unit_price), qty: line.quantity })),
    discountMode: payload.discount_percent ? "percent" : "amount",
    discountValue: payload.discount_percent ?? payload.discount_amount ?? "",
    taxRate: payload.tax_rate ?? "",
  });
  const fee = toCents(payload.fee_amount ?? "0");
  return enqueue(account, {
    id: entryId, kind: "sale_order", path: "/transactions/order", method: "POST",
    body: { ...payload, client_request_id: payload.client_request_id ?? entryId },
    createdAt: now, attempts: 0,
  }, () => ({
    order_id: tempId("order"), subtotal_amount: centsToString(totals.subtotal),
    discount_amount: centsToString(totals.discount), gross_amount: centsToString(totals.gross),
    tax_amount: centsToString(totals.tax), total_amount: centsToString(totals.total),
    fee_amount: centsToString(fee), net_amount: centsToString(totals.gross - fee),
    payments: payload.payments ?? (payload.method ? [{ method: payload.method, amount: centsToString(totals.total) }] : []),
    created_at: now, transactions: [], pending: true,
  }));
}

export async function getPendingInvoices(session = captureSession()): Promise<InvoiceData[]> {
  assertSession(session);
  if (!session.ownerId) return [];
  const journal = await readJournal(requireAccount(session));
  assertSession(session);
  return journal.pendingInvoices;
}

export async function getPendingInvoice(id: string, session = captureSession()): Promise<InvoiceData | null> {
  const pending = await getPendingInvoices(session);
  assertSession(session);
  return pending.find((i) => i.id === id) ?? null;
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** The real invoice number is assigned on the server; no stock is taken here. */
export async function queueCreateInvoice(payload: CreateInvoicePayload, session = captureSession()): Promise<InvoiceData> {
  const account = requireAccount(session);
  const id = tempId();
  const entryId = tempId("ob");
  const now = new Date().toISOString();
  const lines = payload.items.map((line, index) => ({
    id: `${id}_line${index}`, invoice_id: id, inventory_item_id: line.inventory_item_id ?? null,
    size_label: line.size_label ?? null, description: line.description, quantity: line.quantity,
    unit_price: line.unit_price, line_total: money(Number(line.unit_price) * line.quantity),
  }));
  const subtotal = lines.reduce((s, line) => s + Number(line.line_total), 0);
  const total = Math.max(0, subtotal + Number(payload.tax ?? 0) + Number(payload.shipping ?? 0) - Number(payload.discount ?? 0));
  const invoice: InvoiceData = {
    id, user_id: account.ownerId, invoice_number: "", customer_name: payload.customer_name,
    customer_email: payload.customer_email ?? null, customer_phone: payload.customer_phone ?? null,
    customer_id: payload.customer_id ?? null, status: "draft", subtotal: money(subtotal),
    tax: money(Number(payload.tax ?? 0)), shipping: money(Number(payload.shipping ?? 0)),
    discount: money(Number(payload.discount ?? 0)), total: money(total), amount_paid: "0.00",
    balance_due: money(total), payments: [], stripe_payment_intent_id: null, notes: payload.notes ?? null,
    items: lines, created_at: now, updated_at: now, _pending: true,
  };
  return enqueue(account, {
    id: entryId, kind: "create_invoice", path: "/invoices", method: "POST", tempId: id,
    body: { ...payload, client_request_id: payload.client_request_id ?? entryId },
    createdAt: now, attempts: 0,
  }, (journal) => {
    journal.pendingInvoices.unshift(invoice);
    return invoice;
  });
}

function dropPendingInvoice(journal: Journal, temp: string) {
  journal.pendingInvoices = journal.pendingInvoices.filter((i) => i.id !== temp);
}

function referencesTemp(entry: OutboxEntry, temp: string): boolean {
  return entry.path === `/inventory/${temp}` || entry.body?.item_id === temp ||
    entry.body?.lines?.some((line: CreateSaleOrderPayload["lines"][number]) => line.item_id === temp) ||
    entry.body?.items?.some((line: CreateInvoicePayload["items"][number]) => line.inventory_item_id === temp);
}

/** A failed head stays queued unless the server definitively rejected it. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return typeof status !== "number" || status === 401 || status === 408 || status === 429 || status >= 500;
}

// Do not let a new session for the same owner replay its predecessor's in-flight
// head concurrently. A different owner can drain independently.
const flushing = new Map<string, AccountContext>();

export async function flushOutbox(): Promise<void> {
  const session = captureSession();
  if (!session.ownerId || flushing.has(session.ownerId) || !isOnline()) return;
  const send = tryGetSender();
  if (!send) return;
  const account = requireAccount(session);
  flushing.set(account.ownerId, account);
  try {
    while (isCurrentSession(account) && isOnline()) {
      const snapshot = await readJournal(account);
      assertSession(account);
      if (!snapshot.outbox.length) break;
      const entry = applyRemap(snapshot.outbox[0], snapshot.remap);
      let result: InventoryItem | undefined;
      try {
        result = await send(entry.path, entry.method, entry.body, account);
        assertSession(account);
        if (entry.kind === "create_item" && !result?.id) throw new Error("Missing created item ID");
      } catch (err) {
        if (!isCurrentSession(account)) break;
        const transient = isTransient(err);
        const message = String((err as { message?: unknown } | null)?.message ?? err);
        await updateJournal(account, (journal) => {
          const head = journal.outbox[0];
          if (head?.id !== entry.id) return;
          if (transient) {
            head.attempts += 1;
            head.lastError = message;
            return;
          }
          const rejected = [head, ...journal.outbox.slice(1).filter((other) =>
            head.kind === "create_item" && head.tempId && referencesTemp(other, head.tempId),
          )];
          const ids = new Set(rejected.map((other) => other.id));
          journal.outbox = journal.outbox.filter((other) => !ids.has(other.id));
          const failedAt = new Date().toISOString();
          for (const other of rejected) {
            journal.failed.push({ id: other.id, kind: other.kind, message, createdAt: other.createdAt, failedAt });
            if (other.kind === "create_invoice" && other.tempId) dropPendingInvoice(journal, other.tempId);
          }
          journal.failed = journal.failed.slice(-50);
        });
        notifySync();
        if (transient) break;
        continue;
      }
      // Commit remap, mirror, and acknowledgment together. If storage rejects,
      // the existing journal is retained and the failure reaches the caller.
      await updateJournal(account, (journal) => {
        if (journal.outbox[0]?.id !== entry.id) return;
        if (entry.kind === "create_item" && entry.tempId && result?.id) {
          journal.remap[entry.tempId] = result.id;
          journal.mirror[result.id] = result;
          for (const invoice of journal.pendingInvoices) {
            for (const line of invoice.items) {
              if (line.inventory_item_id === entry.tempId) line.inventory_item_id = result.id;
            }
          }
        } else if (entry.kind === "update_item" && result?.id) {
          journal.mirror[result.id] = result;
        } else if (entry.kind === "create_invoice" && entry.tempId) {
          dropPendingInvoice(journal, entry.tempId);
        } else {
          applyStockChange(journal.mirror, entry, false);
        }
        journal.outbox.shift();
      });
      notifySync();
    }
  } catch (error) {
    if (isCurrentSession(account)) throw error;
  } finally {
    flushing.delete(account.ownerId);
    const latest = captureSession();
    if (latest !== account && latest.ownerId === account.ownerId) flushInBackground();
  }
}

/** Automatic triggers retry later; the journal remains intact on I/O failure. */
export function flushInBackground(): void {
  void flushOutbox().catch(() => undefined);
}

export async function getFailedSyncs(): Promise<FailedSync[]> {
  const session = captureSession();
  if (!session.ownerId) return [];
  const journal = await readJournal(requireAccount(session));
  assertSession(session);
  return journal.failed;
}

export async function clearFailedSyncs(): Promise<void> {
  const session = captureSession();
  if (!session.ownerId) return;
  await updateJournal(requireAccount(session), (journal) => { journal.failed = []; });
  notifySync();
}

export async function cacheDashboard(data: Dashboard, session = captureSession()): Promise<void> {
  assertSession(session);
  if (session.ownerId) await writeAccountJSON(requireAccount(session), DASHBOARD, data);
}

export async function readCachedDashboard(session = captureSession()): Promise<Dashboard | null> {
  assertSession(session);
  return session.ownerId ? readAccountJSON<Dashboard | null>(requireAccount(session), DASHBOARD, () => null) : null;
}

export async function getSyncState(session = captureSession()): Promise<{ pending: number; failed: number; lastSync: string | null }> {
  assertSession(session);
  if (!session.ownerId) return { pending: 0, failed: 0, lastSync: null };
  const journal = await readJournal(requireAccount(session));
  assertSession(session);
  return { pending: journal.outbox.length, failed: journal.failed.length, lastSync: journal.lastSync };
}

export { isTempId };
