/**
 * On-device label reader (Apple Vision). Returns the text lines printed on a
 * box label photo. Missing on web, Android and Expo Go: callers must handle
 * `isLabelReaderAvailable() === false` and let the seller type instead.
 */
import { requireOptionalNativeModule } from "expo-modules-core";

type LabelReaderNative = {
  isAvailable: boolean;
  recognize(uri: string): Promise<string[]>;
};

const native = requireOptionalNativeModule<LabelReaderNative>("LabelReader");

export function isLabelReaderAvailable(): boolean {
  return !!native?.isAvailable;
}

export async function readLabelText(uri: string): Promise<string[]> {
  if (!native) return [];
  return native.recognize(uri);
}
