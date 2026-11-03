/**
 * The one button for the whole app.
 *
 * Variants: primary | secondary | ghost | destructive. Sizes: sm | md | lg.
 * Always >= 44pt touch target, a pressed state, disabled + loading states
 * that keep the width stable, and a light haptic on press (iOS).
 */
import { ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { BRAND, COLORS, CONTROL, FONT_SCALE, MIN_TOUCH, RADII, TYPE } from "../theme/tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";
export type HapticKind = "light" | "medium" | "success" | "warning" | "none";
type IconName = keyof typeof Ionicons.glyphMap;

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  haptic?: HapticKind;
  accessibilityLabel?: string;
  testID?: string;
  style?: ViewStyle;
  children?: ReactNode;
}

const PALETTE: Record<ButtonVariant, { bg: string; pressed: string; border: string; text: string }> = {
  primary: { bg: COLORS.primary, pressed: BRAND.primaryPressed, border: COLORS.primary, text: BRAND.onPrimary },
  secondary: { bg: COLORS.cardAlt, pressed: COLORS.border, border: COLORS.border, text: COLORS.text },
  ghost: { bg: "transparent", pressed: COLORS.cardAlt, border: COLORS.border, text: COLORS.textMuted },
  destructive: { bg: COLORS.danger, pressed: BRAND.dangerPressed, border: COLORS.danger, text: BRAND.onPrimary },
};

export function triggerHaptic(kind: HapticKind) {
  if (kind === "none" || Platform.OS === "web") return;
  try {
    if (kind === "success") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "warning") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else void Haptics.impactAsync(kind === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
  } catch {
    // Haptics are a nicety; never let them break a tap.
  }
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  fullWidth = false,
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled = false,
  haptic,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const colors = PALETTE[variant];
  const height = CONTROL[size];
  const slop = Math.max(0, Math.ceil((MIN_TOUCH - height) / 2));
  const inactive = disabled || loading;
  const feel: HapticKind = haptic ?? (variant === "destructive" ? "warning" : "light");
  const iconSize = size === "lg" ? 20 : 18;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      hitSlop={slop ? { top: slop, bottom: slop, left: 4, right: 4 } : undefined}
      onPress={() => {
        triggerHaptic(feel);
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: height,
          paddingHorizontal: size === "sm" ? 12 : 18,
          backgroundColor: pressed && !inactive ? colors.pressed : colors.bg,
          borderColor: colors.border,
          opacity: disabled && !loading ? 0.4 : 1,
          transform: [{ scale: pressed && !inactive ? 0.97 : 1 }],
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      {/* Keep the label laid out while loading so the width never jumps. */}
      <View style={[styles.row, loading && styles.hidden]}>
        {leadingIcon ? <Ionicons name={leadingIcon} size={iconSize} color={colors.text} /> : null}
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          maxFontSizeMultiplier={FONT_SCALE.control}
          style={[styles.label, size === "sm" && styles.labelSm, { color: colors.text }]}
        >
          {label}
        </Text>
        {trailingIcon ? <Ionicons name={trailingIcon} size={iconSize} color={colors.text} /> : null}
      </View>
      {loading ? <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.text} /> : null}
    </Pressable>
  );
}

/** 44x44 circular icon-only button. `label` is required for VoiceOver. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = "secondary",
  disabled = false,
  haptic = "light",
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  haptic?: HapticKind;
  testID?: string;
}) {
  const colors = PALETTE[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        triggerHaptic(haptic);
        onPress();
      }}
      style={({ pressed }) => [
        styles.icon,
        {
          backgroundColor: pressed && !disabled ? colors.pressed : colors.bg,
          borderColor: colors.border,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={20} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: RADII.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  fullWidth: { alignSelf: "stretch" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, flexShrink: 1 },
  hidden: { opacity: 0 },
  label: { ...TYPE.callout, textAlign: "center", flexShrink: 1 },
  labelSm: { fontSize: 14 },
  icon: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
