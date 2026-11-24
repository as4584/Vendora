/**
 * Home nudge when stock is sitting unsold: "6 items have sat 60+ days".
 * Tapping opens the aging screen with one-tap price drops. Hidden otherwise.
 */
import { useCallback, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as api from "../services/api";
import { Card, Icon } from "./ui";
import { COLORS, SPACING } from "../theme/tokens";

export function AgingCard() {
  const router = useRouter();
  const [aging, setAging] = useState<api.AgingStock | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    api.getAgingStock().then((a) => { if (live) setAging(a); }).catch(() => undefined);
    return () => { live = false; };
  }, []));

  if (!aging || aging.count === 0) return null;
  return (
    <TouchableOpacity accessibilityRole="button" onPress={() => router.push("/inventory/aging")}>
      <Card>
        <View style={styles.row}>
          <Icon name="hourglass-outline" size={18} color={COLORS.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {aging.count} item{aging.count === 1 ? " has" : "s have"} sat {aging.days}+ days
            </Text>
            <Text style={styles.sub}>A small price drop often gets them moving. Review</Text>
          </View>
          <Icon name="chevron-forward" size={16} color={COLORS.textMuted} />
        </View>
      </Card>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  sub: { color: COLORS.textMuted, fontSize: 13, marginTop: 2 },
});
