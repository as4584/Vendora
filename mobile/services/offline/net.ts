/**
 * Connectivity store.
 *
 * Wraps @react-native-community/netinfo in a tiny imperative store so both
 * React components (via the network context) and non-React code (the outbox
 * sync runner) can read online state and react to reconnects without prop
 * drilling. NetInfo is bundled in Expo Go, so this works without a dev build.
 */
import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";

// NetInfo's default check pings a Google URL and, once it decides we're
// offline, only re-checks every few seconds with long timeouts, so a seller
// on bad wifi stayed "offline" long after the signal came back. Probe our own
// health endpoint (same-origin on web, so the browser allows it) and re-check
// quickly while offline.
const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "https://vendora.lexmakesit.com/api/v1";
if (typeof NetInfo.configure === "function") {
  NetInfo.configure({
    reachabilityUrl: Platform.OS === "web" ? "/api/v1/health" : `${API_BASE}/health`,
    reachabilityTest: async (response) => response.status === 200,
    reachabilityMethod: "GET",
    reachabilityShortTimeout: 2_000, // re-check every 2s while offline
    reachabilityLongTimeout: 30_000, // re-check every 30s while online
    reachabilityRequestTimeout: 8_000, // slow wifi is still wifi
  });
}

type Listener = (online: boolean) => void;

let _online = true; // optimistic until the first NetInfo event arrives
const listeners = new Set<Listener>();
let _unsubscribe: (() => void) | null = null;

function computeOnline(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  // isInternetReachable is null while unknown — only treat an explicit `false`
  // (both fields) as offline so we don't flap to offline on first mount.
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

/** Start listening. Idempotent — safe to call once from the network provider. */
export function initNetwork(): () => void {
  if (_unsubscribe) return _unsubscribe;
  const stop = NetInfo.addEventListener((state) => {
    const next = computeOnline(state);
    if (next !== _online) {
      _online = next;
      listeners.forEach((l) => l(next));
    }
  });
  const cleanup = () => {
    if (_unsubscribe !== cleanup) return;
    _unsubscribe = null;
    stop();
  };
  _unsubscribe = cleanup;
  // Seed the current value.
  NetInfo.fetch().then((state) => {
    if (_unsubscribe !== cleanup) return;
    const next = computeOnline(state);
    if (next !== _online) {
      _online = next;
      listeners.forEach((l) => l(next));
    }
  }).catch(() => undefined);
  return cleanup;
}

export function isOnline(): boolean {
  return _online;
}

/** Subscribe to online/offline transitions. Returns an unsubscribe fn. */
export function subscribeNetwork(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Any real answer from our server proves we're online, so flip back right
 * away instead of waiting for NetInfo's next probe.
 */
export function markReachable(): void {
  if (_online) return;
  _online = true;
  listeners.forEach((l) => l(true));
}
