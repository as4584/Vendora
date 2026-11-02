/**
 * services/offline/net.ts — connectivity store used by the offline outbox.
 */
type State = { isConnected: boolean | null; isInternetReachable: boolean | null };

function load(os: "ios" | "web") {
  jest.resetModules();
  jest.doMock("react-native", () => ({ Platform: { OS: os } }));
  let net: typeof import("../services/offline/net");
  let NetInfo: any;
  jest.isolateModules(() => {
    NetInfo = require("@react-native-community/netinfo").default;
    NetInfo.configure.mockClear();
    NetInfo.addEventListener.mockClear();
    net = require("../services/offline/net");
  });
  return { net: net!, NetInfo };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("web reachability", () => {
  it("probes our same-origin health endpoint on web", async () => {
    const { NetInfo } = load("web");
    expect(NetInfo.configure).toHaveBeenCalledTimes(1);
    const cfg = NetInfo.configure.mock.calls[0][0];
    expect(cfg.reachabilityUrl).toBe("/api/v1/health");
    expect(cfg.reachabilityMethod).toBe("GET");
    expect(await cfg.reachabilityTest({ status: 200 })).toBe(true);
    expect(await cfg.reachabilityTest({ status: 503 })).toBe(false);
  });

  it("leaves the default probe alone on iOS", () => {
    const { NetInfo } = load("ios");
    expect(NetInfo.configure).not.toHaveBeenCalled();
  });
});

describe("online state", () => {
  it("is optimistic, follows events, and only notifies on real transitions", async () => {
    const { net, NetInfo } = load("ios");
    let emit: (s: State) => void = () => {};
    NetInfo.addEventListener.mockImplementation((cb: (s: State) => void) => {
      emit = cb;
      return () => {};
    });
    NetInfo.fetch.mockResolvedValueOnce({ isConnected: true, isInternetReachable: null });

    expect(net.isOnline()).toBe(true);
    const seen: boolean[] = [];
    const unsub = net.subscribeNetwork((o) => seen.push(o));

    const stop = net.initNetwork();
    expect(net.initNetwork()).toBe(stop); // idempotent
    await flush();
    expect(seen).toEqual([]); // unknown reachability is not "offline"

    emit({ isConnected: false, isInternetReachable: null });
    emit({ isConnected: false, isInternetReachable: false }); // no duplicate
    expect(net.isOnline()).toBe(false);
    emit({ isConnected: true, isInternetReachable: false }); // still offline
    emit({ isConnected: true, isInternetReachable: true });
    expect(seen).toEqual([false, true]);

    unsub();
    emit({ isConnected: false, isInternetReachable: false });
    expect(seen).toEqual([false, true]);
  });

  it("seeds offline from the first fetch", async () => {
    const { net, NetInfo } = load("ios");
    NetInfo.addEventListener.mockImplementation(() => () => {});
    NetInfo.fetch.mockResolvedValueOnce({ isConnected: false, isInternetReachable: false });
    const seen: boolean[] = [];
    net.subscribeNetwork((o) => seen.push(o));
    net.initNetwork();
    await flush();
    expect(net.isOnline()).toBe(false);
    expect(seen).toEqual([false]);
  });
});
