/**
 * Inventory Grid Screen
 *
 * Instagram-style 3-column photo grid. Each cell shows a photo
 * thumbnail (or placeholder icon), item name, status colour dot,
 * and a quantity badge. Tapping any card opens ItemQuickSheet
 * instead of navigating away (prevents the black-screen crash).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useFocusEffect } from "@react-navigation/native";
import * as api from "../../../services/api";
import ItemQuickSheet from "./components/ItemQuickSheet";

const { width: SCREEN_W } = Dimensions.get("window");
const GAP = 3;
const COLS = 3;
const CELL_SIZE = (SCREEN_W - GAP * (COLS + 1)) / COLS;
const IS_SMALL_SCREEN = SCREEN_W < 390;

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

/** Returns total qty: sum of variants if available, else item.quantity */
function resolveQty(item: api.InventoryItem): number {
    const v = item.custom_attributes?.variants;
    if (Array.isArray(v) && v.length > 0) {
        return v.reduce((acc: number, x: any) => acc + (x.quantity ?? 0), 0);
    }
    return item.quantity ?? 1;
}

function GridCell({
    item,
    onPress,
}: {
    item: api.InventoryItem;
    onPress: () => void;
}) {
    const dotColor = STATUS_COLORS[item.status] ?? "#636E72";
    const photoUri = (item.custom_attributes?.photo_front as string | undefined) ?? item.photo_front_url;
    const qty = resolveQty(item);

    return (
        <TouchableOpacity
            style={[styles.cell, { width: CELL_SIZE }]}
            onPress={onPress}
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

            {/* Quantity badge — top-left */}
            <View style={styles.qtyBadge}>
                <Text style={styles.qtyBadgeText}>{qty}</Text>
            </View>

            {item.status === "in_stock" && (
                <View style={styles.restockBadge}>
                    <Text style={styles.restockText}>IN</Text>
                </View>
            )}
        </TouchableOpacity>
    );
}

function getBrand(item: api.InventoryItem): string {
    const raw = item.custom_attributes?.brand;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return "Unbranded";
}

type GridEntry =
    | { type: "header"; key: string; brand: string; count: number }
    | { type: "row"; key: string; brand: string; items: (api.InventoryItem | null)[] };

export default function InventoryGridScreen() {
    const router = useRouter();
    const [items, setItems] = useState<api.InventoryItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pages, setPages] = useState(0);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [selectedBrandFilter, setSelectedBrandFilter] = useState<string | null>(null);

    // Quick Sheet state
    const [selectedItem, setSelectedItem] = useState<api.InventoryItem | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);

    const openSheet = (item: api.InventoryItem) => {
        setSelectedItem(item);
        setSheetOpen(true);
    };

    const closeSheet = () => setSheetOpen(false);

    // When a save happens in the sheet, update the item in-place
    const handleItemUpdated = (updated: api.InventoryItem) => {
        setItems((prev) =>
            prev.map((i) => (i.id === updated.id ? updated : i))
        );
        setSelectedItem(updated);
    };

    // When deleted in the sheet, remove from grid
    const handleItemDeleted = (id: string) => {
        setItems((prev) => prev.filter((i) => i.id !== id));
        setTotal((t) => Math.max(0, t - 1));
    };

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

    // Refresh when screen regains focus (e.g. returning from edit)
    useFocusEffect(
        useCallback(() => {
            fetchItems(1, true);
        }, [])
    );

    const onRefresh = () => { setRefreshing(true); fetchItems(1, true); };
    const onLoadMore = () => { if (page < pages && !loading) fetchItems(page + 1); };

    const existingBrands = useMemo<string[]>(() => {
        const set = new Set<string>();
        for (const item of items) {
            const brand = getBrand(item);
            if (brand !== "Unbranded") set.add(brand);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [items]);

    const groupedEntries = useMemo<GridEntry[]>(() => {
        const sourceItems = selectedBrandFilter
            ? items.filter((item) => getBrand(item) === selectedBrandFilter)
            : items;

        const groups = new Map<string, api.InventoryItem[]>();
        for (const item of sourceItems) {
            const brand = getBrand(item);
            const existing = groups.get(brand);
            if (existing) {
                existing.push(item);
            } else {
                groups.set(brand, [item]);
            }
        }

        const brands = Array.from(groups.keys()).sort((a, b) => {
            if (a === "Unbranded") return 1;
            if (b === "Unbranded") return -1;
            return a.localeCompare(b);
        });

        const out: GridEntry[] = [];
        for (const brand of brands) {
            const brandItems = groups.get(brand) ?? [];
            out.push({
                type: "header",
                key: `header-${brand}`,
                brand,
                count: brandItems.length,
            });

            for (let i = 0; i < brandItems.length; i += COLS) {
                const chunk = brandItems.slice(i, i + COLS);
                while (chunk.length < COLS) chunk.push(null);
                out.push({
                    type: "row",
                    key: `row-${brand}-${i}`,
                    brand,
                    items: chunk,
                });
            }
        }

        return out;
    }, [items, selectedBrandFilter]);

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

            {selectedBrandFilter && (
                <View style={styles.filterBar}>
                    <Text style={styles.filterLabel}>Filtered: {selectedBrandFilter}</Text>
                    <TouchableOpacity
                        style={styles.clearFilterBtn}
                        onPress={() => setSelectedBrandFilter(null)}
                        activeOpacity={0.8}
                    >
                        <Text style={styles.clearFilterText}>Clear</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* ── Grid ── */}
            <FlatList
                data={groupedEntries}
                keyExtractor={(entry) => entry.key}
                renderItem={({ item: entry }) => (
                    entry.type === "header" ? (
                        <TouchableOpacity
                            style={[
                                styles.brandHeader,
                                selectedBrandFilter === entry.brand && styles.brandHeaderActive,
                            ]}
                            onPress={() =>
                                setSelectedBrandFilter((prev) =>
                                    prev === entry.brand ? null : entry.brand
                                )
                            }
                            activeOpacity={0.8}
                        >
                            <Text
                                style={[
                                    styles.brandTitle,
                                    selectedBrandFilter === entry.brand && styles.brandTitleActive,
                                ]}
                            >
                                {entry.brand}
                            </Text>
                            <Text
                                style={[
                                    styles.brandCount,
                                    selectedBrandFilter === entry.brand && styles.brandCountActive,
                                ]}
                            >
                                {entry.count}
                            </Text>
                        </TouchableOpacity>
                    ) : (
                        <View style={styles.row}>
                            {entry.items.map((it, idx) =>
                                it ? (
                                    <GridCell key={it.id} item={it} onPress={() => openSheet(it)} />
                                ) : (
                                    <View key={`${entry.key}-spacer-${idx}`} style={[styles.cellSpacer, { width: CELL_SIZE }]} />
                                )
                            )}
                        </View>
                    )
                )}
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

            {/* ── Item Quick Sheet ── */}
            <ItemQuickSheet
                item={selectedItem}
                visible={sheetOpen}
                existingBrands={existingBrands}
                onClose={closeSheet}
                onItemUpdated={handleItemUpdated}
                onItemDeleted={handleItemDeleted}
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
    headerTitle: { color: "#FFFFFF", fontSize: IS_SMALL_SCREEN ? 17 : 18, fontWeight: "800" },
    headerSub: { color: "#888", fontSize: IS_SMALL_SCREEN ? 11 : 12, marginTop: 2 },
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
    legendLabel: { color: "#666", fontSize: IS_SMALL_SCREEN ? 9 : 10 },
    filterBar: {
        marginHorizontal: 14,
        marginBottom: 6,
        paddingHorizontal: 10,
        paddingVertical: IS_SMALL_SCREEN ? 7 : 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        backgroundColor: "#12122A",
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    filterLabel: {
        color: "#B7B7C7",
        fontSize: IS_SMALL_SCREEN ? 10 : 11,
        fontWeight: "700",
        flexShrink: 1,
        paddingRight: 8,
    },
    clearFilterBtn: {
        borderWidth: 1,
        borderColor: "#6C5CE7",
        borderRadius: 999,
        paddingHorizontal: IS_SMALL_SCREEN ? 8 : 10,
        paddingVertical: IS_SMALL_SCREEN ? 3 : 4,
        backgroundColor: "#1E1B3A",
    },
    clearFilterText: {
        color: "#A69BFF",
        fontSize: IS_SMALL_SCREEN ? 10 : 11,
        fontWeight: "700",
    },

    grid: { paddingHorizontal: GAP, paddingBottom: 30 },
    row: { gap: GAP, marginBottom: GAP },
    brandHeader: {
        marginTop: 10,
        marginBottom: 6,
        paddingHorizontal: 2,
        paddingVertical: 4,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },
    brandHeaderActive: {
        backgroundColor: "#1E1B3A",
        borderRadius: 8,
        paddingHorizontal: 8,
    },
    brandTitle: {
        color: "#B7B7C7",
        fontSize: IS_SMALL_SCREEN ? 11 : 12,
        fontWeight: "800",
        letterSpacing: 0.4,
        textTransform: "uppercase",
    },
    brandTitleActive: {
        color: "#6C5CE7",
    },
    brandCount: {
        color: "#777",
        fontSize: IS_SMALL_SCREEN ? 10 : 11,
        fontWeight: "700",
    },
    brandCountActive: {
        color: "#A69BFF",
    },

    cell: {
        height: CELL_SIZE,
        backgroundColor: "#1A1A2E",
        borderRadius: 6,
        overflow: "hidden",
    },
    cellSpacer: {
        height: CELL_SIZE,
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

    // Quantity badge — top-left corner
    qtyBadge: {
        position: "absolute",
        top: 4,
        left: 4,
        backgroundColor: "rgba(0,0,0,0.70)",
        borderRadius: 8,
        paddingHorizontal: 5,
        paddingVertical: 2,
        minWidth: 18,
        alignItems: "center",
    },
    qtyBadgeText: { color: "#FFF", fontSize: 9, fontWeight: "800" },

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
