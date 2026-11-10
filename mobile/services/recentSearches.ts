/** Last few inventory searches, newest first, kept on this device. */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "vendora.recentSearches";
export const MAX_RECENT = 6;

export async function getRecentSearches(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export async function addRecentSearch(query: string): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return getRecentSearches();
  const next = [q, ...(await getRecentSearches()).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: recent searches are a nicety.
  }
  return next;
}

export async function clearRecentSearches(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
