/**
 * Resqlo design tokens.
 *
 * Direction (unslop pass): a pocket register for a show-floor table.
 * Character: quick, exact, a little street. World: sneaker boxes, price tags,
 * receipts under booth lights. Surfaces are warm paper and off-white so
 * product photos and money carry the color; the brand purple is the single
 * accent, used for the primary action, selection and nothing else.
 */
export const COLORS = {
  bg: "#F7F4EE",
  bgElevated: "#FCFAF6",
  card: "#FFFEFB",
  cardAlt: "#EFEAE2",
  border: "#DFD9D0",
  borderStrong: "#C8C0B5",
  // Three text roles. textSoft stays >= 4.5:1 on card for captions/meta.
  text: "#26231F",
  textMuted: "#625D57",
  textSoft: "#6D665E",
  // Deeper brand violet preserves readable white action labels on light UI.
  primary: "#6746D9",
  primaryBright: "#6746D9",
  primarySoft: "#EEE8FC",
  // Semantic, toned down to sit inside the ramp.
  success: "#23734D",
  warning: "#865B0D",
  danger: "#B83B32",
  info: "#2C65A4",
  overlay: "rgba(0,0,0,0.55)",
};

// Gradients are no longer used on surfaces. Kept as neutral tone shifts for
// any caller that still imports them.
export const GRADIENTS = {
  primary: ["#6746D9", "#6746D9"] as const,
  hero: ["#FFFEFB", "#FCFAF6"] as const,
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
  primaryPressed: "#5234B6",
  onPrimary: "#FFFFFF",
  dangerPressed: "#962F28",
  dangerSoft: "#FBE9E6",
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

// Depth comes from paper surface steps and hairlines, not heavy shadows.
export const ELEVATION = {
  flat: { borderWidth: 1, borderColor: COLORS.border },
  raised: { borderWidth: 1, borderColor: COLORS.borderStrong },
};

// Compact controls keep a real 44pt layout box to avoid overlapping hit areas.
/**
 * Dynamic Type caps (Text maxFontSizeMultiplier). Body copy scales freely and
 * wraps; only text inside fixed-size chrome (tab bar, pills, badges, stepper
 * glyphs, big hero numbers) is capped so it can't clip or push the layout.
 */
export const FONT_SCALE = { chrome: 1.3, display: 1.3, control: 1.4 } as const;

export const CONTROL = { sm: 44, md: 48, lg: 52 };
export const MIN_TOUCH = 44;
