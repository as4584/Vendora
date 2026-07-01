import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, HeaderTitle, SectionLabel } from "../../../components/ui";
import * as api from "../../../services/api";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCurrency } from "../../../utils/inventory";

export default function AnalyticsScreen() {
  const [data, setData] = useState<api.AdvancedAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getAdvancedAnalytics().then(setData).catch((reason: any) => { const message = reason?.message || "Could not load analytics."; setError(message); Alert.alert("Analytics unavailable", message); }).finally(() => setLoading(false));
  }, []);
  if (loading) return <View testID="analytics-loading" style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>;
  if (!data) return <View testID="analytics-error" style={styles.center}><Text style={styles.empty}>{error || "Analytics are unavailable."}</Text></View>;
  const peak = Math.max(1, ...data.daily.map((point) => Number(point.revenue)));
  return (
    <ScrollView testID="analytics-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Advanced Analytics" subtitle={`Your last ${data.period_days} days of sales performance.`} />
      <View style={styles.grid}>
        <Metric label="Revenue" value={formatCurrency(data.revenue)} />
        <Metric label="Net" value={formatCurrency(data.net)} />
        <Metric label="Avg order" value={formatCurrency(data.average_order_value)} />
        <Metric label="Sell-through" value={`${Number(data.sell_through_rate).toFixed(1)}%`} />
      </View>
      <Card><SectionLabel>Daily revenue</SectionLabel><View style={styles.chart}>{data.daily.map((point) => <View accessibilityLabel={`${point.date}: ${formatCurrency(point.revenue)}`} key={point.date} style={[styles.bar, { height: Math.max(3, (Number(point.revenue) / peak) * 100) }]} />)}</View></Card>
      <Card><SectionLabel>Top categories</SectionLabel>{data.categories.length ? data.categories.map((category) => <View key={category.category} style={styles.category}><Text style={styles.categoryName}>{category.category}</Text><Text style={styles.categoryMeta}>{category.units_sold} sold · {formatCurrency(category.revenue)}</Text></View>) : <Text style={styles.empty}>Complete sales to populate category insights.</Text>}</Card>
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <Card style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></Card>; }
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 }, center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm }, metric: { width: "48%", gap: 6 }, metricLabel: { color: COLORS.textMuted, fontSize: 12 }, metricValue: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  chart: { height: 112, flexDirection: "row", alignItems: "flex-end", gap: 2, marginTop: SPACING.md }, bar: { flex: 1, backgroundColor: COLORS.primary, borderRadius: 3 },
  category: { paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.border }, categoryName: { color: COLORS.text, fontWeight: "700" }, categoryMeta: { color: COLORS.textMuted, marginTop: 4, fontSize: 12 }, empty: { color: COLORS.textMuted, marginTop: SPACING.sm },
});
