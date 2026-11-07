/**
 * Apple in-app purchases via RevenueCat (iOS only).
 *
 * On iOS, Apple requires digital subscriptions to be sold through its own
 * payment sheet, so Pro/Partner are bought here. Web (and Android for now)
 * keep the Stripe checkout. Either way the backend sets the same tier:
 * RevenueCat calls POST /api/v1/webhooks/revenuecat with the Resqlo user id,
 * which we pass as the RevenueCat app user id.
 */
import { Platform } from "react-native";
import type { PurchasesPackage } from "react-native-purchases";

const IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || "";

export type StorePlan = {
  id: string;
  productId: string;
  title: string;
  price: string;
  /** e.g. "7-day free trial" when the product has a free intro offer. */
  trial?: string;
  period: string;
  pkg: PurchasesPackage;
};

export const VENDORA_OFFERING = "vendora_default";

let configuredFor: string | null = null;

export function iapEnabled(): boolean {
  return Platform.OS === "ios" && IOS_KEY.length > 0;
}

// Loaded lazily so web/Android bundles never touch the native module.
async function sdk(): Promise<typeof import("react-native-purchases").default> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("react-native-purchases").default;
}

export async function ensureConfigured(userId: string): Promise<void> {
  if (!iapEnabled()) return;
  const Purchases = await sdk();
  if (configuredFor === null) {
    Purchases.configure({ apiKey: IOS_KEY, appUserID: userId });
  } else if (configuredFor !== userId) {
    await Purchases.logIn(userId);
  }
  configuredFor = userId;
}

const PERIOD_LABEL: Record<string, string> = { P1M: "month", P1Y: "year" };

export async function loadPlans(userId: string): Promise<StorePlan[]> {
  await ensureConfigured(userId);
  const Purchases = await sdk();
  const offerings = await Purchases.getOfferings();
  // The RevenueCat project is shared with other apps, so this app uses
  // its own offering rather than the project's "current" one.
  const offering = offerings.all[VENDORA_OFFERING] ?? offerings.current;
  const pkgs = offering?.availablePackages ?? [];
  return pkgs.map((pkg) => ({
    id: pkg.identifier,
    productId: pkg.product.identifier,
    title: pkg.product.title,
    price: pkg.product.priceString,
    trial: trialLabel(pkg.product.introPrice),
    period: PERIOD_LABEL[pkg.product.subscriptionPeriod ?? ""] ?? "period",
    pkg,
  }));
}

/** Returns false if the user cancelled the Apple sheet. */
export async function buy(plan: StorePlan): Promise<boolean> {
  const Purchases = await sdk();
  try {
    await Purchases.purchasePackage(plan.pkg);
    return true;
  } catch (error: any) {
    if (error?.userCancelled) return false;
    throw error;
  }
}

export async function restore(userId: string): Promise<boolean> {
  await ensureConfigured(userId);
  const Purchases = await sdk();
  const info = await Purchases.restorePurchases();
  return Object.keys(info.entitlements.active).length > 0;
}

export async function manageSubscriptions(): Promise<void> {
  const Purchases = await sdk();
  await Purchases.showManageSubscriptions();
}

export async function resetPurchases(): Promise<void> {
  if (!iapEnabled() || configuredFor === null) return;
  try {
    const Purchases = await sdk();
    await Purchases.logOut();
  } catch {
    // Already anonymous; nothing to clear.
  }
  configuredFor = null;
}

const TRIAL_UNIT: Record<string, string> = { DAY: "day", WEEK: "week", MONTH: "month", YEAR: "year" };

/** Free intro offers only; paid intro prices are not called a trial. */
export function trialLabel(intro: any): string | undefined {
  if (!intro || Number(intro.price) !== 0) return undefined;
  const unit = TRIAL_UNIT[String(intro.periodUnit ?? "").toUpperCase()];
  const n = Number(intro.periodNumberOfUnits);
  if (!unit || !n) return undefined;
  return `${n}-${unit} free trial`;
}
