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
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Polyline, Polygon, Defs, LinearGradient as SvgGradient, Stop } from "react-native-svg";
import { COLORS, GRADIENTS, RADII, SPACING } from "../theme/tokens";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

export function Icon({ name, size = 20, color = COLORS.text }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} />;
}

/** Rounded-square icon badge used in action tiles and list rows. */
export function IconCircle({
  name,
  size = 38,
  tone = "primary",
  color,
}: {
  name: IconName;
  size?: number;
  tone?: "primary" | "muted";
  color?: string;
}) {
  const bg = tone === "primary" ? COLORS.primarySoft : COLORS.cardAlt;
  const fg = color ?? (tone === "primary" ? COLORS.primaryBright : COLORS.textMuted);
  return (
    <View style={[styles.iconCircle, { width: size, height: size, borderRadius: size * 0.32, backgroundColor: bg }]}>
      <Icon name={name} size={size * 0.5} color={fg} />
    </View>
  );
}

/** Gradient panel (purple hero card). */
export function GradientCard({
  children,
  style,
  colors = GRADIENTS.hero,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  colors?: readonly [string, string, ...string[]];
}) {
  return (
    <LinearGradient colors={colors as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.gradientCard, style]}>
      {children}
    </LinearGradient>
  );
}

/** Lightweight SVG sparkline with a soft gradient fill under the line. */
export function Sparkline({
  data,
  width = 300,
  height = 70,
  stroke = "#FFFFFF",
  fillOpacity = 0.18,
}: {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fillOpacity?: number;
}) {
  const pts = data.length > 1 ? data : [0, 0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 4;
  const stepX = (width - pad * 2) / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = coords.join(" ");
  const area = `${pad},${height} ${line} ${(width - pad).toFixed(1)},${height}`;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <Defs>
        <SvgGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={stroke} stopOpacity={fillOpacity} />
          <Stop offset="1" stopColor={stroke} stopOpacity={0} />
        </SvgGradient>
      </Defs>
      <Polygon points={area} fill="url(#spark)" />
      <Polyline points={line} fill="none" stroke={stroke} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

/** Compact stat card: label, big value, optional delta chip. */
export function StatCard({
  label,
  value,
  delta,
  deltaTone = "up",
  icon,
  onPress,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "muted";
  icon?: IconName;
  onPress?: () => void;
}) {
  const deltaColor = deltaTone === "up" ? COLORS.success : deltaTone === "down" ? COLORS.danger : COLORS.textSoft;
  const Wrap: any = onPress ? TouchableOpacity : View;
  return (
    <Wrap style={styles.statCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.statTopRow}>
        <Text style={styles.statLabel}>{label}</Text>
        {icon ? <Icon name={icon} size={15} color={COLORS.textSoft} /> : null}
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {delta ? <Text style={[styles.statDelta, { color: deltaColor }]}>{delta}</Text> : null}
    </Wrap>
  );
}

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
  iconCircle: {
    alignItems: "center",
    justifyContent: "center",
  },
  gradientCard: {
    borderRadius: RADII.lg + 2,
    padding: SPACING.lg,
    overflow: "hidden",
  },
  statCard: {
    flex: 1,
    minWidth: 0,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    padding: SPACING.md,
    gap: 6,
  },
  statTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  statValue: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  statDelta: {
    fontSize: 12,
    fontWeight: "700",
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
