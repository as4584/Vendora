/**
 * Settings Screen â€” user profile, tier info, Lightspeed integration, sign out.
 */
import { useEffect, useState } from "react";
import {
    View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "../../context/auth";
import * as api from "../../services/api";
import { registerBackgroundSync, unregisterBackgroundSync } from "../../tasks/backgroundSync";

export default function SettingsScreen() {
    const { user, signOut } = useAuth();

    // Lightspeed state
    const [lsStatus, setLsStatus] = useState<api.LightspeedStatus | null>(null);
    const [lsLoading, setLsLoading] = useState(true);
    const [lsSyncing, setLsSyncing] = useState(false);

    const fetchLsStatus = async () => {
        try {
            const status = await api.getLightspeedStatus();
            setLsStatus(status);
            // Register background sync if connected
            if (status.connected) {
                await registerBackgroundSync().catch(() => {});
            }
        } catch {
            setLsStatus(null);
        } finally {
            setLsLoading(false);
        }
    };

    useEffect(() => { fetchLsStatus(); }, []);

    const handleConnectLightspeed = async () => {
        try {
            const { url } = await api.getLightspeedConnectUrl();
            await WebBrowser.openBrowserAsync(url);
            // Refresh status after OAuth redirect
            setLsLoading(true);
            await fetchLsStatus();
        } catch (err: any) {
            Alert.alert("Error", err.message || "Could not open Lightspeed auth.");
        }
    };

    const handleDisconnectLightspeed = async () => {
        Alert.alert("Disconnect Lightspeed", "Stop syncing from Lightspeed?", [
            { text: "Cancel", style: "cancel" },
            {
                text: "Disconnect",
                style: "destructive",
                onPress: async () => {
                    await unregisterBackgroundSync().catch(() => {});
                    setLsStatus(null);
                },
            },
        ]);
    };

    const handleSyncNow = async () => {
        setLsSyncing(true);
        try {
            const result = await api.triggerLightspeedSync();
            Alert.alert(
                "Sync Complete",
                `Synced ${result.synced_items} items and ${result.synced_transactions} transactions.`
            );
            await fetchLsStatus();
        } catch (err: any) {
            Alert.alert("Sync Failed", err.message || "Could not sync.");
        } finally {
            setLsSyncing(false);
        }
    };

    const handleSignOut = () => {
        Alert.alert("Sign Out", "Are you sure?", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign Out", style: "destructive", onPress: signOut },
        ]);
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* Profile Card */}
            <View style={styles.card}>
                <Text style={styles.avatar}>ðŸ‘¤</Text>
                <Text style={styles.email}>{user?.email}</Text>
                {user?.business_name && (
                    <Text style={styles.businessName}>{user.business_name}</Text>
                )}
            </View>

            {/* Tier Info */}
            <View style={styles.card}>
                <Text style={styles.sectionTitle}>Subscription</Text>
                <View style={styles.tierRow}>
                    <Text style={styles.tierLabel}>Plan</Text>
                    <View style={styles.tierBadge}>
                        <Text style={styles.tierBadgeText}>
                            {user?.subscription_tier?.toUpperCase() || "FREE"}
                        </Text>
                    </View>
                </View>
                {user?.is_partner && (
                    <View style={styles.tierRow}>
                        <Text style={styles.tierLabel}>Partner</Text>
                        <Text style={styles.partnerBadge}>âœ… Active</Text>
                    </View>
                )}
                {user?.subscription_tier === "free" && (
                    <View style={styles.upgradeBox}>
                        <Text style={styles.upgradeText}>
                            ðŸš€ Upgrade to Pro ($20/mo) for unlimited inventory, Stripe integration, and barcode scanning.
                        </Text>
                    </View>
                )}
            </View>

            {/* Lightspeed Integration */}
            <View style={styles.card}>
                <Text style={styles.sectionTitle}>Lightspeed POS</Text>
                {lsLoading ? (
                    <ActivityIndicator color="#6C5CE7" />
                ) : lsStatus?.connected ? (
                    <>
                        <View style={styles.tierRow}>
                            <Text style={styles.tierLabel}>Status</Text>
                            <Text style={styles.connectedBadge}>âœ… Connected</Text>
                        </View>
                        {lsStatus.account_id && (
                            <View style={styles.tierRow}>
                                <Text style={styles.tierLabel}>Account</Text>
                                <Text style={styles.tierValue}>{lsStatus.account_id}</Text>
                            </View>
                        )}
                        {lsStatus.last_synced_at && (
                            <View style={styles.tierRow}>
                                <Text style={styles.tierLabel}>Last Synced</Text>
                                <Text style={styles.tierValue}>
                                    {new Date(lsStatus.last_synced_at).toLocaleString()}
                                </Text>
                            </View>
                        )}
                        <TouchableOpacity
                            style={[styles.syncButton, lsSyncing && styles.syncButtonDisabled]}
                            onPress={handleSyncNow}
                            disabled={lsSyncing}
                        >
                            {lsSyncing
                                ? <ActivityIndicator size="small" color="#FFF" />
                                : <Text style={styles.syncButtonText}>ðŸ”„ Sync Now</Text>
                            }
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.disconnectButton} onPress={handleDisconnectLightspeed}>
                            <Text style={styles.disconnectText}>Disconnect</Text>
                        </TouchableOpacity>
                    </>
                ) : (
                    <>
                        <Text style={styles.lsDescription}>
                            Connect your Lightspeed POS to automatically sync inventory and sales. Background sync runs every 15 minutes.
                        </Text>
                        <TouchableOpacity style={styles.connectButton} onPress={handleConnectLightspeed}>
                            <Text style={styles.connectButtonText}>ðŸ”— Connect Lightspeed</Text>
                        </TouchableOpacity>
                    </>
                )}
            </View>

            {/* Account Info */}
            <View style={styles.card}>
                <Text style={styles.sectionTitle}>Account</Text>
                <View style={styles.tierRow}>
                    <Text style={styles.tierLabel}>Member Since</Text>
                    <Text style={styles.tierValue}>
                        {user?.created_at ? new Date(user.created_at).toLocaleDateString() : "â€”"}
                    </Text>
                </View>
            </View>

            {/* Sign Out */}
            <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                <Text style={styles.signOutText}>Sign Out</Text>
            </TouchableOpacity>

            <Text style={styles.version}>Vendora v1.0.0</Text>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    content: { padding: 20, paddingBottom: 40 },
    card: {
        backgroundColor: "#1A1A2E",
        borderRadius: 14,
        padding: 20,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    avatar: { fontSize: 48, textAlign: "center", marginBottom: 12 },
    email: { color: "#FFFFFF", fontSize: 16, fontWeight: "700", textAlign: "center" },
    businessName: { color: "#888", fontSize: 14, textAlign: "center", marginTop: 4 },
    sectionTitle: {
        fontSize: 13,
        fontWeight: "800",
        color: "#6C5CE7",
        marginBottom: 14,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    tierRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 10,
    },
    tierLabel: { color: "#888", fontSize: 14 },
    tierValue: { color: "#FFFFFF", fontSize: 13, fontWeight: "600", maxWidth: "55%", textAlign: "right" },
    tierBadge: { backgroundColor: "#6C5CE7", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
    tierBadgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
    partnerBadge: { color: "#00B894", fontSize: 14, fontWeight: "600" },
    connectedBadge: { color: "#00B894", fontSize: 14, fontWeight: "700" },
    upgradeBox: { backgroundColor: "#2A1B4E", borderRadius: 10, padding: 14, marginTop: 8 },
    upgradeText: { color: "#B8A9E8", fontSize: 13, lineHeight: 18 },

    // Lightspeed
    lsDescription: { color: "#888", fontSize: 13, lineHeight: 18, marginBottom: 14 },
    connectButton: {
        backgroundColor: "#E87D0D",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
    },
    connectButtonText: { color: "#FFF", fontSize: 15, fontWeight: "700" },
    syncButton: {
        backgroundColor: "#0984E3",
        borderRadius: 12,
        paddingVertical: 12,
        alignItems: "center",
        marginTop: 10,
    },
    syncButtonDisabled: { opacity: 0.6 },
    syncButtonText: { color: "#FFF", fontSize: 14, fontWeight: "700" },
    disconnectButton: {
        borderWidth: 1,
        borderColor: "#636E72",
        borderRadius: 12,
        paddingVertical: 10,
        alignItems: "center",
        marginTop: 8,
    },
    disconnectText: { color: "#636E72", fontSize: 13, fontWeight: "600" },

    // Sign out / footer
    signOutButton: {
        backgroundColor: "#2D1F1F",
        borderWidth: 1,
        borderColor: "#E17055",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: 8,
    },
    signOutText: { color: "#E17055", fontSize: 15, fontWeight: "700" },
    version: { color: "#555", fontSize: 12, textAlign: "center", marginTop: 24 },
});

