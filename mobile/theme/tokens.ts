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
