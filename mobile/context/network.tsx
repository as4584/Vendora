/**
 * Network Context — exposes online/offline state and pending-sync count to the
 * UI, and starts the offline sync runner (flush-on-reconnect) once at the root.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import {
  initOfflineSync,
  isOnline as readOnline,
  subscribeNetwork,
  subscribeSync,
  getSyncState,
  clearFailedSyncs,
} from "../services/offline";

interface NetworkState {
  online: boolean;
  pending: number; // queued offline writes awaiting sync
  failed: number; // offline writes the server rejected
  lastSync: string | null;
  dismissFailed: () => void;
}

const NetworkContext = createContext<NetworkState>({
  online: true,
  pending: 0,
  failed: 0,
  lastSync: null,
  dismissFailed: () => undefined,
});

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(readOnline());
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stop = initOfflineSync();
    const unNet = subscribeNetwork(setOnline);

    const refreshSync = () => {
      void getSyncState().then((s) => {
        setPending(s.pending);
        setFailed(s.failed);
        setLastSync(s.lastSync);
      });
    };
    const unSync = subscribeSync(refreshSync);
    refreshSync();

    return () => {
      unNet();
      unSync();
      stop?.();
    };
  }, []);

  return (
    <NetworkContext.Provider
      value={{ online, pending, failed, lastSync, dismissFailed: () => void clearFailedSyncs() }}
    >
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkState {
  return useContext(NetworkContext);
}
