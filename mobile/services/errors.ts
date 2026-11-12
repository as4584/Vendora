/**
 * Human-readable message from anything thrown, with a fallback for
 * empty/unknown errors.
 *
 * Order: a message the server wrote for people (detail.message) wins. Then
 * technical failures are translated into plain words (no "HTTP 500",
 * "Network request failed" or stack-ish text reaches a seller). Then any
 * other readable message, then the screen's own fallback.
 */
const NETWORK = /network request failed|failed to fetch|networkerror|load failed|timed? ?out|timeout|aborted|econn|enotfound|socket/i;
const TECHNICAL = /^(http \d{3}|internal server error|bad gateway|service unavailable|gateway time-?out|undefined|null|\[object object\]|unexpected token|json parse|syntaxerror|typeerror)/i;

export const FRIENDLY = {
  offline: "Can't reach Resqlo right now. Check your connection and try again.",
  server: "Resqlo had a hiccup on our side. Try again in a moment.",
  busy: "Too many tries at once. Wait a few seconds and try again.",
  session: "Your session expired. Sign in again to keep going.",
} as const;

function statusOf(err: unknown): number | undefined {
  const s = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : undefined;
}

function rawMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return undefined;
}

export function errorMessage(err: unknown, fallback: string): string {
  const detail = err && typeof err === "object" ? (err as { detail?: { message?: unknown } }).detail : undefined;
  if (detail && typeof detail.message === "string" && detail.message) return detail.message;

  const status = statusOf(err);
  if (status === 401) return FRIENDLY.session;
  if (status === 429) return FRIENDLY.busy;
  if (status !== undefined && status >= 500) return FRIENDLY.server;

  const msg = rawMessage(err);
  if (msg && NETWORK.test(msg)) return FRIENDLY.offline;
  if (msg && TECHNICAL.test(msg.trim())) return fallback;
  return msg || fallback;
}
