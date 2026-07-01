import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel, Stepper } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCurrency, resolveQty, sizeBreakdown } from "../../../utils/inventory";

const PAYMENT_METHODS = ["cash", "venmo", "cashapp", "paypal", "zelle", "stripe", "other"];

export default function QuickSaleScreen() {
  const router = useRouter();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [selectedItem, setSelectedItem] = useState<api.InventoryItem | null>(null);
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [method, setMethod] = useState("cash");
  const [grossAmount, setGrossAmount] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listItems({ perPage: 100, availableOnly: true })
      .then((result) => setItems(result.items))
      .catch(() => Alert.alert("Quick sale unavailable", "Could not load sellable inventory."))
      .finally(() => setLoadingItems(false));
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) =>
      [item.name, item.sku || "", item.category || ""].some((value) => value.toLowerCase().includes(q))
    );
  }, [items, query]);

  const variants = useMemo(() => {
    const raw = selectedItem?.custom_attributes?.variants;
    return Array.isArray(raw) ? raw : [];
  }, [selectedItem]);

  const selectItem = (item: api.InventoryItem | null) => {
    setSelectedItem(item);
    setGrossAmount(item?.expected_sell_price || "");
    const itemVariants = item?.custom_attributes?.variants;
    setSelectedSize(Array.isArray(itemVariants) && itemVariants.length === 1 ? itemVariants[0].size : null);
  };

  const parsedQty = Math.max(1, parseInt(quantity || "1", 10) || 1);
  const availableAfter = selectedItem ? Math.max(0, resolveQty(selectedItem) - parsedQty) : 0;

  const handleSubmit = async () => {
    if (!grossAmount.trim()) {
      Alert.alert("Sale amount required", "Enter the amount collected from the sale.");
      return;
    }
    if (selectedItem && variants.length > 0 && !selectedSize) {
      Alert.alert("Size required", "Choose the size that was sold before continuing.");
      return;
    }

    setSubmitting(true);
    try {
      const payload: api.CreateTransactionPayload = {
        item_id: selectedItem?.id,
        method,
        gross_amount: grossAmount.trim(),
        fee_amount: feeAmount.trim() || "0.00",
        quantity: parsedQty,
        notes: [notes.trim(), selectedSize ? `Size sold: ${selectedSize}` : null].filter(Boolean).join(" • ") || undefined,
      };
      const transaction = await api.createTransaction(payload);
      Alert.alert(
        "Sale logged",
        `${formatCurrency(transaction.gross_amount)} captured${selectedItem ? ` for ${selectedItem.name}` : ""}.`,
        [{ text: "OK", onPress: () => router.replace("/(tabs)/dashboard") }]
      );
    } catch (err: any) {
      Alert.alert("Sale failed", err?.message || "Could not log this sale.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Quick Sale" subtitle="Pick an item, confirm stock impact, then log the payment." />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Flow</SectionLabel>
        <Stepper steps={["Item", "Details", "Payment"]} active={selectedItem ? 1 : 0} />
      </Card>

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Step 1 · Select Item</SectionLabel>
        <TextInput
          accessibilityLabel="Search sale inventory"
          style={styles.input}
          placeholder="Search inventory or scan a sku"
          placeholderTextColor={COLORS.textSoft}
          value={query}
          onChangeText={setQuery}
        />

        {loadingItems ? (
          <ActivityIndicator color={COLORS.primary} />
        ) : (
          <View style={{ gap: SPACING.sm }}>
            <ActionButton label="Skip — Log Without Item" onPress={() => selectItem(null)} tone="ghost" />
            {filtered.slice(0, 8).map((item) => (
              <TouchableOpacity key={item.id} activeOpacity={0.84} onPress={() => selectItem(item)}>
                <View style={[styles.itemOption, selectedItem?.id === item.id && styles.itemOptionActive]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemMeta}>
                      Stock {resolveQty(item)} • Ask {formatCurrency(item.expected_sell_price)}
                    </Text>
                    <Text style={styles.itemMeta}>{sizeBreakdown(item)}</Text>
                  </View>
                  <Pill label={selectedItem?.id === item.id ? "Selected" : "Choose"} tone={selectedItem?.id === item.id ? "primary" : "neutral"} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </Card>

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Step 2 · Stock Impact</SectionLabel>
        {selectedItem ? (
          <>
            <Text style={styles.selectedTitle}>{selectedItem.name}</Text>
            <Text style={styles.helperText}>
              In stock {resolveQty(selectedItem)} • Cost {formatCurrency(selectedItem.buy_price)} • Ask {formatCurrency(selectedItem.expected_sell_price)}
            </Text>
            {variants.length > 0 ? (
              <View style={styles.pillRow}>
                {variants.map((variant: any) => (
                  <TouchableOpacity key={variant.size} onPress={() => setSelectedSize(variant.size)}>
                    <Pill label={`${variant.size} (${variant.quantity})`} tone={selectedSize === variant.size ? "primary" : "neutral"} />
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <Text style={styles.helperText}>Single size item • {sizeBreakdown(selectedItem)}</Text>
            )}
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>Quantity</Text>
              <TextInput
                accessibilityLabel="Sale quantity"
                style={[styles.input, styles.qtyInput]}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="number-pad"
              />
            </View>
            <Pill
              label={`Available after sale: ${availableAfter}`}
              tone={availableAfter === 0 ? "warning" : "success"}
            />
          </>
        ) : (
          <Text style={styles.helperText}>No inventory item selected. This will log a standalone payment only.</Text>
        )}
      </Card>

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Step 3 · Payment</SectionLabel>
        <View style={styles.pillRow}>
          {PAYMENT_METHODS.map((entry) => (
            <TouchableOpacity key={entry} onPress={() => setMethod(entry)}>
              <Pill label={entry.toUpperCase()} tone={method === entry ? "primary" : "neutral"} />
            </TouchableOpacity>
          ))}
        </View>
        <TextInput
          accessibilityLabel="Sale amount"
          style={styles.input}
          placeholder="Sale amount"
          placeholderTextColor={COLORS.textSoft}
          value={grossAmount}
          onChangeText={setGrossAmount}
          keyboardType="decimal-pad"
        />
        <TextInput
          accessibilityLabel="Fee amount"
          style={styles.input}
          placeholder="Fee amount (optional)"
          placeholderTextColor={COLORS.textSoft}
          value={feeAmount}
          onChangeText={setFeeAmount}
          keyboardType="decimal-pad"
        />
        <TextInput
          accessibilityLabel="Sale notes"
          style={[styles.input, styles.notesInput]}
          placeholder="Notes"
          placeholderTextColor={COLORS.textSoft}
          value={notes}
          onChangeText={setNotes}
          multiline
        />
        <Text style={styles.helperText}>
          Net after fees: {formatCurrency(String((parseFloat(grossAmount || "0") - parseFloat(feeAmount || "0")).toFixed(2)))}
        </Text>
        <ActionButton label={submitting ? "Logging Sale..." : "Log Sale"} onPress={handleSubmit} disabled={submitting} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  input: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  itemOption: {
    flexDirection: "row",
    gap: SPACING.sm,
    alignItems: "center",
    backgroundColor: COLORS.bgElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  itemOptionActive: {
    borderColor: COLORS.primary,
  },
  itemName: { color: COLORS.text, fontSize: 15, fontWeight: "800" },
  itemMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  selectedTitle: { color: COLORS.text, fontSize: 16, fontWeight: "800" },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  qtyLabel: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  qtyInput: { width: 90 },
  notesInput: { minHeight: 72, textAlignVertical: "top" },
});
