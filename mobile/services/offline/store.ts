/**
 * Offline storage primitives.
 *
 * Thin JSON-over-AsyncStorage helpers plus the key namespace used by the
 * offline layer (read cache, inventory mirror, write outbox). Everything the
 * offline system persists lives under the `offline:` prefix so it can be wiped
 * in one shot on sign-out.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export const KEYS = {
  inventoryMirror: "offline:inventory_mirror", // id -> InventoryItem (+ _pending flags)
  outbox: "offline:outbox", // OutboxEntry[]
  dashboardCache: "offline:cache:dashboard", // last Dashboard payload
  lastSync: "offline:last_sync", // ISO string of last successful server read
} as const;

export async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJSON(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full / serialization failure: non-fatal for the caller.
  }
}

/** Client-generated id for records created while offline. No native crypto dep. */
export function tempId(prefix = "local"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** True for ids minted locally (not yet confirmed by the server). */
export function isTempId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("local_");
}

/** Wipe all offline state — called on sign-out so the next user starts clean. */
export async function clearOfflineData(): Promise<void> {
  await AsyncStorage.multiRemove([
    KEYS.inventoryMirror,
    KEYS.outbox,
    KEYS.dashboardCache,
    KEYS.lastSync,
  ]);
}
