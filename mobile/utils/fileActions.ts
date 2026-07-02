import { Platform } from "react-native";
// Expo 54's top-level module uses the new File/Directory API. This helper
// intentionally uses the stable async URI API, which now lives under legacy.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

function webDownloadBlob(blob: Blob, filename: string, openInNewTab = false) {
  const objectUrl = URL.createObjectURL(blob);

  if (openInNewTab) {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } else {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function base64ToPdfBlob(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

export async function downloadTextFile(
  contents: string,
  filename: string,
  mimeType = "text/csv;charset=utf-8"
) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    webDownloadBlob(new Blob([contents], { type: mimeType }), filename);
    return;
  }

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error("File storage is not available on this device.");
  }

  const uri = `${baseDir}${filename}`;
  await FileSystem.writeAsStringAsync(uri, contents, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType,
      dialogTitle: filename,
    });
    return;
  }

  throw new Error("File sharing is not available on this device.");
}

async function writeOrSharePdf(base64: string, filename: string) {
  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error("File storage is not available on this device.");
  }

  const uri = `${baseDir}${filename}`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: filename,
      UTI: "com.adobe.pdf",
    });
    return;
  }

  throw new Error("PDF sharing is not available on this device.");
}

export async function previewPdfFile(base64: string, filename: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    webDownloadBlob(base64ToPdfBlob(base64), filename, true);
    return;
  }

  return writeOrSharePdf(base64, filename);
}

export async function downloadPdfFile(base64: string, filename: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    webDownloadBlob(base64ToPdfBlob(base64), filename);
    return;
  }

  return writeOrSharePdf(base64, filename);
}

export const openPdfFile = previewPdfFile;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Download an authenticated binary file (e.g. the .xlsx export with embedded
 * photos) straight to disk and hand it to the OS share sheet. Uses
 * FileSystem.downloadAsync on native so large binaries never pass through JS
 * as base64.
 */
export async function downloadAndShareRemote(
  url: string,
  filename: string,
  token: string | null,
  mimeType = XLSX_MIME,
) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  if (Platform.OS === "web" && typeof window !== "undefined") {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(errorForStatus(res.status));
    webDownloadBlob(await res.blob(), filename);
    return;
  }

  const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!baseDir) {
    throw new Error("File storage is not available on this device.");
  }

  const uri = `${baseDir}${filename}`;
  const result = await FileSystem.downloadAsync(url, uri, { headers });
  if (result.status >= 400) {
    throw new Error(errorForStatus(result.status));
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, { mimeType, dialogTitle: filename });
    return;
  }
  throw new Error("File sharing is not available on this device.");
}

function errorForStatus(status: number): string {
  if (status === 402 || status === 403) {
    return "Excel export with photos is a Pro feature — upgrade in Plans & Billing, or export CSV instead.";
  }
  return `Export failed (${status}).`;
}
