import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../services/api";
import { ActionButton, ActionTile, Card, HeaderTitle, MetricCard, Pill, SectionLabel } from "../../components/ui";
import { COLORS, SPACING } from "../../theme/tokens";
import { downloadTextFile } from "../../utils/fileActions";

export default function DashboardScreen() {
  const router = useRouter();
  const [view, setView] = useState({
    data: null as api.Dashboard | null,
    health: [] as api.ProviderHealthEntry[],
    inventory: [] as api.InventoryItem[],
    loading: true,
    refreshing: false,
    loadError: false,
  });

  const fetchAll = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "refresh") {
      setView((current) => ({ ...current, refreshing: true }));
    }
    try {
      const [dashboard, providerHealth, inventoryPage] = await Promise.all([
        api.getDashboard(),
        api.getProviderHealth(),
        api.listItems({ perPage: 100, availableOnly: true }),
      ]);
      setView({
        data: dashboard,
        health: providerHealth.providers,
        inventory: inventoryPage.items,
        loading: false,
        refreshing: false,
        loadError: false,
      });
    } catch {
      setView((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        loadError: true,
      }));
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = () => {
    fetchAll("refresh");
  };

  const handleExport = async () => {
    try {
      const csv = await api.exportInventoryCSV();
      await downloadTextFile(csv, "vendora-inventory.csv");
    } catch (err: any) {
      Alert.alert("Export failed", err?.message || "Could not export inventory.");
    }
  };

  const handleSync = async () => {
    try {
      const [lightspeed, square, clover] = await Promise.all([
        api.getLightspeedStatus(),
        api.getSquareStatus(),
        api.getCloverStatus(),
      ]);

      const jobs: Array<Promise<any>> = [];
      if (lightspeed.connected) jobs.push(api.triggerLightspeedSync());
      if (square.connected) jobs.push(api.triggerSquareSync());
      if (clover.connected) jobs.push(api.triggerCloverSync());

      if (jobs.length === 0) {
        router.push("/settings/sync-center" as any);
        return;
      }

      const results = await Promise.allSettled(jobs);
      const completed = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - completed;
      router.push("/settings/sync-center" as any);
      fetchAll();
    } catch (err: any) {
      Alert.alert("Sync failed", err?.message || "Could not start provider sync.");
    }
  };

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
        <ActionButton label="Retry" onPress={fetchAll} />
      </View>
    );
  }

  const { data, health, inventory } = view;
  const lowStock = inventory.filter((item) => (item.quantity ?? 0) > 0 && (item.quantity ?? 0) <= 3).length;
  const healthyProviders = health.filter(
    (provider) => provider.failed_runs_24h === 0 && provider.open_issues_count === 0
  ).length;

  return (
    <ScrollView
      testID="dashboard-content"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={view.refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />
      }
    >
      <HeaderTitle
        title="Dashboard"
        subtitle="Inventory import, sync, and stock health in one place."
        right={<Pill label={`${healthyProviders}/${Math.max(health.length, 1)} healthy`} tone="primary" />}
      />

      <SectionLabel>Quick Actions</SectionLabel>
      <View style={styles.actionGrid}>
        <ActionTile glyph="IM" label="Import" helper="Preview spreadsheet changes" onPress={() => router.push("/inventory/import" as any)} />
        <ActionTile glyph="EX" label="Export" helper="Generate review CSV" onPress={handleExport} />
        <ActionTile glyph="SY" label="Sync" helper="Pull latest provider stock" onPress={handleSync} />
        <ActionTile glyph="IV" label="Invoice" helper="Create from inventory" onPress={() => router.push("/inventory/invoices" as any)} />
      </View>

      <SectionLabel>Health At A Glance</SectionLabel>
      <Card style={styles.stackGap}>
        <View style={styles.metricsRow}>
          <MetricCard label="Total Items" value={String(data.total_items)} accent={COLORS.text} />
          <MetricCard label="In Stock" value={String(data.items_in_stock)} accent={COLORS.success} />
          <MetricCard label="Low Stock" value={String(lowStock)} accent={lowStock > 0 ? COLORS.warning : COLORS.text} />
          <MetricCard label="Refunds" value={String(data.total_refunds)} accent={COLORS.info} />
        </View>
        <View style={styles.providerRow}>
          {health.length === 0 ? (
            <Text style={styles.helperText}>Provider health will appear once sync history exists.</Text>
          ) : (
            health.map((provider) => (
              <View key={provider.provider} style={styles.providerStatusRow}>
                <Text style={styles.providerName}>
                  {provider.provider.charAt(0).toUpperCase() + provider.provider.slice(1)}
                </Text>
                <Pill
                  label={
                    provider.failed_runs_24h > 0 || provider.open_issues_count > 0
                      ? `${provider.failed_runs_24h} failed • ${provider.open_issues_count} issues`
                      : "Healthy"
                  }
                  tone={
                    provider.failed_runs_24h > 0
                      ? "danger"
                      : provider.open_issues_count > 0
                        ? "warning"
                        : "success"
                  }
                />
              </View>
            ))
          )}
        </View>
      </Card>

      <SectionLabel>Revenue</SectionLabel>
      <View style={styles.metricsRow}>
        <MetricCard label="Today" value={`$${data.revenue_today}`} accent={COLORS.success} />
        <MetricCard label="This Week" value={`$${data.revenue_week}`} accent={COLORS.success} />
        <MetricCard label="This Month" value={`$${data.revenue_month}`} accent={COLORS.success} />
      </View>

      <SectionLabel>Profit + Inventory Value</SectionLabel>
      <View style={styles.metricsRow}>
        <MetricCard label="Net Profit Today" value={`$${data.net_profit_today}`} accent={COLORS.primary} />
        <MetricCard label="Net Profit All Time" value={`$${data.net_profit_all_time}`} accent={COLORS.primary} />
      </View>
      <View style={styles.metricsRow}>
        <MetricCard label="Cost Basis" value={`$${data.total_inventory_value}`} accent={COLORS.info} />
        <MetricCard label="Expected Value" value={`$${data.total_expected_value}`} accent={COLORS.info} />
        <MetricCard label="Potential Profit" value={`$${data.potential_profit}`} accent={COLORS.success} />
      </View>

      <Card style={styles.footerCard}>
        <Text style={styles.footerTitle}>Ready for spreadsheet review</Text>
        <Text style={styles.footerText}>
          Your seeded account now supports export, import preview, sync health, and size-aware inventory validation from one workflow.
        </Text>
        <ActionButton label="Open Inventory" onPress={() => router.push("/inventory" as any)} tone="secondary" />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.bg,
    padding: SPACING.lg,
    gap: SPACING.md,
  },
  errorTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "700",
  },
  actionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.sm,
  },
  metricsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.sm,
  },
  stackGap: {
    gap: SPACING.md,
  },
  providerRow: {
    gap: SPACING.sm,
  },
  providerStatusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: SPACING.md,
  },
  providerName: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
  helperText: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  footerCard: {
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  footerTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "800",
  },
  footerText: {
    color: COLORS.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
});
