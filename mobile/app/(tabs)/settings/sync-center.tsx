import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert, RefreshControl } from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Icon, IconCircle, Pill, SectionLabel, type IconName } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";

type ProviderKey = "lightspeed" | "square" | "clover" | "ebay";
type ProviderStatus = { connected: boolean; last_synced_at: string | null };

const PROVIDERS: { key: ProviderKey; name: string; icon: IconName; getStatus: () => Promise<ProviderStatus>; sync: () => Promise<unknown> }[] = [
  { key: "lightspeed", name: "Lightspeed", icon: "flash", getStatus: api.getLightspeedStatus, sync: api.triggerLightspeedSync },
  { key: "square", name: "Square", icon: "square", getStatus: api.getSquareStatus, sync: api.triggerSquareSync },
  { key: "clover", name: "Clover", icon: "apps", getStatus: api.getCloverStatus, sync: api.triggerCloverSync },
  { key: "ebay", name: "eBay", icon: "pricetag", getStatus: api.getEbayStatus, sync: api.triggerEbaySync },
];

function timeAgo(iso?: string | null): string {
  if (!iso) return "never synced";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SyncCenterScreen() {
  const router = useRouter();
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({});
  const [runs, setRuns] = useState<api.ProviderSyncRun[]>([]);
  const [issues, setIssues] = useState<api.ReconciliationIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const [statusResults, runsResult, issuesResult] = await Promise.all([
      Promise.all(PROVIDERS.map((p) => p.getStatus().catch(() => ({ connected: false, last_synced_at: null })))),
      api.listSyncRuns({ limit: 30 }).catch(() => [] as api.ProviderSyncRun[]),
      api.listReconciliationIssues({ limit: 20 }).catch(() => [] as api.ReconciliationIssue[]),
    ]);
    const map: Record<string, ProviderStatus> = {};
    PROVIDERS.forEach((p, i) => { map[p.key] = statusResults[i]; });
    setStatuses(map);
    setRuns(runsResult);
    setIssues(issuesResult);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const syncOne = async (key: ProviderKey) => {
    const provider = PROVIDERS.find((p) => p.key === key)!;
    if (!statuses[key]?.connected) {
      router.push("/settings" as any);
      return;
    }
    setSyncing(key);
    try {
      await provider.sync();
      await load();
    } catch (err: any) {
      Alert.alert("Sync failed", err?.message || `Could not sync ${provider.name}.`);
    } finally {
      setSyncing(null);
    }
  };

  const syncAll = async () => {
    const connected = PROVIDERS.filter((p) => statuses[p.key]?.connected);
    if (connected.length === 0) {
      Alert.alert("Nothing to sync", "Connect a provider in Settings first.");
      return;
    }
    setSyncing("all");
    try {
      const results = await Promise.allSettled(connected.map((p) => p.sync()));
      const failed = results.filter((r) => r.status === "rejected").length;
      await load();
      if (failed > 0) Alert.alert("Partial sync", `${connected.length - failed} of ${connected.length} providers synced.`);
    } catch (err: any) {
      Alert.alert("Sync failed", err?.message || "Could not start the sync.");
    } finally {
      setSyncing(null);
    }
  };

  if (loading) {
    return <View testID="sync-loading" style={styles.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>;
  }

  const visibleRuns = showAll ? runs : runs.slice(0, 4);

  return (
    <ScrollView
      testID="sync-content"
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={COLORS.primary} />}
    >
      <HeaderTitle title="Sync Center" subtitle="Keep your POS and marketplace inventory in lockstep." />

      <SectionLabel>Integrations</SectionLabel>
      <Card style={styles.stack}>
        {PROVIDERS.map((p, i) => {
          const status = statuses[p.key];
          const connected = !!status?.connected;
          return (
            <TouchableOpacity
              key={p.key}
              style={[styles.intRow, i < PROVIDERS.length - 1 && styles.intRowDivider]}
              activeOpacity={0.8}
              onPress={() => syncOne(p.key)}
              accessibilityRole="button"
              accessibilityLabel={`${p.name} ${connected ? "connected" : "not connected"}`}
            >
              <IconCircle name={p.icon} tone={connected ? "primary" : "muted"} />
              <View style={styles.intText}>
                <Text style={styles.intName}>{p.name}</Text>
                <Text style={styles.intMeta}>{connected ? `Last sync ${timeAgo(status?.last_synced_at)}` : "Tap to connect"}</Text>
              </View>
              {syncing === p.key ? (
                <ActivityIndicator size="small" color={COLORS.primary} />
              ) : (
                <Pill label={connected ? "Connected" : "Not connected"} tone={connected ? "success" : "neutral"} />
              )}
              <Icon name="chevron-forward" size={16} color={COLORS.textSoft} />
            </TouchableOpacity>
          );
        })}
      </Card>

      <ActionButton label={syncing === "all" ? "Syncing..." : "Sync All Now"} onPress={syncAll} disabled={syncing !== null} />

      <SectionLabel>Sync History</SectionLabel>
      <Card style={styles.stack}>
        {runs.length === 0 ? (
          <Text style={styles.emptyText}>No syncs have run yet. Sync a provider to see history here.</Text>
        ) : (
          visibleRuns.map((run, i) => (
            <View key={run.id} style={[styles.histRow, i < visibleRuns.length - 1 && styles.intRowDivider]}>
              <IconCircle name="sync" tone="muted" size={34} />
              <View style={styles.intText}>
                <Text style={styles.intName}>{run.provider.charAt(0).toUpperCase() + run.provider.slice(1)} Sync</Text>
                <Text style={styles.intMeta}>{run.items_imported} imported · {run.items_updated} updated · {timeAgo(run.started_at)}</Text>
              </View>
              <Pill
                label={run.status === "completed" ? "Success" : run.status === "partial" ? "Partial" : run.status === "running" ? "Running" : "Failed"}
                tone={run.status === "completed" ? "success" : run.status === "partial" ? "warning" : run.status === "running" ? "info" : "danger"}
              />
            </View>
          ))
        )}
      </Card>
      {runs.length > 4 ? (
        <ActionButton label={showAll ? "Show less" : "View All History"} onPress={() => setShowAll((v) => !v)} tone="secondary" />
      ) : null}

      {issues.length > 0 ? (
        <>
          <SectionLabel>Reconciliation Issues</SectionLabel>
          <Card style={styles.stack}>
            {issues.map((issue, i) => (
              <View key={issue.id} style={[styles.histRow, i < issues.length - 1 && styles.intRowDivider]}>
                <IconCircle name="alert-circle-outline" tone="muted" size={34} color={COLORS.warning} />
                <View style={styles.intText}>
                  <Text style={styles.intName}>{issue.provider.charAt(0).toUpperCase() + issue.provider.slice(1)} · {issue.issue_type.replace(/_/g, " ")}</Text>
                  <Text style={styles.intMeta}>{issue.external_id || "No external id"} · {timeAgo(issue.detected_at)}</Text>
                </View>
                <Pill label={issue.status.toUpperCase()} tone={issue.status === "open" ? "warning" : "neutral"} />
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: { flex: 1, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center" },
  stack: { gap: 0, paddingVertical: SPACING.xs },
  intRow: { flexDirection: "row", alignItems: "center", gap: SPACING.md, paddingVertical: SPACING.sm },
  histRow: { flexDirection: "row", alignItems: "center", gap: SPACING.md, paddingVertical: SPACING.sm },
  intRowDivider: { borderBottomWidth: 1, borderBottomColor: COLORS.border },
  intText: { flex: 1, gap: 3 },
  intName: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  intMeta: { color: COLORS.textMuted, fontSize: 12 },
  emptyText: { color: COLORS.textMuted, fontSize: 13, paddingVertical: SPACING.sm },
});
