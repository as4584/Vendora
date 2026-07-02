import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, HeaderTitle, SectionLabel, Sparkline } from "../../../components/ui";
import * as api from "../../../services/api";
import { COLORS, RADII, SPACING } from "../../../theme/tokens";
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
  const revSeries = data.daily.map((point) => Number(point.revenue));
  const catTotal = Math.max(1, data.categories.reduce((sum, c) => sum + Number(c.revenue), 0));
  return (
    <ScrollView testID="analytics-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Advanced Analytics" subtitle={`Your last ${data.period_days} days of sales performance.`} />
      <View style={styles.grid}>
        <Metric label="Revenue" value={formatCurrency(data.revenue)} />
        <Metric label="Net" value={formatCurrency(data.net)} />
        <Metric label="Avg order" value={formatCurrency(data.average_order_value)} />
        <Metric label="Sell-through" value={`${Number(data.sell_through_rate).toFixed(1)}%`} />
      </View>
      <Card>
        <SectionLabel>Revenue over time</SectionLabel>
        {revSeries.length > 1 ? (
          <View style={styles.chartWrap}><Sparkline data={revSeries} height={110} stroke={COLORS.primaryBright} fillOpacity={0.16} /></View>
        ) : (
          <Text style={styles.empty}>Not enough data yet to chart a trend.</Text>
        )}
      </Card>
      <Card>
        <SectionLabel>Top categories</SectionLabel>
        {data.categories.length ? data.categories.map((category) => {
          const pct = Math.round((Number(category.revenue) / catTotal) * 100);
          return (
            <View key={category.category} style={styles.category}>
              <View style={styles.categoryRow}>
                <Text style={styles.categoryName}>{category.category}</Text>
                <Text style={styles.categoryPct}>{pct}%</Text>
              </View>
              <View style={styles.track}><View style={[styles.trackFill, { width: `${Math.max(3, pct)}%` }]} /></View>
              <Text style={styles.categoryMeta}>{category.units_sold} sold · {formatCurrency(category.revenue)}</Text>
            </View>
          );
        }) : <Text style={styles.empty}>Complete sales to populate category insights.</Text>}
      </Card>
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <Card style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></Card>; }
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 }, center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm }, metric: { width: "48%", gap: 6 }, metricLabel: { color: COLORS.textMuted, fontSize: 12 }, metricValue: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  chartWrap: { marginTop: SPACING.md, marginHorizontal: -SPACING.xs },
  category: { paddingVertical: SPACING.sm }, categoryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, categoryName: { color: COLORS.text, fontWeight: "700" }, categoryPct: { color: COLORS.textMuted, fontWeight: "700", fontSize: 13 },
  track: { height: 6, borderRadius: RADII.pill, backgroundColor: COLORS.cardAlt, marginTop: 8, overflow: "hidden" }, trackFill: { height: "100%", borderRadius: RADII.pill, backgroundColor: COLORS.primaryBright },
  categoryMeta: { color: COLORS.textMuted, marginTop: 6, fontSize: 12 }, empty: { color: COLORS.textMuted, marginTop: SPACING.sm },
});
