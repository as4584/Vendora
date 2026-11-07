import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { useReducedMotion } from "./useReducedMotion";
import { COLORS } from "../theme/tokens";

/** Always shows the actual quantity; briefly fades in when stock changes. */
export function StockLabel({ quantity }: { quantity: number }) {
  const reduced = useReducedMotion();
  const previous = useRef(quantity);
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const changed = previous.current !== quantity;
    previous.current = quantity;
    if (reduced || !changed) return;
    opacity.setValue(0.4);
    const animation = Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true });
    animation.start();
    return () => { animation.stop(); opacity.setValue(1); };
  }, [quantity, reduced, opacity]);
  const low = quantity > 0 && quantity <= 3;
  return <Animated.Text style={[styles.text, { opacity, color: quantity === 0 ? COLORS.danger : low ? COLORS.warning : COLORS.textMuted }]}>{low ? `Low stock ${quantity}` : `Stock ${quantity}`}</Animated.Text>;
}
const styles = StyleSheet.create({ text: { fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] } });
