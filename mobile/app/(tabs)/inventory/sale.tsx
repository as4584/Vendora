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
import { isOnline } from "../../../services/offline";
import { ActionButton, Card, HeaderTitle, Icon, Pill, SectionLabel, Stepper } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCurrency, resolveQty } from "../../../utils/inventory";

const PAYMENT_METHODS = ["cash", "venmo", "cashapp", "paypal", "zelle", "stripe", "other"];

type CartLine = { item: api.InventoryItem; qty: number };

export default function QuickSaleScreen() {
  const router = useRouter();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [method, setMethod] = useState("cash");
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

  const cartLines = Object.values(cart);
  const total = cartLines.reduce((sum, line) => sum + Number(line.item.expected_sell_price || 0) * line.qty, 0);
  const fee = parseFloat(feeAmount || "0") || 0;
  const net = total - fee;

  const toggleItem = (item: api.InventoryItem) => {
    setCart((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { item, qty: 1 };
      return next;
    });
  };

  const changeQty = (id: string, delta: number) => {
    setCart((prev) => {
      const line = prev[id];
      const max = Math.max(1, resolveQty(line.item));
      const qty = Math.min(max, Math.max(1, line.qty + delta));
      return { ...prev, [id]: { ...line, qty } };
    });
  };

  const handleSubmit = async () => {
    if (cartLines.length === 0) {
      Alert.alert("No items selected", "Tap items above to add them to this sale.");
      return;
    }
    setSubmitting(true);
    try {
      let logged = 0;
      for (let i = 0; i < cartLines.length; i += 1) {
        const line = cartLines[i];
        const lineGross = (Number(line.item.expected_sell_price || 0) * line.qty).toFixed(2);
        await api.createTransaction({
          item_id: line.item.id,
          method,
          gross_amount: lineGross,
          // The whole-order fee is attached to the first line item.
          fee_amount: i === 0 ? (feeAmount.trim() || "0.00") : "0.00",
          quantity: line.qty,
          notes: notes.trim() || undefined,
        });
        logged += 1;
      }
      const offline = !isOnline();
      Alert.alert(
        offline ? "Sale queued offline" : "Sale logged",
        `${logged} item${logged === 1 ? "" : "s"} • ${formatCurrency(total.toFixed(2))} captured.` +
          (offline ? "\n\nStock is updated on your device — this sale syncs automatically when you're back online." : ""),
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
      <HeaderTitle title="Quick Sale" subtitle="Add one or more items, then log the payment in one go." />

      <Card style={{ gap: SPACING.md }}>
        <Stepper steps={["Select", "Review", "Payment"]} active={cartLines.length > 0 ? (total > 0 ? 2 : 1) : 0} />
      </Card>

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Select Items</SectionLabel>
        <TextInput
          accessibilityLabel="Search sale inventory"
          style={styles.input}
          placeholder="Search items, SKU, or category"
          placeholderTextColor={COLORS.textSoft}
          value={query}
          onChangeText={setQuery}
        />
        {loadingItems ? (
          <ActivityIndicator color={COLORS.primary} />
        ) : (
          <View style={{ gap: SPACING.sm }}>
            {filtered.slice(0, 12).map((item) => {
              const added = !!cart[item.id];
              return (
                <TouchableOpacity key={item.id} activeOpacity={0.84} onPress={() => toggleItem(item)} accessibilityRole="button" accessibilityLabel={`${added ? "Remove" : "Add"} ${item.name}`}>
                  <View style={[styles.itemOption, added && styles.itemOptionActive]}>
                    <View style={[styles.check, added && styles.checkOn]}>{added ? <Icon name="checkmark" size={15} color="#fff" /> : null}</View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{item.name}</Text>
                      <Text style={styles.itemMeta}>Stock {resolveQty(item)} · {formatCurrency(item.expected_sell_price)}</Text>
                    </View>
                    <Pill label={added ? "Added" : "Add"} tone={added ? "primary" : "neutral"} />
                  </View>
                </TouchableOpacity>
              );
            })}
            {filtered.length === 0 ? <Text style={styles.helperText}>No sellable items match that search.</Text> : null}
          </View>
        )}
      </Card>

      {cartLines.length > 0 ? (
        <Card style={{ gap: SPACING.sm }}>
          <SectionLabel>Cart · {cartLines.length} item{cartLines.length === 1 ? "" : "s"}</SectionLabel>
          {cartLines.map((line) => (
            <View key={line.item.id} style={styles.cartRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{line.item.name}</Text>
                <Text style={styles.itemMeta}>{formatCurrency(line.item.expected_sell_price)} each</Text>
              </View>
              <View style={styles.qtyStepper}>
                <TouchableOpacity accessibilityLabel={`Decrease ${line.item.name}`} style={styles.qtyBtn} onPress={() => changeQty(line.item.id, -1)}><Icon name="remove" size={16} color={COLORS.text} /></TouchableOpacity>
                <Text style={styles.qtyValue}>{line.qty}</Text>
                <TouchableOpacity accessibilityLabel={`Increase ${line.item.name}`} style={styles.qtyBtn} onPress={() => changeQty(line.item.id, 1)}><Icon name="add" size={16} color={COLORS.text} /></TouchableOpacity>
              </View>
              <Text style={styles.lineTotal}>{formatCurrency((Number(line.item.expected_sell_price || 0) * line.qty).toFixed(2))}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCurrency(total.toFixed(2))}</Text>
          </View>
        </Card>
      ) : null}

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Payment</SectionLabel>
        <View style={styles.pillRow}>
          {PAYMENT_METHODS.map((entry) => (
            <TouchableOpacity key={entry} onPress={() => setMethod(entry)}>
              <Pill label={entry.toUpperCase()} tone={method === entry ? "primary" : "neutral"} />
            </TouchableOpacity>
          ))}
        </View>
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
        <Text style={styles.helperText}>Net after fees: {formatCurrency(net.toFixed(2))}</Text>
        <ActionButton label={submitting ? "Logging Sale..." : `Log Sale · ${formatCurrency(total.toFixed(2))}`} onPress={handleSubmit} disabled={submitting} />
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
  itemOptionActive: { borderColor: COLORS.primary },
  check: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
  },
  checkOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  itemName: { color: COLORS.text, fontSize: 15, fontWeight: "800" },
  itemMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  cartRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, paddingVertical: SPACING.xs },
  qtyStepper: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  qtyBtn: {
    width: 30, height: 30, borderRadius: 10, backgroundColor: COLORS.cardAlt,
    borderWidth: 1, borderColor: COLORS.border, alignItems: "center", justifyContent: "center",
  },
  qtyValue: { color: COLORS.text, fontSize: 15, fontWeight: "800", minWidth: 20, textAlign: "center" },
  lineTotal: { color: COLORS.success, fontSize: 14, fontWeight: "800", minWidth: 64, textAlign: "right" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.sm, marginTop: SPACING.xs },
  totalLabel: { color: COLORS.textMuted, fontSize: 14, fontWeight: "700" },
  totalValue: { color: COLORS.text, fontSize: 20, fontWeight: "800" },
  notesInput: { minHeight: 72, textAlignVertical: "top" },
});
