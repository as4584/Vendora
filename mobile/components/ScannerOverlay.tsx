import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, TouchableOpacity, View, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../theme/tokens";

const FRAME = 250;
const RAY_BAND = 56; // height of the glowing band that travels

/**
 * Camera scan reticle: four purple corner brackets plus an animated purple
 * "ray" that sweeps up and down inside the frame, mimicking an active scanner.
 * Drop it on top of a <CameraView>.
 */
export function ScannerOverlay({
  hint = "Point at a barcode to scan",
  onCancel,
}: {
  hint?: string;
  onCancel?: () => void;
}) {
  const travel = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(travel, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [travel]);

  const translateY = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [0, FRAME - RAY_BAND],
  });

  return (
    <View style={styles.fill} pointerEvents="box-none">
      <View style={styles.center} pointerEvents="none">
        <View style={styles.frame}>
          {/* corner brackets */}
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />

          {/* moving purple ray */}
          <Animated.View style={[styles.ray, { transform: [{ translateY }] }]}>
            <LinearGradient
              colors={["rgba(142,107,255,0)", "rgba(142,107,255,0.28)", "rgba(142,107,255,0)"]}
              style={styles.rayGlow}
            />
            <View style={styles.rayLine} />
          </Animated.View>
        </View>
        <Text style={styles.hint}>{hint}</Text>
      </View>

      {onCancel ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel" style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const CORNER = 30;
const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  center: { alignItems: "center" },
  frame: {
    width: FRAME,
    height: FRAME,
    overflow: "hidden",
  },
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: COLORS.primaryBright,
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },
  ray: {
    position: "absolute",
    left: 6,
    right: 6,
    height: RAY_BAND,
    alignItems: "center",
    justifyContent: "center",
  },
  rayGlow: { ...StyleSheet.absoluteFillObject, borderRadius: 8 },
  rayLine: {
    height: 2,
    alignSelf: "stretch",
    backgroundColor: COLORS.primaryBright,
    borderRadius: 2,
    ...Platform.select({
      ios: { shadowColor: COLORS.primaryBright, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
      android: { elevation: 4 },
      default: {},
    }),
  },
  hint: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 22,
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  cancel: {
    position: "absolute",
    bottom: 48,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: "rgba(20,26,43,0.9)",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelText: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
});
