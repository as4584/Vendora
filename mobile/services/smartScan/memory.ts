/**
 * Smart scan memory. Every barcode the seller saves is remembered on the phone
 * first (so it works offline at a show) and synced to their account (so it
 * follows them to a new phone). No outside product databases are used.
 *
 * Lookup: phone memory -> account (if online) -> same style code -> nothing.
 */
import type { ScanFields } from "./parseLabel";
import { readAccountJSON, updateAccountJSON, tempId } from "../offline/store";
import { assertSession, captureSession, requireAccount, type AccountContext } from "../session";

export type ScanMatch = "memory" | "inventory" | "style" | null;
export type ScanEntry = { fields: ScanFields; times_seen: number; updated_at: string; revision?: string };
export type ScanResolution = { barcode: string; match: ScanMatch; fields: ScanFields; times_seen: number };

export type ScanRemote = {
  lookup(barcode: string, styleCode?: string): Promise<ScanResolution>;
  learn(barcode: string, fields: ScanFields): Promise<unknown>;
  download(): Promise<ScanResolution[]>;
  /** Seed account memory from existing inventory UPCs (idempotent on the server). */
  backfill?(): Promise<{ created: number; updated: number; skipped: number }>;
};

const PER_BOX_KEYS: (keyof ScanFields)[] = ["size"];
const SCAN = "scan:state";
interface ScanState {
  memory: Record<string, ScanEntry>;
  pending: Record<string, { fields: ScanFields; revision: string }>;
  backfilled: boolean;
}
const emptyScan = (): ScanState => ({ memory: {}, pending: {}, backfilled: false });
const readScan = (account: AccountContext) => readAccountJSON(account, SCAN, emptyScan);
function updateScan<T>(account: AccountContext, update: (state: ScanState) => T) {
  return updateAccountJSON(account, SCAN, emptyScan, update);
}

export function normalizeBarcode(raw: string): string {
  let code = raw.trim().replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (code.length === 13 && /^\d+$/.test(code) && code.startsWith("0")) code = code.slice(1);
  return code;
}

export function normalizeStyle(raw?: string): string | undefined {
  const code = raw?.trim().toUpperCase().replace(/\s+/g, "");
  return code || undefined;
}

export function cleanFields(fields: ScanFields): ScanFields {
  const out: ScanFields = {};
  for (const [k, v] of Object.entries(fields) as [keyof ScanFields, unknown][]) {
    if (v === undefined || v === null) continue;
    const text = String(v).trim();
    if (text) out[k] = text.slice(0, 200);
  }
  if (out.style_code) out.style_code = normalizeStyle(out.style_code);
  return out;
}

/** Remembered fields win; the label only fills gaps. */
export function mergeFields(remembered: ScanFields, fromLabel: ScanFields): ScanFields {
  return { ...cleanFields(fromLabel), ...cleanFields(remembered) };
}

function fromStyleFamily(memory: Record<string, ScanEntry>, style?: string): ScanFields | null {
  const target = normalizeStyle(style);
  if (!target) return null;
  const sibling = Object.values(memory)
    .filter((e) => normalizeStyle(e.fields.style_code) === target)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!sibling) return null;
  const fields = { ...sibling.fields };
  for (const k of PER_BOX_KEYS) delete fields[k];
  return fields;
}

export async function resolveScan(
  rawBarcode: string,
  opts: { styleCode?: string; online: boolean; remote?: ScanRemote },
  session = captureSession(),
): Promise<ScanResolution> {
  const account = requireAccount(session);
  const barcode = normalizeBarcode(rawBarcode);
  const { memory } = await readScan(account);
  assertSession(account);
  const local = memory[barcode];
  if (local) return { barcode, match: "memory", fields: local.fields, times_seen: local.times_seen };

  if (opts.online && opts.remote) {
    try {
      const remote = await opts.remote.lookup(barcode, opts.styleCode);
      assertSession(account);
      if (remote.match) {
        if (remote.match === "memory") {
          const saved = await updateScan(account, (latest) => {
            latest.memory[barcode] ??= { fields: remote.fields, times_seen: remote.times_seen, updated_at: new Date().toISOString() };
            return latest.memory[barcode];
          });
          assertSession(account);
          return { barcode, match: "memory", fields: saved.fields, times_seen: saved.times_seen };
        }
        return { ...remote, barcode };
      }
    } catch {
      assertSession(account);
      // Fall through to the on-phone style family.
    }
  }

  const family = fromStyleFamily(memory, opts.styleCode);
  if (family) return { barcode, match: "style", fields: family, times_seen: 0 };
  return { barcode, match: null, fields: {}, times_seen: 0 };
}

/** Save what the seller confirmed. Phone first, then their account. */
export async function rememberScan(
  rawBarcode: string,
  rawFields: ScanFields,
  opts: { online: boolean; remote?: ScanRemote },
  session = captureSession(),
): Promise<void> {
  const account = requireAccount(session);
  const barcode = normalizeBarcode(rawBarcode);
  const fields = cleanFields(rawFields);
  if (barcode.length < 4 || !fields.name) return;

  const revision = tempId("scan");
  await updateScan(account, ({ memory, pending }) => {
    memory[barcode] = { fields, times_seen: (memory[barcode]?.times_seen ?? 0) + 1, updated_at: new Date().toISOString(), revision };
    pending[barcode] = { fields, revision };
  });
  assertSession(account);
  if (opts.online && opts.remote) await flushScanLearning(opts.remote, account);
}

/** Push saves made offline. Keeps anything that still fails for next time. */
const flushing = new Set<string>();
export async function flushScanLearning(remote: ScanRemote, session = captureSession()): Promise<number> {
  const account = requireAccount(session);
  if (flushing.has(account.ownerId)) return 0;
  flushing.add(account.ownerId);
  try {
    const { pending } = await readScan(account);
    let sent = 0;
    for (const [barcode, { fields, revision }] of Object.entries(pending)) {
      assertSession(account);
      try {
        await remote.learn(barcode, fields);
        sent += 1;
      } catch (error) {
        assertSession(account);
        const status = (error as { status?: number } | null)?.status;
        if (!status || status < 400 || status >= 500 || [401, 408, 429].includes(status)) continue;
      }
      await updateScan(account, (latest) => {
        if (latest.pending[barcode]?.revision === revision) delete latest.pending[barcode];
      });
    }
    assertSession(account);
    return sent;
  } finally {
    flushing.delete(account.ownerId);
  }
}

/** Pull the account's memory onto the phone. Unsynced local saves are kept. */
export async function syncScanMemory(remote: ScanRemote, session = captureSession()): Promise<number> {
  const account = requireAccount(session);
  await flushScanLearning(remote, account);
  const before = await readScan(account);
  assertSession(account);
  const rows = await remote.download();
  assertSession(account);
  const now = new Date().toISOString();
  await updateScan(account, ({ memory, pending }) => {
    for (const row of rows) {
      const code = normalizeBarcode(row.barcode);
      if (pending[code] || memory[code]?.revision !== before.memory[code]?.revision) continue;
      memory[code] = { fields: row.fields, times_seen: row.times_seen, updated_at: memory[code]?.updated_at ?? now };
    }
  });
  assertSession(account);
  return rows.length;
}

/**
 * One time per account on this device: ask the server to learn barcodes from inventory the
 * seller already has, then pull anything new down. Failures retry next time.
 */
export async function backfillScanMemoryOnce(remote: ScanRemote, session = captureSession()): Promise<boolean> {
  const account = requireAccount(session);
  if (!remote.backfill) return false;
  if ((await readScan(account)).backfilled) return false;
  assertSession(account);
  const result = await remote.backfill();
  assertSession(account);
  if (result.created + result.updated > 0) await syncScanMemory(remote, account);
  await updateScan(account, (state) => { state.backfilled = true; });
  assertSession(account);
  return true;
}

export async function forgetScan(rawBarcode: string, session = captureSession()): Promise<void> {
  const account = requireAccount(session);
  const barcode = normalizeBarcode(rawBarcode);
  await updateScan(account, (state) => {
    delete state.memory[barcode];
    delete state.pending[barcode];
  });
}
