/**
 * Connectivity store.
 *
 * Wraps @react-native-community/netinfo in a tiny imperative store so both
 * React components (via the network context) and non-React code (the outbox
 * sync runner) can read online state and react to reconnects without prop
 * drilling. NetInfo is bundled in Expo Go, so this works without a dev build.
 */
import NetInfo from "@react-native-community/netinfo";

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
  _unsubscribe = NetInfo.addEventListener((state) => {
    const next = computeOnline(state);
    if (next !== _online) {
      _online = next;
      listeners.forEach((l) => l(next));
    }
  });
  // Seed the current value.
  NetInfo.fetch().then((state) => {
    const next = computeOnline(state);
    if (next !== _online) {
      _online = next;
      listeners.forEach((l) => l(next));
    }
  });
  return _unsubscribe;
}

export function isOnline(): boolean {
  return _online;
}

/** Subscribe to online/offline transitions. Returns an unsubscribe fn. */
export function subscribeNetwork(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
