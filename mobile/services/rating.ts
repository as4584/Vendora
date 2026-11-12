/**
 * App Store rating prompt. Asked only after a happy moment (a completed sale is closed),
 * once the seller has made a few sales, and at most every 120 days. Apple further limits
 * it to 3 showings a year and may decide not to show it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";
import { track } from "./telemetry";

const SALES_KEY = "vendora.rating.sales";
const ASKED_KEY = "vendora.rating.lastAsked";
export const SALES_BEFORE_ASK = 3;
export const ASK_INTERVAL_MS = 120 * 24 * 60 * 60 * 1000;

/** Count a completed, synced sale. */
export async function recordSale(): Promise<void> {
  try {
    const n = Number((await AsyncStorage.getItem(SALES_KEY)) ?? "0") || 0;
    await AsyncStorage.setItem(SALES_KEY, String(n + 1));
  } catch {
    // Storage unavailable: just don't count.
  }
}

/** Call when the seller closes a sale receipt. Returns true if Apple's prompt was requested. */
export async function maybeAskForRating(now: number = Date.now()): Promise<boolean> {
  try {
    const sales = Number((await AsyncStorage.getItem(SALES_KEY)) ?? "0") || 0;
    if (sales < SALES_BEFORE_ASK) return false;
    const last = Number((await AsyncStorage.getItem(ASKED_KEY)) ?? "0") || 0;
    if (last && now - last < ASK_INTERVAL_MS) return false;
    if (!(await StoreReview.isAvailableAsync()) || !(await StoreReview.hasAction())) return false;
    await AsyncStorage.setItem(ASKED_KEY, String(now));
    await StoreReview.requestReview();
    track("rating_prompt_shown", { sales });
    return true;
  } catch {
    return false;
  }
}
