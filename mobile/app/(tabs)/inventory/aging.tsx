/**
 * Aging stock — items that have sat unsold the longest, with one-tap price
 * drops (10/15/20%) for one item or all of them. Drops never go below cost
 * when a cost is known.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card } from "../../../components/ui";
import { errorMessage } from "../../../services/errors";
import { markdownPrice } from "../../../utils/aging";
import { COLORS, SPACING } from "../../../theme/tokens";

const DROPS = [10, 15, 20];

export default function AgingScreen() {
  const router = useRouter();
  const [data, setData] = useState<api.AgingStock | null>(null);
  const [percent, setPercent] = useState(10);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getAgingStock());
    } catch (err) {
      Alert.alert("Couldn't load items", errorMessage(err, "Please try again."));
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const drop = async (items: api.AgingStock["items"]) => {
    const changes = items
      .map((i) => ({ id: i.id, price: markdownPrice(i.expected_sell_price, percent, i.buy_price) }))
      .filter((c): c is { id: string; price: string } => c.price !== null);
    if (!changes.length) {
      Alert.alert("Nothing to drop", "These items have no list price, or are already at cost.");
      return;
    }
    setBusy(true);
    let done = 0;
    try {
      for (const c of changes) {
        await api.updateItem(c.id, { expected_sell_price: c.price });
        done += 1;
      }
      Alert.alert("Prices dropped", `${done} item${done === 1 ? "" : "s"} now ${percent}% lower.`);
    } catch (err) {
      Alert.alert("Some prices didn't change", `${done} updated before an error: ${errorMessage(err, "please try again.")}`);
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (!data) {
    return <View style={styles.center}><ActivityIndicator color={COLORS.primaryBright} /></View>;
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.sm }}
      data={data.items}
      keyExtractor={(i) => i.id}
      ListHeaderComponent={
        <View style={{ gap: SPACING.sm, marginBottom: SPACING.xs }}>
          <Text accessibilityRole="header" style={styles.title}>Not selling</Text>
          <Text style={styles.muted}>
            {data.count === 0
              ? `Nothing has sat more than ${data.days} days. Nice.`
              : `${data.count} item${data.count === 1 ? " has" : "s have"} sat ${data.days}+ days. Drop the price to turn them into cash.`}
          </Text>
          {data.count > 0 ? (
            <>
              <View style={styles.chips}>
                {DROPS.map((p) => (
                  <TouchableOpacity key={p} onPress={() => setPercent(p)} accessibilityRole="button"
                    accessibilityState={{ selected: percent === p }} style={[styles.chip, percent === p && styles.chipActive]}>
                    <Text style={[styles.chipText, percent === p && styles.chipTextActive]}>{p}% off</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <ActionButton label={busy ? "Updating..." : `Drop all ${percent}%`} onPress={() => void drop(data.items)} disabled={busy} />
            </>
          ) : null}
        </View>
      }
      renderItem={({ item }) => {
        const next = markdownPrice(item.expected_sell_price, percent, item.buy_price);
        return (
          <Card style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.muted}>
                {`${item.days_old} days · `}
                {item.expected_sell_price ? `$${Number(item.expected_sell_price).toFixed(2)}${next ? ` → $${next}` : " (at cost)"}` : "No list price"}
              </Text>
            </View>
            {next ? (
              <ActionButton label={`-${percent}%`} tone="secondary" compact disabled={busy} onPress={() => void drop([item])} />
            ) : null}
          </Card>
        );
      }}
      ListFooterComponent={<View style={{ marginTop: SPACING.md }}><ActionButton label="Done" tone="ghost" onPress={() => router.back()} /></View>}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "700" },
  muted: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  name: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  chips: { flexDirection: "row", gap: SPACING.xs },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
});
