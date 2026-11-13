/**
 * Invoices created offline: a local "Pending sync" copy (never a guessed INV
 * number), one outbox entry with an idempotency key, temp item ids remapped
 * at flush, and a clean revert if the server rejects it.
 */
let AsyncStorage: any;

const OUTBOX = "outbox";
const PENDING = "pendingInvoices";
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

const PAYLOAD = {
  customer_name: "Show Buyer",
  items: [
    { description: "Dunk Low", quantity: 2, unit_price: "100.00", inventory_item_id: "local_item1" },
    { description: "Laces", quantity: 1, unit_price: "5.50" },
  ],
  tax: "8.00",
  shipping: "2.00",
  discount: "10.00",
};

describe("offline invoices", () => {
  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
    require("../services/session").replaceSession("seller");
  });

  it("keeps a pending local copy with totals and queues one create", async () => {
    const offline = require("../services/offline/inventory");
    const inv = await offline.queueCreateInvoice(PAYLOAD);

    expect(inv._pending).toBe(true);
    expect(inv.invoice_number).toBe("");
    expect(inv.id.startsWith("local_")).toBe(true);
    expect(inv).toMatchObject({
      status: "draft",
      subtotal: "205.50",
      total: "205.50",
      balance_due: "205.50",
      amount_paid: "0.00",
      customer_email: null,
      notes: null,
    });
    expect(inv.items[0]).toMatchObject({ line_total: "200.00", inventory_item_id: "local_item1" });
    expect(inv.items[1]).toMatchObject({ inventory_item_id: null, size_label: null });

    const outbox = await read(OUTBOX);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "create_invoice", path: "/invoices", method: "POST", tempId: inv.id });
    expect(outbox[0].body.client_request_id).toBe(outbox[0].id);
    expect(await offline.getPendingInvoices()).toHaveLength(1);
    expect(await offline.getPendingInvoice(inv.id)).toMatchObject({ id: inv.id });
    expect(await offline.getPendingInvoice("nope")).toBeNull();
  });

  it("reuses the key of an online attempt and never goes below zero", async () => {
    const offline = require("../services/offline/inventory");
    const inv = await offline.queueCreateInvoice({
      customer_name: "A",
      items: [{ description: "x", quantity: 1, unit_price: "1.00" }],
      discount: "50.00",
      client_request_id: "inv_online_try",
    });
    expect(inv.total).toBe("0.00");
    expect((await read(OUTBOX))[0].body.client_request_id).toBe("inv_online_try");
  });

  it("replays after the item it uses is created, then drops the local copy", async () => {
    const offline = require("../services/offline/inventory");
    await seed(OUTBOX, JSON.stringify([
      { id: "ob_c", kind: "create_item", path: "/inventory", method: "POST",
        body: { name: "Dunk" }, tempId: "local_item1", createdAt: "t", attempts: 0 },
    ]));
    const inv = await offline.queueCreateInvoice(PAYLOAD);
    const send = jest.fn()
      .mockResolvedValueOnce({ id: "srv_item", name: "Dunk", quantity: 2 })
      .mockResolvedValueOnce({ id: "srv_inv", invoice_number: "INV0007" });
    require("../services/offline/sender").setSender(send);

    await offline.flushOutbox();

    expect(send).toHaveBeenLastCalledWith("/invoices", "POST", expect.objectContaining({
      items: [expect.objectContaining({ inventory_item_id: "srv_item" }), expect.objectContaining({ description: "Laces" })],
      client_request_id: expect.any(String),
    }), expect.objectContaining({ ownerId: "seller" }));
    expect(await read(OUTBOX)).toEqual([]);
    expect(await read(PENDING)).toEqual([]);
    expect(inv._pending).toBe(true);
  });

  it("keeps it queued on a transient failure", async () => {
    const offline = require("../services/offline/inventory");
    await offline.queueCreateInvoice(PAYLOAD);
    require("../services/offline/sender").setSender(jest.fn().mockRejectedValue(apiError(503, "down")));
    await offline.flushOutbox();
    expect(await read(OUTBOX)).toHaveLength(1);
    expect(await read(PENDING)).toHaveLength(1);
  });

  it("removes the local copy and records the failure when rejected", async () => {
    const offline = require("../services/offline/inventory");
    await offline.queueCreateInvoice({ ...PAYLOAD, items: [PAYLOAD.items[1]] });
    require("../services/offline/sender").setSender(
      jest.fn().mockRejectedValue(apiError(409, "Only 0 units available")),
    );
    await offline.flushOutbox();
    expect(await read(OUTBOX)).toEqual([]);
    expect(await read(PENDING)).toEqual([]);
    expect(await read(FAILED)).toEqual([expect.objectContaining({ kind: "create_invoice", message: "Only 0 units available" })]);
  });

  it("drops a dependent invoice when the item it uses is rejected", async () => {
    const offline = require("../services/offline/inventory");
    await seed(OUTBOX, JSON.stringify([
      { id: "ob_c", kind: "create_item", path: "/inventory", method: "POST",
        body: { name: "Dunk" }, tempId: "local_item1", createdAt: "t", attempts: 0 },
    ]));
    await offline.queueCreateInvoice(PAYLOAD);
    require("../services/offline/sender").setSender(jest.fn().mockRejectedValue(apiError(422, "bad item")));
    await offline.flushOutbox();
    expect(await read(OUTBOX)).toEqual([]);
    expect(await read(PENDING)).toEqual([]);
    expect((await read(FAILED)).map((f: any) => f.kind)).toEqual(["create_item", "create_invoice"]);
  });

  it("retains a pending invoice without exposing it after sign-out", async () => {
    const offline = require("../services/offline/inventory");
    const { replaceSession } = require("../services/session");
    const pending = await offline.queueCreateInvoice(PAYLOAD);
    replaceSession();
    await expect(offline.getPendingInvoices()).resolves.toEqual([]);
    replaceSession("seller");
    await expect(offline.getPendingInvoices()).resolves.toEqual([pending]);
  });
});

describe("invoice API offline behaviour", () => {
  let online = true;
  let api: any;
  const fetchMock = jest.fn();

  function response(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify(body),
    };
  }

  beforeEach(async () => {
    jest.resetModules();
    online = true;
    jest.doMock("../services/offline/net", () => ({
      ...jest.requireActual("../services/offline/net"),
      isOnline: () => online,
    }));
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
    (global as any).fetch = fetchMock;
    fetchMock.mockReset();
    api = require("../services/api");
    const { captureSession } = require("../services/session");
    const token = `x.${Buffer.from(JSON.stringify({ sub: "seller" })).toString("base64url")}.x`;
    await api.setSession(token, "test-refresh");
    api.activateAccount("seller", captureSession());
  });

  afterAll(() => {
    jest.dontMock("../services/offline/net");
  });

  it("queues the create when offline and shows it first in the list", async () => {
    online = false;
    const inv = await api.createInvoice({ customer_name: "Off", items: [{ description: "x", quantity: 1, unit_price: "3.00" }] });
    expect(inv._pending).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const page = await api.listInvoices({ perPage: 20 });
    expect(page.items.map((i: any) => i.id)).toEqual([inv.id]);
    expect(page.pages).toBe(1);
    expect(await api.getInvoice(inv.id)).toMatchObject({ customer_name: "Off" });
    await expect(api.recordInvoicePayment(inv.id, { amount: "1.00", method: "cash" })).rejects.toThrow(/waiting to sync/);
  });

  it("returns an empty offline page with no pending invoices", async () => {
    online = false;
    expect(await api.listInvoices()).toMatchObject({ items: [], total: 0, pages: 0 });
  });

  it("merges pending invoices ahead of the server page and skips them when filtered", async () => {
    online = false;
    const inv = await api.createInvoice({ customer_name: "Off", items: [{ description: "x", quantity: 1, unit_price: "3.00" }] });
    online = true;
    fetchMock.mockResolvedValue(response({ items: [{ id: "srv" }], total: 1, page: 1, per_page: 20, pages: 1 }));
    const page = await api.listInvoices();
    expect(page.items.map((i: any) => i.id)).toEqual([inv.id, "srv"]);
    expect(page.total).toBe(2);
    const filtered = await api.listInvoices({ status: "paid" });
    expect(filtered.items.map((i: any) => i.id)).toEqual(["srv"]);
  });

  it("falls back to the outbox on a network error, keeping the same key", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    const inv = await api.createInvoice({ customer_name: "Flaky", items: [{ description: "x", quantity: 1, unit_price: "3.00" }] });
    expect(inv._pending).toBe(true);
    const sentKey = JSON.parse(fetchMock.mock.calls[0][1].body).client_request_id;
    const outbox = await read(OUTBOX);
    expect(outbox[0].body.client_request_id).toBe(sentKey);
    // The list also falls back when the network drops mid-request.
    expect((await api.listInvoices()).items).toHaveLength(1);
  });

  it("surfaces server errors instead of queueing", async () => {
    fetchMock.mockResolvedValue(response({ detail: "Customer required" }, 422));
    await expect(api.createInvoice({ customer_name: "", items: [] })).rejects.toBeTruthy();
    expect(await read(OUTBOX)).toBeNull();
    await expect(api.listInvoices()).rejects.toBeTruthy();
  });

  it("says a missing temp invoice has synced", async () => {
    await expect(api.getInvoice("local_gone")).rejects.toThrow(/synced or was removed/);
  });
});
