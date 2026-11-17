import AsyncStorage from "@react-native-async-storage/async-storage";
import { assertSession, type AccountContext } from "../session";

/** Never read or remove pre-scope device-global offline/scan keys. */
export function accountKey(ownerId: string, name: string): string {
  return `account:v1:${encodeURIComponent(ownerId)}:${name}`;
}

export class OfflineStorageError extends Error {
  constructor(cause: unknown) {
    super("Unable to access offline storage. The change was not confirmed on this device.", { cause });
    this.name = "OfflineStorageError";
  }
}

export async function readAccountJSON<T>(account: AccountContext, name: string, empty: () => T): Promise<T> {
  assertSession(account);
  let data: T;
  try {
    const raw = await AsyncStorage.getItem(accountKey(account.ownerId, name));
    data = raw === null ? empty() : JSON.parse(raw);
  } catch (cause) {
    assertSession(account);
    throw new OfflineStorageError(cause);
  }
  assertSession(account);
  return data;
}

export async function writeAccountJSON(account: AccountContext, name: string, data: unknown): Promise<void> {
  assertSession(account);
  try {
    await AsyncStorage.setItem(accountKey(account.ownerId, name), JSON.stringify(data));
  } catch (cause) {
    assertSession(account);
    throw new OfflineStorageError(cause);
  }
  assertSession(account);
}

// Serialize read-modify-write per owner's document, never hold a lock over
// network I/O. A failed write must not poison the next transaction.
const writes = new Map<string, Promise<unknown>>();
export async function updateAccountJSON<T, R>(
  account: AccountContext,
  name: string,
  empty: () => T,
  update: (state: T) => R,
): Promise<R> {
  const key = accountKey(account.ownerId, name);
  const previous = writes.get(key);
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const state = await readAccountJSON(account, name, empty);
    const result = update(state);
    await writeAccountJSON(account, name, state);
    return result;
  });
  writes.set(key, next);
  try {
    return await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
}

/** Client-generated id for records created while offline. No native crypto dep. */
export function tempId(prefix = "local"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isTempId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("local_");
}
