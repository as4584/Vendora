/**
 * Smart scan memory. Every barcode the seller saves is remembered on the phone
 * first (so it works offline at a show) and synced to their account (so it
 * follows them to a new phone). No outside product databases are used.
 *
 * Lookup: phone memory -> account (if online) -> same style code -> nothing.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ScanFields } from "./parseLabel";

const MEMORY_KEY = "scan:memory";
const PENDING_KEY = "scan:pending";

export type ScanMatch = "memory" | "inventory" | "style" | null;
export type ScanEntry = { fields: ScanFields; times_seen: number; updated_at: string };
export type ScanResolution = { barcode: string; match: ScanMatch; fields: ScanFields; times_seen: number };

export type ScanRemote = {
  lookup(barcode: string, styleCode?: string): Promise<ScanResolution>;
  learn(barcode: string, fields: ScanFields): Promise<unknown>;
  download(): Promise<ScanResolution[]>;
};

const PER_BOX_KEYS: (keyof ScanFields)[] = ["size"];

export function normalizeBarcode(raw: string): string {
  let code = raw.trim().replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (code.length === 13 && /^\d+$/.test(code) && code.startsWith("0")) code = code.slice(1);
  return code;
}

export function normalizeStyle(raw?: string): string | undefined {
  const code = raw?.trim().toUpperCase().replace(/\s+/g, "");
  return code || undefined;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
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
): Promise<ScanResolution> {
  const barcode = normalizeBarcode(rawBarcode);
  const memory = await readJson<Record<string, ScanEntry>>(MEMORY_KEY, {});
  const local = memory[barcode];
  if (local) return { barcode, match: "memory", fields: local.fields, times_seen: local.times_seen };

  if (opts.online && opts.remote) {
    try {
      const remote = await opts.remote.lookup(barcode, opts.styleCode);
      if (remote.match) {
        if (remote.match === "memory") {
          memory[barcode] = { fields: remote.fields, times_seen: remote.times_seen, updated_at: new Date().toISOString() };
          await writeJson(MEMORY_KEY, memory);
        }
        return { ...remote, barcode };
      }
    } catch {
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
): Promise<void> {
  const barcode = normalizeBarcode(rawBarcode);
  const fields = cleanFields(rawFields);
  if (barcode.length < 4 || !fields.name) return;

  const memory = await readJson<Record<string, ScanEntry>>(MEMORY_KEY, {});
  const prev = memory[barcode];
  memory[barcode] = { fields, times_seen: (prev?.times_seen ?? 0) + 1, updated_at: new Date().toISOString() };
  await writeJson(MEMORY_KEY, memory);

  const pending = await readJson<Record<string, ScanFields>>(PENDING_KEY, {});
  pending[barcode] = fields;
  await writeJson(PENDING_KEY, pending);
  if (opts.online && opts.remote) await flushScanLearning(opts.remote);
}

/** Push saves made offline. Keeps anything that still fails for next time. */
export async function flushScanLearning(remote: ScanRemote): Promise<number> {
  const pending = await readJson<Record<string, ScanFields>>(PENDING_KEY, {});
  let sent = 0;
  for (const [barcode, fields] of Object.entries(pending)) {
    try {
      await remote.learn(barcode, fields);
      delete pending[barcode];
      sent += 1;
    } catch (err: any) {
      // A 4xx will never succeed; drop it rather than retry forever.
      if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) delete pending[barcode];
    }
  }
  await writeJson(PENDING_KEY, pending);
  return sent;
}

/** Pull the account's memory onto the phone. Unsynced local saves are kept. */
export async function syncScanMemory(remote: ScanRemote): Promise<number> {
  await flushScanLearning(remote);
  const rows = await remote.download();
  const memory = await readJson<Record<string, ScanEntry>>(MEMORY_KEY, {});
  const pending = await readJson<Record<string, ScanFields>>(PENDING_KEY, {});
  const now = new Date().toISOString();
  for (const row of rows) {
    const code = normalizeBarcode(row.barcode);
    if (pending[code]) continue;
    memory[code] = { fields: row.fields, times_seen: row.times_seen, updated_at: memory[code]?.updated_at ?? now };
  }
  await writeJson(MEMORY_KEY, memory);
  return rows.length;
}

export async function forgetScan(rawBarcode: string): Promise<void> {
  const barcode = normalizeBarcode(rawBarcode);
  const memory = await readJson<Record<string, ScanEntry>>(MEMORY_KEY, {});
  delete memory[barcode];
  await writeJson(MEMORY_KEY, memory);
}
