import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";
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

export async function openPdfFile(base64: string, filename: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    webDownloadBlob(base64ToPdfBlob(base64), filename);
    return;
  }

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
