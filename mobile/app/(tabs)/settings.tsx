/**
 * Settings Screen — user profile, tier info, sign out.
 */
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useAuth } from "../../context/auth";

export default function SettingsScreen() {
    const { user, signOut } = useAuth();

    const handleSignOut = () => {
        Alert.alert("Sign Out", "Are you sure?", [
            { text: "Cancel", style: "cancel" },
            {
                text: "Sign Out",
                style: "destructive",
                onPress: signOut,
            },
        ]);
    };

    return (
        <View style={styles.container}>
            {/* Profile Card */}
            <View style={styles.card}>
                <Text style={styles.avatar}>👤</Text>
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
                        <Text style={styles.partnerBadge}>✅ Active</Text>
                    </View>
                )}
                {user?.subscription_tier === "free" && (
                    <View style={styles.upgradeBox}>
                        <Text style={styles.upgradeText}>
                            🚀 Upgrade to Pro ($20/mo) for unlimited inventory, Stripe integration, and barcode scanning.
                        </Text>
                    </View>
                )}
            </View>

            {/* Account Info */}
            <View style={styles.card}>
                <Text style={styles.sectionTitle}>Account</Text>
                <View style={styles.tierRow}>
                    <Text style={styles.tierLabel}>Member Since</Text>
                    <Text style={styles.tierValue}>
                        {user?.created_at ? new Date(user.created_at).toLocaleDateString() : "—"}
                    </Text>
                </View>
            </View>

            {/* Sign Out */}
            <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                <Text style={styles.signOutText}>Sign Out</Text>
            </TouchableOpacity>

            {/* Version */}
            <Text style={styles.version}>Vendora v1.0.0</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
        padding: 20,
    },
    card: {
        backgroundColor: "#1A1A2E",
        borderRadius: 14,
        padding: 20,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    avatar: {
        fontSize: 48,
        textAlign: "center",
        marginBottom: 12,
    },
    email: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "700",
        textAlign: "center",
    },
    businessName: {
        color: "#888",
        fontSize: 14,
        textAlign: "center",
        marginTop: 4,
    },
    sectionTitle: {
        fontSize: 14,
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
    tierLabel: {
        color: "#888",
        fontSize: 14,
    },
    tierValue: {
        color: "#FFFFFF",
        fontSize: 14,
        fontWeight: "600",
    },
    tierBadge: {
        backgroundColor: "#6C5CE7",
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    tierBadgeText: {
        color: "#FFFFFF",
        fontSize: 12,
        fontWeight: "800",
    },
    partnerBadge: {
        color: "#00B894",
        fontSize: 14,
        fontWeight: "600",
    },
    upgradeBox: {
        backgroundColor: "#2A1B4E",
        borderRadius: 10,
        padding: 14,
        marginTop: 8,
    },
    upgradeText: {
        color: "#B8A9E8",
        fontSize: 13,
        lineHeight: 18,
    },
    signOutButton: {
        backgroundColor: "#2D1F1F",
        borderWidth: 1,
        borderColor: "#E17055",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: 8,
    },
    signOutText: {
        color: "#E17055",
        fontSize: 15,
        fontWeight: "700",
    },
    version: {
        color: "#555",
        fontSize: 12,
        textAlign: "center",
        marginTop: 24,
    },
});
