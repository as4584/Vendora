/**
 * Stability voting for the live scanner.
 *
 * Live OCR jitters: one frame reads "DD1391-100", the next "DD1391-10O".
 * A field is only accepted once the SAME value is seen in N consecutive
 * updates that mention that field. A frame where a field isn't read at all
 * (label half out of view) neither counts for nor against it. Once accepted
 * a value is kept unless a different value is itself seen N times in a row.
 */
import type { ScanFields } from "./parseLabel";

export type LiveField = "barcode" | keyof ScanFields;

export type LiveSnapshot = ScanFields & { barcode?: string };

export const DEFAULT_STABLE_FRAMES = 3;

/** Fields shown in the live checklist, in order. */
export const CHECKLIST: { field: LiveField; label: string }[] = [
  { field: "barcode", label: "Barcode" },
  { field: "name", label: "Name" },
  { field: "style_code", label: "Style code" },
  { field: "size", label: "Size" },
  { field: "color", label: "Color" },
];

type Streak = { value: string; count: number };

export interface FieldVoter {
  /** Feed one live update; returns every field accepted so far. */
  update(snapshot: LiveSnapshot): LiveSnapshot;
  /** Accepted fields so far. */
  stable(): LiveSnapshot;
  /** True once any frame has read a style code (so it becomes required). */
  sawStyle(): boolean;
  reset(): void;
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\s+/g, " ").trim();
  return v ? v : undefined;
}

export function createFieldVoter(frames: number = DEFAULT_STABLE_FRAMES): FieldVoter {
  const need = Math.max(1, Math.floor(frames));
  let streaks: Partial<Record<LiveField, Streak>> = {};
  let accepted: LiveSnapshot = {};
  let styleSeen = false;

  return {
    update(snapshot) {
      for (const [key, raw] of Object.entries(snapshot) as [LiveField, unknown][]) {
        const value = normalize(raw);
        if (!value) continue;
        if (key === "style_code") styleSeen = true;
        const streak = streaks[key];
        const next = streak && streak.value === value ? { value, count: streak.count + 1 } : { value, count: 1 };
        streaks[key] = next;
        if (next.count >= need) (accepted as Record<string, string>)[key] = value;
      }
      return { ...accepted };
    },
    stable: () => ({ ...accepted }),
    sawStyle: () => styleSeen,
    reset() {
      streaks = {};
      accepted = {};
      styleSeen = false;
    },
  };
}

/**
 * Enough to close the scanner on its own: barcode + name + size, plus the
 * style code whenever the label shows one.
 */
export function isScanComplete(stable: LiveSnapshot, styleSeen: boolean): boolean {
  if (!stable.barcode || !stable.name || !stable.size) return false;
  return styleSeen ? !!stable.style_code : true;
}
