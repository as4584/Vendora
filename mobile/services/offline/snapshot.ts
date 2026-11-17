/**
 * Screen snapshots: the last data a screen showed, so it can paint instantly
 * next time and refresh quietly in the background.
 *
 * Scoped to the signed-in account (like the rest of the offline layer): kept
 * in memory for the current account only (synchronous, so a tab switch renders
 * on the first frame) and on disk under that account's key space (so a cold
 * start is instant too). Switching or signing out drops the memory copy, so
 * one account can never paint another account's data.
 */
import { captureSession, subscribeSession, type AccountContext } from "../session";

// Storage is required lazily so screens can import this module cheaply
// (and test suites that mock AsyncStorage don't recurse on import).
/* eslint-disable @typescript-eslint/no-require-imports */
const store = () => require("./store") as typeof import("./store");
/* eslint-enable @typescript-eslint/no-require-imports */

export const SNAPSHOT_PREFIX = "snap:";
let memoryOwner: string | null = null;
const memory = new Map<string, unknown>();

subscribeSession(() => {
  memory.clear();
  memoryOwner = null;
});

function account(): AccountContext | null {
  const session = captureSession();
  if (!session.ownerId) return null;
  if (memoryOwner !== session.ownerId) {
    memory.clear();
    memoryOwner = session.ownerId;
  }
  return session as AccountContext;
}

/** Synchronous read from memory; use as a useState initializer. */
export function peekSnapshot<T>(name: string): T | undefined {
  if (!account()) return undefined;
  return memory.get(name) as T | undefined;
}

/** Memory first, then disk (cold start). */
export async function loadSnapshot<T>(name: string): Promise<T | undefined> {
  const acct = account();
  if (!acct) return undefined;
  if (memory.has(name)) return memory.get(name) as T;
  try {
    const stored = await store().readAccountJSON<T | null>(acct, SNAPSHOT_PREFIX + name, () => null);
    if (stored == null || memoryOwner !== acct.ownerId) return undefined;
    memory.set(name, stored);
    return stored;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(name: string, data: unknown): void {
  const acct = account();
  if (!acct) return;
  memory.set(name, data);
  void store().writeAccountJSON(acct, SNAPSHOT_PREFIX + name, data).catch(() => undefined);
}

/** Drop the in-memory copy (disk copies stay with their own account). */
export function clearSnapshots(): void {
  memory.clear();
  memoryOwner = null;
}
