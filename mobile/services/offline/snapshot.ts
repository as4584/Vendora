/**
 * Screen snapshots: the last data a screen showed, so it can paint instantly
 * next time and refresh quietly in the background.
 *
 * Kept in memory (synchronous, so a tab switch renders on the first frame)
 * and on disk under the `offline:` prefix (so a cold start is instant too).
 * Wiped with the rest of the offline data on sign-out.
 */
// Storage is required lazily so screens can import this module cheaply
// (and test suites that mock AsyncStorage don't recurse on import).
/* eslint-disable @typescript-eslint/no-require-imports */
const store = () => require("./store") as typeof import("./store");
const storage = () =>
  (require("@react-native-async-storage/async-storage") as typeof import("@react-native-async-storage/async-storage")).default;
/* eslint-enable @typescript-eslint/no-require-imports */

export const SNAPSHOT_PREFIX = "offline:snap:";
const memory = new Map<string, unknown>();

/** Synchronous read from memory; use as a useState initializer. */
export function peekSnapshot<T>(name: string): T | undefined {
  return memory.get(name) as T | undefined;
}

/** Memory first, then disk (cold start). */
export async function loadSnapshot<T>(name: string): Promise<T | undefined> {
  if (memory.has(name)) return memory.get(name) as T;
  const stored = await store().readJSON<T | null>(SNAPSHOT_PREFIX + name, null);
  if (stored == null) return undefined;
  memory.set(name, stored);
  return stored;
}

export function saveSnapshot(name: string, data: unknown): void {
  memory.set(name, data);
  void store().writeJSON(SNAPSHOT_PREFIX + name, data);
}

export async function clearSnapshots(): Promise<void> {
  memory.clear();
  try {
    const keys = await storage().getAllKeys();
    const ours = keys.filter((k) => k.startsWith(SNAPSHOT_PREFIX));
    if (ours.length) await storage().multiRemove(ours);
  } catch {
    // Storage unavailable: memory is already clear.
  }
}
