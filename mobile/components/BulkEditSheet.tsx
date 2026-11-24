/**
 * BulkEditSheet — edit price, cost, category, platform or status for the
 * items selected on the inventory list. Only filled-in fields are sent.
 */
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { BulkUpdatePayload } from "../services/api";
import { ActionButton, Icon } from "./ui";
import { COLORS, SPACING } from "../theme/tokens";

type PriceMode = "set" | "percent" | "amount";
const PRICE_MODES: { key: PriceMode; label: string }[] = [
  { key: "set", label: "Set to $" },
  { key: "percent", label: "Change %" },
  { key: "amount", label: "Change $" },
];
const STATUSES: { key: "in_stock" | "listed"; label: string }[] = [
  { key: "in_stock", label: "In stock" },
  { key: "listed", label: "Listed" },
];

function parseNumber(text: string): number | null {
  const n = Number(text.replace(/[$,%\s]/g, ""));
  return text.trim() && Number.isFinite(n) ? n : null;
}

/** Turn the form into an API payload; returns an error string when invalid. */
export function buildBulkPayload(form: {
  priceMode: PriceMode; price: string; cost: string; category: string; platform: string;
  status: "in_stock" | "listed" | null;
}): BulkUpdatePayload | string {
  const payload: BulkUpdatePayload = {};
  if (form.price.trim()) {
    const value = parseNumber(form.price);
    if (value === null) return "Enter a number for the price.";
    if (form.priceMode === "set" && value < 0) return "Price can't be negative.";
    payload.list_price = { mode: form.priceMode, value };
  }
  if (form.cost.trim()) {
    const value = parseNumber(form.cost);
    if (value === null || value < 0) return "Enter a cost of 0 or more.";
    payload.buy_price = value;
  }
  if (form.category.trim()) payload.category = form.category.trim();
  if (form.platform.trim()) payload.platform = form.platform.trim();
  if (form.status) payload.status = form.status;
  return Object.keys(payload).length ? payload : "Change at least one field.";
}

export function BulkEditSheet({
  visible, count, saving, onClose, onApply,
}: {
  visible: boolean;
  count: number;
  saving: boolean;
  onClose: () => void;
  onApply: (changes: BulkUpdatePayload) => void;
}) {
  const [priceMode, setPriceMode] = useState<PriceMode>("percent");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [category, setCategory] = useState("");
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState<"in_stock" | "listed" | null>(null);
  const [error, setError] = useState("");

  const apply = () => {
    const result = buildBulkPayload({ priceMode, price, cost, category, platform, status });
    if (typeof result === "string") { setError(result); return; }
    setError("");
    onApply(result);
  };

  const pricePlaceholder = priceMode === "percent" ? "-10 for 10% off" : priceMode === "amount" ? "-5 for $5 off" : "25.00";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity testID="bulk-edit-backdrop" style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>Edit {count} item{count === 1 ? "" : "s"}</Text>
            <TouchableOpacity accessibilityLabel="Close bulk edit" onPress={onClose}>
              <Icon name="close" size={20} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>Leave a field blank to keep it as it is.</Text>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>List price</Text>
            <View style={styles.chips}>
              {PRICE_MODES.map(({ key, label }) => (
                <TouchableOpacity key={key} onPress={() => setPriceMode(key)}
                  style={[styles.chip, priceMode === key && styles.chipActive]}
                  accessibilityRole="button" accessibilityState={{ selected: priceMode === key }}>
                  <Text style={[styles.chipText, priceMode === key && styles.chipTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput style={styles.input} value={price} onChangeText={setPrice} placeholder={pricePlaceholder}
              placeholderTextColor={COLORS.textMuted} keyboardType="numbers-and-punctuation" accessibilityLabel="List price" />

            <Text style={styles.label}>Cost (what you paid)</Text>
            <TextInput style={styles.input} value={cost} onChangeText={setCost} placeholder="e.g. 12.50"
              placeholderTextColor={COLORS.textMuted} keyboardType="decimal-pad" accessibilityLabel="Cost" />

            <Text style={styles.label}>Category</Text>
            <TextInput style={styles.input} value={category} onChangeText={setCategory} placeholder="e.g. Sneakers"
              placeholderTextColor={COLORS.textMuted} accessibilityLabel="Category" />

            <Text style={styles.label}>Platform</Text>
            <TextInput style={styles.input} value={platform} onChangeText={setPlatform} placeholder="eBay, StockX, Mercari…"
              placeholderTextColor={COLORS.textMuted} accessibilityLabel="Platform" />

            <Text style={styles.label}>Status</Text>
            <View style={styles.chips}>
              {STATUSES.map(({ key, label }) => (
                <TouchableOpacity key={key} onPress={() => setStatus(status === key ? null : key)}
                  style={[styles.chip, status === key && styles.chipActive]}
                  accessibilityRole="button" accessibilityState={{ selected: status === key }}>
                  <Text style={[styles.chipText, status === key && styles.chipTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.hint}>To mark items sold, use Sell so the sale and profit are recorded.</Text>

            {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
            <View style={styles.actions}>
              <ActionButton label={saving ? "Saving..." : `Apply to ${count}`} onPress={apply} disabled={saving} />
            </View>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.bgElevated, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: SPACING.lg, paddingBottom: 36, maxHeight: "88%",
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "600" },
  hint: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: SPACING.xs },
  label: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginTop: SPACING.md, marginBottom: SPACING.xs },
  input: {
    color: COLORS.text, backgroundColor: COLORS.card, borderColor: COLORS.border, borderWidth: 1,
    borderRadius: 12, paddingHorizontal: SPACING.md, paddingVertical: 10, fontSize: 15,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginBottom: SPACING.xs },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
  error: { color: COLORS.danger, fontSize: 13, marginTop: SPACING.md },
  actions: { marginTop: SPACING.lg },
});
