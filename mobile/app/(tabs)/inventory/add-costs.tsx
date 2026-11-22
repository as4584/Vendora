/**
 * Add costs — after an import (eBay etc.), list every item with no buy price
 * so the seller can type what they paid and profit fills in. Rows left blank
 * are skipped; "Use for all" copies one cost to every blank row.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card } from "../../../components/ui";
import { errorMessage } from "../../../services/errors";
import { COLORS, SPACING } from "../../../theme/tokens";

export function parseCost(text: string): number | null {
  const n = Number(text.replace(/[$,\s]/g, ""));
  return text.trim() && Number.isFinite(n) && n >= 0 ? n : null;
}

export default function AddCostsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listItems({ page: 1, perPage: 100, missingCost: true });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      Alert.alert("Couldn't load items", errorMessage(err, "Please try again."));
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const filled = items.filter((i) => parseCost(costs[i.id] ?? "") !== null);
  const invalid = items.filter((i) => (costs[i.id] ?? "").trim() && parseCost(costs[i.id]) === null);

  const useForAll = (value: string) => {
    setCosts((prev) => {
      const next = { ...prev };
      for (const i of items) if (!(next[i.id] ?? "").trim()) next[i.id] = value;
      return next;
    });
  };

  const save = async () => {
    if (invalid.length) {
      Alert.alert("Check the costs", `${invalid.length} cost${invalid.length === 1 ? " isn't" : "s aren't"} a valid amount.`);
      return;
    }
    setSaving(true);
    let saved = 0;
    try {
      for (const item of filled) {
        await api.updateItem(item.id, { buy_price: String(parseCost(costs[item.id]!)) });
        saved += 1;
      }
      setCosts({});
      await load();
      Alert.alert("Saved", `Added costs to ${saved} item${saved === 1 ? "" : "s"}. Profit now includes them.`);
    } catch (err) {
      Alert.alert("Save failed", `${saved} saved before an error: ${errorMessage(err, "please try again.")}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !items.length) {
    return <View style={styles.center}><ActivityIndicator color={COLORS.primaryBright} /></View>;
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.sm }}
      data={items}
      keyExtractor={(i) => i.id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: SPACING.xs, marginBottom: SPACING.sm }}>
          <Text accessibilityRole="header" style={styles.title}>Add what you paid</Text>
          <Text style={styles.muted}>
            {total === 0
              ? "Every item has a cost. Profit is accurate."
              : `${total} item${total === 1 ? " has" : "s have"} no cost, so profit counts the whole sale price. Fill in what you can; blanks are skipped.`}
          </Text>
        </View>
      }
      renderItem={({ item, index }) => (
        <Card style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
            {item.expected_sell_price ? <Text style={styles.muted}>Listed at ${Number(item.expected_sell_price).toFixed(2)}</Text> : null}
            {index === 0 && (costs[item.id] ?? "").trim() && items.length > 1 ? (
              <Text style={styles.link} accessibilityRole="button" onPress={() => useForAll(costs[item.id]!)}>Use this cost for all blank items</Text>
            ) : null}
          </View>
          <TextInput
            accessibilityLabel={`Cost for ${item.name}`}
            style={styles.input}
            placeholder="$0.00"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="decimal-pad"
            value={costs[item.id] ?? ""}
            onChangeText={(t) => setCosts((prev) => ({ ...prev, [item.id]: t }))}
          />
        </Card>
      )}
      ListFooterComponent={
        <View style={{ marginTop: SPACING.md, gap: SPACING.sm }}>
          {total > items.length ? <Text style={styles.muted}>Showing the first {items.length}. Save to load more.</Text> : null}
          {total > 0 ? (
            <ActionButton
              label={saving ? "Saving..." : `Save ${filled.length} cost${filled.length === 1 ? "" : "s"}`}
              onPress={save}
              disabled={saving || filled.length === 0}
            />
          ) : null}
          <ActionButton label="Done" tone="ghost" onPress={() => router.back()} />
        </View>
      }
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
  link: { color: COLORS.primaryBright, fontSize: 13, fontWeight: "600", marginTop: 4 },
  input: {
    width: 96, color: COLORS.text, backgroundColor: COLORS.card, borderColor: COLORS.border, borderWidth: 1,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, textAlign: "right",
  },
});
