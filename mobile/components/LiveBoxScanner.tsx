/**
 * Live box scanner: camera reads the barcode and the label at once, a
 * checklist fills in as each field holds steady, and it closes on its own
 * once barcode + name + size (+ style code, when the label has one) are in.
 * All recognition is on the phone (VisionKit); nothing goes to a network.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, IconButton, triggerHaptic } from "./Button";
import { Icon } from "./ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";
import {
  CHECKLIST,
  createFieldVoter,
  getLiveScannerView,
  isScanComplete,
  parseBoxLabel,
  type LiveSnapshot,
} from "../services/smartScan";

export type LiveScanResult = LiveSnapshot;

// Resolved once: null on web / Android / Expo Go, where this never renders.
const NativeScanner = getLiveScannerView();

export function LiveBoxScanner({
  onFinish,
  onCancel,
  onUnavailable,
  stableFrames,
}: {
  /** Called once, with every field that held steady. */
  onFinish: (result: LiveScanResult) => void;
  onCancel: () => void;
  /** Native scanner can't run (permission, unsupported): fall back. */
  onUnavailable: (message: string) => void;
  stableFrames?: number;
}) {
  const insets = useSafeAreaInsets();
  const voter = useMemo(() => createFieldVoter(stableFrames), [stableFrames]);
  const [stable, setStable] = useState<LiveSnapshot>({});
  const [styleSeen, setStyleSeen] = useState(false);
  const finished = useRef(false);

  const finish = useCallback(
    (result: LiveSnapshot) => {
      if (finished.current) return;
      finished.current = true;
      onFinish(result);
    },
    [onFinish],
  );

  const onLines = useCallback(
    (event: { nativeEvent: { lines: string[]; barcodes: string[] } }) => {
      if (finished.current) return;
      const { lines = [], barcodes = [] } = event.nativeEvent ?? {};
      const snapshot: LiveSnapshot = { ...parseBoxLabel(lines) };
      if (barcodes[0]) snapshot.barcode = barcodes[0];
      const next = voter.update(snapshot);
      setStable(next);
      setStyleSeen(voter.sawStyle());
      if (isScanComplete(next, voter.sawStyle())) {
        triggerHaptic("success");
        finish(next);
      }
    },
    [voter, finish],
  );

  if (!NativeScanner) return null;

  const found = CHECKLIST.filter((c) => stable[c.field]).length;
  const required = CHECKLIST.filter(c => c.field !== "color" && (c.field !== "style_code" || styleSeen));
  const requiredFound = required.filter(c => stable[c.field]).length;
  const complete = isScanComplete(stable, styleSeen);

  return (
    <View style={styles.container} testID="live-box-scanner">
      <NativeScanner
        style={StyleSheet.absoluteFill}
        active
        onLines={onLines}
        onScanError={(e) => {
          if (!finished.current) onUnavailable(e.nativeEvent?.message ?? "Live scanning isn't available.");
        }}
      />
      <View style={[styles.top, { paddingTop: insets.top + SPACING.sm }]}>
        <IconButton icon="close" label="Cancel scan" variant="secondary" onPress={onCancel} />
        <Text style={styles.hint} numberOfLines={2}>
          Hold the box label and barcode in view
        </Text>
      </View>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]}>
        <Text accessibilityRole="header" style={styles.progressTitle}>
          {complete ? "Label ready" : "Reading your box"}
        </Text>
        <Text style={styles.progressCopy}>{requiredFound} of {required.length} required details found</Text>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Box label progress"
          accessibilityValue={{ min: 0, max: required.length, now: requiredFound }}
          style={styles.progressTrack}
        >
          <View style={[styles.progressFill, { width: `${requiredFound / required.length * 100}%` }]} />
        </View>
        <View style={styles.list} accessibilityLabel={`Found ${found} of ${CHECKLIST.length}`}>
          {CHECKLIST.map(({ field, label }) => {
            const value = stable[field];
            const optional = field === "color" || (field === "style_code" && !styleSeen);
            return (
              <View key={field} style={styles.row} testID={`live-check-${field}`}>
                <Icon
                  name={value ? "checkmark-circle" : "ellipse-outline"}
                  size={20}
                  color={value ? COLORS.success : COLORS.textSoft}
                />
                <Text style={styles.rowLabel}>{label}</Text>
                <Text style={[styles.rowValue, !value && styles.rowPending]} numberOfLines={1}>
                  {value ?? (optional ? "If shown" : "Looking...")}
                </Text>
              </View>
            );
          })}
        </View>
        <Text style={styles.progressCopy}>Hold steady, or tap Done to review what was found.</Text>
        <Button label="Done" size="lg" fullWidth onPress={() => finish(voter.stable())} haptic="success" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.canvas },
  top: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  hint: {
    ...TYPE.callout,
    flex: 1,
    minWidth: 0,
    color: COLORS.text,
    backgroundColor: COLORS.card,
    borderRadius: RADII.pill,
    overflow: "hidden",
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: SPACING.md,
    padding: SPACING.md,
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADII.lg,
    borderTopRightRadius: RADII.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  list: { gap: SPACING.xs },
  progressTitle: { ...TYPE.headline, color: COLORS.text },
  progressCopy: { ...TYPE.footnote, color: COLORS.textMuted },
  progressTrack: { height: 5, borderRadius: 3, overflow: "hidden", backgroundColor: COLORS.border },
  progressFill: { height: "100%", backgroundColor: COLORS.success },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, minHeight: 28 },
  rowLabel: { ...TYPE.footnote, color: COLORS.textMuted, width: 84 },
  rowValue: { ...TYPE.callout, color: COLORS.text, flex: 1, minWidth: 0, textAlign: "right" },
  rowPending: { color: COLORS.textSoft, fontWeight: "500" },
});
