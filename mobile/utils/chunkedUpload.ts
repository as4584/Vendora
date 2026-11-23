import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

/** Files above this go up in chunks; Cloudflare refuses one request over 100 MB. */
export const DIRECT_UPLOAD_LIMIT = 80 * 1024 * 1024;

/** Read `length` bytes at `offset` from a picked file as base64. */
export async function readBase64Chunk(uri: string, offset: number, length: number): Promise<string> {
  if (Platform.OS === "web") {
    const blob = await fetch(uri).then((response) => response.blob());
    return blobToBase64(blob.slice(offset, offset + length));
  }
  return FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position: offset,
    length,
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
