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
} from "../services/offline";

interface NetworkState {
  online: boolean;
  pending: number; // queued offline writes awaiting sync
  lastSync: string | null;
}

const NetworkContext = createContext<NetworkState>({
  online: true,
  pending: 0,
  lastSync: null,
});

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(readOnline());
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stop = initOfflineSync();
    const unNet = subscribeNetwork(setOnline);

    const refreshSync = () => {
      void getSyncState().then((s) => {
        setPending(s.pending);
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
    <NetworkContext.Provider value={{ online, pending, lastSync }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkState {
  return useContext(NetworkContext);
}
