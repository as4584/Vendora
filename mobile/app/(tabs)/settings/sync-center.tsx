import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import * as api from "../../../services/api";
import { Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCompactDate } from "../../../utils/inventory";

export default function SyncCenterScreen() {
  const [runs, setRuns] = useState<api.ProviderSyncRun[]>([]);
  const [issues, setIssues] = useState<api.ReconciliationIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.listSyncRuns({ limit: 20 }),
      api.listReconciliationIssues({ limit: 20 }),
    ])
      .then(([syncRuns, reconciliationIssues]) => {
        setRuns(syncRuns);
        setIssues(reconciliationIssues);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Sync Center" subtitle="Recent provider sync runs and surfaced reconciliation issues." />

      <Card style={{ gap: SPACING.sm }}>
        <SectionLabel>Sync Runs</SectionLabel>
        {runs.length === 0 ? (
          <Text style={styles.helperText}>No provider sync runs have been recorded yet.</Text>
        ) : (
          runs.map((run) => (
            <View key={run.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{run.provider.toUpperCase()}</Text>
                <Text style={styles.helperText}>
                  {run.items_imported} imported • {run.items_updated} updated • {formatCompactDate(run.started_at)}
                </Text>
              </View>
              <Pill
                label={run.status.toUpperCase()}
                tone={run.status === "completed" ? "success" : run.status === "partial" ? "warning" : "danger"}
              />
            </View>
          ))
        )}
      </Card>

      <Card style={{ gap: SPACING.sm }}>
        <SectionLabel>Issues</SectionLabel>
        {issues.length === 0 ? (
          <Text style={styles.helperText}>No open reconciliation issues were found.</Text>
        ) : (
          issues.map((issue) => (
            <View key={issue.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{issue.provider.toUpperCase()} • {issue.issue_type.replace(/_/g, " ")}</Text>
                <Text style={styles.helperText}>
                  {issue.external_id || "No external id"} • {formatCompactDate(issue.detected_at)}
                </Text>
              </View>
              <Pill label={issue.status.toUpperCase()} tone={issue.status === "open" ? "warning" : "neutral"} />
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: { flex: 1, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  title: { color: COLORS.text, fontSize: 14, fontWeight: "800" },
  helperText: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
});
