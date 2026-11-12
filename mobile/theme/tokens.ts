/**
 * Resqlo design tokens.
 *
 * Direction (unslop pass): a pocket register for a show-floor table.
 * Character: quick, exact, a little street. World: sneaker boxes, price tags,
 * receipts under booth lights. Surfaces are a near-neutral graphite ramp so
 * product photos and money carry the color; the brand purple is the single
 * accent, used for the primary action, selection and nothing else.
 */
import { Appearance } from "react-native";

/**
 * Light/dark follows the phone (Settings > Display). The scheme is read once
 * at launch so every StyleSheet resolves against one palette; the root layout
 * reloads the JS bundle if the phone switches while the app is backgrounded.
 */
export type Scheme = "light" | "dark";
export const SCHEME: Scheme = Appearance.getColorScheme() === "light" ? "light" : "dark";
export const IS_LIGHT = SCHEME === "light";

const DARK = {
  // Graphite ramp, very slightly cool so it sits next to the purple accent.
  bg: "#0E0E11",
  bgElevated: "#141418",
  card: "#18181D",
  cardAlt: "#212127",
  border: "rgba(237,237,242,0.09)",
  borderStrong: "rgba(237,237,242,0.16)",
  // Three text roles. textSoft stays >= 4.5:1 on card for captions/meta.
  text: "#EDEDF2",
  textMuted: "#A6A6B0",
  textSoft: "#8C8C96",
  // Brand accent (real brand color, kept). White text on it is 4.35:1.
  primary: "#7C5CFF",
  primaryBright: "#A08BFF",
  primarySoft: "#24203A",
  // Semantic, toned down to sit inside the ramp.
  success: "#4CC38A",
  warning: "#E5B04A",
  danger: "#E5584D",
  info: "#6EA8F5",
  overlay: "rgba(0,0,0,0.55)",
};

// Same roles on a cool paper ramp. Every text role keeps >= 4.5:1 on card.
const LIGHT: typeof DARK = {
  bg: "#F4F4F7",
  bgElevated: "#FFFFFF",
  card: "#FFFFFF",
  cardAlt: "#ECECF1",
  border: "rgba(14,14,17,0.08)",
  borderStrong: "rgba(14,14,17,0.16)",
  text: "#141418",
  textMuted: "#4F4F59",
  textSoft: "#686872",
  primary: "#6A49F0",
  // On light, "bright" accent is used for text/icons, so it goes deeper.
  primaryBright: "#5A3BE0",
  primarySoft: "#ECE7FF",
  success: "#1D8553",
  warning: "#9A6400",
  danger: "#C7362C",
  info: "#2B67C2",
  overlay: "rgba(14,14,17,0.40)",
};

/** Both palettes, for tests and previews. */
export const PALETTES = { dark: DARK, light: LIGHT };

export const COLORS = IS_LIGHT ? LIGHT : DARK;

/** Tinted pill/badge tones (bg + readable text) for each scheme. */
export const TONES = IS_LIGHT
  ? {
      primary: { bg: "rgba(106,73,240,0.12)", text: "#4B2FC4" },
      success: { bg: "rgba(29,133,83,0.12)", text: "#176B43" },
      warning: { bg: "rgba(154,100,0,0.12)", text: "#7A4F00" },
      danger: { bg: "rgba(199,54,44,0.12)", text: "#A82C24" },
      info: { bg: "rgba(43,103,194,0.12)", text: "#235598" },
    }
  : {
      primary: { bg: "rgba(124,92,255,0.16)", text: "#C4B6FF" },
      success: { bg: "rgba(76,195,138,0.13)", text: "#8FDDB6" },
      warning: { bg: "rgba(229,176,74,0.13)", text: "#EFCB85" },
      danger: { bg: "rgba(229,88,77,0.14)", text: "#F2A49D" },
      info: { bg: "rgba(110,168,245,0.13)", text: "#A9CBF8" },
    };

// Gradients are no longer used on surfaces. Kept as neutral tone shifts for
// any caller that still imports them.
export const GRADIENTS = {
  primary: ["#7C5CFF", "#7C5CFF"] as const,
  hero: (IS_LIGHT ? ["#FFFFFF", "#FFFFFF"] : ["#1C1C22", "#18181D"]) as readonly [string, string],
};

// 4pt grid.
export const SPACING = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 32,
};

// Controls 10, cards 16, sheets 20. Nested radius = outer - padding.
export const RADII = {
  sm: 10,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

// Pressed/on-color companions for the brand purple. Use COLORS.primary
// everywhere; the old off-brand #6C5CE7 must not be reintroduced.
export const BRAND = {
  primaryPressed: IS_LIGHT ? "#5A3BE0" : "#6A49F0",
  onPrimary: "#FFFFFF",
  dangerPressed: "#C9483E",
  dangerSoft: IS_LIGHT ? "#FBE9E7" : "#33191A",
};

// Type scale (iOS text styles). Hierarchy from size and color; weights 400-600.
export const TYPE = {
  largeTitle: { fontSize: 30, fontWeight: "600" as const, lineHeight: 36 },
  title: { fontSize: 22, fontWeight: "600" as const, lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: "600" as const, lineHeight: 22 },
  body: { fontSize: 16, fontWeight: "400" as const, lineHeight: 22 },
  callout: { fontSize: 15, fontWeight: "600" as const, lineHeight: 20 },
  subhead: { fontSize: 14, fontWeight: "400" as const, lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: "400" as const, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: "500" as const, lineHeight: 16 },
  figure: { fontSize: 28, fontWeight: "600" as const, lineHeight: 34, fontVariant: ["tabular-nums"] as ["tabular-nums"] },
};

// Depth on dark comes from surface steps + hairlines, not shadows.
export const ELEVATION = {
  flat: { borderWidth: 1, borderColor: COLORS.border },
  raised: { borderWidth: 1, borderColor: COLORS.borderStrong },
};

// Control heights. Apple's minimum touch target is 44pt; "sm" reaches it via hitSlop.
/**
 * Dynamic Type caps (Text maxFontSizeMultiplier). Body copy scales freely and
 * wraps; only text inside fixed-size chrome (tab bar, pills, badges, stepper
 * glyphs, big hero numbers) is capped so it can't clip or push the layout.
 */
export const FONT_SCALE = { chrome: 1.3, display: 1.3, control: 1.4 } as const;

export const CONTROL = { sm: 36, md: 48, lg: 52 };
export const MIN_TOUCH = 44;
