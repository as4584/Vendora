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
  Modal,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Icon, IconCircle, Pill } from "../../../components/ui";
import { GoogleSheetsPrompt } from "../../../components/GoogleSheets";
import { ProUpsell, graceMessage } from "../../../components/ProUpsell";
import { useAuth } from "../../../context/auth";
import { COLORS, FONT_SCALE, SPACING } from "../../../theme/tokens";
import { SOURCE_LABELS, STATUS_LABELS } from "../../../utils/inventory";
import InventoryCard, { STATUS_TONES } from "../../../components/InventoryCard";
import { downloadTextFile, downloadAndShareRemote } from "../../../utils/fileActions";

/**
 * Case-insensitive subsequence match: every character of `query` must appear in
 * `text` in the same order, but not necessarily adjacent or at a word boundary.
 * e.g. "bla" → "Nike Black", "coc" → "Croc". Whitespace in the query is ignored.
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

/** Mirrors backend TIER_LIMITS['free'] in app/dependencies/tier_limiter.py. */
export const FREE_ITEM_LIMIT = 25;

export default function InventoryListScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const freeLimit = user && user.subscription_tier !== "pro" ? FREE_ITEM_LIMIT : null;
  const [graceUntil, setGraceUntil] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    if (!freeLimit) { setGraceUntil(null); return; }
    let live = true;
    Promise.resolve(api.getSubscriptionStatus?.())
      .then((st) => { if (live) setGraceUntil(st?.pricing_grace_until ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, [freeLimit]));
  const insets = useSafeAreaInsets();
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
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
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
    // Fetch more matches from the server in the background — no full-screen
    // spinner, so the instant client-side filter stays visible while typing.
    searchTimer.current = setTimeout(() => {
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

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const runBulkDelete = async (deleteFromSource: boolean) => {
    const ids = Array.from(selectedIds);
    setDeleting(true);
    try {
      const result = await api.bulkDeleteItems(ids, deleteFromSource);
      exitSelect();
      await fetchItems({ page: 1, refresh: true });
      const extra = result.source_note ? `\n\n${result.source_note}` : "";
      Alert.alert("Deleted", `${result.deleted} item${result.deleted === 1 ? "" : "s"} removed.${extra}`);
    } catch (err: any) {
      Alert.alert("Delete failed", err?.message || "Could not delete the selected items.");
    } finally {
      setDeleting(false);
    }
  };

  const confirmBulkDelete = () => {
    const n = selectedIds.size;
    Alert.alert(
      `Delete ${n} item${n === 1 ? "" : "s"}?`,
      "Choose where to remove them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete from app only", style: "destructive", onPress: () => runBulkDelete(false) },
        { text: "Delete from app + source", style: "destructive", onPress: () => runBulkDelete(true) },
      ]
    );
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const token = await api.getToken();
      await downloadAndShareRemote(api.exportInventoryXlsxUrl(), "resqlo-inventory.xlsx", token);
    } catch (err: any) {
      Alert.alert("Export failed", err?.message || "Could not export the Excel file.");
    } finally {
      setExporting(false);
    }
  };

  const exportCsv = async () => {
    try {
      const csv = await api.exportInventoryWarehouseCSV();
      await downloadTextFile(csv, "resqlo-inventory.csv");
    } catch (err: any) {
      Alert.alert("Export failed", err?.message || "Could not export the inventory CSV.");
    }
  };

  const onExport = () => {
    Alert.alert("Export inventory", "Excel keeps item photos and is easiest to read. CSV is best for re-importing.", [
      { text: "Excel (with photos)", onPress: exportExcel },
      { text: "CSV", onPress: exportCsv },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const applyStatus = (next: string | null) => {
    setStatusFilter(next);
    filtersRef.current.status = next;
    setLoading(true);
    fetchItems({ page: 1, refresh: true, status: next });
  };

  const applySource = (next: string | null) => {
    setSourceFilter(next);
    filtersRef.current.source = next;
    setLoading(true);
    fetchItems({ page: 1, refresh: true, source: next });
  };

  const clearFilters = () => {
    setStatusFilter(null);
    setSourceFilter(null);
    filtersRef.current.status = null;
    filtersRef.current.source = null;
    setLoading(true);
    fetchItems({ page: 1, refresh: true, status: null, source: null });
  };

  const activeFilterCount = (statusFilter ? 1 : 0) + (sourceFilter ? 1 : 0);

  const availableSources = useMemo(() => {
    const seen = new Set<string>();
    items.forEach((item) => {
      if (item.source) seen.add(item.source);
    });
    return Array.from(seen);
  }, [items]);

  // Instant, reactive client-side subsequence filter over the loaded items. The
  // debounced server search still runs to pull additional matches from the DB.
  const displayedItems = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return items;
    return items.filter((item) =>
      fuzzyMatch(q, `${item.name} ${item.sku || ""} ${item.category || ""} ${item.color || ""}`)
    );
  }, [items, searchQuery]);

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
        data={displayedItems}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <InventoryCard
            item={item}
            onPress={() => router.push(`/inventory/${item.id}` as any)}
            selectMode={selectMode}
            selected={selectedIds.has(item.id)}
            onToggleSelect={() => toggleSelect(item.id)}
          />
        )}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + SPACING.sm }]}
        ItemSeparatorComponent={() => <View style={{ height: SPACING.sm }} />}
        onEndReached={onLoadMore}
        onEndReachedThreshold={0.35}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
        ListHeaderComponent={
          <View style={{ gap: SPACING.md, marginBottom: SPACING.md }}>
            <HeaderTitle title="Inventory" subtitle={freeLimit ? `${total} of ${freeLimit} free items used` : `${total} ${total === 1 ? "item" : "items"}`} />
            {graceUntil ? <ProUpsell testID="grace-upsell" message={graceMessage(graceUntil)} /> : null}
            {freeLimit && total >= freeLimit - 5 ? (
              <ProUpsell
                testID="item-limit-upsell"
                message={total >= freeLimit
                  ? "You've used all your free items. Pro gives you unlimited inventory."
                  : `${freeLimit - total} free ${freeLimit - total === 1 ? "item" : "items"} left. Pro gives you unlimited inventory.`}
              />
            ) : null}

            <View style={styles.actionRow}>
              {selectMode ? (
                <ActionButton label="Cancel" onPress={exitSelect} tone="ghost" compact />
              ) : (
                <ActionButton label="Select" onPress={() => setSelectMode(true)} tone="secondary" compact />
              )}
              <ActionButton label="Import" onPress={() => router.push("/inventory/import" as any)} tone="secondary" compact />
              <ActionButton label="Export" onPress={onExport} tone="secondary" compact />
              <ActionButton label="Add Stock" onPress={() => router.push("/inventory/add" as any)} compact />
            </View>

            <Card>
              <View style={styles.searchRow}>
                <View style={styles.searchWrap}>
                  <Icon name="search" size={16} color={COLORS.textSoft} />
                  <TextInput
                    accessibilityLabel="Search inventory"
                    style={styles.searchInputFlex}
                    placeholder="Search name or SKU"
                    placeholderTextColor={COLORS.textSoft}
                    value={searchQuery}
                    onChangeText={onSearchChange}
                  />
                </View>
                <TouchableOpacity accessibilityLabel="Filters" accessibilityRole="button" style={styles.filterBtn} onPress={() => setFilterOpen(true)}>
                  <Icon name="options-outline" size={18} color={activeFilterCount ? COLORS.primaryBright : COLORS.text} />
                  {activeFilterCount ? <View style={styles.filterBadge}><Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.filterBadgeText}>{activeFilterCount}</Text></View> : null}
                </TouchableOpacity>
              </View>
              {activeFilterCount ? (
                <View style={styles.activeFilters}>
                  {statusFilter ? <Pill label={STATUS_LABELS[statusFilter] || statusFilter} tone={STATUS_TONES[statusFilter] || "primary"} /> : null}
                  {sourceFilter ? <Pill label={SOURCE_LABELS[sourceFilter] || sourceFilter} tone="info" /> : null}
                  <TouchableOpacity accessibilityLabel="Clear filters" onPress={clearFilters}><Pill label="Clear" tone="neutral" /></TouchableOpacity>
                </View>
              ) : null}
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
            <View style={styles.empty}>
              <IconCircle name="cube-outline" size={56} />
              <Text style={styles.emptyTitle}>No inventory matches this view.</Text>
              <Text style={styles.emptyText}>Change the filters or add a new stock item to continue.</Text>
              <View style={styles.emptyCta}>
                <ActionButton label="Add an item" onPress={() => router.push("/inventory/add" as any)} />
              </View>
              {!searchQuery && !statusFilter && !sourceFilter ? <GoogleSheetsPrompt onPress={() => router.push("/settings" as any)} /> : null}
            </View>
          </Card>
        }
      />
      {selectMode && selectedIds.size > 0 ? (
        <View style={styles.bulkBar}>
          <Text style={styles.bulkCount}>{selectedIds.size} selected</Text>
          <ActionButton
            label={deleting ? "Deleting..." : `Delete ${selectedIds.size}`}
            onPress={confirmBulkDelete}
            tone="primary"
            compact
            disabled={deleting}
          />
        </View>
      ) : null}

      <Modal visible={exporting} transparent animationType="fade">
        <View style={styles.exportOverlay}>
          <View style={styles.exportCard}>
            <ActivityIndicator size="large" color={COLORS.primaryBright} />
            <Text style={styles.exportTitle}>Building your Excel file…</Text>
            <Text style={styles.exportHint}>Embedding item photos — this can take a moment for large inventories.</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={filterOpen} transparent animationType="fade" onRequestClose={() => setFilterOpen(false)}>
        <TouchableOpacity testID="filter-backdrop" style={styles.modalBackdrop} activeOpacity={1} onPress={() => setFilterOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.filterSheet}>
            <View style={styles.filterSheetHead}>
              <Text style={styles.filterSheetTitle}>Filter inventory</Text>
              <TouchableOpacity accessibilityLabel="Close filters" onPress={() => setFilterOpen(false)}><Icon name="close" size={20} color={COLORS.textMuted} /></TouchableOpacity>
            </View>

            <Text style={styles.filterGroupLabel}>Status</Text>
            <FilterOption label="All statuses" active={!statusFilter} onPress={() => { applyStatus(null); setFilterOpen(false); }} />
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <FilterOption key={key} label={label} active={statusFilter === key} onPress={() => { applyStatus(statusFilter === key ? null : key); setFilterOpen(false); }} />
            ))}

            {availableSources.length > 0 ? (
              <>
                <Text style={styles.filterGroupLabel}>Source</Text>
                <FilterOption label="All sources" active={!sourceFilter} onPress={() => { applySource(null); setFilterOpen(false); }} />
                {availableSources.map((source) => (
                  <FilterOption key={source} label={SOURCE_LABELS[source] || source} active={sourceFilter === source} onPress={() => { applySource(sourceFilter === source ? null : source); setFilterOpen(false); }} />
                ))}
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function FilterOption({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.filterOption} activeOpacity={0.8} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.filterOptionText, active && styles.filterOptionTextActive]}>{label}</Text>
      {active ? <Icon name="checkmark" size={18} color={COLORS.primaryBright} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48 },
  actionRow: { flexDirection: "row", gap: SPACING.sm },
  searchRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
  },
  searchInputFlex: { flex: 1, color: COLORS.text, paddingVertical: 12 },
  filterBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBadgeText: { color: "#fff", fontSize: 10, fontWeight: "600" },
  activeFilters: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginTop: SPACING.sm },
  exportOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: SPACING.xl },
  exportCard: { backgroundColor: COLORS.card, borderRadius: 20, borderWidth: 1, borderColor: COLORS.border, padding: SPACING.xl, alignItems: "center", gap: SPACING.md, maxWidth: 320 },
  exportTitle: { color: COLORS.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  exportHint: { color: COLORS.textMuted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  filterSheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    paddingBottom: SPACING.xl,
    gap: 4,
  },
  filterSheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SPACING.sm },
  filterSheetTitle: { color: COLORS.text, fontSize: 18, fontWeight: "600" },
  filterGroupLabel: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: "600",
    marginTop: SPACING.md,
    marginBottom: 4,
  },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  filterOptionText: { color: COLORS.textMuted, fontSize: 15, fontWeight: "600" },
  filterOptionTextActive: { color: COLORS.text, fontWeight: "600" },
  bulkBar: {
    position: "absolute", left: SPACING.lg, right: SPACING.lg, bottom: SPACING.lg,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: COLORS.bgElevated, borderColor: COLORS.border, borderWidth: 1,
    borderRadius: 16, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
  },
  bulkCount: { color: COLORS.text, fontSize: 14, fontWeight: "600" },
  empty: { alignItems: "center", paddingVertical: SPACING.lg, gap: SPACING.xs },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: "600", marginTop: SPACING.sm, textAlign: "center" },
  emptyText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, textAlign: "center", maxWidth: 260 },
  emptyCta: { marginTop: SPACING.sm, alignSelf: "stretch" },
  footerLoader: { paddingVertical: SPACING.md },
});
