/**
 * Background Sync Task
 *
 * Registered via expo-background-fetch + expo-task-manager.
 * When the OS wakes the app in the background, this task fires
 * triggerLightspeedSync() if the user has Lightspeed connected.
 *
 * IMPORTANT: TaskManager.defineTask MUST be called at the module
 * top level (not inside a component) before the app registers it.
 */
import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import { getLightspeedStatus, triggerLightspeedSync } from "../services/api";

export const BACKGROUND_SYNC_TASK = "VENDORA_LIGHTSPEED_SYNC";

// ── Define task at module scope ──────────────────────────────────────────────
// Wrapped in try/catch so it silently no-ops in Expo Go (native module unavailable).
try {
  TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
    try {
      const status = await getLightspeedStatus();
      if (!status.connected) {
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }
      const result = await triggerLightspeedSync();
      const hadWork = result.synced_items > 0 || result.synced_transactions > 0;
      return hadWork
        ? BackgroundFetch.BackgroundFetchResult.NewData
        : BackgroundFetch.BackgroundFetchResult.NoData;
    } catch {
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch {
  // Expo Go: background task native module not available — safe to ignore.
}

// ── Registration helper (call from a component after auth) ───────────────────
export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      console.warn("[BackgroundSync] Background fetch is restricted or denied.");
      return;
    }
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: 15 * 60,
        stopOnTerminate: false,
        startOnBoot: true,
      });
      console.log("[BackgroundSync] Task registered.");
    }
  } catch {
    // Expo Go: native module not available — no-op.
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
      console.log("[BackgroundSync] Task unregistered.");
    }
  } catch {
    // Expo Go: native module not available — no-op.
  }
}
