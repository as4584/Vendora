/**
 * "This month Resqlo saved you about 3.5 hrs" — shows the work integrations
 * did (imports, auto-logged sales, synced stock) and fees counted, so the
 * value of the app is visible. Hidden until there's something to show.
 */
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as api from "../services/api";
import { Card, Icon } from "./ui";
import { hasSavings, hoursLabel, savingsLines } from "../utils/savings";
import { COLORS, SPACING } from "../theme/tokens";

export function SavingsCard() {
  const [savings, setSavings] = useState<api.Savings | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    api.getSavings().then((s) => { if (live) setSavings(s); }).catch(() => undefined);
    return () => { live = false; };
  }, []));

  if (!hasSavings(savings)) return null;
  const lines = savingsLines(savings);
  return (
    <Card>
      <View style={styles.head}>
        <Icon name="time-outline" size={18} color={COLORS.success} />
        <Text style={styles.title}>
          {savings.minutes_saved > 0 ? `This month Resqlo saved you about ${hoursLabel(savings.minutes_saved)}` : "This month in Resqlo"}
        </Text>
      </View>
      {lines.map((line) => (
        <Text key={line} style={styles.line}>· {line}</Text>
      ))}
      <Text style={styles.note}>
        {`Estimate: ${savings.minutes_per_item} min per item and ${savings.minutes_per_sale} min per sale you'd otherwise type in.`}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: SPACING.xs, marginBottom: SPACING.xs },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  line: { color: COLORS.text, fontSize: 13, lineHeight: 20 },
  note: { color: COLORS.textMuted, fontSize: 11.5, marginTop: SPACING.xs },
});
