/**
 * NetworkProvider: shows the signed-in account's sync counts, zeroes them when
 * signed out, and lets the seller dismiss rejected syncs.
 */
import React from "react";
import { Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockClearFailed = jest.fn(async () => undefined);
let mockSyncListener: (() => void) | null = null;
const mockStop = jest.fn();
jest.mock("../services/offline", () => ({
  initOfflineSync: () => mockStop,
  isOnline: () => true,
  subscribeNetwork: () => () => undefined,
  subscribeSync: (cb: () => void) => {
    mockSyncListener = cb;
    return () => { mockSyncListener = null; };
  },
  getSyncState: async () => ({ pending: 2, failed: 1, lastSync: "2026-11-17T00:00:00Z" }),
  clearFailedSyncs: () => mockClearFailed(),
}));

import { NetworkProvider, useNetwork } from "../context/network";
import { replaceSession } from "../services/session";

function Probe() {
  const n = useNetwork();
  return <Text onPress={n.dismissFailed}>{`${n.online}|${n.pending}|${n.failed}|${n.lastSync}`}</Text>;
}

describe("NetworkProvider", () => {
  it("tracks the signed-in account's sync state and clears it on sign-out", async () => {
    replaceSession("seller");
    const screen = render(<NetworkProvider><Probe /></NetworkProvider>);
    await waitFor(() => expect(screen.getByText("true|2|1|2026-11-17T00:00:00Z")).toBeTruthy());

    fireEvent.press(screen.getByText("true|2|1|2026-11-17T00:00:00Z"));
    expect(mockClearFailed).toHaveBeenCalled();

    act(() => {
      replaceSession(null);
      mockSyncListener?.();
    });
    expect(screen.getByText("true|0|0|null")).toBeTruthy();

    screen.unmount();
    expect(mockStop).toHaveBeenCalled();
    expect(mockSyncListener).toBeNull();
  });

  it("defaults to online with nothing pending outside a provider", () => {
    const screen = render(<Probe />);
    fireEvent.press(screen.getByText("true|0|0|null"));
    expect(screen.getByText("true|0|0|null")).toBeTruthy();
  });
});
