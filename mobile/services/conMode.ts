/**
 * Con Mode — for a busy table on bad venue wifi.
 *
 * While on, checkouts and trades never wait on the network: they are written
 * to the offline outbox (instant receipt) and synced right away in the
 * background. eBay comps are served from cache first and refreshed behind.
 * The switch is per device and survives restarts.
 */
import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "resqlo.con_mode.v1";
let enabled = false;
const listeners = new Set<() => void>();

export function isConMode(): boolean {
  return enabled;
}

export function subscribeConMode(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setConMode(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, on ? "1" : "0").catch(() => undefined);
}

/** Read the saved switch once at startup. */
export async function loadConMode(): Promise<boolean> {
  try {
    const saved = (await AsyncStorage.getItem(KEY)) === "1";
    if (saved !== enabled) {
      enabled = saved;
      listeners.forEach((l) => l());
    }
  } catch {
    /* keep current */
  }
  return enabled;
}

export function useConMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeConMode, isConMode, isConMode);
  return [on, setConMode];
}

export function resetConModeForTests(): void {
  enabled = false;
  listeners.clear();
}
