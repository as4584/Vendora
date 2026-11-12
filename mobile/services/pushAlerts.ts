/**
 * eBay sale alerts: the only push notification Vendora sends.
 * Permission is asked once, with an explanation first, and only after eBay is connected.
 */
import { Alert, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as api from "./api";

const askedKey = (userId: string) => `vendora.saleAlerts.asked.${userId}`;
let registeredToken: string | null = null;

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** Fetch this device's Expo token and send it to the backend. Needs permission already granted. */
async function register(): Promise<boolean> {
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: projectId() });
  await api.registerPushToken(token, Platform.OS);
  registeredToken = token;
  return true;
}

/** Silent: re-register if the user already allowed notifications (token can rotate). */
export async function syncPushToken(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === "granted" ? await register() : false;
  } catch {
    return false;
  }
}

/** Ask the system for permission and register. */
export async function enableSaleAlerts(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    return status === "granted" ? await register() : false;
  } catch {
    return false;
  }
}

/** One-time, explained prompt once the seller has eBay connected. */
export async function maybePromptSaleAlerts(userId: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    if ((await AsyncStorage.getItem(askedKey(userId))) === "1") return;
    const { status, canAskAgain } = await Notifications.getPermissionsAsync();
    if (status !== "undetermined" || !canAskAgain) return;
    const ebay = await api.getEbayStatus();
    if (!ebay.connected) return;
    await AsyncStorage.setItem(askedKey(userId), "1");
    Alert.alert(
      "Get a ping when something sells on eBay?",
      "We'll only notify you when an item sells on eBay. Nothing else.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Turn on", onPress: () => void enableSaleAlerts() },
      ],
    );
  } catch {
    // Never block the app over notifications.
  }
}

/** On sign-out, stop alerts to this device for this account. */
export async function unregisterPushToken(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (!token) return;
  try {
    await api.unregisterPushToken(token);
  } catch {
    // Best effort; the server also prunes dead tokens.
  }
}
