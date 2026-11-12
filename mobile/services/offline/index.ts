/**
 * Public surface for the offline layer + one-time sync wiring.
 */
import { initNetwork, isOnline, subscribeNetwork } from "./net";
import { flushInBackground } from "./inventory";
import { subscribeSession } from "../session";

export { isOnline, subscribeNetwork } from "./net";
export {
  cacheItemsFromServer,
  cacheItemFromServer,
  offlineListItems,
  offlineGetItem,
  queueCreateItem,
  queueUpdateItem,
  queueQuickSale,
  queueSaleOrder,
  queueCreateInvoice,
  getPendingInvoices,
  getPendingInvoice,
  flushOutbox,
  subscribeSync,
  getSyncState,
  getFailedSyncs,
  clearFailedSyncs,
  cacheDashboard,
  readCachedDashboard,
  isTempId,
} from "./inventory";
export { setSender } from "./sender";

let stopSync: (() => void) | null = null;

/**
 * Start connectivity tracking and drain the outbox whenever we come back
 * online. Idempotent — safe to call from the app root on every mount.
 */
export function initOfflineSync(): () => void {
  if (stopSync) return stopSync;
  const stopNet = initNetwork();

  // Flush on every offline→online transition.
  const stopConnectivity = subscribeNetwork((online) => {
    if (online) flushInBackground();
  });
  const stopSession = subscribeSession(flushInBackground);
  // And attempt once now, in case we launched already-online with a backlog.
  if (isOnline()) flushInBackground();

  const stop = () => {
    if (stopSync !== stop) return;
    stopSync = null;
    stopNet();
    stopConnectivity();
    stopSession();
  };
  stopSync = stop;
  return stop;
}
