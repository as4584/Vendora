import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Card, Icon } from "./ui";
import { COLORS, MIN_TOUCH, SPACING } from "../theme/tokens";

/** Secondary information stays out of the way without becoming inaccessible. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={title}
        accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => [styles.toggle, pressed && { backgroundColor: COLORS.cardAlt }]}>
        <Text style={styles.title}>{title}</Text>
        <Icon name={expanded ? "chevron-up" : "chevron-down"} color={COLORS.textMuted} />
      </Pressable>
      {expanded ? <View style={styles.body}>{children}</View> : null}
    </Card>
  );
}
const styles = StyleSheet.create({
  toggle: { minHeight: MIN_TOUCH, flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  title: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "600" },
  body: { paddingTop: SPACING.sm },
});
