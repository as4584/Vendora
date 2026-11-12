/**
 * Styles resolve against one palette at launch (see tokens.ts). If the phone
 * switches light/dark while Resqlo is in the background, reload the JS bundle
 * the next time the app comes to the front, so every screen repaints in the
 * new mode. Never reloads while the app is in use (mid-sale, mid-scan).
 */
import { useEffect } from "react";
import { Appearance, AppState, DevSettings } from "react-native";
import { SCHEME, type Scheme } from "./tokens";

export function currentScheme(): Scheme {
  return Appearance.getColorScheme() === "light" ? "light" : "dark";
}

async function reloadApp() {
  if (__DEV__) {
    DevSettings.reload();
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require("expo-updates") as typeof import("expo-updates");
    await Updates.reloadAsync();
  } catch {
    // No reload available (e.g. web): the new mode applies on next launch.
  }
}

export function useSchemeReload() {
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && currentScheme() !== SCHEME) void reloadApp();
    });
    return () => sub.remove();
  }, []);
}
