/**
 * "Undo" bar instead of "Are you sure?" popups: the action shows as done
 * right away, and is only sent to the server when the bar times out. Undo
 * puts things back with no network call at all.
 *
 *   const undo = useUndo();
 *   undo.run({ message: "Deleted Jordan 4", apply, revert, commit });
 *   <UndoBar state={undo} />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { COLORS, FONT_SCALE, RADII, SPACING, TYPE } from "../theme/tokens";
import { GlassBlur } from "./Backdrop";
import { Icon } from "./ui";

export const UNDO_MS = 5000;

export interface UndoAction {
  message: string;
  /** Change the screen now (e.g. hide the row). */
  apply: () => void;
  /** Put the screen back. */
  revert: () => void;
  /** Make it real (server call). Runs when the bar times out or is replaced. */
  commit: () => Promise<void>;
  /** Called if the commit fails, after revert. */
  onCommitError?: (err: unknown) => void;
}

export interface UndoState {
  pending: UndoAction | null;
  run: (action: UndoAction) => void;
  undo: () => void;
  /** Commit now (e.g. leaving the screen). */
  flush: () => void;
}

export function useUndo(timeoutMs = UNDO_MS): UndoState {
  const [pending, setPending] = useState<UndoAction | null>(null);
  const current = useRef<UndoAction | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setPending(null);
  };

  const flush = useCallback(() => {
    const action = current.current;
    if (!action) return;
    clear();
    action.commit().catch((err) => {
      action.revert();
      action.onCommitError?.(err);
    });
  }, []);

  const run = useCallback(
    (action: UndoAction) => {
      flush(); // one pending action at a time: the previous one becomes real
      action.apply();
      current.current = action;
      setPending(action);
      timer.current = setTimeout(flush, timeoutMs);
    },
    [flush, timeoutMs],
  );

  const undo = useCallback(() => {
    const action = current.current;
    if (!action) return;
    clear();
    action.revert();
  }, []);

  // Leaving the screen or backgrounding the app makes the pending action real.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") flush();
    });
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);

  return { pending, run, undo, flush };
}

export function UndoBar({ state, bottom = SPACING.md }: { state: UndoState; bottom?: number }) {
  if (!state.pending) return null;
  return (
    <View testID="undo-bar" accessibilityLiveRegion="polite" style={[styles.bar, { bottom }]}>
      <GlassBlur style={styles.blur} />
      <Icon name="checkmark-circle" size={18} color={COLORS.success} />
      <Text numberOfLines={2} style={styles.message}>{state.pending.message}</Text>
      <TouchableOpacity testID="undo-button" accessibilityRole="button" accessibilityLabel="Undo" onPress={state.undo} hitSlop={10} style={styles.undo}>
        <Text maxFontSizeMultiplier={FONT_SCALE.control} style={styles.undoText}>Undo</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: SPACING.md,
    right: SPACING.md,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingLeft: SPACING.md,
    paddingRight: SPACING.xs,
    minHeight: 52,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.bgElevated,
    overflow: "hidden",
  },
  blur: { borderRadius: RADII.pill },
  message: { ...TYPE.subhead, color: COLORS.text, flex: 1, fontWeight: "600" },
  undo: { minHeight: 44, minWidth: 64, paddingHorizontal: SPACING.md, alignItems: "center", justifyContent: "center", borderRadius: RADII.pill, backgroundColor: COLORS.primarySoft },
  undoText: { ...TYPE.callout, color: COLORS.primaryBright },
});
