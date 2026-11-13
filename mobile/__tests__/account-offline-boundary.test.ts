import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import * as api from "../services/api";
import * as offline from "../services/offline";
import * as scan from "../services/smartScan/memory";
import * as recent from "../services/recentSearches";
import { accountKey } from "../services/offline/store";
import { captureSession, replaceSession } from "../services/session";

let mockOnline = true;
jest.mock("../services/offline/net", () => ({
  ...jest.requireActual("../services/offline/net"),
  isOnline: () => mockOnline,
}));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const token = (id: string, sid = id) =>
  `x.${Buffer.from(JSON.stringify({ sub: id, sid })).toString("base64url")}.x`;
const user = (id: string) => ({ id, email: `${id}@example.test` });
const invoice = { customer_name: "Private buyer A", items: [{ description: "Box", quantity: 1, unit_price: "4" }] };
const sale = { item_id: "a-item", method: "cash", gross_amount: "10.00" };
const order = { method: "cash", lines: [{ item_id: "a-item", quantity: 1, unit_price: "10.00" }] };
const item = { id: "a-item", user_id: "A", name: "A item", quantity: 2, status: "in_stock" } as api.InventoryItem;
const customer = { id: "a-customer", name: "Private buyer A", email: "a@example.test", phone: null };
const dashboard = { revenue_today: "19.99" } as api.Dashboard;
const journalKey = accountKey("A", "offline:journal");
const fetchMock = jest.spyOn(global, "fetch");

async function login(owner: string) {
  await api.setSession(token(owner), `refresh-${owner}`);
  api.activateAccount(owner, captureSession());
  return captureSession();
}

beforeEach(async () => {
  mockOnline = true;
  fetchMock.mockReset();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  replaceSession();
  api.onUnauthorized(null);
});

it("isolates all offline surfaces and resumes known-owner work after signing back in", async () => {
  const legacy = {
    "offline:customers": JSON.stringify([customer]),
    "offline:inventory_mirror": JSON.stringify({ [item.id]: item }),
    "offline:outbox": '[{"id":"legacy-sale"}]',
    "offline:pending_invoices": JSON.stringify([invoice]),
    "offline:cache:dashboard": JSON.stringify(dashboard),
    "scan:memory": '{"12345678":{"fields":{"name":"Legacy"}}}',
    "scan:pending": '{"12345678":{"name":"Legacy"}}',
    "scan:backfilled": "true",
    "vendora.recentSearches": '["legacy query"]',
  };
  await AsyncStorage.multiSet(Object.entries(legacy));
  await login("A");
  fetchMock.mockResolvedValueOnce(response({ items: [customer] }));
  await expect(api.listCustomers()).resolves.toEqual([customer]);
  await offline.cacheItemFromServer(item);
  await offline.cacheDashboard(dashboard);
  const pendingInvoice = await offline.queueCreateInvoice(invoice);
  await offline.queueQuickSale(sale);
  await scan.rememberScan("12345678", { name: "Scan A" }, { online: false });
  const backfill = jest.fn(async () => ({ created: 0, updated: 0, skipped: 0 }));
  const learn = jest.fn(async () => undefined);
  const remote = { lookup: jest.fn(), download: jest.fn(async () => []), backfill, learn };
  await expect(scan.backfillScanMemoryOnce(remote)).resolves.toBe(true);
  await recent.addRecentSearch("private query A");

  fetchMock.mockResolvedValueOnce(response({ message: "Signed out" }));
  await api.logoutSession();
  await login("B");
  mockOnline = false;
  fetchMock.mockRejectedValue(new TypeError("offline"));
  await expect(api.listCustomers()).rejects.toThrow("offline");
  await expect(api.listItems()).resolves.toMatchObject({ items: [] });
  await expect(api.listInvoices()).resolves.toMatchObject({ items: [] });
  await expect(api.getInvoice(pendingInvoice.id)).rejects.toThrow(/synced or was removed/);
  await expect(api.getDashboard()).rejects.toThrow("offline");
  await expect(offline.getSyncState()).resolves.toEqual({ pending: 0, failed: 0, lastSync: null });
  await expect(scan.resolveScan("12345678", { online: false })).resolves.toMatchObject({ match: null });
  await expect(scan.flushScanLearning(remote)).resolves.toBe(0);
  expect(learn).not.toHaveBeenCalled();
  await expect(scan.backfillScanMemoryOnce(remote)).resolves.toBe(true);
  expect(backfill).toHaveBeenCalledTimes(2);
  await expect(recent.getRecentSearches()).resolves.toEqual([]);
  mockOnline = true;
  fetchMock.mockClear();
  await offline.flushOutbox();
  expect(fetchMock).not.toHaveBeenCalled();

  await login("A");
  mockOnline = false;
  await expect(api.listCustomers("buyer")).resolves.toEqual([customer]);
  await expect(api.getItem(item.id)).resolves.toMatchObject({ quantity: 1 });
  await expect(api.getInvoice(pendingInvoice.id)).resolves.toMatchObject({ customer_name: invoice.customer_name });
  await expect(api.getDashboard()).resolves.toEqual(dashboard);
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 2 });
  await expect(scan.resolveScan("12345678", { online: false })).resolves.toMatchObject({ fields: { name: "Scan A" } });
  await expect(scan.flushScanLearning(remote)).resolves.toBe(1);
  await expect(recent.getRecentSearches()).resolves.toEqual(["private query A"]);
  await expect(AsyncStorage.multiGet(Object.keys(legacy))).resolves.toEqual(Object.entries(legacy));
});

it("restores an offline profile only with the matching stored token and reopens its journal", async () => {
  await login("A");
  fetchMock.mockResolvedValueOnce(response(user("A")));
  await api.getMe();
  await offline.queueSaleOrder(order);
  // Simulate reinitializing the session with only persisted storage.
  replaceSession();
  fetchMock.mockRejectedValue(new TypeError("offline"));
  await expect(api.getMe()).rejects.toThrow("offline");
  const cached = await api.getCachedUser();
  expect(cached).toEqual(user("A"));
  replaceSession(cached!.id);
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 1 });

  await api.setSession(token("B"), "refresh-B");
  await AsyncStorage.setItem("vendora_cached_user", JSON.stringify(user("A")));
  await expect(api.getCachedUser()).resolves.toBeNull();
  await AsyncStorage.setItem("vendora_cached_user", JSON.stringify(user("B")));
  await expect(api.getCachedUser()).resolves.toEqual(user("B"));
});

it("rejects a late customer response before it can display or cache A data", async () => {
  await login("A");
  const sent = deferred<void>();
  const reply = deferred<Response>();
  fetchMock.mockImplementationOnce(() => { sent.resolve(); return reply.promise; });
  const oldRequest = api.listCustomers();
  const failure = expect(oldRequest).rejects.toMatchObject({ name: "SessionChangedError" });
  await sent.promise;
  await login("B");
  reply.resolve(response({ items: [customer] }));
  await failure;
  await expect(AsyncStorage.getItem(accountKey("B", "offline:customers"))).resolves.toBeNull();
  fetchMock.mockResolvedValueOnce(response({ items: [{ ...customer, id: "b-customer", name: "B" }] }));
  await expect(api.listCustomers()).resolves.toEqual([expect.objectContaining({ id: "b-customer" })]);
});

it("rejects a late failed A sale instead of falling through to B's outbox", async () => {
  await login("A");
  const sent = deferred<void>();
  const reply = deferred<Response>();
  fetchMock.mockImplementationOnce(() => { sent.resolve(); return reply.promise; });
  const failure = expect(api.createSaleOrder(order)).rejects.toMatchObject({ name: "SessionChangedError" });
  await sent.promise;
  await login("B");
  reply.reject(new TypeError("response lost"));
  await failure;
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
  await expect(AsyncStorage.getItem(journalKey)).resolves.toBeNull();
});

it.each([200, 401])("a late refresh response (%s) cannot overwrite or sign out B", async (status) => {
  await login("A");
  const unauthorized = jest.fn();
  api.onUnauthorized(unauthorized);
  const refreshing = deferred<void>();
  const reply = deferred<Response>();
  fetchMock
    .mockResolvedValueOnce(response({ detail: "expired" }, 401))
    .mockImplementationOnce(() => { refreshing.resolve(); return reply.promise; });
  const failure = expect(api.getMe()).rejects.toMatchObject({ name: "SessionChangedError" });
  await refreshing.promise;
  await login("B");
  reply.resolve(response({ access_token: token("A"), refresh_token: "late-A" }, status));
  await failure;
  expect(await api.getToken()).toBe(token("B"));
  expect(await api.getRefreshToken()).toBe("refresh-B");
  expect(captureSession().ownerId).toBe("B");
  expect(unauthorized).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps A's mounted browser session separate from B's shared-storage login and logout", async () => {
  const platform = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "web" });
  try {
    await login("A");
    const aKey = (await AsyncStorage.getItem("vendora_active_credentials"))!;
    const bKey = "vendora_credentials_other_tab";
    const bPair = JSON.stringify({ accessToken: token("B"), refreshToken: "refresh-B" });
    // Simulate another tab changing shared storage without changing this
    // runtime's immutable auth generation.
    await AsyncStorage.setItem(bKey, bPair);
    await AsyncStorage.setItem("vendora_active_credentials", bKey);
    fetchMock
      .mockResolvedValueOnce(response({ detail: "expired" }, 401))
      .mockResolvedValueOnce(response({ access_token: token("A", "rotated"), refresh_token: "new-A" }))
      .mockResolvedValueOnce(response(user("A")))
      .mockResolvedValueOnce(response({ message: "signed out" }));
    await expect(api.getMe()).resolves.toEqual(user("A"));
    const [first, refresh, retry] = fetchMock.mock.calls;
    expect(first[1]?.headers).toMatchObject({ Authorization: `Bearer ${token("A")}` });
    expect(JSON.parse(String(refresh[1]?.body))).toEqual({ refresh_token: "refresh-A" });
    expect(retry[1]?.headers).toMatchObject({ Authorization: `Bearer ${token("A", "rotated")}` });
    await api.logoutSession();
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ refresh_token: "new-A" });
    await expect(AsyncStorage.getItem(aKey)).resolves.toBeNull();
    await expect(AsyncStorage.getItem("vendora_active_credentials")).resolves.toBe(bKey);
    await expect(AsyncStorage.getItem(bKey)).resolves.toBe(bPair);
    replaceSession();
    await expect(api.getToken()).resolves.toBe(token("B"));
  } finally {
    Object.defineProperty(Platform, "OS", { configurable: true, value: platform });
  }
});

it("never replays the next A entry with B credentials when a flush is already sending", async () => {
  await login("A");
  await offline.queueQuickSale(sale);
  await offline.queueSaleOrder(order);
  const sent = deferred<void>();
  const reply = deferred<Response>();
  fetchMock.mockImplementationOnce(() => { sent.resolve(); return reply.promise; });
  const aFlush = offline.flushOutbox();
  await sent.promise;
  await login("B");
  await offline.queueQuickSale({ ...sale, item_id: "b-item" });
  fetchMock.mockResolvedValueOnce(response({ id: "b-sale" }));
  await offline.flushOutbox();
  reply.resolve(response({ id: "a-sale" }));
  await aFlush;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([, options]) => [
    (options?.headers as Record<string, string>).Authorization,
    JSON.parse(String(options?.body)).item_id,
  ])).toEqual([[`Bearer ${token("A")}`, "a-item"], [`Bearer ${token("B")}`, "b-item"]]);
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
  await login("A");
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 2 });
  fetchMock.mockResolvedValue(response({ id: "a-sale" }));
  await offline.flushOutbox();
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
});

it("keeps a scan correction appended during a send and cancels old-account downloads", async () => {
  await login("A");
  await scan.rememberScan("12345678", { name: "first" }, { online: false });
  const sending = deferred<void>();
  const reply = deferred<void>();
  const learn = jest.fn(() => { sending.resolve(); return reply.promise; });
  const remote = { lookup: jest.fn(), download: jest.fn(async () => []), learn };
  const flushing = scan.flushScanLearning(remote);
  await sending.promise;
  await scan.rememberScan("12345678", { name: "correction" }, { online: false });
  reply.resolve();
  await flushing;
  await expect(scan.flushScanLearning(remote)).resolves.toBe(1);
  expect(learn).toHaveBeenLastCalledWith("12345678", { name: "correction" });

  const downloading = deferred<void>();
  const rows = deferred<scan.ScanResolution[]>();
  const syncing = scan.syncScanMemory({ ...remote, download: () => { downloading.resolve(); return rows.promise; } });
  const failure = expect(syncing).rejects.toMatchObject({ name: "SessionChangedError" });
  await downloading.promise;
  await login("B");
  rows.resolve([{ barcode: "87654321", match: "memory", fields: { name: "A only" }, times_seen: 1 }]);
  await failure;
  await expect(scan.resolveScan("87654321", { online: false })).resolves.toMatchObject({ match: null });
});

it("reports storage rejection and never shows a phantom receipt, invoice, or stock change", async () => {
  await login("A");
  await offline.cacheItemFromServer(item);
  mockOnline = false;
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
  await expect(api.createSaleOrder(order)).rejects.toMatchObject({ name: "OfflineStorageError" });
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
  await expect(api.createInvoice(invoice)).rejects.toMatchObject({ name: "OfflineStorageError" });
  (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error("read failed"));
  await expect(api.createTransaction(sale)).rejects.toMatchObject({ name: "OfflineStorageError" });
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
  await expect(api.getItem(item.id)).resolves.toMatchObject({ quantity: 2 });
  await expect(api.listInvoices()).resolves.toMatchObject({ items: [] });
  await expect(api.createSaleOrder(order)).resolves.toMatchObject({ pending: true });
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 1 });
});

it("persists the temp-ID remap across reconnect and preserves an enqueue made during the send", async () => {
  await login("A");
  const local = await offline.queueCreateItem({ name: "New item", quantity: 2 });
  const sent = deferred<void>();
  const reply = deferred<Response>();
  fetchMock.mockImplementationOnce(() => { sent.resolve(); return reply.promise; });
  const flushing = offline.flushOutbox();
  await sent.promise;
  await offline.queueSaleOrder({ ...order, lines: [{ ...order.lines[0], item_id: local.id }] });
  fetchMock.mockRejectedValueOnce(new TypeError("reconnect later"));
  reply.resolve(response({ ...item, quantity: 2 }));
  await flushing;
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 1 });
  const persisted = JSON.parse((await AsyncStorage.getItem(journalKey))!);
  expect(persisted.remap).toEqual({ [local.id]: item.id });

  await login("A");
  fetchMock.mockResolvedValueOnce(response({ id: "sale" }));
  await offline.flushOutbox();
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).lines[0].item_id).toBe(item.id);
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
  await expect(offline.offlineGetItem(local.id)).resolves.toMatchObject({ id: item.id, quantity: 1 });
});

it.each([
  ["quick sale", () => api.createTransaction(sale), "pending_sync"],
  ["order", () => api.createSaleOrder(order), undefined],
] as const)("reuses one %s id after response loss and a failed acknowledgment", async (_name, submit, status) => {
  await login("A");
  const serverReceipts = new Set<string>();
  const observed: string[] = [];
  fetchMock.mockImplementation(async (_url, options) => {
    const key = JSON.parse(String(options?.body)).client_request_id as string;
    observed.push(key);
    serverReceipts.add(key);
    if (observed.length === 1) throw new TypeError("lost response after commit");
    return response({ id: "original" });
  });
  const receipt = await submit();
  if (status) expect(receipt).toMatchObject({ status });
  else expect(receipt).toMatchObject({ pending: true });
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error("ack write failed"));
  await expect(offline.flushOutbox()).rejects.toMatchObject({ name: "OfflineStorageError" });
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 1 });
  await offline.flushOutbox();
  expect(observed).toEqual([expect.any(String), observed[0], observed[0]]);
  expect(serverReceipts.size).toBe(1);
  await expect(offline.getSyncState()).resolves.toMatchObject({ pending: 0 });
});
