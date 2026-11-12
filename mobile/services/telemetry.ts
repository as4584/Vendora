/**
 * Crash reporting (Sentry, off unless EXPO_PUBLIC_SENTRY_DSN is set) and
 * first-party funnel events posted to our own backend. Both are fire-and-forget.
 */
import * as Sentry from "@sentry/react-native";

export type ClientEvent =
  | "app_open"
  | "onboarding_step"
  | "onboarding_dismissed"
  | "paywall_view"
  | "purchase_start"
  | "purchase_success"
  | "purchase_cancel"
  | "purchase_error"
  | "trial_start"
  | "rating_prompt_shown"
  | "scan_used";

type Props = Record<string, string | number | boolean | null>;

let sentryOn = false;

export function initCrashReporting(dsn: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN): boolean {
  if (!dsn || sentryOn) return sentryOn;
  Sentry.init({ dsn, sendDefaultPii: false, tracesSampleRate: 0, enableAutoSessionTracking: true });
  sentryOn = true;
  return true;
}

export function identify(userId: string | null): void {
  if (sentryOn) Sentry.setUser(userId ? { id: userId } : null);
}

export function reportError(err: unknown, context?: string): void {
  if (sentryOn) Sentry.captureException(err, context ? { tags: { context } } : undefined);
}

export function track(name: ClientEvent, props?: Props): void {
  try {
    // Required lazily so importing telemetry never drags the API/offline stack into the root layout.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { request } = require("./api") as typeof import("./api");
    request("/events", { method: "POST", body: JSON.stringify({ name, props: props ?? null }) }).catch(() => {});
  } catch {
    // Analytics must never break the app.
  }
}
