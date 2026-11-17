/**
 * Skeleton loaders: gray placeholders in the shape of the content that is
 * coming, instead of a spinner. A slow pulse unless Reduce Motion is on.
 */
import { useEffect, useState } from "react";
import { Animated, StyleSheet, View, type DimensionValue, type ViewStyle } from "react-native";
import { COLORS, RADII, SPACING } from "../theme/tokens";
import { useReducedMotion } from "./useReducedMotion";

export function Bone({ width = "100%", height = 14, radius = 6, style }: { width?: DimensionValue; height?: number; radius?: number; style?: ViewStyle }) {
  return <View style={[{ width, height, borderRadius: radius, backgroundColor: COLORS.cardAlt }, style]} />;
}

function Pulse({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.55, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, opacity]);
  return (
    <Animated.View
      testID={testID}
      accessible
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
      style={[styles.fill, { opacity }]}
    >
      {children}
    </Animated.View>
  );
}

/** Inventory-style rows: photo square, two text lines, price. */
export function SkeletonList({ rows = 6, testID }: { rows?: number; testID?: string }) {
  return (
    <Pulse testID={testID}>
      <View style={styles.pad}>
        {Array.from({ length: rows }, (_, i) => (
          <View key={i} style={styles.row}>
            <Bone width={64} height={64} radius={RADII.md} />
            <View style={styles.rowText}>
              <Bone width="70%" height={16} />
              <Bone width="45%" />
              <Bone width="30%" />
            </View>
            <Bone width={56} height={16} />
          </View>
        ))}
      </View>
    </Pulse>
  );
}

/** Dashboard: greeting, hero number, 2x2 stat tiles, a chart card. */
export function SkeletonDashboard({ testID }: { testID?: string }) {
  return (
    <Pulse testID={testID}>
      <View style={styles.pad}>
        <Bone width="60%" height={26} />
        <Bone width="35%" style={styles.gapSm} />
        <View style={[styles.card, styles.gapLg]}>
          <Bone width="30%" />
          <Bone width="45%" height={36} style={styles.gapSm} />
        </View>
        <View style={styles.tiles}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.card, styles.tile]}>
              <Bone width="60%" />
              <Bone width="40%" height={24} style={styles.gapSm} />
            </View>
          ))}
        </View>
        <View style={[styles.card, styles.gapMd]}>
          <Bone width="40%" />
          <Bone height={90} radius={RADII.md} style={styles.gapSm} />
        </View>
      </View>
    </Pulse>
  );
}

/** Detail page: big photo, title lines, a metric strip, a few rows. */
export function SkeletonDetail({ testID }: { testID?: string }) {
  return (
    <Pulse testID={testID}>
      <View style={styles.pad}>
        <Bone width="80%" height={26} />
        <Bone width="40%" style={styles.gapSm} />
        <Bone height={220} radius={RADII.lg} style={styles.gapLg} />
        <View style={[styles.card, styles.gapMd, styles.strip]}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.stripCell}>
              <Bone width="70%" height={18} />
              <Bone width="50%" height={10} />
            </View>
          ))}
        </View>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.card, styles.gapMd]}>
            <Bone width="50%" />
            <Bone width="80%" style={styles.gapSm} />
          </View>
        ))}
      </View>
    </Pulse>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: COLORS.bg },
  pad: { padding: SPACING.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    padding: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  rowText: { flex: 1, gap: 8 },
  card: { backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.md },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginTop: SPACING.sm },
  tile: { flexBasis: "47%", flexGrow: 1 },
  strip: { flexDirection: "row", gap: SPACING.sm },
  stripCell: { flex: 1, gap: 6, alignItems: "center" },
  gapSm: { marginTop: SPACING.xs },
  gapMd: { marginTop: SPACING.sm },
  gapLg: { marginTop: SPACING.md },
});
