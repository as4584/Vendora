/**
 * Required first-run setup: a brand-new seller must get inventory in (import
 * a spreadsheet or add/scan a first item) before using the app, so the first
 * session ends with real value on screen. The free trial is unchanged.
 *
 * "Needed" = no completion flag on this device AND the account has 0 items.
 * Accounts that already have inventory are marked done silently.
 * Network trouble never traps anyone: if we can't tell, we don't force it.
 */
import * as api from "./api";

export type OnboardingState = "unknown" | "needed" | "done";

/* eslint-disable @typescript-eslint/no-require-imports */
const storage = () =>
  (require("@react-native-async-storage/async-storage") as typeof import("@react-native-async-storage/async-storage")).default;
/* eslint-enable @typescript-eslint/no-require-imports */

const doneKey = (userId: string) => `vendora.onboarded.${userId}`;
const listeners = new Set<(s: OnboardingState) => void>();

export function subscribeOnboarding(cb: (s: OnboardingState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function markOnboarded(userId: string): Promise<void> {
  try {
    await storage().setItem(doneKey(userId), "1");
  } catch {
    // Non-fatal: they have items now, so the next check passes anyway.
  }
  listeners.forEach((cb) => cb("done"));
}

export async function checkOnboarding(userId: string): Promise<OnboardingState> {
  try {
    if ((await storage().getItem(doneKey(userId))) === "1") return "done";
  } catch {
    // Fall through to the server check.
  }
  try {
    const page = await api.listItems({ perPage: 1 });
    if (page.total > 0) {
      await markOnboarded(userId);
      return "done";
    }
    return "needed";
  } catch {
    return "done";
  }
}

/** Screens a seller may use while setup is required (where items get added). */
export function allowedDuringOnboarding(segments: string[]): boolean {
  if (segments[0] === "onboarding" || segments[0] === "(auth)") return true;
  return segments[0] === "(tabs)" && segments[1] === "inventory" && ["add", "import", "batch-scan"].includes(segments[2] ?? "");
}
