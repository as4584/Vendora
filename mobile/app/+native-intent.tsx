/**
 * Rewrites incoming deep links before expo-router resolves them.
 *
 * Reset emails link to https://vendora.lexmakesit.com/reset-password#token=...
 * (Universal Link). The token lives in the URL fragment, which expo-router
 * ignores, so move it into the query string the reset screen reads.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
    try {
        const hashIndex = path.indexOf("#");
        if (hashIndex === -1 || !path.includes("reset-password")) return path;
        const token = new URLSearchParams(path.slice(hashIndex + 1)).get("token");
        if (!token) return path;
        return `/reset-password?token=${encodeURIComponent(token)}`;
    } catch {
        return path;
    }
}
