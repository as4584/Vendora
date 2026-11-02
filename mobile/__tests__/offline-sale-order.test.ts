/**
 * A multi-item checkout made offline is ONE outbox entry, so it can never
 * reach the server halfway. It adjusts mirrored stock per line, follows
 * offline-created items to their real ids, and is fully undone if rejected.
 */
let AsyncStorage: any;

const OUTBOX = "offline:outbox";
const MIRROR = "offline:inventory_mirror";
const FAILED = "offline:failed";

async function read(key: string) {
  return JSON.parse((await AsyncStorage.getItem(key)) ?? "null");
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

describe("offline sale orders", () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
  });

  it("queues one entry and decrements every line in the mirror", async () => {
    await AsyncStorage.setItem(MIRROR, JSON.stringify({
      a: { id: "a", quantity: 2, status: "in_stock" },
      b: { id: "b", quantity: 1, status: "in_stock" },
    }));
    const offline = require("../services/offline/inventory");

    const order = await offline.queueSaleOrder({
      lines: [
        { item_id: "a", quantity: 1, unit_price: "120.00" },
        { item_id: "b", quantity: 1, unit_price: "80.50" },
        { item_id: "missing", quantity: 1, unit_price: "1.00" },
      ],
      method: "cash",
      fee_amount: "1.50",
    });

    expect(order).toMatchObject({ pending: true, gross_amount: "201.50", fee_amount: "1.50", net_amount: "200.00" });
    const outbox = await read(OUTBOX);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "sale_order", path: "/transactions/order", method: "POST" });
    expect(outbox[0].body.client_request_id).toBe(outbox[0].id);
    const mirror = await read(MIRROR);
    expect(mirror.a).toMatchObject({ quantity: 1, status: "in_stock" });
    expect(mirror.b).toMatchObject({ quantity: 0, status: "sold" });
  });

  it("rewrites offline-created item ids inside the order lines", async () => {
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_c", kind: "create_item", path: "/inventory", method: "POST",
        body: { name: "New" }, tempId: "local_1", createdAt: "t", attempts: 0 },
      { id: "ob_o", kind: "sale_order", path: "/transactions/order", method: "POST",
        body: { method: "cash", lines: [{ item_id: "local_1", quantity: 1, unit_price: "5.00" },
                                        { item_id: "real_2", quantity: 1, unit_price: "6.00" }] },
        createdAt: "t", attempts: 0 },
    ]));
    const send = jest.fn()
      .mockResolvedValueOnce({ id: "srv_1", name: "New", quantity: 1 })
      .mockResolvedValueOnce({ order_id: "o1" });
    require("../services/offline/sender").setSender(send);
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    expect(send).toHaveBeenLastCalledWith("/transactions/order", "POST", expect.objectContaining({
      lines: [{ item_id: "srv_1", quantity: 1, unit_price: "5.00" },
              { item_id: "real_2", quantity: 1, unit_price: "6.00" }],
    }));
    expect(await read(OUTBOX)).toEqual([]);
  });

  it("restores stock for every line when the server rejects the order", async () => {
    await AsyncStorage.setItem(MIRROR, JSON.stringify({
      a: { id: "a", quantity: 0, status: "sold" },
      b: { id: "b", quantity: 3, status: "in_stock" },
    }));
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_o", kind: "sale_order", path: "/transactions/order", method: "POST",
        body: { method: "cash", lines: [{ item_id: "a", quantity: 2, unit_price: "5.00" },
                                        { item_id: "b", quantity: 1, unit_price: "5.00" }] },
        createdAt: "t", attempts: 0 },
    ]));
    require("../services/offline/sender").setSender(jest.fn().mockRejectedValue(apiError(409, "Only 0 unit(s) available.")));
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    const mirror = await read(MIRROR);
    expect(mirror.a).toMatchObject({ quantity: 2, status: "in_stock" });
    expect(mirror.b).toMatchObject({ quantity: 4 });
    expect((await read(FAILED))[0]).toMatchObject({ id: "ob_o", kind: "sale_order" });
  });

  it("pulls an order that depends on a rejected offline-created item", async () => {
    await AsyncStorage.setItem(OUTBOX, JSON.stringify([
      { id: "ob_c", kind: "create_item", path: "/inventory", method: "POST",
        body: { name: "" }, tempId: "local_x", createdAt: "t", attempts: 0 },
      { id: "ob_o", kind: "sale_order", path: "/transactions/order", method: "POST",
        body: { method: "cash", lines: [{ item_id: "local_x", quantity: 1, unit_price: "1.00" }] },
        createdAt: "t", attempts: 0 },
    ]));
    const send = jest.fn().mockRejectedValue(apiError(422, "Name is required"));
    require("../services/offline/sender").setSender(send);
    const offline = require("../services/offline/inventory");

    await offline.flushOutbox();

    expect(send).toHaveBeenCalledTimes(1);
    expect((await read(FAILED)).map((f: any) => f.id)).toEqual(["ob_c", "ob_o"]);
  });
});

describe("api.createSaleOrder", () => {
  beforeEach(() => jest.resetModules());

  it("queues the order when offline", async () => {
    jest.doMock("../services/offline", () => {
      const actual = jest.requireActual("../services/offline");
      return { ...actual, isOnline: () => false, queueSaleOrder: jest.fn(async () => ({ pending: true })) };
    });
    const api = require("../services/api");
    const offline = require("../services/offline");
    const payload = { lines: [{ item_id: "a", quantity: 1, unit_price: "1.00" }], method: "cash" };
    await expect(api.createSaleOrder(payload)).resolves.toEqual({ pending: true });
    expect(offline.queueSaleOrder).toHaveBeenCalledWith(payload);
  });
});
