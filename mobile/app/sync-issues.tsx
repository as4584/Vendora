/**
 * Sync status screen: what's waiting to upload, when the last sync was, and
 * every offline change the server rejected, with the reason, so nothing is
 * lost silently.
 */
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNetwork } from "../context/network";
import { getFailedSyncs, subscribeSync, type FailedSync } from "../services/offline";
import { ActionButton, Card } from "../components/ui";
import { failedSyncLabel, syncSummary, timeAgo } from "../utils/syncStatus";
import { COLORS, SPACING } from "../theme/tokens";

export default function SyncIssuesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const net = useNetwork();
  const [failed, setFailed] = useState<FailedSync[]>([]);

  useFocusEffect(useCallback(() => {
    let live = true;
    const load = () => void getFailedSyncs().then((f) => { if (live) setFailed(f); }).catch(() => undefined);
    load();
    const unsub = subscribeSync(load);
    return () => { live = false; unsub(); };
  }, []));

  const { label } = syncSummary(net);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: SPACING.lg, paddingTop: insets.top + SPACING.lg }}>
      <Text accessibilityRole="header" style={styles.title}>Sync status</Text>
      <Card>
        <Text style={styles.status}>{label}</Text>
        <Text style={styles.muted}>
          {net.lastSync ? `Last synced ${timeAgo(net.lastSync)}.` : "Not synced yet on this phone."}
          {" "}Changes you make offline are saved on this phone and upload automatically when you're back online.
        </Text>
      </Card>

      <Text style={styles.section}>Changes that didn&apos;t sync</Text>
      {failed.length === 0 ? (
        <Card><Text style={styles.muted}>None. Everything you&apos;ve entered is saved.</Text></Card>
      ) : (
        <>
          {failed.slice().reverse().map((f) => (
            <Card key={f.id} style={styles.issue}>
              <Text style={styles.issueTitle}>{failedSyncLabel(f.kind)} · {timeAgo(f.createdAt)}</Text>
              <Text style={styles.muted}>{f.message}</Text>
            </Card>
          ))}
          <Text style={styles.muted}>Re-enter these from the right screen, then clear this list.</Text>
          <View style={styles.actions}>
            <ActionButton label="Clear list" tone="secondary" onPress={net.dismissFailed} />
          </View>
        </>
      )}
      <View style={styles.actions}>
        <ActionButton label="Done" tone="ghost" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 24, fontWeight: "700", marginBottom: SPACING.md },
  status: { color: COLORS.text, fontSize: 16, fontWeight: "600", marginBottom: SPACING.xs },
  muted: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  section: { color: COLORS.text, fontSize: 15, fontWeight: "600", marginTop: SPACING.lg, marginBottom: SPACING.sm },
  issue: { marginBottom: SPACING.sm },
  issueTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginBottom: 2 },
  actions: { marginTop: SPACING.md },
});
