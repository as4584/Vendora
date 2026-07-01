import { useCallback, useMemo, useRef, useState } from "react";
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
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card, ChipRow, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCurrency, resolveQty, resolvedPhoto, sizeBreakdown, SOURCE_LABELS, STATUS_LABELS } from "../../../utils/inventory";
import { downloadTextFile } from "../../../utils/fileActions";

const STATUS_TONES: Record<string, "success" | "warning" | "danger" | "info" | "neutral" | "primary"> = {
  in_stock: "success",
  listed: "info",
  sold: "danger",
  shipped: "warning",
  paid: "primary",
  archived: "neutral",
};

function InventoryCard({
  item,
  onPress,
}: {
  item: api.InventoryItem;
  onPress: () => void;
}) {
  const qty = resolveQty(item);
  const lowStock = qty > 0 && qty <= 3;
  const sourceLabel = item.source ? SOURCE_LABELS[item.source] || item.source : "Manual";
  const frontPhoto = resolvedPhoto(item, "front");
  const backPhoto = resolvedPhoto(item, "back");

  return (
    <TouchableOpacity accessibilityLabel={`Open ${item.name}`} accessibilityRole="button" activeOpacity={0.84} onPress={onPress}>
      <Card style={styles.itemCard}>
        <View style={styles.itemCardRow}>
          <View style={styles.photoColumn}>
            {frontPhoto ? (
              <Image source={{ uri: frontPhoto }} style={styles.mainPhoto} resizeMode="cover" />
            ) : (
              <View style={[styles.mainPhoto, styles.photoFallback]}><Text style={styles.photoFallbackText}>Front</Text></View>
            )}
            <View style={styles.backPhotoWrap}>
              {backPhoto ? (
                <Image source={{ uri: backPhoto }} style={styles.backPhoto} resizeMode="cover" />
              ) : (
                <View style={[styles.backPhoto, styles.photoFallback]}><Text style={styles.photoFallbackText}>Back</Text></View>
              )}
            </View>
          </View>

          <View style={styles.itemBody}>
            <View style={styles.itemTopRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemMeta}>
                  {[item.category, item.sku ? `SKU ${item.sku}` : null].filter(Boolean).join(" • ")}
                </Text>
              </View>
              <Text style={styles.itemPrice}>{formatCurrency(item.expected_sell_price)}</Text>
            </View>

            <View style={styles.pillRow}>
              <Pill label={STATUS_LABELS[item.status] || item.status} tone={STATUS_TONES[item.status] || "neutral"} />
              <Pill label={lowStock ? `Low stock ${qty}` : `Stock ${qty}`} tone={qty === 0 ? "danger" : lowStock ? "warning" : "success"} />
              <Pill label={sourceLabel} tone="info" />
            </View>

            <Text style={styles.sizeLine}>{sizeBreakdown(item)}</Text>
            <Text style={styles.secondaryLine}>
              Cost {formatCurrency(item.buy_price)} • Vendor {item.vendor_name || "Unassigned"}
            </Text>
          </View>
        </View>
      </Card>
    </TouchableOpacity>
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef<{
    query: string;
    status: string | null;
    source: string | null;
  }>({ query: "", status: null, source: null });

  const fetchItems = useCallback(
    async (options: { page?: number; refresh?: boolean; query?: string; status?: string | null; source?: string | null } = {}) => {
      const nextPage = options.page ?? 1;
      const nextQuery = options.query ?? filtersRef.current.query;
      const nextStatus = options.status !== undefined ? options.status : filtersRef.current.status;
      const nextSource = options.source !== undefined ? options.source : filtersRef.current.source;

      try {
        const result = await api.listItems({
          page: nextPage,
          perPage: 24,
          q: nextQuery || undefined,
          status: nextStatus ?? undefined,
          source: nextSource ?? undefined,
        });
        setItems((previous) => (options.refresh === false ? [...previous, ...result.items] : result.items));
        setTotal(result.total);
        setPage(result.page);
        setPages(result.pages);
      } catch (err: any) {
        Alert.alert("Inventory unavailable", err?.message || "Could not load inventory.");
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      fetchItems({ refresh: true });
    }, [fetchItems])
  );

  const onSearchChange = (text: string) => {
    setSearchQuery(text);
    filtersRef.current.query = text;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setLoading(true);
      fetchItems({ page: 1, refresh: true, query: text });
    }, 250);
  };

  const onRefresh = () => {
    setRefreshing(true);
    fetchItems({ page: 1, refresh: true });
  };

  const onLoadMore = () => {
    if (!loadingMore && page < pages) {
      setLoadingMore(true);
      fetchItems({ page: page + 1, refresh: false });
    }
  };

  const onExport = async () => {
    try {
      const csv = await api.exportInventoryWarehouseCSV();
      await downloadTextFile(csv, "vendora-inventory-warehouse.csv");
    } catch (err: any) {
      Alert.alert("Export failed", err?.message || "Could not export the inventory CSV.");
    }
  };

  const availableSources = useMemo(() => {
    const seen = new Set<string>();
    items.forEach((item) => {
      if (item.source) seen.add(item.source);
    });
    return Array.from(seen);
  }, [items]);

  if (loading) {
    return (
      <View testID="inventory-loading" style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <InventoryCard item={item} onPress={() => router.push(`/inventory/${item.id}` as any)} />
        )}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={() => <View style={{ height: SPACING.sm }} />}
        onEndReached={onLoadMore}
        onEndReachedThreshold={0.35}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
        ListHeaderComponent={
          <View style={{ gap: SPACING.md, marginBottom: SPACING.md }}>
            <HeaderTitle title="Inventory" subtitle={`${total} items ready for stock, sync, and spreadsheet review.`} />

            <View style={styles.actionRow}>
              <ActionButton label="Import" onPress={() => router.push("/inventory/import" as any)} tone="secondary" compact />
              <ActionButton label="Export" onPress={onExport} tone="secondary" compact />
              <ActionButton label="Add Stock" onPress={() => router.push("/inventory/add" as any)} compact />
            </View>

            <Card>
              <SectionLabel>Search + Filter</SectionLabel>
              <TextInput
                accessibilityLabel="Search inventory"
                style={styles.searchInput}
                placeholder="Search items, sku, upc"
                placeholderTextColor={COLORS.textSoft}
                value={searchQuery}
                onChangeText={onSearchChange}
              />
              <ChipRow>
                {Object.entries(STATUS_LABELS).map(([key, label]) => (
                  <TouchableOpacity key={key} onPress={() => {
                    const next = statusFilter === key ? null : key;
                    setStatusFilter(next);
                    filtersRef.current.status = next;
                    setLoading(true);
                    fetchItems({ page: 1, refresh: true, status: next });
                  }}>
                    <Pill label={label} tone={statusFilter === key ? STATUS_TONES[key] || "primary" : "neutral"} />
                  </TouchableOpacity>
                ))}
                {availableSources.map((source) => (
                  <TouchableOpacity key={source} onPress={() => {
                    const next = sourceFilter === source ? null : source;
                    setSourceFilter(next);
                    filtersRef.current.source = next;
                    setLoading(true);
                    fetchItems({ page: 1, refresh: true, source: next });
                  }}>
                    <Pill label={SOURCE_LABELS[source] || source} tone={sourceFilter === source ? "info" : "neutral"} />
                  </TouchableOpacity>
                ))}
              </ChipRow>
            </Card>
          </View>
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator size="small" color={COLORS.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <Card>
            <Text style={styles.emptyTitle}>No inventory matches this view.</Text>
            <Text style={styles.emptyText}>Change the filters or add a new stock item to continue.</Text>
          </Card>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48 },
  actionRow: { flexDirection: "row", gap: SPACING.sm },
  searchInput: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: SPACING.sm,
  },
  itemCard: { padding: 0 },
  itemCardRow: { flexDirection: "row", gap: SPACING.md },
  photoColumn: { width: 88, gap: SPACING.xs },
  mainPhoto: { width: 88, height: 88, borderRadius: 14, backgroundColor: COLORS.cardAlt },
  backPhotoWrap: { alignItems: "flex-end" },
  backPhoto: { width: 44, height: 44, borderRadius: 10, backgroundColor: COLORS.cardAlt, borderWidth: 1, borderColor: COLORS.border },
  photoFallback: { alignItems: "center", justifyContent: "center" },
  photoFallbackText: { color: COLORS.textSoft, fontSize: 11, fontWeight: "700" },
  itemBody: { flex: 1, gap: SPACING.sm },
  itemTopRow: { flexDirection: "row", gap: SPACING.sm },
  itemName: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  itemMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  itemPrice: { color: COLORS.success, fontSize: 16, fontWeight: "800" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  sizeLine: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  secondaryLine: { color: COLORS.textMuted, fontSize: 12 },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: "800", marginBottom: 6 },
  emptyText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 18 },
  footerLoader: { paddingVertical: SPACING.md },
});
