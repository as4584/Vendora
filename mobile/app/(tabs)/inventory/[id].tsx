import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCompactDate, formatCurrency, resolveQty, resolvedPhoto, sizeBreakdown, SOURCE_LABELS, STATUS_LABELS } from "../../../utils/inventory";

const VALID_TRANSITIONS: Record<string, string[]> = {
  in_stock: ["listed", "sold"],
  listed: ["sold", "in_stock"],
  sold: ["shipped", "paid"],
  shipped: ["paid"],
  paid: ["archived"],
  archived: [],
};

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { push, replace } = useRouter();
  const [item, setItem] = useState<api.InventoryItem | null>(null);
  const [activity, setActivity] = useState<api.InventoryActivityEntry[]>([]);
  const [transactions, setTransactions] = useState<api.Transaction[]>([]);
  const [invoices, setInvoices] = useState<api.InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activePhoto, setActivePhoto] = useState<"front" | "back">("front");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [market, setMarket] = useState<api.MarketPriceResult | null>(null);
  const [suggestion, setSuggestion] = useState<api.PricingSuggestion | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const loadItem = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    if (!id) {
      setLoadError("This item link is missing an inventory ID.");
      setLoading(false);
      return;
    }
    try {
      const nextItem = await api.getItem(id);
      setItem(nextItem);

      const [nextActivity, nextTransactions, nextInvoices] = await Promise.allSettled([
        api.getItemActivity(nextItem.id),
        api.listTransactions({ itemId: nextItem.id, perPage: 10 }),
        api.listInvoices({ inventoryItemId: nextItem.id, perPage: 10 }),
      ]);
      if (nextActivity.status === "fulfilled") setActivity(nextActivity.value);
      if (nextTransactions.status === "fulfilled") setTransactions(nextTransactions.value.items);
      if (nextInvoices.status === "fulfilled") setInvoices(nextInvoices.value.items);
    } catch (err: any) {
      setLoadError(err?.message || "Could not load this item.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadItem();
  }, [loadItem]);

  const uploadPhoto = async (side: "front" | "back", uri: string) => {
    setPhotoUploading(true);
    try {
      const updated = await api.uploadItemPhotos(
        item!.id,
        side === "front" ? uri : undefined,
        side === "back" ? uri : undefined
      );
      setItem(updated);
    } catch (err: any) {
      Alert.alert("Upload failed", err?.message || "Could not update the item photo.");
    } finally {
      setPhotoUploading(false);
    }
  };

  const pickPhotoForSide = async (side: "front" | "back") => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== "granted") {
      Alert.alert("Permission required", "Allow photo library access to update item photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: Platform.OS !== "web",
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const dataUrl = asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri;
      uploadPhoto(side, dataUrl);
    }
  };

  const handleTransition = async (status: string) => {
    try {
      const updated = await api.updateItemStatus(item!.id, status);
      setItem(updated);
    } catch (err: any) {
      Alert.alert("Status update failed", err?.message || "Could not update item status.");
    }
  };

  const handleDelete = async () => {
    Alert.alert("Delete item", "This will soft-delete the item from active inventory.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.deleteItem(item!.id);
            replace("/(tabs)/inventory");
          } catch (err: any) {
            Alert.alert("Delete failed", err?.message || "Could not delete this item.");
          }
        },
      },
    ]);
  };

  const loadMarketPricing = async () => {
    setPricingLoading(true);
    try {
      const [nextMarket, nextSuggestion] = await Promise.all([
        api.getMarketPrice(item!.name, item!.upc || undefined),
        api.getPricingSuggestion(item!.id),
      ]);
      setMarket(nextMarket); setSuggestion(nextSuggestion);
    } catch (err: any) { Alert.alert("Market pricing unavailable", err?.message || "Could not compare current pricing."); }
    finally { setPricingLoading(false); }
  };

  const publishToLightspeed = async () => {
    setPublishing(true);
    try {
      const result = await api.pushItemToLightspeed(item!.id);
      Alert.alert("Published to Lightspeed", result.items_created ? "A linked Lightspeed catalog item was created." : "The linked Lightspeed catalog item was updated.");
    } catch (err: any) { Alert.alert("Publish failed", err?.message || "Connect Lightspeed in Settings first."); }
    finally { setPublishing(false); }
  };

  const variants = useMemo(() => {
    const raw = item?.custom_attributes?.variants;
    return Array.isArray(raw) ? raw : [];
  }, [item]);

  if (loading) {
    return (
      <View testID="item-detail-loading" style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (loadError || !item) {
    return (
      <View testID="item-detail-error" style={styles.center}>
        <Text style={styles.errorTitle}>Couldn&apos;t load this item</Text>
        <Text style={styles.errorText}>{loadError || "Item not found."}</Text>
        <View style={styles.actionRow}>
          <ActionButton label="Retry" onPress={() => void loadItem()} compact />
          <ActionButton label="Back to Inventory" onPress={() => replace("/(tabs)/inventory")} tone="secondary" compact />
        </View>
      </View>
    );
  }

  const qty = resolveQty(item);
  const frontPhoto = resolvedPhoto(item, "front");
  const backPhoto = resolvedPhoto(item, "back");
  const currentPhoto = activePhoto === "front" ? frontPhoto : backPhoto;
  const availableTransitions = VALID_TRANSITIONS[item.status] || [];
  const sourceLabel = item.source ? SOURCE_LABELS[item.source] || item.source : "Manual";

  return (
    <ScrollView testID="item-detail-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle
        title={item.name}
        subtitle={`${item.category || "Inventory item"} • ${item.sku || "No SKU yet"}`}
        right={<ActionButton label="Edit" onPress={() => push({ pathname: "/(tabs)/inventory/edit", params: { id: item.id } } as any)} tone="secondary" compact />}
      />

      <Card>
        <View style={styles.photoHeader}>
          <SectionLabel>Photos</SectionLabel>
          <View style={styles.photoSwitchRow}>
            <TouchableOpacity accessibilityLabel="Show front photo" accessibilityRole="button" onPress={() => setActivePhoto("front")}><Pill label="Front" tone={activePhoto === "front" ? "primary" : "neutral"} /></TouchableOpacity>
            <TouchableOpacity accessibilityLabel="Show back photo" accessibilityRole="button" onPress={() => setActivePhoto("back")}><Pill label="Back" tone={activePhoto === "back" ? "primary" : "neutral"} /></TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity accessibilityLabel={`Update ${activePhoto} photo`} accessibilityRole="button" activeOpacity={0.88} onPress={() => pickPhotoForSide(activePhoto)}>
          {currentPhoto ? (
            <Image source={{ uri: currentPhoto }} style={styles.heroPhoto} resizeMode="cover" />
          ) : (
            <View style={[styles.heroPhoto, styles.photoFallback]}>
              <Text style={styles.photoFallbackText}>Tap to add {activePhoto} photo</Text>
            </View>
          )}
          {photoUploading ? (
            <View style={styles.photoOverlay}><ActivityIndicator color={COLORS.text} /></View>
          ) : null}
        </TouchableOpacity>

        <View style={styles.photoThumbRow}>
          {[{ key: "front", uri: frontPhoto }, { key: "back", uri: backPhoto }].map((photo) => (
            <TouchableOpacity accessibilityLabel={`Show ${photo.key} thumbnail`} accessibilityRole="button" key={photo.key} onPress={() => setActivePhoto(photo.key as "front" | "back")}>
              {photo.uri ? (
                <Image source={{ uri: photo.uri }} style={[styles.thumbPhoto, activePhoto === photo.key && styles.thumbPhotoActive]} />
              ) : (
                <View style={[styles.thumbPhoto, styles.photoFallback, activePhoto === photo.key && styles.thumbPhotoActive]}>
                  <Text style={styles.photoFallbackText}>{photo.key}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </Card>

      {(() => {
        const cost = Number(item.buy_price ?? 0);
        const list = Number(item.expected_sell_price ?? 0);
        const profit = list - cost;
        const roi = cost > 0 ? Math.round((profit / cost) * 100) : null;
        return (
          <Card>
            <View style={styles.metricStrip}>
              <View style={styles.metricCell}>
                <Text style={styles.metricCellValue}>{formatCurrency(item.buy_price)}</Text>
                <Text style={styles.metricCellLabel}>Cost</Text>
              </View>
              <View style={styles.metricCellDivider} />
              <View style={styles.metricCell}>
                <Text style={styles.metricCellValue}>{formatCurrency(item.expected_sell_price)}</Text>
                <Text style={styles.metricCellLabel}>List</Text>
              </View>
              <View style={styles.metricCellDivider} />
              <View style={styles.metricCell}>
                <Text style={[styles.metricCellValue, { color: profit >= 0 ? COLORS.success : COLORS.danger }]}>
                  {`${profit >= 0 ? "+" : "-"}$${Math.abs(profit).toFixed(0)}`}
                </Text>
                <Text style={styles.metricCellLabel}>Profit</Text>
              </View>
              <View style={styles.metricCellDivider} />
              <View style={styles.metricCell}>
                <Text style={[styles.metricCellValue, { color: COLORS.primaryBright }]}>{roi == null ? "—" : `${roi}%`}</Text>
                <Text style={styles.metricCellLabel}>ROI</Text>
              </View>
            </View>
          </Card>
        );
      })()}

      <Card>
        <SectionLabel>Stock Summary</SectionLabel>
        <View style={styles.summaryGrid}>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Status</Text>
            <Text style={styles.summaryValue}>{STATUS_LABELS[item.status] || (item.status || "").toUpperCase()}</Text>
          </View>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Available</Text>
            <Text style={styles.summaryValue}>{qty}</Text>
          </View>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Ask</Text>
            <Text style={styles.summaryValue}>{formatCurrency(item.expected_sell_price)}</Text>
          </View>
          <View style={styles.summaryBlock}>
            <Text style={styles.summaryLabel}>Source</Text>
            <Text style={styles.summaryValue}>{sourceLabel}</Text>
          </View>
        </View>

        <View style={styles.pillRow}>
          <Pill label={STATUS_LABELS[item.status] || item.status} tone={qty === 0 ? "danger" : "success"} />
          <Pill label={qty === 0 ? "Out of stock" : `Stock ${qty}`} tone={qty === 0 ? "danger" : qty <= 3 ? "warning" : "success"} />
          <Pill label={sourceLabel} tone="info" />
        </View>

        <Text style={styles.detailLine}>Sizes: {sizeBreakdown(item)}</Text>
        <Text style={styles.detailLine}>Buy {formatCurrency(item.buy_price)} • Last updated {formatCompactDate(item.updated_at)}</Text>
      </Card>

      {variants.length > 0 ? (
        <Card>
          <SectionLabel>Sizes</SectionLabel>
          <View style={styles.variantGrid}>
            {variants.map((variant: any) => (
              <View key={`${variant.size}-${variant.quantity}`} style={styles.variantCard}>
                <Text style={styles.variantSize}>{variant.size}</Text>
                <Text style={styles.variantQty}>{variant.quantity}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      <Card>
        <SectionLabel>Details</SectionLabel>
        <DetailRow label="Vendor" value={item.vendor_name || "Unassigned"} />
        <DetailRow label="Condition" value={item.condition || "Unknown"} />
        <DetailRow label="Color" value={item.color || "Not set"} />
        <DetailRow label="UPC" value={item.upc || "Not set"} />
        <DetailRow label="Notes" value={item.notes || "No notes"} />
      </Card>

      <Card>
        <SectionLabel>Sales History</SectionLabel>
        {transactions.length === 0 ? (
          <Text style={styles.emptyText}>No completed sales are linked to this item yet.</Text>
        ) : (
          transactions.slice(0, 5).map((transaction) => (
            <View key={transaction.id} style={styles.timelineRow}>
              <Text style={styles.timelineTitle}>{(transaction.method || "sale").toUpperCase()}</Text>
              <Text style={styles.timelineMeta}>
                {formatCurrency(transaction.gross_amount)} • Qty {transaction.quantity} • {formatCompactDate(transaction.created_at)}
              </Text>
            </View>
          ))
        )}
      </Card>

      <Card>
        <SectionLabel>Market Pricing</SectionLabel>
        <Text style={styles.emptyText}>Compare external listings and your own sold history before changing the asking price.</Text>
        {suggestion ? <View style={styles.marketSummary}><Text style={styles.marketPrice}>{suggestion.suggested_price == null ? "More sales data needed" : formatCurrency(suggestion.suggested_price)}</Text><Pill label={`${suggestion.confidence.toUpperCase()} CONFIDENCE`} tone={suggestion.confidence === "high" ? "success" : "info"} /><Text style={styles.timelineMeta}>{suggestion.reason}</Text></View> : null}
        {market?.sources.map((source) => <View key={`${source.source}-${source.label}`} style={styles.detailRow}><Text style={styles.detailLabel}>{source.label}</Text><Text style={styles.detailValue}>{source.price == null ? "No match" : formatCurrency(source.price)}</Text></View>)}
        <View style={[styles.actionRow, { marginTop: SPACING.sm }]}><ActionButton label={pricingLoading ? "Checking..." : "Check Market Price"} onPress={loadMarketPricing} disabled={pricingLoading} tone="secondary" compact /><ActionButton label={publishing ? "Publishing..." : "Publish to Lightspeed"} onPress={publishToLightspeed} disabled={publishing} tone="secondary" compact /></View>
      </Card>

      <Card>
        <SectionLabel>Linked Invoices</SectionLabel>
        {invoices.length === 0 ? (
          <Text style={styles.emptyText}>No invoice line items are linked to this inventory item yet.</Text>
        ) : (
          invoices.slice(0, 5).map((invoice) => (
            <View key={invoice.id} style={styles.timelineRow}>
              <Text style={styles.timelineTitle}>{invoice.customer_name}</Text>
              <Text style={styles.timelineMeta}>
                {invoice.status.toUpperCase()} • {formatCurrency(invoice.total)} • {formatCompactDate(invoice.created_at)}
              </Text>
            </View>
          ))
        )}
      </Card>

      <Card>
        <SectionLabel>Activity Log</SectionLabel>
        {activity.length === 0 ? (
          <Text style={styles.emptyText}>No stock activity recorded yet.</Text>
        ) : (
          activity.slice(0, 8).map((entry) => (
            <View key={entry.id} style={styles.timelineRow}>
              <Text style={styles.timelineTitle}>
                {entry.event_type.replace(/_/g, " ")} • {entry.delta_quantity > 0 ? `+${entry.delta_quantity}` : entry.delta_quantity}
              </Text>
              <Text style={styles.timelineMeta}>
                After {entry.quantity_after} • {entry.source_type || "system"} • {formatCompactDate(entry.created_at)}
              </Text>
            </View>
          ))
        )}
      </Card>

      <Card>
        <SectionLabel>Actions</SectionLabel>
        <View style={styles.actionRow}>
          {availableTransitions.map((status) => (
            <ActionButton key={status} label={`Mark ${STATUS_LABELS[status] || status}`} onPress={() => handleTransition(status)} tone="secondary" compact />
          ))}
        </View>
        <View style={{ marginTop: SPACING.sm }}>
          <ActionButton label="Delete Item" onPress={handleDelete} tone="ghost" />
        </View>
      </Card>
    </ScrollView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg, padding: SPACING.lg, gap: SPACING.sm },
  errorTitle: { color: COLORS.text, fontSize: 18, fontWeight: "800" },
  errorText: { color: COLORS.textMuted, fontSize: 13, textAlign: "center", marginBottom: SPACING.sm },
  photoHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SPACING.sm },
  photoSwitchRow: { flexDirection: "row", gap: SPACING.xs },
  heroPhoto: { width: "100%", height: 260, borderRadius: 18, backgroundColor: COLORS.cardAlt },
  photoOverlay: {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(7,11,22,0.35)",
    borderRadius: 18,
  },
  photoFallback: { alignItems: "center", justifyContent: "center" },
  photoFallbackText: { color: COLORS.textMuted, fontWeight: "700", textTransform: "capitalize" },
  photoThumbRow: { flexDirection: "row", gap: SPACING.sm, marginTop: SPACING.sm },
  thumbPhoto: { width: 64, height: 64, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.cardAlt },
  thumbPhotoActive: { borderColor: COLORS.primary, borderWidth: 2 },
  metricStrip: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  metricCell: { flex: 1, alignItems: "center", gap: 3 },
  metricCellValue: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  metricCellLabel: { color: COLORS.textMuted, fontSize: 11, fontWeight: "600" },
  metricCellDivider: { width: 1, height: 30, backgroundColor: COLORS.border },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginBottom: SPACING.sm },
  summaryBlock: {
    flex: 1,
    minWidth: 130,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  summaryLabel: { color: COLORS.textMuted, fontSize: 12, fontWeight: "600" },
  summaryValue: { color: COLORS.text, fontSize: 18, fontWeight: "800", marginTop: 6 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginBottom: SPACING.sm },
  detailLine: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  variantGrid: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  variantCard: {
    minWidth: 82,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    alignItems: "center",
    gap: 4,
  },
  variantSize: { color: COLORS.text, fontSize: 14, fontWeight: "800" },
  variantQty: { color: COLORS.success, fontSize: 18, fontWeight: "800" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: SPACING.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  detailLabel: { color: COLORS.textSoft, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  detailValue: { color: COLORS.text, fontSize: 13, fontWeight: "600", flex: 1, textAlign: "right" },
  emptyText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  timelineRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  timelineTitle: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  timelineMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  marketSummary: { gap: SPACING.xs, marginTop: SPACING.sm },
  marketPrice: { color: COLORS.success, fontSize: 28, fontWeight: "800" },
});
