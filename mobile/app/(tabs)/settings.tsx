import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  Image,
  Modal,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
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
  onPush,
  onDisconnect,
}: {
  name: string;
  connected: boolean;
  lastSynced?: string | null;
  helper: string;
  loading: boolean;
  syncing: boolean;
  onConnect: () => void;
  onSync: () => void;
  onPush?: () => void;
  onDisconnect?: () => void;
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
        {connected && onPush ? <ActionButton label="Push to POS" onPress={onPush} tone="secondary" compact /> : null}
        {connected && onDisconnect ? <ActionButton label="Disconnect" onPress={onDisconnect} tone="ghost" compact /> : null}
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
  const [connectionProvider, setConnectionProvider] = useState<"square" | "clover" | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);

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
    const timer = setTimeout(() => void fetchAll(), 0);
    return () => clearTimeout(timer);
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
      } catch (err: any) {
        Alert.alert("Photo update failed", err?.message || "Could not update your profile photo.");
      } finally {
        setPhotoSaving(false);
      }
    }
  };

  const handleConnectLightspeed = async () => {
    try {
      const { authorization_url } = await api.getLightspeedConnectUrl();
      await WebBrowser.openAuthSessionAsync(authorization_url, Linking.createURL("settings"));
      await registerBackgroundSync().catch(() => {});
      await fetchAll();
    } catch (err: any) {
      Alert.alert("Lightspeed unavailable", err?.message || "Could not open the Lightspeed connect flow.");
    }
  };

  const handleSyncLightspeed = async () => {
    setLsSyncing(true);
    try {
      await api.triggerLightspeedSync();
      await fetchAll();
      router.push("/settings/sync-center" as any);
    } catch (err: any) {
      Alert.alert("Lightspeed sync failed", err?.message || "Could not complete the Lightspeed sync.");
    } finally {
      setLsSyncing(false);
    }
  };

  const handlePushLightspeed = async () => {
    setLsSyncing(true);
    try {
      const result = await api.pushLightspeedInventory();
      Alert.alert("Lightspeed updated", `${result.items_updated} linked item${result.items_updated === 1 ? "" : "s"} pushed to the POS.${result.errors_count ? ` ${result.errors_count} failed.` : ""}`);
      await fetchAll();
    } catch (err: any) { Alert.alert("Lightspeed push failed", err?.message || "Could not publish inventory updates."); }
    finally { setLsSyncing(false); }
  };

  const handleDisconnectLightspeed = () => Alert.alert(
    "Disconnect Lightspeed?",
    "OAuth credentials will be removed. Existing inventory links stay available for a safe reconnect.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: async () => {
        try { await api.disconnectLightspeed(); await unregisterBackgroundSync().catch(() => {}); await fetchAll(); }
        catch (err: any) { Alert.alert("Disconnect failed", err?.message || "Could not disconnect Lightspeed."); }
      } },
    ],
  );

  const handleSyncSquare = async () => {
    setSqSyncing(true);
    try {
      await api.triggerSquareSync();
      await fetchAll();
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
      await fetchAll();
      router.push("/settings/sync-center" as any);
    } catch (err: any) {
      Alert.alert("Clover sync failed", err?.message || "Could not complete the Clover sync.");
    } finally {
      setCvSyncing(false);
    }
  };

  const openProviderConnection = (provider: "square" | "clover") => {
    setConnectionProvider(provider);
    setAccessToken("");
    setMerchantId("");
    setLocationId("");
  };

  const closeProviderConnection = () => {
    if (!connectionSaving) setConnectionProvider(null);
  };

  const handleSaveProviderConnection = async () => {
    if (!connectionProvider || !accessToken.trim()) {
      Alert.alert("Missing token", "Enter the provider access token.");
      return;
    }
    if (connectionProvider === "clover" && !merchantId.trim()) {
      Alert.alert("Missing merchant ID", "Clover requires a merchant ID.");
      return;
    }

    setConnectionSaving(true);
    try {
      if (connectionProvider === "square") {
        await api.connectSquare({
          access_token: accessToken.trim(),
          merchant_id: merchantId.trim() || undefined,
          location_id: locationId.trim() || undefined,
        });
      } else {
        await api.connectClover({
          access_token: accessToken.trim(),
          merchant_id: merchantId.trim(),
        });
      }
      const providerName = connectionProvider === "square" ? "Square" : "Clover";
      setConnectionProvider(null);
      await fetchAll();
      Alert.alert("Connected", `${providerName} is connected. You can sync inventory now.`);
    } catch (err: any) {
      Alert.alert("Connection failed", err?.message || "Could not save the provider connection.");
    } finally {
      setConnectionSaving(false);
    }
  };


  const handleConnectSquare = () => openProviderConnection("square");
  const handleConnectClover = () => openProviderConnection("clover");

  const handleDeleteAccount = async () => {
    if (!deletePassword || deleteConfirmation !== "DELETE") {
      Alert.alert("Confirmation required", 'Enter your password and type "DELETE" exactly.');
      return;
    }
    setDeleteSaving(true);
    try {
      await api.deleteAccount(deletePassword);
      setDeleteModalOpen(false);
      await signOut();
    } catch (err: any) {
      Alert.alert("Account deletion failed", err?.message || "Could not delete your account.");
    } finally {
      setDeleteSaving(false);
    }
  };

  return (
    <ScrollView testID="settings-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Settings" subtitle="Account profile, provider sync, and readiness signals for the seeded inventory workflow." />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Account</SectionLabel>
        <TouchableOpacity
          accessibilityLabel="Change profile photo"
          accessibilityRole="button"
          onPress={handleChangePhoto}
          activeOpacity={0.82}
          style={styles.profileRow}
        >
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
          <Pill label={user?.is_partner ? "✓ PARTNER" : user?.subscription_tier?.toUpperCase() || "FREE"} tone={user?.is_partner ? "success" : "primary"} />
        </TouchableOpacity>
      </Card>

      <Card style={{ gap: SPACING.sm }}>
        <SectionLabel>Vendora Plus</SectionLabel>
        <Text style={styles.helperText}>Billing, analytics, storefront, and support are now available in the app.</Text>
        <View style={styles.productActions}>
          <ActionButton label="Plans & Billing" onPress={() => router.push("/settings/subscription" as any)} tone="secondary" compact />
          <ActionButton label="Advanced Analytics" onPress={() => router.push("/settings/analytics" as any)} tone="secondary" compact />
          <ActionButton label="Support" onPress={() => router.push("/settings/support" as any)} tone="secondary" compact />
          {user?.is_partner ? <ActionButton label="View Public Storefront" onPress={() => router.push(`/seller/${user.id}` as any)} tone="secondary" compact /> : null}
        </View>
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
        onPush={handlePushLightspeed}
        onDisconnect={handleDisconnectLightspeed}
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

      <Modal
        visible={connectionProvider !== null}
        transparent
        animationType="fade"
        onRequestClose={closeProviderConnection}
      >
        <View style={styles.modalBackdrop}>
          <Card style={styles.modalCard}>
            <SectionLabel>
              Connect {connectionProvider === "square" ? "Square" : "Clover"}
            </SectionLabel>
            <Text style={styles.helperText}>
              Credentials are sent directly to Vendora and stored encrypted on the server.
            </Text>
            <Text style={styles.inputLabel}>Access token</Text>
            <TextInput
              accessibilityLabel="Provider access token"
              style={styles.connectionInput}
              value={accessToken}
              onChangeText={setAccessToken}
              placeholder="Paste access token"
              placeholderTextColor={COLORS.textSoft}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={styles.inputLabel}>
              Merchant ID {connectionProvider === "square" ? "(optional)" : ""}
            </Text>
            <TextInput
              accessibilityLabel="Merchant ID"
              style={styles.connectionInput}
              value={merchantId}
              onChangeText={setMerchantId}
              placeholder="Merchant ID"
              placeholderTextColor={COLORS.textSoft}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {connectionProvider === "square" ? (
              <>
                <Text style={styles.inputLabel}>Location ID (optional)</Text>
                <TextInput
                  accessibilityLabel="Location ID"
                  style={styles.connectionInput}
                  value={locationId}
                  onChangeText={setLocationId}
                  placeholder="Location ID"
                  placeholderTextColor={COLORS.textSoft}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            ) : null}
            <View style={styles.modalActions}>
              <ActionButton
                label="Cancel"
                onPress={closeProviderConnection}
                tone="secondary"
                compact
              />
              <ActionButton
                label={connectionSaving ? "Connecting..." : "Connect"}
                onPress={handleSaveProviderConnection}
                compact
              />
            </View>
          </Card>
        </View>
      </Modal>

      <Card style={{ gap: SPACING.sm }}>
        <SectionLabel>Danger Zone</SectionLabel>
        <Text style={styles.helperText}>Permanently deletes your account and Vendora-owned data.</Text>
        <ActionButton label="Delete Account" onPress={() => setDeleteModalOpen(true)} tone="ghost" />
      </Card>

      <Modal
        visible={deleteModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !deleteSaving && setDeleteModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Card style={styles.modalCard}>
            <SectionLabel>Delete Account Permanently</SectionLabel>
            <Text accessibilityRole="alert" style={styles.dangerText}>
              This cannot be undone. Inventory, transactions, invoices, and integrations will be deleted.
            </Text>
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              accessibilityLabel="Account password"
              style={styles.connectionInput}
              value={deletePassword}
              onChangeText={setDeletePassword}
              secureTextEntry
              autoCapitalize="none"
            />
            <Text style={styles.inputLabel}>Type DELETE to confirm</Text>
            <TextInput
              accessibilityLabel="Delete confirmation"
              style={styles.connectionInput}
              value={deleteConfirmation}
              onChangeText={setDeleteConfirmation}
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <ActionButton label="Cancel" onPress={() => setDeleteModalOpen(false)} tone="secondary" compact />
              <ActionButton
                label={deleteSaving ? "Deleting..." : "Delete Permanently"}
                onPress={handleDeleteAccount}
                disabled={deleteSaving}
                compact
              />
            </View>
          </Card>
        </View>
      </Modal>


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
  providerActions: { flexDirection: "row", justifyContent: "flex-start", flexWrap: "wrap", gap: SPACING.xs },
  productActions: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.lg,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    gap: SPACING.sm,
  },
  inputLabel: { color: COLORS.textSoft, fontSize: 12, fontWeight: "700", marginTop: SPACING.xs },
  connectionInput: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 12,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: SPACING.sm, marginTop: SPACING.sm },
  dangerText: { color: COLORS.danger, fontSize: 13, lineHeight: 19 },
});
