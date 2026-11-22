/** Price-label QR codes encode `resqlo:item:<id>` (see backend app/services/labels.py). */
export const LABEL_QR_PREFIX = "resqlo:item:";

/** The item id from a scanned label QR, or null for any other code. */
export function itemIdFromScan(data: string): string | null {
  const text = data.trim();
  if (!text.toLowerCase().startsWith(LABEL_QR_PREFIX)) return null;
  const id = text.slice(LABEL_QR_PREFIX.length).trim();
  return /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
}
