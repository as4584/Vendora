/**
 * On-device label reader (Apple Vision / VisionKit).
 *
 * - `readLabelText(uri)`: text lines printed on a captured box label photo.
 * - `LiveScannerView`: live camera view (VisionKit DataScannerViewController)
 *   that streams the barcode + label text it currently sees.
 *
 * Missing on web, Android and Expo Go: callers must handle
 * `isLabelReaderAvailable() === false` / `isLiveScanAvailable() === false`
 * and fall back (tap-to-read, or let the seller type).
 */
import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";

type LabelReaderNative = {
  isAvailable: boolean;
  recognize(uri: string): Promise<string[]>;
  isLiveScanAvailable?: () => Promise<boolean>;
};

export type LiveScanLinesEvent = { nativeEvent: { lines: string[]; barcodes: string[] } };
export type LiveScanErrorEvent = {
  nativeEvent: { code: "unsupported" | "permission" | "unavailable" | "start_failed"; message: string };
};

export type LiveScannerViewProps = ViewProps & {
  active?: boolean;
  onLines?: (event: LiveScanLinesEvent) => void;
  onScanError?: (event: LiveScanErrorEvent) => void;
};

const native = requireOptionalNativeModule<LabelReaderNative>("LabelReader");

export function isLabelReaderAvailable(): boolean {
  return !!native?.isAvailable;
}

export async function readLabelText(uri: string): Promise<string[]> {
  if (!native) return [];
  return native.recognize(uri);
}

/** Live scanning needs iOS 16+, an A12 chip or newer, and camera access. */
export async function isLiveScanAvailable(): Promise<boolean> {
  if (!native?.isLiveScanAvailable) return false;
  try {
    return await native.isLiveScanAvailable();
  } catch {
    return false;
  }
}

let liveView: ComponentType<LiveScannerViewProps> | null = null;

/** The native live scanner view, or null where the module isn't built in. */
export function getLiveScannerView(): ComponentType<LiveScannerViewProps> | null {
  if (!native?.isLiveScanAvailable) return null;
  if (!liveView) liveView = requireNativeViewManager<LiveScannerViewProps>("LabelReader");
  return liveView;
}
