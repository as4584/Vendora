/**
 * Always-visible sync status for the Home screen, so people can see their
 * offline work made it: "All synced · 2m ago", "Offline · 3 changes saved on
 * this phone", or a red "didn't sync" that opens the sync issues screen.
 */
import { Text, TouchableOpacity, View, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useNetwork } from "../context/network";
import { syncSummary, type SyncTone } from "../utils/syncStatus";
import { COLORS, FONT_SCALE } from "../theme/tokens";

const TONE_COLORS: Record<SyncTone, string> = {
  success: COLORS.success,
  info: COLORS.info,
  warning: COLORS.warning,
  danger: COLORS.danger,
};

export function SyncStatusPill() {
  const router = useRouter();
  const net = useNetwork();
  const { tone, label } = syncSummary(net);
  const color = TONE_COLORS[tone];
  return (
    <TouchableOpacity
      testID="sync-status-pill"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push("/sync-issues")}
      style={[styles.pill, { borderColor: color }]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6,
    borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: 6,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
});
