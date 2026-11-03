/**
 * Smart scan: on-device label parsing + barcode memory. No outside services.
 */
import { parseBoxLabel } from "../services/smartScan/parseLabel";

let AsyncStorage: any;

// Text lines as Apple Vision returns them for real-world box labels.
const NIKE_DUNK = [
  "NIKE DUNK LOW RETRO",
  "WHITE/BLACK-WHITE",
  "DD1391-100",
  "US 10 UK 9 EUR 44 CM 28",
  "MADE IN VIETNAM",
  "195866137738",
];
const JORDAN_4 = ["AIR JORDAN 4 RETRO", "BLACK/CEMENT GREY-SUMMIT WHITE", "FV5029 006", "US M 9.5", "EUR 43"];
const ADIDAS_SAMBA = ["adidas", "SAMBA OG", "ART. B75806", "UK 8 US 8.5 FR 42", "FTWWHT/CBLACK/GUM5"];
const NB_9060 = ["NEW BALANCE", "U9060AAA", "9060", "SIZE 11", "MADE IN VIETNAM"];
const KIDS = ["NIKE AIR FORCE 1 LE (GS)", "WHITE/WHITE", "DH2920-111", "US 5.5Y"];

describe("parseBoxLabel", () => {
  it("reads a Nike label", () => {
    expect(parseBoxLabel(NIKE_DUNK)).toEqual({
      brand: "Nike",
      style_code: "DD1391-100",
      sku: "DD1391-100",
      size: "10",
      color: "White/Black-White",
      name: "Nike Dunk Low Retro",
      category: "Sneakers",
    });
  });

  it("joins a space-separated Jordan style code and reads men's size", () => {
    const out = parseBoxLabel(JORDAN_4);
    expect(out).toMatchObject({ brand: "Jordan", style_code: "FV5029-006", size: "9.5", name: "Air Jordan 4 Retro" });
    expect(out.color).toBe("Black/Cement Grey-Summit White");
  });

  it("reads an adidas article number and US size, not UK", () => {
    expect(parseBoxLabel(ADIDAS_SAMBA)).toMatchObject({
      brand: "adidas", style_code: "B75806", size: "8.5", name: "adidas Samba OG",
    });
  });

  it("reads a New Balance style and SIZE line", () => {
    expect(parseBoxLabel(NB_9060)).toMatchObject({ brand: "New Balance", style_code: "U9060AAA", size: "11" });
  });

  it("keeps kids sizing", () => {
    expect(parseBoxLabel(KIDS)).toMatchObject({ size: "5.5Y", style_code: "DH2920-111", name: "Nike Air Force 1 Le (GS)" });
  });

  it("returns nothing for empty or junk text instead of guessing", () => {
    expect(parseBoxLabel([])).toEqual({});
    expect(parseBoxLabel(["12345", "MADE IN CHINA"])).toEqual({});
  });

  it("does not invent a category without a brand and size", () => {
    expect(parseBoxLabel(["VINTAGE LEATHER WALLET"]).category).toBeUndefined();
  });
});

describe("scan memory", () => {
  let memory: typeof import("../services/smartScan/memory");

  beforeEach(async () => {
    jest.resetModules();
    AsyncStorage = require("@react-native-async-storage/async-storage").default;
    await AsyncStorage.clear();
    memory = require("../services/smartScan/memory");
  });

  const remote = (overrides: Partial<import("../services/smartScan/memory").ScanRemote> = {}) => ({
    lookup: jest.fn(async (barcode: string) => ({ barcode, match: null, fields: {}, times_seen: 0 })),
    learn: jest.fn(async () => ({})),
    download: jest.fn(async () => []),
    ...overrides,
  });

  it("treats UPC-A and its EAN-13 form as the same barcode", () => {
    expect(memory.normalizeBarcode("0195866137738")).toBe("195866137738");
    expect(memory.normalizeBarcode(" 1958-6613 7738 ")).toBe("195866137738");
  });

  it("remembers a save offline and fills it next scan with no network", async () => {
    await memory.rememberScan("195866137738", { name: "Nike Dunk Low", size: "10" }, { online: false });
    const hit = await memory.resolveScan("0195866137738", { online: false });
    expect(hit).toMatchObject({ match: "memory", fields: { name: "Nike Dunk Low", size: "10" }, times_seen: 1 });
  });

  it("a correction replaces the old answer", async () => {
    await memory.rememberScan("195866137738", { name: "Dunk" }, { online: false });
    await memory.rememberScan("195866137738", { name: "Nike Dunk Low Panda" }, { online: false });
    const hit = await memory.resolveScan("195866137738", { online: false });
    expect(hit.fields.name).toBe("Nike Dunk Low Panda");
    expect(hit.times_seen).toBe(2);
  });

  it("fills a new size of a known shoe from its style code, minus the size", async () => {
    await memory.rememberScan("195866137738", { name: "Nike Dunk Low", style_code: "dd1391-100", size: "10" }, { online: false });
    const hit = await memory.resolveScan("195866137745", { online: false, styleCode: "DD1391-100" });
    expect(hit.match).toBe("style");
    expect(hit.fields).toEqual({ name: "Nike Dunk Low", style_code: "DD1391-100" });
  });

  it("asks the account when the phone does not know, and caches the answer", async () => {
    const r = remote({
      lookup: jest.fn(async (barcode: string) => ({ barcode, match: "memory" as const, fields: { name: "From account" }, times_seen: 3 })),
    });
    expect((await memory.resolveScan("12345678", { online: true, remote: r })).fields.name).toBe("From account");
    const offline = await memory.resolveScan("12345678", { online: false });
    expect(offline.match).toBe("memory");
  });

  it("falls back to the phone if the account lookup fails", async () => {
    const r = remote({ lookup: jest.fn(async () => { throw new Error("network"); }) });
    expect((await memory.resolveScan("12345678", { online: true, remote: r })).match).toBeNull();
  });

  it("queues offline saves and pushes them when back online", async () => {
    await memory.rememberScan("12345678", { name: "A" }, { online: false });
    const r = remote();
    expect(await memory.flushScanLearning(r)).toBe(1);
    expect(r.learn).toHaveBeenCalledWith("12345678", { name: "A" });
    expect(await memory.flushScanLearning(r)).toBe(0);
  });

  it("keeps a save queued on a network error, drops it on a 4xx", async () => {
    await memory.rememberScan("12345678", { name: "A" }, { online: false });
    await memory.flushScanLearning(remote({ learn: jest.fn(async () => { throw new Error("offline"); }) }));
    const bad = remote({ learn: jest.fn(async () => { throw Object.assign(new Error("bad"), { status: 422 }); }) });
    expect(await memory.flushScanLearning(bad)).toBe(0);
    const ok = remote();
    await memory.flushScanLearning(ok);
    expect(ok.learn).not.toHaveBeenCalled();
  });

  it("sync downloads the account but never overwrites an unsynced local save", async () => {
    await memory.rememberScan("11111111", { name: "Local edit" }, { online: false });
    const r = remote({
      learn: jest.fn(async () => { throw new Error("offline"); }),
      download: jest.fn(async () => [
        { barcode: "11111111", match: "memory" as const, fields: { name: "Old server" }, times_seen: 1 },
        { barcode: "22222222", match: "memory" as const, fields: { name: "Other phone" }, times_seen: 1 },
      ]),
    });
    await memory.syncScanMemory(r);
    expect((await memory.resolveScan("11111111", { online: false })).fields.name).toBe("Local edit");
    expect((await memory.resolveScan("22222222", { online: false })).fields.name).toBe("Other phone");
  });

  it("backfills from inventory once per device, then pulls the new memory", async () => {
    const backfill = jest.fn(async () => ({ created: 1, updated: 0, skipped: 0 }));
    const download = jest.fn(async () => [
      { barcode: "33333333", match: "memory" as const, fields: { name: "From inventory" }, times_seen: 1 },
    ]);
    const r = remote({ backfill, download });
    expect(await memory.backfillScanMemoryOnce(r)).toBe(true);
    expect(backfill).toHaveBeenCalledTimes(1);
    expect((await memory.resolveScan("33333333", { online: false })).fields.name).toBe("From inventory");
    expect(await memory.backfillScanMemoryOnce(r)).toBe(false);
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  it("retries the backfill next time when it fails", async () => {
    const backfill = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ created: 0, updated: 0, skipped: 0 });
    const r = remote({ backfill });
    await expect(memory.backfillScanMemoryOnce(r)).rejects.toThrow("offline");
    expect(await memory.backfillScanMemoryOnce(r)).toBe(true);
    expect(r.download).not.toHaveBeenCalled(); // nothing new to pull
  });

  it("ignores saves without a name or a usable barcode", async () => {
    await memory.rememberScan("123", { name: "Short" }, { online: false });
    await memory.rememberScan("12345678", { size: "10" }, { online: false });
    expect((await memory.resolveScan("12345678", { online: false })).match).toBeNull();
  });

  it("remembered fields beat what the label says", () => {
    expect(memory.mergeFields({ name: "My name" }, { name: "Label name", size: "10" })).toEqual({ name: "My name", size: "10" });
  });

  it("forget removes a barcode", async () => {
    await memory.rememberScan("12345678", { name: "A" }, { online: false });
    await memory.forgetScan("12345678");
    expect((await memory.resolveScan("12345678", { online: false })).match).toBeNull();
  });
});
