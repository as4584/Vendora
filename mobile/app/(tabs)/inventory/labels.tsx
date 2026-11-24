/**
 * Price Labels — pick pairs, choose label printer or Avery sheet, print.
 * The PDF opens in the share sheet (Print / AirPrint / save / send).
 * Each label's QR code scans straight into the Quick Sale cart.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as api from "../../../services/api";
import { Button } from "../../../components/Button";
import { Icon } from "../../../components/ui";
import { COLORS, RADII, SPACING, TYPE } from "../../../theme/tokens";
import { downloadAndShareRemote } from "../../../utils/fileActions";
import { errorMessage } from "../../../services/errors";
import { formatCurrency } from "../../../utils/inventory";

const LAYOUTS: { id: api.LabelLayout; label: string; hint: string }[] = [
  { id: "thermal", label: "Label printer", hint: '2.25" x 1.25" (Rollo, Dymo, Zebra)' },
  { id: "sheet", label: "Avery sheet", hint: "Letter, 30 per page (5160)" },
];

export default function LabelsScreen() {
  const { ids } = useLocalSearchParams<{ ids?: string }>();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ids ? ids.split(",").filter(Boolean) : []));
  const [layout, setLayout] = useState<api.LabelLayout>("thermal");
  const [perUnit, setPerUnit] = useState(false);
  const [printing, setPrinting] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (term: string) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await api.listItems({ perPage: 100, availableOnly: true, ...(term.trim() ? { q: term.trim() } : {}) });
      if (mine === seq.current) setItems(res.items);
    } catch {
      if (mine === seq.current) setItems([]);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(query), 200);
    return () => clearTimeout(t);
  }, [load, query]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allShown = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of items) {
        if (allShown) next.delete(i.id);
        else next.add(i.id);
      }
      return next;
    });

  const count = perUnit
    ? items.filter((i) => selected.has(i.id)).reduce((n, i) => n + Math.max(1, i.quantity || 1), 0) +
      [...selected].filter((id) => !items.some((i) => i.id === id)).length
    : selected.size;

  async function print() {
    if (!selected.size || printing) return;
    setPrinting(true);
    try {
      const token = await api.getToken();
      await downloadAndShareRemote(
        api.priceLabelsUrl([...selected].slice(0, 200), layout, perUnit),
        "resqlo-labels.pdf",
        token,
        "application/pdf",
        (status) => `Could not make the labels (${status}).`,
      );
    } catch (err) {
      Alert.alert("Price labels", errorMessage(err, "Could not make the labels."));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.controls}>
        <View style={styles.row}>
          {LAYOUTS.map((l) => (
            <Pressable
              key={l.id}
              style={[styles.option, layout === l.id && styles.optionOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: layout === l.id }}
              onPress={() => setLayout(l.id)}
            >
              <Text style={[styles.optionTitle, layout === l.id && styles.onText]}>{l.label}</Text>
              <Text style={[styles.meta, layout === l.id && styles.onText]}>{l.hint}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked: perUnit }} onPress={() => setPerUnit((v) => !v)}>
          <Icon name={perUnit ? "checkbox" : "square-outline"} color={perUnit ? COLORS.primary : COLORS.textSoft} />
          <Text style={styles.body}>One label per pair in stock</Text>
        </Pressable>
        <View style={styles.row}>
          <TextInput
            accessibilityLabel="Search items to label"
            style={[styles.input, styles.flex]}
            placeholder="Search your pairs"
            placeholderTextColor={COLORS.textSoft}
            value={query}
            onChangeText={setQuery}
          />
          <Button label={allShown ? "Clear" : "Select all"} variant="secondary" size="sm" onPress={toggleAll} />
        </View>
      </View>
      {loading && !items.length ? (
        <ActivityIndicator color={COLORS.primary} style={{ marginTop: SPACING.lg }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl }}
          ListEmptyComponent={<Text style={[styles.meta, { textAlign: "center", marginTop: SPACING.lg }]}>No pairs in stock match.</Text>}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            return (
              <Pressable
                style={styles.item}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`Label for ${item.name}`}
                onPress={() => toggle(item.id)}
              >
                <Icon name={on ? "checkbox" : "square-outline"} color={on ? COLORS.primary : COLORS.textSoft} />
                <View style={styles.flex}>
                  <Text style={styles.body} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {[item.size ? `Size ${item.size}` : null, item.expected_sell_price ? formatCurrency(item.expected_sell_price) : "No price", `Qty ${item.quantity}`]
                      .filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
      <View style={styles.footer}>
        <Button
          testID="print-labels"
          label={count ? `Print ${count} label${count === 1 ? "" : "s"}` : "Pick pairs to label"}
          size="lg"
          fullWidth
          leadingIcon="print-outline"
          loading={printing}
          disabled={!selected.size}
          onPress={() => void print()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  controls: { padding: SPACING.md, gap: SPACING.sm },
  row: { flexDirection: "row", gap: SPACING.sm, alignItems: "center" },
  option: {
    flex: 1, minHeight: 60, padding: SPACING.sm, borderRadius: RADII.md, borderWidth: 1,
    borderColor: COLORS.border, backgroundColor: COLORS.card, justifyContent: "center",
  },
  optionOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  optionTitle: { ...TYPE.body, fontWeight: "700", color: COLORS.text },
  onText: { color: "#FFFFFF" },
  check: { flexDirection: "row", alignItems: "center", gap: SPACING.xs, minHeight: 44 },
  input: {
    minHeight: 44, borderRadius: RADII.md, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.card, color: COLORS.text, paddingHorizontal: SPACING.sm, fontSize: 16,
  },
  item: {
    flexDirection: "row", alignItems: "center", gap: SPACING.sm, minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border,
  },
  body: { ...TYPE.body, color: COLORS.text },
  meta: { ...TYPE.caption, color: COLORS.textSoft },
  footer: { padding: SPACING.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
});
