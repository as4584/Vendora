import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  Image,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useAuth } from "../../context/auth";
import * as api from "../../services/api";
import { registerBackgroundSync, unregisterBackgroundSync } from "../../tasks/backgroundSync";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../components/ui";
import { COLORS, SPACING } from "../../theme/tokens";
import { formatCompactDate } from "../../utils/inventory";

function ProviderCard({
  name,
  connected,
  lastSynced,
  helper,
  loading,
  syncing,
  onConnect,
  onSync,
}: {
  name: string;
  connected: boolean;
  lastSynced?: string | null;
  helper: string;
  loading: boolean;
  syncing: boolean;
  onConnect: () => void;
  onSync: () => void;
}) {
  return (
    <Card style={{ gap: SPACING.sm }}>
      <View style={styles.providerHeader}>
        <Text style={styles.providerName}>{name}</Text>
        {loading ? (
          <ActivityIndicator size="small" color={COLORS.primary} />
        ) : (
          <Pill label={connected ? "Connected" : "Not connected"} tone={connected ? "success" : "neutral"} />
        )}
      </View>
      <Text style={styles.helperText}>{helper}</Text>
      <Text style={styles.helperText}>Last sync: {formatCompactDate(lastSynced)}</Text>
      <View style={styles.providerActions}>
        <ActionButton label={connected ? (syncing ? "Syncing..." : "Sync Now") : `Connect ${name}`} onPress={connected ? onSync : onConnect} tone={connected ? "primary" : "secondary"} compact />
      </View>
    </Card>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut, refreshUser } = useAuth();
  const [health, setHealth] = useState<api.ProviderHealthEntry[]>([]);
  const [lsStatus, setLsStatus] = useState<api.LightspeedStatus | null>(null);
  const [sqStatus, setSqStatus] = useState<api.SquareStatus | null>(null);
  const [cvStatus, setCvStatus] = useState<api.CloverStatus | null>(null);
  const [lsLoading, setLsLoading] = useState(true);
  const [sqLoading, setSqLoading] = useState(true);
  const [cvLoading, setCvLoading] = useState(true);
  const [lsSyncing, setLsSyncing] = useState(false);
  const [sqSyncing, setSqSyncing] = useState(false);
  const [cvSyncing, setCvSyncing] = useState(false);
  const [photoSaving, setPhotoSaving] = useState(false);

  const fetchAll = async () => {
    setLsLoading(true);
    setSqLoading(true);
    setCvLoading(true);
    const [ls, sq, cv, providerHealth] = await Promise.allSettled([
      api.getLightspeedStatus(),
      api.getSquareStatus(),
      api.getCloverStatus(),
      api.getProviderHealth(),
    ]);
    if (ls.status === "fulfilled") setLsStatus(ls.value); else setLsStatus(null);
    if (sq.status === "fulfilled") setSqStatus(sq.value); else setSqStatus(null);
    if (cv.status === "fulfilled") setCvStatus(cv.value); else setCvStatus(null);
    if (providerHealth.status === "fulfilled") setHealth(providerHealth.value.providers); else setHealth([]);
    setLsLoading(false);
    setSqLoading(false);
    setCvLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const issuesCount = useMemo(
    () => health.reduce((sum, entry) => sum + entry.open_issues_count, 0),
    [health]
  );

  const handleChangePhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("Permission required", "Allow photo library access to update your profile photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.6,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64) {
      setPhotoSaving(true);
      try {
        await api.updateProfile(user?.business_name, `data:image/jpeg;base64,${result.assets[0].base64}`);
        await refreshUser();
      } finally {
        setPhotoSaving(false);
      }
    }
  };

  const handleConnectLightspeed = async () => {
    try {
      const { authorization_url } = await api.getLightspeedConnectUrl();
      await WebBrowser.openBrowserAsync(authorization_url);
      await registerBackgroundSync().catch(() => {});
      fetchAll();
    } catch (err: any) {
      Alert.alert("Lightspeed unavailable", err?.message || "Could not open the Lightspeed connect flow.");
    }
  };

  const handleSyncLightspeed = async () => {
    setLsSyncing(true);
    try {
      await api.triggerLightspeedSync();
      fetchAll();
      router.push("/settings/sync-center" as any);
    } catch (err: any) {
      Alert.alert("Lightspeed sync failed", err?.message || "Could not complete the Lightspeed sync.");
    } finally {
      setLsSyncing(false);
    }
  };

  const handleSyncSquare = async () => {
    setSqSyncing(true);
    try {
      await api.triggerSquareSync();
      fetchAll();
      router.push("/settings/sync-center" as any);
    } catch (err: any) {
      Alert.alert("Square sync failed", err?.message || "Could not complete the Square sync.");
    } finally {
      setSqSyncing(false);
    }
  };

  const handleSyncClover = async () => {
    setCvSyncing(true);
    try {
      await api.triggerCloverSync();
      fetchAll();
      router.push("/settings/sync-center" as any);
    } catch (err: any) {
      Alert.alert("Clover sync failed", err?.message || "Could not complete the Clover sync.");
    } finally {
      setCvSyncing(false);
    }
  };

  const handleConnectSquare = async () => {
    Alert.alert("Square connection", "Use the seeded/test environment token when you are ready to connect Square.");
  };

  const handleConnectClover = async () => {
    Alert.alert("Clover connection", "Use the seeded/test environment token when you are ready to connect Clover.");
  };

  return (
    <ScrollView testID="settings-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Settings" subtitle="Account profile, provider sync, and readiness signals for the seeded inventory workflow." />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Account</SectionLabel>
        <TouchableOpacity onPress={handleChangePhoto} activeOpacity={0.82} style={styles.profileRow}>
          {user?.profile_picture ? (
            <Image source={{ uri: user.profile_picture }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              {photoSaving ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.avatarLetter}>{user?.email?.[0]?.toUpperCase() || "V"}</Text>}
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.emailText}>{user?.email}</Text>
            <Text style={styles.helperText}>{user?.business_name || "Ninja Resale"}</Text>
            <Text style={styles.helperText}>Tap profile photo to update the invoice identity.</Text>
          </View>
          <Pill label={user?.subscription_tier?.toUpperCase() || "FREE"} tone="primary" />
        </TouchableOpacity>
      </Card>

      <Card style={{ gap: SPACING.sm }}>
        <SectionLabel>Sync Overview</SectionLabel>
        <View style={styles.syncOverviewRow}>
          <View>
            <Text style={styles.syncStatValue}>{health.filter((entry) => entry.last_run_status === "completed" || entry.last_run_status === "partial").length}</Text>
            <Text style={styles.syncStatLabel}>Healthy providers</Text>
          </View>
          <View>
            <Text style={styles.syncStatValue}>{issuesCount}</Text>
            <Text style={styles.syncStatLabel}>Open issues</Text>
          </View>
          <View>
            <Text style={styles.syncStatValue}>{health.length}</Text>
            <Text style={styles.syncStatLabel}>Tracked providers</Text>
          </View>
        </View>
        <ActionButton label="Open Sync Center" onPress={() => router.push("/settings/sync-center" as any)} tone="secondary" />
      </Card>

      <SectionLabel>Integrations</SectionLabel>
      <ProviderCard
        name="Lightspeed"
        connected={lsStatus?.connected ?? false}
        lastSynced={lsStatus?.last_synced_at}
        helper="POS inventory source with recurring sync support."
        loading={lsLoading}
        syncing={lsSyncing}
        onConnect={handleConnectLightspeed}
        onSync={handleSyncLightspeed}
      />
      <ProviderCard
        name="Square"
        connected={sqStatus?.connected ?? false}
        lastSynced={sqStatus?.last_synced_at}
        helper="Connect Square to compare local inventory against your provider catalog."
        loading={sqLoading}
        syncing={sqSyncing}
        onConnect={handleConnectSquare}
        onSync={handleSyncSquare}
      />
      <ProviderCard
        name="Clover"
        connected={cvStatus?.connected ?? false}
        lastSynced={cvStatus?.last_synced_at}
        helper="Pull Clover inventory updates into the same stock dashboard."
        loading={cvLoading}
        syncing={cvSyncing}
        onConnect={handleConnectClover}
        onSync={handleSyncClover}
      />

      <ActionButton label="Sign Out" onPress={() => { unregisterBackgroundSync().catch(() => {}); signOut(); }} tone="ghost" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  profileRow: { flexDirection: "row", gap: SPACING.md, alignItems: "center" },
  avatar: { width: 72, height: 72, borderRadius: 24 },
  avatarFallback: {
    backgroundColor: COLORS.primarySoft,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  avatarLetter: { color: COLORS.text, fontSize: 28, fontWeight: "800" },
  emailText: { color: COLORS.text, fontSize: 15, fontWeight: "800" },
  helperText: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  syncOverviewRow: { flexDirection: "row", justifyContent: "space-between", gap: SPACING.md },
  syncStatValue: { color: COLORS.text, fontSize: 22, fontWeight: "800" },
  syncStatLabel: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  providerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: SPACING.sm },
  providerName: { color: COLORS.text, fontSize: 15, fontWeight: "800" },
  providerActions: { flexDirection: "row", justifyContent: "flex-start" },
});
