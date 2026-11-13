/** Last few inventory searches for the active account, newest first. */
import { OfflineStorageError, readAccountJSON, updateAccountJSON, writeAccountJSON } from "./offline/store";
import { assertSession, captureSession, requireAccount } from "./session";

const KEY = "inventory:recentSearches";
export const MAX_RECENT = 6;
const empty = () => ({ values: [] as string[] });
function normalize(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT) : [];
}

export async function getRecentSearches(session = captureSession()): Promise<string[]> {
  assertSession(session);
  if (!session.ownerId) return [];
  try {
    const data = await readAccountJSON(requireAccount(session), KEY, empty);
    assertSession(session);
    return normalize(data?.values);
  } catch (error) {
    if (error instanceof OfflineStorageError) return [];
    throw error;
  }
}

export async function addRecentSearch(query: string, session = captureSession()): Promise<string[]> {
  assertSession(session);
  if (!session.ownerId) return [];
  const q = query.trim();
  if (q.length < 2) return getRecentSearches(session);
  let next = [q];
  try {
    await updateAccountJSON(requireAccount(session), KEY, empty, (data) => {
      next = [q, ...normalize(data.values).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
      data.values = next;
    });
  } catch (error) {
    if (!(error instanceof OfflineStorageError)) throw error;
  }
  assertSession(session);
  return next;
}

export async function clearRecentSearches(session = captureSession()): Promise<void> {
  assertSession(session);
  if (!session.ownerId) return;
  try {
    await writeAccountJSON(requireAccount(session), KEY, empty());
  } catch (error) {
    if (!(error instanceof OfflineStorageError)) throw error;
  }
}
