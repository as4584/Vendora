/**
 * initOfflineSync: drains the outbox on launch, on reconnect and on account
 * change, is idempotent, and stops cleanly.
 */
const mockFlush = jest.fn();
let mockNetListener: ((online: boolean) => void) | null = null;
let mockSessionListener: (() => void) | null = null;
const mockStopNet = jest.fn();
let mockOnline = true;

jest.mock("../services/offline/inventory", () => ({ flushInBackground: () => mockFlush() }));
jest.mock("../services/offline/net", () => ({
  initNetwork: () => mockStopNet,
  isOnline: () => mockOnline,
  subscribeNetwork: (cb: (online: boolean) => void) => {
    mockNetListener = cb;
    return () => { mockNetListener = null; };
  },
}));
jest.mock("../services/session", () => ({
  subscribeSession: (cb: () => void) => {
    mockSessionListener = cb;
    return () => { mockSessionListener = null; };
  },
}));
jest.mock("../services/offline/snapshot", () => ({}));
jest.mock("../services/offline/sender", () => ({}));

describe("initOfflineSync", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFlush.mockClear();
    mockStopNet.mockClear();
  });

  it("flushes at launch, on reconnect and on account change, then stops once", () => {
    mockOnline = true;
    const { initOfflineSync } = require("../services/offline");
    const stop = initOfflineSync();
    expect(initOfflineSync()).toBe(stop);
    expect(mockFlush).toHaveBeenCalledTimes(1);

    mockNetListener?.(false);
    expect(mockFlush).toHaveBeenCalledTimes(1);
    mockNetListener?.(true);
    expect(mockFlush).toHaveBeenCalledTimes(2);
    mockSessionListener?.();
    expect(mockFlush).toHaveBeenCalledTimes(3);

    stop();
    stop();
    expect(mockStopNet).toHaveBeenCalledTimes(1);
    expect(mockNetListener).toBeNull();
    expect(mockSessionListener).toBeNull();
  });

  it("does not flush at launch while offline", () => {
    mockOnline = false;
    const { initOfflineSync } = require("../services/offline");
    const stop = initOfflineSync();
    expect(mockFlush).not.toHaveBeenCalled();
    stop();
  });
});
