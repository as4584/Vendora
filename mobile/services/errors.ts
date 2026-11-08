/** Server detail.message if present, else the error message, else the fallback.
 * Human-readable message from anything thrown, with a fallback for empty/unknown errors. */
export function errorMessage(err: unknown, fallback: string): string {
  const detail = err && typeof err === "object" ? (err as { detail?: { message?: unknown } }).detail : undefined;
  if (detail && typeof detail.message === "string" && detail.message) return detail.message;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}
