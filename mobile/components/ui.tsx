import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ViewStyle,
  TextStyle,
  ScrollView,
} from "react-native";
import { COLORS, RADII, SPACING } from "../theme/tokens";

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" style={styles.sectionLabel}>{children}</Text>;
}

export function HeaderTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.headerRow}>
      <View style={{ flex: 1 }}>
        <Text accessibilityRole="header" style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Pill({
  label,
  tone = "neutral",
  style,
  textStyle,
}: {
  label: string;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "info";
  style?: ViewStyle | ViewStyle[];
  textStyle?: TextStyle | TextStyle[];
}) {
  const palette = {
    neutral: { bg: COLORS.bgElevated, border: COLORS.border, text: COLORS.textMuted },
    primary: { bg: "#21193C", border: "#4D3CA9", text: "#C9BCFF" },
    success: { bg: "#123426", border: "#2B7C5A", text: "#9EE7C6" },
    warning: { bg: "#3E2B11", border: "#9B6D20", text: "#F6D38A" },
    danger: { bg: "#3A1C1A", border: "#94514A", text: "#F5B2AB" },
    info: { bg: "#182744", border: "#336FB5", text: "#AFCEFF" },
  }[tone];

  return (
    <View style={[styles.pill, { backgroundColor: palette.bg, borderColor: palette.border }, style]}>
      <Text style={[styles.pillText, { color: palette.text }, textStyle]}>{label}</Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  tone = "primary",
  disabled = false,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "secondary" | "success" | "ghost";
  disabled?: boolean;
  compact?: boolean;
}) {
  const tones = {
    primary: { bg: COLORS.primary, border: COLORS.primary, text: COLORS.text },
    secondary: { bg: COLORS.cardAlt, border: COLORS.border, text: COLORS.text },
    success: { bg: COLORS.success, border: COLORS.success, text: COLORS.bg },
    ghost: { bg: "transparent", border: COLORS.border, text: COLORS.textMuted },
  }[tone];

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      activeOpacity={0.82}
      disabled={disabled}
      style={[
        styles.actionButton,
        compact && styles.actionButtonCompact,
        {
          backgroundColor: tones.bg,
          borderColor: tones.border,
          opacity: disabled ? 0.55 : 1,
        },
      ]}
    >
      <Text style={[styles.actionButtonText, { color: tones.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function MetricCard({
  label,
  value,
  accent = COLORS.primary,
  helper,
  wide = false,
}: {
  label: string;
  value: string;
  accent?: string;
  helper?: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.metricCard, wide && { flex: 2 }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color: accent }]}>{value}</Text>
      {helper ? <Text style={styles.metricHelper}>{helper}</Text> : null}
    </View>
  );
}

export function ActionTile({
  glyph,
  label,
  helper,
  onPress,
}: {
  glyph: string;
  label: string;
  helper?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={helper ? `${label}. ${helper}` : label}
      style={styles.actionTile}
      onPress={onPress}
      activeOpacity={0.82}
    >
      <View style={styles.glyphWrap}>
        <Text style={styles.glyphText}>{glyph}</Text>
      </View>
      <Text style={styles.actionTileLabel}>{label}</Text>
      {helper ? <Text style={styles.actionTileHelper}>{helper}</Text> : null}
    </TouchableOpacity>
  );
}

export function Stepper({
  steps,
  active,
}: {
  steps: string[];
  active: number;
}) {
  return (
    <View style={styles.stepper}>
      {steps.map((step, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <View key={step} style={styles.stepItem}>
            <View
              style={[
                styles.stepCircle,
                done && styles.stepCircleDone,
                current && styles.stepCircleCurrent,
              ]}
            >
              <Text style={styles.stepCircleText}>{index + 1}</Text>
            </View>
            <Text style={[styles.stepLabel, current && { color: COLORS.text }]}>{step}</Text>
            {index < steps.length - 1 ? <View style={styles.stepLine} /> : null}
          </View>
        );
      })}
    </View>
  );
}

export function TabGlyph({
  glyph,
  active,
}: {
  glyph: string;
  active: boolean;
}) {
  return (
    <View
      style={[
        styles.tabGlyph,
        active ? styles.tabGlyphActive : styles.tabGlyphInactive,
      ]}
    >
      <Text style={styles.tabGlyphText}>{glyph}</Text>
    </View>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  sectionLabel: {
    color: COLORS.textSoft,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: SPACING.sm,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: "800",
  },
  headerSubtitle: {
    color: COLORS.textMuted,
    fontSize: 13,
    marginTop: 4,
  },
  pill: {
    borderRadius: RADII.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  actionButton: {
    borderRadius: RADII.md,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonCompact: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: "700",
  },
  metricCard: {
    flex: 1,
    minWidth: 0,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.cardAlt,
    padding: SPACING.md,
    gap: 8,
  },
  metricLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  metricValue: {
    fontSize: 24,
    fontWeight: "800",
  },
  metricHelper: {
    color: COLORS.textSoft,
    fontSize: 11,
  },
  actionTile: {
    flex: 1,
    minWidth: 110,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.cardAlt,
    padding: SPACING.md,
    gap: 8,
  },
  glyphWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: COLORS.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphText: {
    color: COLORS.text,
    fontWeight: "800",
  },
  actionTileLabel: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
  },
  actionTileHelper: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACING.sm,
  },
  stepItem: {
    flex: 1,
    alignItems: "center",
    position: "relative",
    minWidth: 0,
  },
  stepCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.cardAlt,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  stepCircleDone: {
    backgroundColor: COLORS.success,
    borderColor: COLORS.success,
  },
  stepCircleCurrent: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primarySoft,
  },
  stepCircleText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "800",
  },
  stepLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
  },
  stepLine: {
    position: "absolute",
    top: 13,
    left: "60%",
    right: "-40%",
    height: 1,
    backgroundColor: COLORS.border,
  },
  tabGlyph: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  tabGlyphActive: {
    backgroundColor: COLORS.primarySoft,
    borderColor: COLORS.primary,
  },
  tabGlyphInactive: {
    backgroundColor: COLORS.cardAlt,
    borderColor: COLORS.border,
  },
  tabGlyphText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: "800",
  },
  chipRow: {
    gap: SPACING.sm,
    paddingBottom: 2,
  },
});
