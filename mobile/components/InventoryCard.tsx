/**
 * The inventory item card. Used by the Inventory list and by the import
 * review screen, so an imported row looks exactly like the item it becomes.
 */
import { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ProductImage } from "./ProductImage";
import * as api from "../services/api";
import { Card, Icon, Pill } from "./ui";
import { StockLabel } from "./StockLabel";
import { BRAND, COLORS, FONT_SCALE, SPACING } from "../theme/tokens";
import { formatCurrency, resolveQty, resolvedPhoto, sizeBreakdown, SOURCE_LABELS, STATUS_LABELS } from "../utils/inventory";

export const STATUS_TONES: Record<string, "success" | "warning" | "danger" | "info" | "neutral" | "primary"> = {
  in_stock: "success",
  listed: "info",
  sold: "danger",
  shipped: "warning",
  paid: "primary",
  archived: "neutral",
};

const DOT_COLORS: Record<string, string> = {
  success: COLORS.success,
  info: COLORS.info,
  danger: COLORS.danger,
  warning: COLORS.warning,
  primary: COLORS.primaryBright,
  neutral: COLORS.textSoft,
};

// "New" alone is not evidence of an unworn, boxed sneaker.
const CONDITION_LABELS: Record<string, string> = {
  ds: "DS · Deadstock", deadstock: "DS · Deadstock",
  vnds: "VNDS · Very near deadstock", "very near deadstock": "VNDS · Very near deadstock",
  new: "New", used: "Pre-owned", refurbished: "Refurbished",
};

export interface InventoryCardProps {
  item: api.InventoryItem;
  onPress: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Shown above the name (e.g. the import action badge). */
  badge?: ReactNode;
  /** Shown under the card body (e.g. an import error or row actions). */
  footer?: ReactNode;
  /** Red outline: the row needs attention. */
  flagged?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export default function InventoryCard({
  item,
  onPress,
  selectMode = false,
  selected = false,
  onToggleSelect,
  badge,
  footer,
  flagged = false,
  accessibilityLabel,
  testID,
}: InventoryCardProps) {
  const qty = resolveQty(item);
  const condition = item.condition?.trim();
  const grade = condition?.toLowerCase();
  const conditionLabel = condition && grade
    ? (Object.prototype.hasOwnProperty.call(CONDITION_LABELS, grade) ? CONDITION_LABELS[grade] : condition)
    : null;
  const sourceLabel = item.source ? SOURCE_LABELS[item.source] || item.source : "Manual";
  const frontPhoto = resolvedPhoto(item, "front");
  const backPhoto = resolvedPhoto(item, "back");
  const cardStyle = [
    styles.itemCard,
    ...(selectMode && selected ? [styles.itemCardSelected] : []),
    ...(flagged ? [styles.itemCardFlagged] : []),
  ];

  return (
    <TouchableOpacity
      accessibilityLabel={accessibilityLabel || (selectMode ? `Select ${item.name}` : `Open ${item.name}`)}
      accessibilityRole="button"
      activeOpacity={0.84}
      onPress={selectMode ? onToggleSelect : onPress}
      onLongPress={onToggleSelect}
      testID={testID}
    >
      <Card style={cardStyle}>
        <View style={styles.itemCardRow}>
          {selectMode ? (
            <View style={[styles.checkbox, selected && styles.checkboxOn]}>
              {selected ? <Icon name="checkmark" size={16} color={BRAND.onPrimary} /> : null}
            </View>
          ) : null}
          <ProductImage uri={frontPhoto || backPhoto} label={item.name} style={styles.thumbBox} />

          <View style={styles.itemBody}>
            {badge ? <View style={styles.badgeRow}>{badge}</View> : null}
            <View style={styles.itemTopRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemMeta}>
                  {[item.category, item.sku ? `SKU ${item.sku}` : null].filter(Boolean).join(" • ")}
                </Text>
              </View>
              <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.itemPrice}>{formatCurrency(item.expected_sell_price)}</Text>
            </View>

            {/* One quiet status line: dot + status, stock count, and only the exceptions. */}
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: DOT_COLORS[STATUS_TONES[item.status] || "neutral"] }]} />
              <Text style={styles.statusText}>{STATUS_LABELS[item.status] || item.status}</Text>
              <Text style={styles.statusSep}>·</Text>
              <StockLabel quantity={qty} />
              {item._pending ? <Pill label="Sync pending" tone="warning" /> : null}
            </View>

            {conditionLabel ? (
              <View style={styles.conditionTag} accessibilityLabel={`Condition: ${conditionLabel}`}>
                <Text style={styles.conditionText}>{conditionLabel}</Text>
              </View>
            ) : null}

            <Text style={styles.sizeLine}>{sizeBreakdown(item)}</Text>
            <Text style={styles.secondaryLine}>
              Cost {formatCurrency(item.buy_price)} · <Text>{sourceLabel}</Text>{item.vendor_name ? ` · ${item.vendor_name}` : ""}
            </Text>
          </View>
        </View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </Card>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  itemCard: { padding: SPACING.md },
  itemCardSelected: { borderColor: COLORS.primary, borderWidth: 2 },
  itemCardFlagged: { borderColor: COLORS.danger, borderWidth: 1 },
  itemCardRow: { flexDirection: "row", gap: SPACING.md },
  checkbox: {
    width: 26, height: 26, borderRadius: 999, borderWidth: 2, borderColor: COLORS.border,
    alignItems: "center", justifyContent: "center", alignSelf: "center",
  },
  checkboxOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  thumbBox: { width: 72, aspectRatio: 1, borderRadius: 8 },
  thumbImg: { width: "100%", height: "100%" },
  photoFallback: { alignItems: "center", justifyContent: "center" },
  itemBody: { flex: 1, minWidth: 0, gap: 6 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  itemTopRow: { flexDirection: "row", gap: SPACING.sm },
  itemName: { color: COLORS.text, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  itemMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  itemPrice: { color: COLORS.text, fontSize: 16, fontWeight: "600", fontVariant: ["tabular-nums"] },
  statusRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "500" },
  statusSep: { color: COLORS.textSoft, fontSize: 13 },
  sizeLine: { color: COLORS.text, fontSize: 13, fontWeight: "500", fontVariant: ["tabular-nums"] },
  secondaryLine: { color: COLORS.textMuted, fontSize: 12 },
  conditionTag: { alignSelf: "flex-start", maxWidth: "100%", borderWidth: 1, borderColor: COLORS.border, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: COLORS.cardAlt },
  conditionText: { color: COLORS.textMuted, fontSize: 12, lineHeight: 17, fontWeight: "600" },
  footer: { marginTop: SPACING.sm, gap: SPACING.sm },
});
