/**
 * Startup ordering: the offline sync runner can fire (app launch, reconnect)
 * before api.ts has registered its authenticated sender. That must be a quiet
 * no-op that keeps the outbox for the next trigger, not a crash.
 */
let AsyncStorage: any;

const OUTBOX_KEY = "offline:outbox";
const queued = [
  { kind: "quick_sale", path: "/transactions/quick-sale", method: "POST", body: { item_id: "a" }, attempts: 0 },
];

describe("offline sync before api.ts initializes", () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(queued));
  });

  it("tryGetSender returns null until a sender is registered", () => {
    const sender = require("../services/offline/sender");
    expect(sender.tryGetSender()).toBeNull();
    expect(() => sender.getSender()).toThrow("offline sender not initialized");

    const send = jest.fn();
    sender.setSender(send);
    expect(sender.tryGetSender()).toBe(send);
  });

  it("flushOutbox does not throw and keeps the outbox when no sender exists", async () => {
    const { flushOutbox } = require("../services/offline/inventory");
    await expect(flushOutbox()).resolves.toBeUndefined();
    expect(JSON.parse((await AsyncStorage.getItem(OUTBOX_KEY)) as string)).toEqual(queued);
  });

  it("drains the kept outbox once the sender is registered", async () => {
    const sender = require("../services/offline/sender");
    const { flushOutbox } = require("../services/offline/inventory");
    await flushOutbox(); // too early: no-op

    const send = jest.fn().mockResolvedValue({});
    sender.setSender(send);
    await flushOutbox();

    expect(send).toHaveBeenCalledWith("/transactions/quick-sale", "POST", { item_id: "a" });
    expect(JSON.parse((await AsyncStorage.getItem(OUTBOX_KEY)) as string)).toEqual([]);
  });
});
