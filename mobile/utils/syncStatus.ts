/** Pure helpers for the sync status pill and sync issues screen. */
import type { FailedSync } from "../services/offline";

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export type SyncTone = "success" | "info" | "warning" | "danger";

export function syncSummary(
  s: { online: boolean; pending: number; failed: number; lastSync: string | null },
  now = Date.now(),
): { tone: SyncTone; label: string } {
  const plural = (n: number) => (n === 1 ? "" : "s");
  if (s.failed > 0) return { tone: "danger", label: `${s.failed} change${plural(s.failed)} didn't sync · Review` };
  if (!s.online) {
    return s.pending > 0
      ? { tone: "warning", label: `Offline · ${s.pending} change${plural(s.pending)} saved on this phone` }
      : { tone: "warning", label: "Offline · new changes will be saved on this phone" };
  }
  if (s.pending > 0) return { tone: "info", label: `Syncing ${s.pending} change${plural(s.pending)}…` };
  const ago = timeAgo(s.lastSync, now);
  return { tone: "success", label: ago ? `All synced · ${ago}` : "All synced" };
}

const KIND_LABELS: Record<FailedSync["kind"], string> = {
  create_item: "New item",
  update_item: "Item edit",
  quick_sale: "Sale",
  sale_order: "Sale",
  create_invoice: "Invoice",
  trade: "Trade",
};

export function failedSyncLabel(kind: FailedSync["kind"]): string {
  return KIND_LABELS[kind] ?? "Change";
}
