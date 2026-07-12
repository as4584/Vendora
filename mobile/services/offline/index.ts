/**
 * Public surface for the offline layer + one-time sync wiring.
 */
import { initNetwork, isOnline, subscribeNetwork } from "./net";
import { flushOutbox } from "./inventory";

export { isOnline, subscribeNetwork } from "./net";
export {
  cacheItemsFromServer,
  cacheItemFromServer,
  offlineListItems,
  offlineGetItem,
  queueCreateItem,
  queueUpdateItem,
  queueQuickSale,
  flushOutbox,
  subscribeSync,
  getSyncState,
  cacheDashboard,
  readCachedDashboard,
  isTempId,
} from "./inventory";
export { clearOfflineData } from "./store";
export { setSender } from "./sender";

let _started = false;

/**
 * Start connectivity tracking and drain the outbox whenever we come back
 * online. Idempotent — safe to call from the app root on every mount.
 */
export function initOfflineSync(): () => void {
  const stopNet = initNetwork();
  if (_started) return stopNet;
  _started = true;

  // Flush on every offline→online transition.
  subscribeNetwork((online) => {
    if (online) void flushOutbox();
  });
  // And attempt once now, in case we launched already-online with a backlog.
  if (isOnline()) void flushOutbox();

  return stopNet;
}
