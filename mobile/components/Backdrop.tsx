/**
 * The glass look's base layer: a pre-blurred sneaker-wall photo (Unsplash,
 * "Wall of Jordans" by Mick Haupt, Unsplash License) darkened or lightened
 * per scheme. Blur is baked into the JPEG, so it costs nothing at runtime.
 * Frosted cards (COLORS.card) sit on top of it.
 */
import { BlurView } from "expo-blur";
import { Image, StyleSheet, View, type ViewStyle } from "react-native";
import { COLORS, IS_LIGHT } from "../theme/tokens";

const PHOTO = IS_LIGHT ? require("../assets/images/bg-light.jpg") : require("../assets/images/bg-dark.jpg");

export function Backdrop({ children, style }: { children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.fill, style]}>
      <Image source={PHOTO} resizeMode="cover" style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors />
      {children}
    </View>
  );
}

/** Live frosted glass for chrome that floats over moving content (tab bar, sheets). */
export function GlassBlur({ style }: { style?: ViewStyle }) {
  return (
    <BlurView
      tint={IS_LIGHT ? "systemChromeMaterialLight" : "systemChromeMaterialDark"}
      intensity={IS_LIGHT ? 70 : 60}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}

const styles = StyleSheet.create({
  // Clip to the screen: the photo must never make the page itself scrollable.
  fill: { flex: 1, backgroundColor: COLORS.canvas, overflow: "hidden" },
});
