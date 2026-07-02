import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as api from "../../services/api";
import { useAuth } from "../../context/auth";
import {
  ActionButton,
  Card,
  GradientCard,
  Icon,
  Sparkline,
  StatCard,
} from "../../components/ui";
import { COLORS, GRADIENTS, RADII, SPACING } from "../../theme/tokens";
import { downloadTextFile } from "../../utils/fileActions";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function money(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pctDelta(current: number, prior: number): { text: string; tone: "up" | "down" | "muted" } | null {
  if (!isFinite(current) || !isFinite(prior) || prior === 0) return null;
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  const rounded = Math.round(pct * 10) / 10;
  const arrow = rounded >= 0 ? "▲" : "▼";
  return { text: `${arrow} ${Math.abs(rounded)}% vs last week`, tone: rounded >= 0 ? "up" : "down" };
}

export default function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [view, setView] = useState({
    data: null as api.Dashboard | null,
    analytics: null as api.AdvancedAnalytics | null,
    inventory: [] as api.InventoryItem[],
    loading: true,
    refreshing: false,
    loadError: false,
  });

  const fetchAll = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "refresh") setView((c) => ({ ...c, refreshing: true }));
    try {
      const [dashboardResult, analyticsResult, inventoryResult] = await Promise.allSettled([
        api.getDashboard(),
        api.getAdvancedAnalytics(30),
        api.listItems({ perPage: 100, availableOnly: true }),
      ]);
      if (dashboardResult.status === "rejected") throw dashboardResult.reason;
      setView({
        data: dashboardResult.value,
        analytics: analyticsResult.status === "fulfilled" ? analyticsResult.value : null,
        inventory: inventoryResult.status === "fulfilled" ? inventoryResult.value.items : [],
        loading: false,
        refreshing: false,
        loadError: false,
      });
    } catch {
      setView((c) => ({ ...c, loading: false, refreshing: false, loadError: true }));
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void fetchAll(), 0);
    return () => clearTimeout(timer);
  }, [fetchAll]);

  if (view.loading) {
    return (
      <View testID="dashboard-loading" style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (view.loadError || !view.data) {
    return (
      <View testID="dashboard-error" style={styles.center}>
        <Text style={styles.errorTitle}>Could not load dashboard.</Text>
        <ActionButton label="Retry" onPress={() => fetchAll()} />
      </View>
    );
  }

  const { data, analytics, inventory } = view;
  const lowStock = inventory.filter((item) => (item.quantity ?? 0) > 0 && (item.quantity ?? 0) <= 3).length;
  const name = (user?.business_name || "there").split(" ")[0];

  // Build a real daily net-profit series for the hero sparkline.
  const daily = analytics?.daily ?? [];
  const netSeries = daily.map((d) => Number(d.net));
  const revSeries = daily.map((d) => Number(d.revenue));
  const heroSpark = netSeries.length > 1 ? netSeries : [0, 0];

  // Today-vs-yesterday delta for the hero card.
  let heroDelta: { text: string; tone: "up" | "down" | "muted" } | null = null;
  if (netSeries.length >= 2) {
    const today = netSeries[netSeries.length - 1];
    const yday = netSeries[netSeries.length - 2];
    const d = pctDelta(today, yday);
    if (d) heroDelta = { text: d.text.replace("last week", "yesterday"), tone: d.tone };
  }

  // Week-over-week deltas for the Business Overview card.
  const sumLast = (arr: number[], n: number, offset = 0) =>
    arr.slice(Math.max(0, arr.length - n - offset), arr.length - offset).reduce((s, v) => s + v, 0);
  const revDelta = revSeries.length >= 8 ? pctDelta(sumLast(revSeries, 7), sumLast(revSeries, 7, 7)) : null;
  const netDelta = netSeries.length >= 8 ? pctDelta(sumLast(netSeries, 7), sumLast(netSeries, 7, 7)) : null;

  return (
    <ScrollView
      testID="dashboard-content"
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + SPACING.sm }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={view.refreshing} onRefresh={() => fetchAll("refresh")} tintColor={COLORS.primary} />
      }
    >
      {/* Greeting header */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>{`${greeting()}, ${name} 👋`}</Text>
          <Text style={styles.greetingSub}>Here&apos;s what&apos;s happening today.</Text>
        </View>
      </View>

      {/* Hero: today's profit */}
      <GradientCard colors={GRADIENTS.hero}>
        <Text style={styles.heroLabel}>Today&apos;s Profit</Text>
        <Text style={styles.heroValue}>{money(data.net_profit_today)}</Text>
        {heroDelta ? <Text style={styles.heroDelta}>{heroDelta.text}</Text> : null}
        <View style={styles.heroSparkWrap}>
          <Sparkline data={heroSpark} height={64} stroke="#FFFFFF" fillOpacity={0.22} />
        </View>
      </GradientCard>

      {/* 2x2 stat grid */}
      <View style={styles.grid}>
        <StatCard label="Inventory Value" value={money(data.total_inventory_value)} icon="cube-outline" delta={`${data.items_in_stock} in stock`} deltaTone="muted" />
        <StatCard label="Total Items" value={String(data.total_items)} icon="layers-outline" delta={`${data.items_listed} listed`} deltaTone="muted" />
      </View>
      <View style={styles.grid}>
        <StatCard label="Low Stock" value={String(lowStock)} icon="alert-circle-outline" delta="View items" deltaTone={lowStock > 0 ? "down" : "muted"} onPress={() => router.push("/inventory" as any)} />
        <StatCard label="Refunds" value={String(data.total_refunds)} icon="return-down-back-outline" delta="All time" deltaTone="muted" />
      </View>

      {/* Business overview */}
      <Card style={styles.overviewCard}>
        <View style={styles.overviewHead}>
          <Text style={styles.overviewTitle}>Business Overview</Text>
          <View style={styles.periodPill}>
            <Text style={styles.periodPillText}>Last 30 days</Text>
            <Icon name="chevron-down" size={13} color={COLORS.textMuted} />
          </View>
        </View>
        <View style={styles.overviewStats}>
          <View style={styles.overviewStat}>
            <Text style={styles.overviewStatLabel}>Revenue</Text>
            <Text style={styles.overviewStatValue}>{money(analytics?.revenue ?? data.revenue_month)}</Text>
            {revDelta ? <Text style={[styles.overviewStatDelta, { color: revDelta.tone === "up" ? COLORS.success : COLORS.danger }]}>{revDelta.text}</Text> : null}
          </View>
          <View style={styles.overviewDivider} />
          <View style={styles.overviewStat}>
            <Text style={styles.overviewStatLabel}>Net Profit</Text>
            <Text style={styles.overviewStatValue}>{money(analytics?.net ?? data.net_profit_month)}</Text>
            {netDelta ? <Text style={[styles.overviewStatDelta, { color: netDelta.tone === "up" ? COLORS.success : COLORS.danger }]}>{netDelta.text}</Text> : null}
          </View>
        </View>
        {revSeries.length > 1 ? (
          <View style={styles.overviewChart}>
            <Sparkline data={revSeries} height={80} stroke={COLORS.primaryBright} fillOpacity={0.16} />
          </View>
        ) : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 40, gap: SPACING.md },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.bg,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  errorTitle: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  headerRow: { flexDirection: "row", alignItems: "center", gap: SPACING.md },
  greeting: { color: COLORS.text, fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  greetingSub: { color: COLORS.textMuted, fontSize: 13, marginTop: 3 },
  bell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  heroLabel: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "600" },
  heroValue: { color: "#FFFFFF", fontSize: 34, fontWeight: "800", letterSpacing: -0.5, marginTop: 4 },
  heroDelta: { color: "rgba(255,255,255,0.9)", fontSize: 12.5, fontWeight: "700", marginTop: 4 },
  heroSparkWrap: { marginTop: 10, marginHorizontal: -SPACING.lg, marginBottom: -SPACING.lg },
  grid: { flexDirection: "row", gap: SPACING.sm },
  overviewCard: { gap: SPACING.md, marginTop: SPACING.xs },
  overviewHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  overviewTitle: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  periodPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: COLORS.cardAlt,
    borderRadius: RADII.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  periodPillText: { color: COLORS.textMuted, fontSize: 12, fontWeight: "700" },
  overviewStats: { flexDirection: "row", alignItems: "center" },
  overviewStat: { flex: 1, gap: 4 },
  overviewStatLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  overviewStatValue: { color: COLORS.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  overviewStatDelta: { fontSize: 12, fontWeight: "700" },
  overviewDivider: { width: 1, height: 40, backgroundColor: COLORS.border, marginHorizontal: SPACING.md },
  overviewChart: { marginHorizontal: -SPACING.sm },
  sectionLabel: {
    color: COLORS.textSoft,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: SPACING.xs,
  },
  actionsRow: { gap: SPACING.sm, paddingRight: SPACING.lg },
  actionTile: {
    width: 88,
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.lg,
    paddingVertical: SPACING.md,
  },
  actionTileLabel: { color: COLORS.text, fontSize: 12, fontWeight: "600", textAlign: "center" },
});
