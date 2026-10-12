/**
 * Offline changes the server permanently rejects (4xx) must not vanish:
 * they're recorded for the user, their optimistic effects are undone, and
 * anything that depends on a rejected offline-created item is pulled too.
 */
let AsyncStorage: any;

const OUTBOX = "offline:outbox";
const MIRROR = "offline:inventory_mirror";
const FAILED = "offline:failed";

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function read(key: string) {
  return JSON.parse((await AsyncStorage.getItem(key)) ?? "null");
}

describe("offline outbox rejections", () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
  });

  it("records a rejected quick sale and restores the mirrored stock", async () => {
    await AsyncStorage.setItem(MIRROR, JSON.stringify({
      item1: { id: "item1", quantity: 0, status: "sold" },
    }));
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_1", kind: "quick_sale", path: "/transactions", method: "POST",
        body: { item_id: "item1", quantity: 1 }, createdAt: "t", attempts: 0 },
    ]));
    const sender = require("../services/offline/sender");
    sender.setSender(jest.fn().mockRejectedValue(apiError(409, "Only 0 unit(s) available.")));
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    expect(await read(OUTBOX)).toEqual([]);
    const failed = await read(FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: "ob_1", kind: "quick_sale", message: "Only 0 unit(s) available." });
    expect((await read(MIRROR)).item1).toMatchObject({ quantity: 1, status: "in_stock" });
    await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0, failed: 1 });
  });

  it("pulls dependents of a rejected offline-created item and keeps others", async () => {
    await AsyncStorage.setItem(MIRROR, JSON.stringify({
      local_x: { id: "local_x", quantity: 2, status: "in_stock" },
    }));
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_c", kind: "create_item", path: "/inventory", method: "POST",
        body: { name: "" }, tempId: "local_x", createdAt: "t", attempts: 0 },
      { id: "ob_u", kind: "update_item", path: "/inventory/local_x", method: "PUT",
        body: {}, createdAt: "t", attempts: 0 },
      { id: "ob_s", kind: "quick_sale", path: "/transactions", method: "POST",
        body: { item_id: "local_x" }, createdAt: "t", attempts: 0 },
      { id: "ob_other", kind: "quick_sale", path: "/transactions", method: "POST",
        body: { item_id: "real1" }, createdAt: "t", attempts: 0 },
    ]));
    const send = jest.fn()
      .mockRejectedValueOnce(apiError(422, "Name is required"))
      .mockResolvedValue({});
    require("../services/offline/sender").setSender(send);
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    // Only the independent sale reached the server after the rejection.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("/transactions", "POST", { item_id: "real1" });
    expect((await read(FAILED)).map((f: any) => f.id)).toEqual(["ob_c", "ob_u", "ob_s"]);
    expect((await read(MIRROR)).local_x).toBeUndefined();
    expect(await read(OUTBOX)).toEqual([]);
  });

  it("keeps transient failures queued instead of recording them", async () => {
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_t", kind: "quick_sale", path: "/transactions", method: "POST",
        body: {}, createdAt: "t", attempts: 0 },
    ]));
    require("../services/offline/sender").setSender(jest.fn().mockRejectedValue(apiError(503, "down")));
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    expect(await read(OUTBOX)).toHaveLength(1);
    expect(await read(FAILED)).toBeNull();
  });

  it("clearFailedSyncs empties the list", async () => {
    await AsyncStorage.setItem(FAILED, JSON.stringify([{ id: "x" }]));
    const offline = require("../services/offline/inventory");
    await offline.clearFailedSyncs();
    expect(await read(FAILED)).toEqual([]);
  });
});
