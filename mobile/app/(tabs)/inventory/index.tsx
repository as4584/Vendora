/**
 * Inventory Grid Screen
 *
 * Instagram-style 3-column photo grid. Each cell shows a photo
 * thumbnail (or placeholder icon), item name, status colour dot,
 * and a "LOW STOCK" badge when the item has no stock.
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
    Dimensions,
    Image,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";

const { width: SCREEN_W } = Dimensions.get("window");
const GAP = 3;
const COLS = 3;
const CELL_SIZE = (SCREEN_W - GAP * (COLS + 1)) / COLS;

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

function GridCell({ item }: { item: api.InventoryItem }) {
    const router = useRouter();
    const dotColor = STATUS_COLORS[item.status] ?? "#636E72";
    const photoUri = (item as any).photo_front_url as string | null;

    return (
        <TouchableOpacity
            style={[styles.cell, { width: CELL_SIZE }]}
            onPress={() => router.push(`/(tabs)/inventory/${item.id}`)}
            activeOpacity={0.82}
        >
            {photoUri ? (
                <Image
                    source={{ uri: photoUri }}
                    style={styles.cellImage}
                    resizeMode="cover"
                />
            ) : (
                <View style={styles.cellPlaceholder}>
                    <Text style={styles.placeholderIcon}>📦</Text>
                </View>
            )}

            <View style={styles.cellOverlay}>
                <View style={[styles.dot, { backgroundColor: dotColor }]} />
                <Text style={styles.cellName} numberOfLines={2}>
                    {item.name}
                </Text>
                {item.expected_sell_price && (
                    <Text style={styles.cellPrice}>
                        ${parseFloat(item.expected_sell_price).toFixed(0)}
                    </Text>
                )}
            </View>

            {item.status === "in_stock" && (
                <View style={styles.restockBadge}>
                    <Text style={styles.restockText}>IN</Text>
                </View>
            )}
        </TouchableOpacity>
    );
}

export default function InventoryGridScreen() {
    const router = useRouter();
    const [items, setItems] = useState<api.InventoryItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pages, setPages] = useState(0);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    const fetchItems = useCallback(async (pageNum: number, refresh = false) => {
        try {
            const data = await api.listItems(pageNum, 30);
            if (refresh || pageNum === 1) {
                setItems(data.items);
            } else {
                setItems((prev) => [...prev, ...data.items]);
            }
            setTotal(data.total);
            setPages(data.pages);
            setPage(pageNum);
        } catch {
            // silent on pagination errors
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { fetchItems(1); }, []);

    const onRefresh = () => { setRefreshing(true); fetchItems(1, true); };
    const onLoadMore = () => { if (page < pages && !loading) fetchItems(page + 1); };

    if (loading && items.length === 0) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {/* ── Header ── */}
            <View style={styles.header}>
                <View>
                    <Text style={styles.headerTitle}>Warehouse Inventory</Text>
                    <Text style={styles.headerSub}>{total} item{total !== 1 ? "s" : ""}</Text>
                </View>
                <TouchableOpacity
                    style={styles.addButton}
                    onPress={() => router.push("/(tabs)/inventory/add")}
                >
                    <Text style={styles.addButtonText}>+ Add Stock</Text>
                </TouchableOpacity>
            </View>

            {/* ── Status legend ── */}
            <View style={styles.legend}>
                {Object.entries(STATUS_COLORS).map(([s, c]) => (
                    <View key={s} style={styles.legendItem}>
                        <View style={[styles.legendDot, { backgroundColor: c }]} />
                        <Text style={styles.legendLabel}>{s.replace("_", " ")}</Text>
                    </View>
                ))}
            </View>

            {/* ── Grid ── */}
            <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                numColumns={COLS}
                renderItem={({ item }) => <GridCell item={item} />}
                columnWrapperStyle={styles.row}
                contentContainerStyle={styles.grid}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor="#6C5CE7"
                        colors={["#6C5CE7"]}
                    />
                }
                onEndReached={onLoadMore}
                onEndReachedThreshold={0.4}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyIcon}>📭</Text>
                        <Text style={styles.emptyTitle}>No items yet</Text>
                        <Text style={styles.emptySubtitle}>
                            Tap "+ Add Stock" to create your first inventory item
                        </Text>
                    </View>
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0A0A1A" },

    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 14,
        paddingTop: 14,
        paddingBottom: 10,
    },
    headerTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
    headerSub: { color: "#888", fontSize: 12, marginTop: 2 },
    addButton: {
        backgroundColor: "#00B894",
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 10,
    },
    addButtonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },

    legend: {
        flexDirection: "row",
        flexWrap: "wrap",
        paddingHorizontal: 14,
        paddingBottom: 8,
        gap: 8,
    },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    legendDot: { width: 6, height: 6, borderRadius: 3 },
    legendLabel: { color: "#666", fontSize: 10 },

    grid: { paddingHorizontal: GAP, paddingBottom: 30 },
    row: { gap: GAP, marginBottom: GAP },

    cell: {
        height: CELL_SIZE,
        backgroundColor: "#1A1A2E",
        borderRadius: 6,
        overflow: "hidden",
    },
    cellImage: { width: "100%", height: "100%" },
    cellPlaceholder: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#16213E",
    },
    placeholderIcon: { fontSize: 28 },

    cellOverlay: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: "rgba(0,0,0,0.62)",
        padding: 5,
    },
    dot: { width: 6, height: 6, borderRadius: 3, marginBottom: 3 },
    cellName: { color: "#FFF", fontSize: 10, fontWeight: "600", lineHeight: 13 },
    cellPrice: { color: "#00B894", fontSize: 10, fontWeight: "700", marginTop: 1 },

    restockBadge: {
        position: "absolute",
        top: 4,
        right: 4,
        backgroundColor: "#00B894",
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: 4,
    },
    restockText: { color: "#FFF", fontSize: 8, fontWeight: "800" },

    emptyContainer: { alignItems: "center", marginTop: 80 },
    emptyIcon: { fontSize: 64, marginBottom: 16 },
    emptyTitle: { fontSize: 20, fontWeight: "700", color: "#FFFFFF", marginBottom: 8 },
    emptySubtitle: { fontSize: 14, color: "#888", textAlign: "center", paddingHorizontal: 40 },
});
