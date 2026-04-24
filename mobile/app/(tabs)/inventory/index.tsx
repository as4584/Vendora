/**
 * Inventory List Screen
 *
 * Card-based list with search, status/source filter chips, and
 * Import/Export actions. Tapping a card opens the ItemQuickSheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    RefreshControl,
    TextInput,
    Alert,
    Image,
    ScrollView,
    Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import * as api from "../../../services/api";
import ItemQuickSheet from "./components/ItemQuickSheet";

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed:   "#0984E3",
    sold:     "#E17055",
    shipped:  "#FDCB6E",
    paid:     "#6C5CE7",
    archived: "#636E72",
};

const STATUS_LABELS: Record<string, string> = {
    in_stock: "In Stock",
    listed:   "Listed",
    sold:     "Sold",
    shipped:  "Shipped",
    paid:     "Paid",
    archived: "Archived",
};

const SOURCE_LABELS: Record<string, string> = {
    lightspeed: "Lightspeed",
    square:     "Square",
    clover:     "Clover",
    manual:     "Manual",
};

const SOURCE_COLORS: Record<string, string> = {
    lightspeed: "#FF6B35",
    square:     "#3E9BFF",
    clover:     "#00C853",
    manual:     "#A0AEC0",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveQty(item: api.InventoryItem): number {
    const v = item.custom_attributes?.variants;
    if (Array.isArray(v) && v.length > 0) {
        return v.reduce((acc: number, x: any) => acc + (x.quantity ?? 0), 0);
    }
    return item.quantity ?? 0;
}

function getSourceLabel(item: api.InventoryItem): string | null {
    const src = item.source ?? item.custom_attributes?.source ?? null;
    if (!src) return null;
    return SOURCE_LABELS[src] ?? src;
}

function getSourceColor(item: api.InventoryItem): string {
    const src = item.source ?? item.custom_attributes?.source ?? "";
    return SOURCE_COLORS[src] ?? "#A0AEC0";
}

function formatPrice(val: string | null): string | null {
    if (!val) return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    return `$${n.toFixed(2)}`;
}

// ─── InventoryCard ────────────────────────────────────────────────────────────

function InventoryCard({
    item,
    onPress,
}: {
    item: api.InventoryItem;
    onPress: () => void;
}) {
    const dotColor  = STATUS_COLORS[item.status] ?? "#636E72";
    const statusLabel = STATUS_LABELS[item.status] ?? item.status;
    const srcLabel  = getSourceLabel(item);
    const srcColor  = getSourceColor(item);
    const qty       = resolveQty(item);
    const sellPrice = formatPrice(item.expected_sell_price);
    const buyPrice  = formatPrice(item.buy_price);
    const photoUri  = (item.custom_attributes?.photo_front as string | undefined) ?? item.photo_front_url;

    const isLowStock = qty > 0 && qty <= 3 && item.status === "in_stock";
    const isOOS      = qty === 0 && item.status === "in_stock";

    return (
        <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.78}>
            {/* Thumbnail */}
            <View style={styles.cardThumb}>
                {photoUri ? (
                    <Image source={{ uri: photoUri }} style={styles.thumbImage} resizeMode="cover" />
                ) : (
                    <View style={styles.thumbPlaceholder}>
                        <Text style={styles.thumbIcon}>📦</Text>
                    </View>
                )}
            </View>

            {/* Body */}
            <View style={styles.cardBody}>
                <View style={styles.cardTopRow}>
                    <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
                    {sellPrice && (
                        <Text style={styles.cardPrice}>{sellPrice}</Text>
                    )}
                </View>

                {/* Meta row: category, sku */}
                {(item.category || item.sku) && (
                    <Text style={styles.cardMeta} numberOfLines={1}>
                        {[item.category, item.sku ? `SKU: ${item.sku}` : null]
                            .filter(Boolean)
                            .join("  ·  ")}
                    </Text>
                )}

                <View style={styles.cardBottomRow}>
                    {/* Status pill */}
                    <View style={[styles.statusPill, { borderColor: dotColor }]}>
                        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
                        <Text style={[styles.statusLabel, { color: dotColor }]}>{statusLabel}</Text>
                    </View>

                    {/* Quantity */}
                    <View style={[
                        styles.qtyChip,
                        isOOS      && styles.qtyChipOOS,
                        isLowStock && styles.qtyChipLow,
                    ]}>
                        <Text style={[
                            styles.qtyText,
                            isOOS      && styles.qtyTextOOS,
                            isLowStock && styles.qtyTextLow,
                        ]}>
                            {isOOS ? "Out of stock" : `Qty: ${qty}`}
                        </Text>
                    </View>

                    {/* Source badge */}
                    {srcLabel && (
                        <View style={[styles.sourceBadge, { backgroundColor: srcColor + "22", borderColor: srcColor + "55" }]}>
                            <Text style={[styles.sourceText, { color: srcColor }]}>{srcLabel}</Text>
                        </View>
                    )}
                </View>
            </View>
        </TouchableOpacity>
    );
}

// ─── FilterChip ──────────────────────────────────────────────────────────────

function FilterChip({
    label,
    color,
    active,
    onPress,
}: {
    label: string;
    color?: string;
    active: boolean;
    onPress: () => void;
}) {
    const accentColor = color ?? "#6C5CE7";
    return (
        <TouchableOpacity
            style={[
                styles.chip,
                active && { backgroundColor: accentColor + "22", borderColor: accentColor },
            ]}
            onPress={onPress}
            activeOpacity={0.75}
        >
            {color && <View style={[styles.chipDot, { backgroundColor: color }]} />}
            <Text style={[styles.chipLabel, active && { color: accentColor, fontWeight: "700" }]}>
                {label}
            </Text>
        </TouchableOpacity>
    );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function InventoryListScreen() {
    const router = useRouter();

    const [items,      setItems]      = useState<api.InventoryItem[]>([]);
    const [total,      setTotal]      = useState(0);
    const [page,       setPage]       = useState(1);
    const [pages,      setPages]      = useState(0);
    const [loading,    setLoading]    = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    // Filters
    const [searchQuery,    setSearchQuery]    = useState("");
    const [statusFilter,   setStatusFilter]   = useState<string | null>(null);
    const [sourceFilter,   setSourceFilter]   = useState<string | null>(null);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSearch = useRef("");

    // Quick Sheet
    const [selectedItem, setSelectedItem] = useState<api.InventoryItem | null>(null);
    const [sheetOpen,    setSheetOpen]    = useState(false);

    // Export state
    const [exporting, setExporting] = useState(false);

    // ── Fetch ──────────────────────────────────────────────────────────────────

    const fetchItems = useCallback(async (
        opts: { page?: number; q?: string; status?: string | null; source?: string | null; refresh?: boolean } = {}
    ) => {
        const pg       = opts.page   ?? 1;
        const q        = opts.q      ?? pendingSearch.current;
        const status   = opts.status  !== undefined ? opts.status  : statusFilter;
        const source   = opts.source  !== undefined ? opts.source  : sourceFilter;
        const refresh  = opts.refresh ?? pg === 1;

        try {
            const data = await api.listItems({
                page:   pg,
                perPage: 30,
                q:      q || undefined,
                status: status ?? undefined,
                source: source ?? undefined,
            });
            setItems(prev => refresh ? data.items : [...prev, ...data.items]);
            setTotal(data.total);
            setPages(data.pages);
            setPage(pg);
        } catch {
            // silent
        } finally {
            setLoading(false);
            setRefreshing(false);
            setLoadingMore(false);
        }
    }, [statusFilter, sourceFilter]);

    useEffect(() => { fetchItems(); }, []);

    useFocusEffect(
        useCallback(() => {
            fetchItems({ refresh: true });
        }, [fetchItems])
    );

    // ── Search debounce ────────────────────────────────────────────────────────

    const onSearchChange = (text: string) => {
        setSearchQuery(text);
        pendingSearch.current = text;
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setLoading(true);
            fetchItems({ page: 1, q: text, refresh: true });
        }, 350);
    };

    // ── Status filter ──────────────────────────────────────────────────────────

    const onStatusChip = (status: string) => {
        const next = statusFilter === status ? null : status;
        setStatusFilter(next);
        setLoading(true);
        fetchItems({ page: 1, status: next, refresh: true });
    };

    // ── Source filter ──────────────────────────────────────────────────────────

    const onSourceChip = (source: string) => {
        const next = sourceFilter === source ? null : source;
        setSourceFilter(next);
        setLoading(true);
        fetchItems({ page: 1, source: next, refresh: true });
    };

    // ── Refresh / Load more ────────────────────────────────────────────────────

    const onRefresh = () => {
        setRefreshing(true);
        fetchItems({ page: 1, refresh: true });
    };

    const onLoadMore = () => {
        if (page < pages && !loading && !loadingMore) {
            setLoadingMore(true);
            fetchItems({ page: page + 1, refresh: false });
        }
    };

    // ── Quick Sheet callbacks ──────────────────────────────────────────────────

    const handleItemUpdated = (updated: api.InventoryItem) => {
        setItems(prev => prev.map(i => i.id === updated.id ? updated : i));
        setSelectedItem(updated);
    };

    const handleItemDeleted = (id: string) => {
        setItems(prev => prev.filter(i => i.id !== id));
        setTotal(t => Math.max(0, t - 1));
    };

    // ── Export ─────────────────────────────────────────────────────────────────

    const handleExport = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const csv = await api.exportInventoryCSV();
            Alert.alert(
                "Export ready",
                `${csv.split("\n").length - 1} rows exported. Share or save from here.`,
                [{ text: "OK" }]
            );
        } catch (e: any) {
            Alert.alert("Export failed", e?.message ?? "Unknown error");
        } finally {
            setExporting(false);
        }
    };

    // ── Sources present in current result set ──────────────────────────────────

    const availableSources = useMemo(() => {
        const seen = new Set<string>();
        for (const item of items) {
            const s = item.source ?? (item.custom_attributes?.source as string | undefined);
            if (s) seen.add(s);
        }
        return Array.from(seen);
    }, [items]);

    // ── Render ─────────────────────────────────────────────────────────────────

    const hasActiveFilters = !!(searchQuery || statusFilter || sourceFilter);

    return (
        <View style={styles.container}>

            {/* ── Header ──────────────────────────────────────────────────── */}
            <View style={styles.header}>
                <View>
                    <Text style={styles.headerTitle}>Inventory</Text>
                    <Text style={styles.headerSub}>
                        {loading && items.length === 0
                            ? "Loading…"
                            : `${total.toLocaleString()} item${total !== 1 ? "s" : ""}`}
                    </Text>
                </View>
                <View style={styles.headerActions}>
                    <TouchableOpacity
                        style={styles.actionBtn}
                        onPress={handleExport}
                        disabled={exporting}
                        activeOpacity={0.75}
                    >
                        <Text style={styles.actionBtnText}>
                            {exporting ? "…" : "Export"}
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.actionBtnSecondary}
                        onPress={() => router.push("/(tabs)/inventory/add")}
                        activeOpacity={0.75}
                    >
                        <Text style={styles.actionBtnSecondaryText}>+ Add</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* ── Search bar ──────────────────────────────────────────────── */}
            <View style={styles.searchRow}>
                <View style={styles.searchWrap}>
                    <Text style={styles.searchIcon}>🔍</Text>
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Search items, SKU, UPC…"
                        placeholderTextColor="#555"
                        value={searchQuery}
                        onChangeText={onSearchChange}
                        autoCorrect={false}
                        autoCapitalize="none"
                        returnKeyType="search"
                    />
                    {searchQuery.length > 0 && (
                        <TouchableOpacity onPress={() => onSearchChange("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.clearIcon}>✕</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>

            {/* ── Status chips ─────────────────────────────────────────────── */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.chipScrollView}
                contentContainerStyle={styles.chipScrollContent}
            >
                {Object.entries(STATUS_LABELS).map(([key, label]) => (
                    <FilterChip
                        key={key}
                        label={label}
                        color={STATUS_COLORS[key]}
                        active={statusFilter === key}
                        onPress={() => onStatusChip(key)}
                    />
                ))}
                {/* Source chips — only if sources are known */}
                {availableSources.length > 0 && (
                    <View style={styles.chipDivider} />
                )}
                {availableSources.map((src) => (
                    <FilterChip
                        key={`src-${src}`}
                        label={SOURCE_LABELS[src] ?? src}
                        color={SOURCE_COLORS[src]}
                        active={sourceFilter === src}
                        onPress={() => onSourceChip(src)}
                    />
                ))}
                {/* Always show known POS sources for filtering */}
                {["lightspeed", "square", "clover"].filter(s => !availableSources.includes(s)).map((src) => (
                    <FilterChip
                        key={`srchidden-${src}`}
                        label={SOURCE_LABELS[src]}
                        color={SOURCE_COLORS[src]}
                        active={sourceFilter === src}
                        onPress={() => onSourceChip(src)}
                    />
                ))}
            </ScrollView>

            {/* ── Active filter summary ────────────────────────────────────── */}
            {hasActiveFilters && (
                <View style={styles.filterSummary}>
                    <Text style={styles.filterSummaryText}>
                        {[
                            searchQuery ? `"${searchQuery}"` : null,
                            statusFilter ? STATUS_LABELS[statusFilter] : null,
                            sourceFilter ? (SOURCE_LABELS[sourceFilter] ?? sourceFilter) : null,
                        ].filter(Boolean).join("  ·  ")}
                    </Text>
                    <TouchableOpacity
                        onPress={() => {
                            setSearchQuery("");
                            setStatusFilter(null);
                            setSourceFilter(null);
                            pendingSearch.current = "";
                            setLoading(true);
                            fetchItems({ page: 1, q: "", status: null, source: null, refresh: true });
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 12, right: 8 }}
                    >
                        <Text style={styles.clearAllText}>Clear all</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* ── List ────────────────────────────────────────────────────── */}
            {loading && items.length === 0 ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" color="#6C5CE7" />
                </View>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={({ item }) => (
                        <InventoryCard
                            item={item}
                            onPress={() => { setSelectedItem(item); setSheetOpen(true); }}
                        />
                    )}
                    contentContainerStyle={styles.listContent}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
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
                    ListFooterComponent={
                        loadingMore ? (
                            <View style={styles.footerLoader}>
                                <ActivityIndicator size="small" color="#6C5CE7" />
                            </View>
                        ) : null
                    }
                    ListEmptyComponent={
                        !loading ? (
                            <View style={styles.emptyContainer}>
                                <Text style={styles.emptyIcon}>📭</Text>
                                <Text style={styles.emptyTitle}>
                                    {hasActiveFilters ? "No matches" : "No items yet"}
                                </Text>
                                <Text style={styles.emptySubtitle}>
                                    {hasActiveFilters
                                        ? "Try adjusting your search or filters."
                                        : "Tap \"+\u00a0Add\" to create your first item."}
                                </Text>
                            </View>
                        ) : null
                    }
                />
            )}

            {/* ── Quick Sheet ──────────────────────────────────────────────── */}
            <ItemQuickSheet
                item={selectedItem}
                visible={sheetOpen}
                existingBrands={[]}
                onClose={() => setSheetOpen(false)}
                onItemUpdated={handleItemUpdated}
                onItemDeleted={handleItemDeleted}
            />
        </View>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container:  { flex: 1, backgroundColor: "#0A0A1A" },
    center:     { flex: 1, justifyContent: "center", alignItems: "center" },

    // Header
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingTop: Platform.OS === "android" ? 14 : 14,
        paddingBottom: 10,
    },
    headerTitle: { color: "#FFFFFF", fontSize: 22, fontWeight: "800" },
    headerSub:   { color: "#666", fontSize: 12, marginTop: 2 },
    headerActions: { flexDirection: "row", gap: 8 },
    actionBtn: {
        backgroundColor: "#1E1B3A",
        borderWidth: 1,
        borderColor: "#3A3A6A",
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 10,
    },
    actionBtnText: { color: "#A0A0D0", fontSize: 13, fontWeight: "600" },
    actionBtnSecondary: {
        backgroundColor: "#00B894",
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 10,
    },
    actionBtnSecondaryText: { color: "#FFF", fontSize: 13, fontWeight: "700" },

    // Search
    searchRow: { paddingHorizontal: 16, marginBottom: 10 },
    searchWrap: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#12122A",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#252550",
        paddingHorizontal: 12,
        paddingVertical: 9,
        gap: 8,
    },
    searchIcon:  { fontSize: 14 },
    searchInput: { flex: 1, color: "#FFFFFF", fontSize: 14, padding: 0 },
    clearIcon:   { color: "#555", fontSize: 14, paddingLeft: 4 },

    // Chips
    chipScrollView:    { flexGrow: 0, marginBottom: 8 },
    chipScrollContent: { paddingHorizontal: 16, gap: 8, flexDirection: "row", alignItems: "center" },
    chip: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        backgroundColor: "#12122A",
        gap: 5,
    },
    chipDot:   { width: 7, height: 7, borderRadius: 4 },
    chipLabel: { color: "#777", fontSize: 12, fontWeight: "500" },
    chipDivider: {
        width: 1,
        height: 20,
        backgroundColor: "#2A2A4A",
        marginHorizontal: 4,
    },

    // Filter summary bar
    filterSummary: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginHorizontal: 16,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        backgroundColor: "#1A1A38",
        borderWidth: 1,
        borderColor: "#2A2A5A",
    },
    filterSummaryText: { color: "#9090C0", fontSize: 12, flex: 1, flexShrink: 1 },
    clearAllText:      { color: "#6C5CE7", fontSize: 12, fontWeight: "700", marginLeft: 8 },

    // List
    listContent: { paddingHorizontal: 16, paddingBottom: 24 },
    separator:   { height: 8 },
    footerLoader: { paddingVertical: 20, alignItems: "center" },

    // Card
    card: {
        flexDirection: "row",
        backgroundColor: "#12122A",
        borderRadius: 14,
        borderWidth: 1,
        borderColor: "#1E1E40",
        overflow: "hidden",
    },
    cardThumb: {
        width: 76,
        height: 76,
        backgroundColor: "#0E0E24",
        alignSelf: "stretch",
    },
    thumbImage: { width: "100%", height: "100%" },
    thumbPlaceholder: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#16163A",
    },
    thumbIcon: { fontSize: 26 },

    cardBody: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        justifyContent: "space-between",
    },
    cardTopRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 6,
    },
    cardName: {
        flex: 1,
        color: "#FFFFFF",
        fontSize: 14,
        fontWeight: "700",
        lineHeight: 18,
    },
    cardPrice: {
        color: "#00B894",
        fontSize: 14,
        fontWeight: "800",
        flexShrink: 0,
    },
    cardMeta: {
        color: "#555577",
        fontSize: 11,
        marginTop: 3,
    },
    cardBottomRow: {
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 8,
    },

    // Status pill
    statusPill: {
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        backgroundColor: "transparent",
    },
    statusDot:   { width: 6, height: 6, borderRadius: 3 },
    statusLabel: { fontSize: 11, fontWeight: "600" },

    // Qty chip
    qtyChip: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: "#1E1E40",
    },
    qtyChipLow: { backgroundColor: "#3D2B00" },
    qtyChipOOS: { backgroundColor: "#2D0A0A" },
    qtyText:    { color: "#8888AA", fontSize: 11, fontWeight: "600" },
    qtyTextLow: { color: "#FDCB6E" },
    qtyTextOOS: { color: "#E17055" },

    // Source badge
    sourceBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
    },
    sourceText: { fontSize: 11, fontWeight: "600" },

    // Empty state
    emptyContainer: { alignItems: "center", marginTop: 80, paddingHorizontal: 40 },
    emptyIcon:      { fontSize: 56, marginBottom: 16 },
    emptyTitle:     { fontSize: 18, fontWeight: "700", color: "#FFFFFF", marginBottom: 8 },
    emptySubtitle:  { fontSize: 13, color: "#666", textAlign: "center" },
});
