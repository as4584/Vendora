import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import { useReducedMotion } from "./useReducedMotion";
import { COLORS, SPACING, TYPE } from "../theme/tokens";

/** Confirms where the scanned item went without covering checkout controls. */
export function CartNotice({ name }: { name: string }) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduced) return;
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: 180, useNativeDriver: true });
    animation.start();
    return () => { animation.stop(); progress.setValue(1); };
  }, [progress, reduced]);
  return (
    <Animated.View accessibilityLiveRegion="polite" style={[styles.notice, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}>
      <Text style={styles.text}>{`In your cart · ${name}`}</Text>
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  notice: { padding: SPACING.sm, borderLeftWidth: 3, borderLeftColor: COLORS.success, backgroundColor: COLORS.cardAlt, borderRadius: 6 },
  text: { ...TYPE.footnote, color: COLORS.text },
});
