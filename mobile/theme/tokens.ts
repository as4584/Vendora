export const COLORS = {
  bg: "#0A0E1A",
  bgElevated: "#0F1627",
  card: "#141A2B",
  cardAlt: "#1B2338",
  border: "#232C42",
  text: "#F6F8FC",
  textMuted: "#9CAAC4",
  textSoft: "#6F7E98",
  primary: "#7C5CFF",
  primaryBright: "#8E6BFF",
  primarySoft: "#241C4A",
  success: "#32C48D",
  warning: "#F5B942",
  danger: "#F16A5B",
  info: "#4E9BFF",
};

// Linear-gradient stop tuples (left→right or top→bottom depending on usage).
export const GRADIENTS = {
  primary: ["#8E6BFF", "#6A38E8"] as const,
  hero: ["#7E5BFF", "#5A2FE0"] as const,
};

export const SPACING = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 20,
  xl: 28,
};

export const RADII = {
  sm: 10,
  md: 14,
  lg: 18,
  pill: 999,
};

// Pressed/on-color companions for the brand purple. Use COLORS.primary
// everywhere; the old off-brand #6C5CE7 must not be reintroduced.
export const BRAND = {
  primaryPressed: "#6A49F0",
  onPrimary: "#FFFFFF",
  dangerPressed: "#D9564A",
  dangerSoft: "#3A1C1C",
};

// Type scale (iOS-like). size / weight / lineHeight.
export const TYPE = {
  largeTitle: { fontSize: 34, fontWeight: "800" as const, lineHeight: 41 },
  title: { fontSize: 22, fontWeight: "700" as const, lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: "600" as const, lineHeight: 22 },
  body: { fontSize: 16, fontWeight: "400" as const, lineHeight: 22 },
  callout: { fontSize: 15, fontWeight: "600" as const, lineHeight: 20 },
  footnote: { fontSize: 13, fontWeight: "500" as const, lineHeight: 18 },
  caption: { fontSize: 11, fontWeight: "600" as const, lineHeight: 14 },
};

// Control heights. Apple's minimum touch target is 44pt; "sm" reaches it via hitSlop.
export const CONTROL = { sm: 36, md: 48, lg: 54 };
export const MIN_TOUCH = 44;
