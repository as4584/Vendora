/**
 * Swipe actions on a list row. Swipe right: Sell. Swipe left: Edit, Delete.
 * Every action is also reachable without swiping (VoiceOver custom actions,
 * and the item screen), so swiping is a shortcut, never the only way.
 */
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { BRAND, FONT_SCALE, RADII, SPACING } from "../theme/tokens";
import { triggerHaptic } from "./Button";
import { Icon, type IconName } from "./ui";

export interface SwipeAction {
  key: string;
  label: string;
  icon: IconName;
  color: string;
  onPress: () => void;
}

function ActionPanel({ actions, close }: { actions: SwipeAction[]; close: () => void }) {
  return (
    <View style={styles.panel}>
      {actions.map((a) => (
        <TouchableOpacity
          key={a.key}
          testID={`swipe-${a.key}`}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          onPress={() => {
            close();
            triggerHaptic("light");
            a.onPress();
          }}
          style={[styles.action, { backgroundColor: a.color }]}
        >
          <Icon name={a.icon} size={20} color={BRAND.onPrimary} />
          <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.actionText}>{a.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function SwipeRow({
  children,
  left = [],
  right = [],
  enabled = true,
  testID,
}: {
  children: React.ReactNode;
  /** Revealed by swiping right (shown on the left edge). */
  left?: SwipeAction[];
  /** Revealed by swiping left (shown on the right edge). */
  right?: SwipeAction[];
  enabled?: boolean;
  testID?: string;
}) {
  const all = [...left, ...right];
  return (
    <View
      testID={testID}
      accessibilityActions={all.map((a) => ({ name: a.key, label: a.label }))}
      onAccessibilityAction={(e) => all.find((a) => a.key === e.nativeEvent.actionName)?.onPress()}
    >
      <ReanimatedSwipeable
        enabled={enabled}
        friction={1.6}
        overshootLeft={false}
        overshootRight={false}
        leftThreshold={48}
        rightThreshold={48}
        renderLeftActions={left.length ? (_p, _t, m) => <ActionPanel actions={left} close={m.close} /> : undefined}
        renderRightActions={right.length ? (_p, _t, m) => <ActionPanel actions={right} close={m.close} /> : undefined}
        onSwipeableWillOpen={() => triggerHaptic("light")}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

// Fixed deep tones in both modes so white labels stay >= 4.5:1.
export const SWIPE_COLORS = {
  sell: "#1D7A4C",
  edit: "#2B5FB3",
  delete: "#B93229",
};

const styles = StyleSheet.create({
  panel: { flexDirection: "row", gap: SPACING.xs, paddingHorizontal: SPACING.xs, alignItems: "stretch" },
  action: { width: 76, borderRadius: RADII.lg, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { color: BRAND.onPrimary, fontSize: 12, fontWeight: "700" },
});
