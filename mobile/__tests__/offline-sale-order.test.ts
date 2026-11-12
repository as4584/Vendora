/**
 * A multi-item checkout made offline is ONE outbox entry, so it can never
 * reach the server halfway. It adjusts mirrored stock per line, follows
 * offline-created items to their real ids, and is fully undone if rejected.
 */
let AsyncStorage: any;

const OUTBOX = "outbox";
const MIRROR = "mirror";
const FAILED = "failed";

const JOURNAL_KEY = "account:v1:seller:offline:journal";
async function read(key: string) {
  return JSON.parse((await AsyncStorage.getItem(JOURNAL_KEY)) ?? "null")?.[key] ?? null;
}

async function seed(key: string, value: string) {
  const prior = JSON.parse((await AsyncStorage.getItem(JOURNAL_KEY)) ?? "null");
  await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify({
    mirror: {}, outbox: [], remap: {}, pendingInvoices: [], failed: [], lastSync: null,
    ...prior, [key]: JSON.parse(value),
  }));
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

describe("offline sale orders", () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
    require("../services/session").replaceSession("seller");
  });

  it("queues one entry and decrements every line in the mirror", async () => {
    await seed(MIRROR, JSON.stringify({
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
    const mirror = (await offline.offlineListItems({})).items.reduce((all: any, item: any) => ({ ...all, [item.id]: item }), {});
    expect(mirror.a).toMatchObject({ quantity: 1, status: "in_stock" });
    expect(mirror.b).toMatchObject({ quantity: 0, status: "sold" });
  });

  it("rewrites offline-created item ids inside the order lines", async () => {
    await seed(OUTBOX, JSON.stringify([
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
    }), expect.objectContaining({ ownerId: "seller" }));
    expect(await read(OUTBOX)).toEqual([]);
  });

  it("restores stock for every line when the server rejects the order", async () => {
    await seed(MIRROR, JSON.stringify({
      a: { id: "a", quantity: 2, status: "in_stock" },
      b: { id: "b", quantity: 4, status: "in_stock" },
    }));
    await seed(OUTBOX, JSON.stringify([
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

  it("queues a split, discounted, taxed, sized order and returns server-identical totals", async () => {
    await seed(MIRROR, JSON.stringify({
      s: { id: "s", quantity: 3, status: "in_stock", custom_attributes: { variants: [{ size: "9", quantity: 1 }, { size: "10", quantity: 2 }] } },
    }));
    const offline = require("../services/offline/inventory");
    const payments = [{ method: "cash", amount: "150.00" }, { method: "card", amount: "60.00" }];

    const order = await offline.queueSaleOrder({
      lines: [{ item_id: "s", quantity: 2, unit_price: "110.00", size: "10" }],
      payments,
      discount_amount: "20.00",
      tax_rate: "5",
      fee_amount: "1.00",
    });

    expect(order).toMatchObject({
      pending: true, subtotal_amount: "220.00", discount_amount: "20.00", gross_amount: "200.00",
      tax_amount: "10.00", total_amount: "210.00", net_amount: "199.00", payments,
    });
    const mirror = { s: await offline.offlineGetItem("s") };
    expect(mirror.s.quantity).toBe(1);
    expect(mirror.s.custom_attributes.variants).toEqual([{ size: "9", quantity: 1 }, { size: "10", quantity: 0 }]);
    const outbox = await read(OUTBOX);
    expect(outbox[0].body).toMatchObject({ payments, discount_amount: "20.00", tax_rate: "5" });

    // Percent discount + single method fills in one payment part.
    const pct = await offline.queueSaleOrder({
      lines: [{ item_id: "s", quantity: 1, unit_price: "100.00" }], method: "card", discount_percent: "10",
    });
    expect(pct).toMatchObject({ total_amount: "90.00", payments: [{ method: "card", amount: "90.00" }] });

    // Rejected: stock and the size come back.
    require("../services/offline/sender").setSender(jest.fn().mockRejectedValue(apiError(409, "size gone")));
    await offline.flushOutbox();
    const after = await read(MIRROR);
    expect(after.s.custom_attributes.variants).toEqual([{ size: "9", quantity: 1 }, { size: "10", quantity: 2 }]);
  });

  it("finds mirrored items by barcode offline", async () => {
    await seed(MIRROR, JSON.stringify({
      a: { id: "a", quantity: 1, status: "in_stock", upc: "012345678905", created_at: "2" },
      b: { id: "b", quantity: 1, status: "in_stock", upc: null, created_at: "1" },
    }));
    const offline = require("../services/offline/inventory");
    const res = await offline.offlineListItems({ upc: "12345678905" });
    expect(res.items.map((i: any) => i.id)).toEqual(["a"]);
  });

  it("pulls an order that depends on a rejected offline-created item", async () => {
    await seed(OUTBOX, JSON.stringify([
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
    expect(offline.queueSaleOrder).toHaveBeenCalledWith({ ...payload, client_request_id: expect.any(String) }, expect.any(Object));
  });
});
