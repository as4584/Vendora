/**
 * Stale-while-revalidate cache for eBay sold comps.
 *
 * Comps barely move within a day, so a repeat scan of the same pair should be
 * instant. Fresh entries (< FRESH_MS) are returned without a request; older
 * ones (< MAX_AGE_MS) are returned at once in Con Mode and refreshed behind.
 * Kept in memory and mirrored to storage so it survives a restart.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export const FRESH_MS = 30 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KEY = "resqlo.comps_cache.v1";
const LIMIT = 200;

interface Entry<T> { at: number; value: T }
let memory: Record<string, Entry<unknown>> | null = null;

async function load(): Promise<Record<string, Entry<unknown>>> {
  if (memory) return memory;
  try {
    memory = JSON.parse((await AsyncStorage.getItem(KEY)) ?? "{}") ?? {};
  } catch {
    memory = {};
  }
  return memory!;
}

function persist(): void {
  if (!memory) return;
  const keys = Object.keys(memory).sort((a, b) => memory![b].at - memory![a].at);
  for (const k of keys.slice(LIMIT)) delete memory[k];
  AsyncStorage.setItem(KEY, JSON.stringify(memory)).catch(() => undefined);
}

/**
 * Return cached comps when usable, otherwise fetch. `preferCache` (Con Mode)
 * accepts stale entries and refreshes them in the background.
 */
export async function cachedComps<T>(
  key: string, fetcher: () => Promise<T>, opts: { preferCache?: boolean; now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const store = await load();
  const hit = store[key] as Entry<T> | undefined;
  const age = hit ? now() - hit.at : Infinity;
  const refresh = async () => {
    const value = await fetcher();
    store[key] = { at: now(), value };
    persist();
    return value;
  };
  if (hit && age < FRESH_MS) return hit.value;
  if (hit && opts.preferCache && age < MAX_AGE_MS) {
    void refresh().catch(() => undefined);
    return hit.value;
  }
  try {
    return await refresh();
  } catch (err) {
    if (hit && age < MAX_AGE_MS) return hit.value; // no signal: last known comps beat an error
    throw err;
  }
}

export function clearCompsCache(): void {
  memory = {};
  AsyncStorage.removeItem(KEY).catch(() => undefined);
}

export function resetCompsCacheForTests(): void {
  memory = null;
}
