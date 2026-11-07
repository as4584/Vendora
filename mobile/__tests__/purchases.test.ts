/**
 * services/purchases.ts — RevenueCat wrapper (iOS in-app subscriptions).
 */
const mockSdk = {
  configure: jest.fn(),
  logIn: jest.fn(async () => ({})),
  logOut: jest.fn(async () => ({})),
  getOfferings: jest.fn(),
  purchasePackage: jest.fn(async () => ({})),
  restorePurchases: jest.fn(),
  showManageSubscriptions: jest.fn(async () => undefined),
};

jest.mock("react-native-purchases", () => ({ __esModule: true, default: mockSdk }), { virtual: true });

function pkg(id: string, productId: string, period: string | null, price = "$19.99") {
  return {
    identifier: id,
    product: { identifier: productId, title: `${productId} title`, priceString: price, subscriptionPeriod: period },
  };
}

function load(os: "ios" | "web" | "android", key = "appl_test", executionEnvironment = "standalone") {
  let mod: typeof import("../services/purchases");
  jest.resetModules();
  process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY = key;
  jest.doMock("react-native", () => ({ Platform: { OS: os } }));
  jest.doMock("expo-constants", () => ({ __esModule: true, default: { executionEnvironment } }));
  jest.isolateModules(() => {
    mod = require("../services/purchases");
  });
  return mod!;
}

beforeEach(() => {
  Object.values(mockSdk).forEach((fn) => (fn as jest.Mock).mockClear());
});

afterAll(() => {
  delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY;
});

describe("isAppleStorefront", () => {
  it("is true only on iOS, with or without a RevenueCat key", () => {
    expect(load("ios", "").isAppleStorefront()).toBe(true);
    expect(load("web").isAppleStorefront()).toBe(false);
    expect(load("android").isAppleStorefront()).toBe(false);
  });
});

describe("iapEnabled", () => {
  it("does not load native purchases or offer Stripe in Expo Go", async () => {
    const p = load("ios", "appl_test", "storeClient");
    expect(p.iapEnabled()).toBe(false);
    expect(p.isAppleStorefront()).toBe(true);
    await expect(p.restore("u1")).rejects.toThrow('not Expo Go');
    expect(mockSdk.restorePurchases).not.toHaveBeenCalled();
  });
  it("is on only for iOS with a key", () => {
    expect(load("ios").iapEnabled()).toBe(true);
    expect(load("web").iapEnabled()).toBe(false);
    expect(load("android").iapEnabled()).toBe(false);
    expect(load("ios", "").iapEnabled()).toBe(false);
  });
});

describe("ensureConfigured", () => {
  it("does nothing when IAP is off", async () => {
    await load("web").ensureConfigured("u1");
    expect(mockSdk.configure).not.toHaveBeenCalled();
  });

  it("configures once, then logs in only when the user changes", async () => {
    const p = load("ios");
    await p.ensureConfigured("u1");
    await p.ensureConfigured("u1");
    expect(mockSdk.configure).toHaveBeenCalledTimes(1);
    expect(mockSdk.configure).toHaveBeenCalledWith({ apiKey: "appl_test", appUserID: "u1" });
    expect(mockSdk.logIn).not.toHaveBeenCalled();
    await p.ensureConfigured("u2");
    expect(mockSdk.logIn).toHaveBeenCalledWith("u2");
  });
});

describe("loadPlans", () => {
  it("prefers the Vendora offering over the shared project's current one", async () => {
    mockSdk.getOfferings.mockResolvedValueOnce({
      all: {
        vendora_default: {
          availablePackages: [
            pkg("$rc_monthly", "com.vendora.pro.monthly", "P1M"),
            pkg("$rc_annual", "com.vendora.pro.yearly", "P1Y", "$199.99"),
            pkg("partner_monthly", "com.vendora.partner.monthly", null, "$24.99"),
          ],
        },
      },
      current: { availablePackages: [pkg("other", "com.other.app", "P1M")] },
    });
    const plans = await load("ios").loadPlans("u1");
    expect(plans.map((p) => [p.id, p.productId, p.period, p.price])).toEqual([
      ["$rc_monthly", "com.vendora.pro.monthly", "month", "$19.99"],
      ["$rc_annual", "com.vendora.pro.yearly", "year", "$199.99"],
      ["partner_monthly", "com.vendora.partner.monthly", "period", "$24.99"],
    ]);
  });

  it("falls back to current, then to no plans", async () => {
    const p = load("ios");
    mockSdk.getOfferings.mockResolvedValueOnce({ all: {}, current: { availablePackages: [pkg("m", "x", "P1M")] } });
    expect(await p.loadPlans("u1")).toHaveLength(1);
    mockSdk.getOfferings.mockResolvedValueOnce({ all: {}, current: null });
    expect(await p.loadPlans("u1")).toEqual([]);
  });
});

describe("buy", () => {
  const plan = { id: "m", productId: "x", title: "", price: "", period: "month", pkg: {} as any };

  it("returns true on purchase", async () => {
    expect(await load("ios").buy(plan)).toBe(true);
    expect(mockSdk.purchasePackage).toHaveBeenCalledWith(plan.pkg);
  });

  it("returns false when the user cancels the Apple sheet", async () => {
    mockSdk.purchasePackage.mockRejectedValueOnce({ userCancelled: true });
    expect(await load("ios").buy(plan)).toBe(false);
  });

  it("rethrows real errors", async () => {
    mockSdk.purchasePackage.mockRejectedValueOnce(new Error("store down"));
    await expect(load("ios").buy(plan)).rejects.toThrow("store down");
  });
});

describe("restore / manage / reset", () => {
  it("restore reports whether any entitlement is active", async () => {
    const p = load("ios");
    mockSdk.restorePurchases.mockResolvedValueOnce({ entitlements: { active: { pro: {} } } });
    expect(await p.restore("u1")).toBe(true);
    mockSdk.restorePurchases.mockResolvedValueOnce({ entitlements: { active: {} } });
    expect(await p.restore("u1")).toBe(false);
  });

  it("manageSubscriptions opens Apple's sheet", async () => {
    await load("ios").manageSubscriptions();
    expect(mockSdk.showManageSubscriptions).toHaveBeenCalled();
  });

  it("reset logs out only once configured, and tolerates an anonymous user", async () => {
    const p = load("ios");
    await p.resetPurchases();
    expect(mockSdk.logOut).not.toHaveBeenCalled();
    await p.ensureConfigured("u1");
    mockSdk.logOut.mockRejectedValueOnce(new Error("anonymous"));
    await p.resetPurchases();
    expect(mockSdk.logOut).toHaveBeenCalledTimes(1);
    // configured state cleared → next configure is a fresh configure, not logIn
    await p.ensureConfigured("u2");
    expect(mockSdk.logIn).not.toHaveBeenCalled();
  });
});
