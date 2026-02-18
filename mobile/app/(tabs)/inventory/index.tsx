/**
 * Inventory List Screen
 *
 * Displays paginated inventory items with status badges.
 * Pull-to-refresh and load more on scroll.
 */
import { useCallback, useEffect, useState } from "react";
import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    Alert,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

function StatusBadge({ status }: { status: string }) {
    return (
        <View style={[styles.badge, { backgroundColor: STATUS_COLORS[status] || "#636E72" }]}>
            <Text style={styles.badgeText}>{status.replace("_", " ").toUpperCase()}</Text>
        </View>
    );
}

export default function InventoryListScreen() {
    const router = useRouter();
    const [items, setItems] = useState<api.InventoryItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pages, setPages] = useState(0);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const fetchItems = useCallback(async (pageNum: number, refresh = false) => {
        try {
            const data = await api.listItems(pageNum, 20);
            if (refresh || pageNum === 1) {
                setItems(data.items);
            } else {
                setItems((prev) => [...prev, ...data.items]);
            }
            setTotal(data.total);
            setPages(data.pages);
            setPage(pageNum);
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to load inventory.");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        fetchItems(1);
    }, []);

    const onRefresh = () => {
        setRefreshing(true);
        fetchItems(1, true);
    };

    const onLoadMore = () => {
        if (page < pages && !loading) {
            fetchItems(page + 1);
        }
    };

    const renderItem = ({ item }: { item: api.InventoryItem }) => (
        <TouchableOpacity
            style={styles.card}
            onPress={() => router.push(`/(tabs)/inventory/${item.id}`)}
            activeOpacity={0.7}
        >
            <View style={styles.cardHeader}>
                <Text style={styles.itemName} numberOfLines={1}>
                    {item.name}
                </Text>
                <StatusBadge status={item.status} />
            </View>

            <View style={styles.cardMeta}>
                {item.category && (
                    <Text style={styles.metaText}>📁 {item.category}</Text>
                )}
                {item.buy_price && (
                    <Text style={styles.metaText}>💰 ${item.buy_price}</Text>
                )}
                {item.platform && (
                    <Text style={styles.metaText}>🏪 {item.platform}</Text>
                )}
            </View>
        </TouchableOpacity>
    );

    if (loading && items.length === 0) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* Stats bar */}
            <View style={styles.statsBar}>
                <Text style={styles.statsText}>{total} item{total !== 1 ? "s" : ""}</Text>
            </View>

            <FlatList
                data={items}
                renderItem={renderItem}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.list}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor="#6C5CE7"
                        colors={["#6C5CE7"]}
                    />
                }
                onEndReached={onLoadMore}
                onEndReachedThreshold={0.3}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyIcon}>📭</Text>
                        <Text style={styles.emptyTitle}>No items yet</Text>
                        <Text style={styles.emptySubtitle}>
                            Tap the + tab to add your first inventory item
                        </Text>
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    center: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#0A0A1A",
    },
    statsBar: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A2E",
    },
    statsText: {
        color: "#888",
        fontSize: 13,
        fontWeight: "600",
    },
    list: {
        padding: 16,
        gap: 12,
    },
    card: {
        backgroundColor: "#1A1A2E",
        borderRadius: 14,
        padding: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    cardHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 10,
    },
    itemName: {
        fontSize: 16,
        fontWeight: "700",
        color: "#FFFFFF",
        flex: 1,
        marginRight: 10,
    },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
    },
    badgeText: {
        color: "#FFFFFF",
        fontSize: 10,
        fontWeight: "800",
        letterSpacing: 0.5,
    },
    cardMeta: {
        flexDirection: "row",
        gap: 16,
    },
    metaText: {
        color: "#999",
        fontSize: 12,
    },
    emptyContainer: {
        alignItems: "center",
        marginTop: 80,
    },
    emptyIcon: {
        fontSize: 64,
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        fontWeight: "700",
        color: "#FFFFFF",
        marginBottom: 8,
    },
    emptySubtitle: {
        fontSize: 14,
        color: "#888",
        textAlign: "center",
        paddingHorizontal: 40,
    },
});
