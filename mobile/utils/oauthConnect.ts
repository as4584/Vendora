/**
 * Open a provider's OAuth consent page and resolve when the seller is back.
 *
 * Native: an auth session that closes on the vendora://settings deep link.
 * Web: a popup. The backend callback (started with ?platform=web) answers
 * with a page that postMessages the opener, writes a localStorage event and
 * closes itself; we also notice the popup closing on its own.
 */
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";

export const OAUTH_MESSAGE_TYPE = "resqlo-oauth";
export const OAUTH_STORAGE_KEY = "resqlo-oauth";

export type ConnectOutcome = "connected" | "denied" | "closed";

const TIMEOUT_MS = 10 * 60 * 1000;

function outcomeOf(data: unknown): ConnectOutcome | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as { type?: unknown; status?: unknown };
  if (msg.type !== OAUTH_MESSAGE_TYPE) return null;
  return msg.status === "connected" ? "connected" : "denied";
}

export function waitForWebPopup(popup: Window, win: Window = window): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: ConnectOutcome) => {
      if (done) return;
      done = true;
      win.removeEventListener("message", onMessage);
      win.removeEventListener("storage", onStorage);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      const outcome = outcomeOf(event.data);
      if (outcome) finish(outcome);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== OAUTH_STORAGE_KEY || !event.newValue) return;
      try {
        const outcome = outcomeOf(JSON.parse(event.newValue));
        if (outcome) finish(outcome);
      } catch {
        // ignore malformed values
      }
    };
    win.addEventListener("message", onMessage);
    win.addEventListener("storage", onStorage);
    const poll = setInterval(() => {
      if (popup.closed) finish("closed");
    }, 500);
    const timer = setTimeout(() => finish("closed"), TIMEOUT_MS);
  });
}

export async function openProviderConnect(authorizationUrl: string): Promise<ConnectOutcome> {
  if (Platform.OS === "web") {
    const popup = window.open(authorizationUrl, "resqlo-oauth", "popup,width=520,height=720");
    if (!popup) {
      // Popup blocked: go in this tab; the callback page falls back to /settings.
      window.location.assign(authorizationUrl);
      return "closed";
    }
    return waitForWebPopup(popup);
  }
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, Linking.createURL("settings"));
  if (result.type !== "success") return "closed";
  return /status=connected/.test(result.url) ? "connected" : "denied";
}
