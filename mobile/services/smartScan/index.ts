/**
 * Smart scan = barcode memory + on-device box label reading.
 * See docs/features/SMART_SCAN.md.
 */
import { isOnline } from "../offline";
import { request } from "../api";
import {
  getLiveScannerView,
  isLabelReaderAvailable,
  isLiveScanAvailable,
  readLabelText,
} from "../../modules/label-reader";
import { parseBoxLabel, type ScanFields } from "./parseLabel";

export {
  createFieldVoter,
  isScanComplete,
  CHECKLIST,
  DEFAULT_STABLE_FRAMES,
  type LiveSnapshot,
  type LiveField,
} from "./stability";
export { isLiveScanAvailable, getLiveScannerView };
import {
  mergeFields,
  rememberScan as rememberWith,
  resolveScan as resolveWith,
  syncScanMemory as syncWith,
  type ScanRemote,
  type ScanResolution,
} from "./memory";

export { parseBoxLabel, mergeFields, isLabelReaderAvailable };
export type { ScanFields, ScanResolution };

export const scanRemote: ScanRemote = {
  lookup(barcode, styleCode) {
    const params = new URLSearchParams({ barcode });
    if (styleCode) params.append("style_code", styleCode);
    return request<ScanResolution>(`/scan/lookup?${params}`);
  },
  learn(barcode, fields) {
    return request("/scan/learn", { method: "POST", body: JSON.stringify({ barcode, fields }) });
  },
  download() {
    return request<ScanResolution[]>("/scan/memory");
  },
};

export function resolveScan(barcode: string, styleCode?: string) {
  return resolveWith(barcode, { styleCode, online: isOnline(), remote: scanRemote });
}

export function rememberScan(barcode: string, fields: ScanFields) {
  return rememberWith(barcode, fields, { online: isOnline(), remote: scanRemote });
}

export function syncScanMemory() {
  return syncWith(scanRemote);
}

/** Read a label photo on the phone and merge it under anything remembered. */
export async function readLabel(photoUri: string, remembered: ScanFields = {}): Promise<ScanFields> {
  const lines = await readLabelText(photoUri);
  return mergeFields(remembered, parseBoxLabel(lines));
}
