import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";
import { Card, HeaderTitle, Icon, IconCircle, Pill } from "../../../components/ui";
import { customerContact } from "../../../components/CustomerPicker";
import { COLORS, FONT_SCALE, SPACING, TYPE } from "../../../theme/tokens";
import { formatCompactDate, formatCurrency } from "../../../utils/inventory";

export default function CustomersScreen() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<api.Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      setCustomers(await api.listCustomers(q));
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Could not load customers.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  return (
    <ScrollView
      testID="customers-content"
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(query); }} tintColor={COLORS.primary} />}
    >
      <HeaderTitle title="Customers" subtitle="Everyone you've invoiced or tagged at checkout." />
      <TextInput
        accessibilityLabel="Search customers"
        placeholder="Search name, email or phone"
        placeholderTextColor={COLORS.textSoft}
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
      />
      {loading ? <ActivityIndicator color={COLORS.primary} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !error && customers.length === 0 ? (
        <Card>
          <Text style={styles.meta}>
            {query.trim()
              ? "No customers match that search."
              : "No customers yet. They're added when you create an invoice or pick a buyer at checkout."}
          </Text>
        </Card>
      ) : null}
      {customers.map((c) => (
        <TouchableOpacity
          key={c.id}
          style={styles.row}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Open ${c.name}`}
          onPress={() => router.push(`/customers/${c.id}` as any)}
        >
          <IconCircle name="person-outline" />
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>{customerContact(c)}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {c.order_count} {c.order_count === 1 ? "purchase" : "purchases"}
              {c.last_purchase_at ? ` · last ${formatCompactDate(c.last_purchase_at)}` : ""}
            </Text>
          </View>
          <View style={styles.aside}>
            <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.total}>{formatCurrency(c.total_spent)}</Text>
            {c.tax_exempt ? <Pill label="Tax exempt" tone="info" /> : null}
          </View>
          <Icon name="chevron-forward" size={16} color={COLORS.textSoft} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.sm },
  input: {
    ...TYPE.body,
    color: COLORS.text,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingHorizontal: SPACING.sm,
    minHeight: 48,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    backgroundColor: COLORS.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.sm,
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  aside: { alignItems: "flex-end", gap: 4, flexShrink: 0 },
  name: { ...TYPE.callout, color: COLORS.text },
  meta: { ...TYPE.footnote, color: COLORS.textMuted },
  total: { ...TYPE.callout, color: COLORS.success },
  error: { ...TYPE.footnote, color: COLORS.danger },
});
