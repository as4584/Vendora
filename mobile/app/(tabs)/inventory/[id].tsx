/**
 * Item Detail Screen — /inventory/[id]
 *
 * Displays item details with status transition and soft-delete.
 */
import { useEffect, useState } from "react";
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as api from "../../../services/api";

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

const VALID_TRANSITIONS: Record<string, string[]> = {
    in_stock: ["listed", "sold"],
    listed: ["sold", "in_stock"],
    sold: ["shipped", "paid"],
    shipped: ["paid"],
    paid: ["archived"],
    archived: [],
};

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
        <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{label}</Text>
            <Text style={styles.detailValue}>{value}</Text>
        </View>
    );
}

export default function ItemDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [item, setItem] = useState<api.InventoryItem | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchItem = async () => {
        try {
            const data = await api.getItem(id!);
            setItem(data);
        } catch (err: any) {
            Alert.alert("Error", err.message || "Item not found.", [
                { text: "OK", onPress: () => router.back() },
            ]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchItem();
    }, [id]);

    const handleTransition = async (newStatus: string) => {
        try {
            const updated = await api.updateItemStatus(item!.id, newStatus);
            setItem(updated);
        } catch (err: any) {
            Alert.alert("Transition Failed", err.message || "Cannot change status.");
        }
    };

    const handleDelete = () => {
        Alert.alert(
            "Delete Item",
            "This item will be recoverable for 30 days. Continue?",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await api.deleteItem(item!.id);
                            Alert.alert("Deleted", "Item has been removed.", [
                                { text: "OK", onPress: () => router.replace("/(tabs)/inventory") },
                            ]);
                        } catch (err: any) {
                            Alert.alert("Error", err.message);
                        }
                    },
                },
            ]
        );
    };

    if (loading || !item) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    const transitions = VALID_TRANSITIONS[item.status] || [];

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* Header */}
            <Text style={styles.itemName}>{item.name}</Text>
            <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[item.status] }]}>
                <Text style={styles.statusText}>{item.status.replace("_", " ").toUpperCase()}</Text>
            </View>

            {/* Details */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Details</Text>
                <DetailRow label="Category" value={item.category} />
                <DetailRow label="SKU" value={item.sku} />
                <DetailRow label="UPC" value={item.upc} />
                <DetailRow label="Size" value={item.size} />
                <DetailRow label="Color" value={item.color} />
                <DetailRow label="Condition" value={item.condition} />
                <DetailRow label="Serial Number" value={item.serial_number} />
                <DetailRow label="Platform" value={item.platform} />
            </View>

            {/* Pricing */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Pricing</Text>
                <DetailRow label="Buy Price" value={item.buy_price ? `$${item.buy_price}` : null} />
                <DetailRow
                    label="Expected Sell"
                    value={item.expected_sell_price ? `$${item.expected_sell_price}` : null}
                />
                <DetailRow
                    label="Actual Sell"
                    value={item.actual_sell_price ? `$${item.actual_sell_price}` : null}
                />
                {item.buy_price && item.expected_sell_price && (
                    <DetailRow
                        label="Expected Profit"
                        value={`$${(parseFloat(item.expected_sell_price) - parseFloat(item.buy_price)).toFixed(2)}`}
                    />
                )}
            </View>

            {/* Status Transitions */}
            {transitions.length > 0 && (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Actions</Text>
                    <View style={styles.actionsRow}>
                        {transitions.map((status) => (
                            <TouchableOpacity
                                key={status}
                                style={[styles.transitionButton, { borderColor: STATUS_COLORS[status] }]}
                                onPress={() => handleTransition(status)}
                            >
                                <Text style={[styles.transitionText, { color: STATUS_COLORS[status] }]}>
                                    → {status.replace("_", " ").toUpperCase()}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}

            {/* Timestamps */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Timestamps</Text>
                <DetailRow label="Created" value={new Date(item.created_at).toLocaleDateString()} />
                <DetailRow label="Updated" value={new Date(item.updated_at).toLocaleDateString()} />
            </View>

            {/* Delete */}
            <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                <Text style={styles.deleteText}>🗑 Delete Item</Text>
            </TouchableOpacity>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    content: {
        padding: 20,
        paddingBottom: 40,
    },
    center: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#0A0A1A",
    },
    itemName: {
        fontSize: 24,
        fontWeight: "800",
        color: "#FFFFFF",
        marginBottom: 12,
    },
    statusBadge: {
        alignSelf: "flex-start",
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginBottom: 24,
    },
    statusText: {
        color: "#FFFFFF",
        fontSize: 12,
        fontWeight: "800",
        letterSpacing: 0.5,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: "800",
        color: "#6C5CE7",
        marginBottom: 12,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    detailRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A2E",
    },
    detailLabel: {
        color: "#888",
        fontSize: 14,
        fontWeight: "500",
    },
    detailValue: {
        color: "#FFFFFF",
        fontSize: 14,
        fontWeight: "600",
        maxWidth: "60%",
        textAlign: "right",
    },
    actionsRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 10,
    },
    transitionButton: {
        borderWidth: 1.5,
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    transitionText: {
        fontSize: 13,
        fontWeight: "700",
    },
    deleteButton: {
        backgroundColor: "#2D1F1F",
        borderWidth: 1,
        borderColor: "#E17055",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: 8,
    },
    deleteText: {
        color: "#E17055",
        fontSize: 15,
        fontWeight: "700",
    },
});
