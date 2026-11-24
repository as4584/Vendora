/**
 * Trade — "my 4s for your 11s plus $20" in one screen.
 *
 * Pairs given come out of stock and count as sold at their agreed value;
 * pairs received go into inventory at what they actually cost (value out
 * minus cash in). Works offline: the trade is queued and synced later.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";
import { Card, SectionLabel } from "../../../components/ui";
import { Button, IconButton, triggerHaptic } from "../../../components/Button";
import { COLORS, RADII, SPACING, TYPE } from "../../../theme/tokens";
import { centsToString, toCents } from "../../../utils/checkout";
import { cashLabel, splitBasis, summarizeTrade } from "../../../utils/trade";
import { errorMessage } from "../../../services/errors";

interface GiveRow { key: string; item: api.InventoryItem; value: string }
interface GetRow { key: string; name: string; size: string; value: string }

const METHODS: { id: api.TradeCashMethod; label: string }[] = [
  { id: "cash", label: "Cash" }, { id: "venmo", label: "Venmo" }, { id: "cashapp", label: "Cash App" },
  { id: "zelle", label: "Zelle" }, { id: "card", label: "Card" },
];
const money = (cents: number) => `${cents < 0 ? "-" : ""}$${centsToString(Math.abs(cents))}`;
let nextKey = 0;
const key = () => `row-${++nextKey}`;
const blankGet = (): GetRow => ({ key: key(), name: "", size: "", value: "" });

export default function TradeScreen() {
  const router = useRouter();
  const [give, setGive] = useState<GiveRow[]>([]);
  const [get, setGet] = useState<GetRow[]>([blankGet()]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.InventoryItem[]>([]);
  // null = follow the suggested balance; otherwise the seller's own figure.
  const [cashOverride, setCashOverride] = useState<{ amount: string; theyPay: boolean } | null>(null);
  const [method, setMethod] = useState<api.TradeCashMethod>("cash");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<api.Trade | null>(null);
  const searchSeq = useRef(0);

  const search = useCallback(async (term: string) => {
    const seq = ++searchSeq.current;
    if (!term.trim()) {
      setResults([]);
      return;
    }
    try {
      const res = await api.listItems({ q: term.trim(), perPage: 8, availableOnly: true });
      if (seq === searchSeq.current) setResults(res.items);
    } catch {
      if (seq === searchSeq.current) setResults([]);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void search(query), 200);
    return () => clearTimeout(t);
  }, [query, search]);

  const filledGet = get.filter((g) => g.name.trim());
  const draft = summarizeTrade(
    give.map((g) => ({ value: g.value, cost: g.item.buy_price })),
    filledGet.map((g) => ({ value: g.value })),
    0,
  );
  const cashCents = cashOverride
    ? toCents(cashOverride.amount) * (cashOverride.theyPay ? 1 : -1)
    : draft.suggestedCashCents;
  const summary = summarizeTrade(
    give.map((g) => ({ value: g.value, cost: g.item.buy_price })),
    filledGet.map((g) => ({ value: g.value })),
    cashCents,
  );
  const bases = splitBasis(summary.basisCents, filledGet.map((g) => g.value));

  function addGive(item: api.InventoryItem) {
    triggerHaptic("light");
    setGive((rows) => (rows.some((r) => r.item.id === item.id) ? rows : [...rows, { key: key(), item, value: item.expected_sell_price ?? "" }]));
    setQuery("");
    setResults([]);
  }
  const editGet = (k: string, patch: Partial<GetRow>) => setGet((rows) => rows.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  async function save() {
    if (summary.error) {
      setError(summary.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trade = await api.createTrade({
        give: give.map((g) => ({ item_id: g.item.id, value: centsToString(toCents(g.value)), ...(g.item.size ? { size: g.item.size } : {}) })),
        get: filledGet.map((g) => ({ name: g.name.trim(), value: centsToString(toCents(g.value)), ...(g.size.trim() ? { size: g.size.trim() } : {}) })),
        cash_amount: centsToString(cashCents),
        cash_method: method,
      });
      triggerHaptic("success");
      setSaved(trade);
      setGive([]);
      setGet([blankGet()]);
      setCashOverride(null);
    } catch (e) {
      setError(errorMessage(e, "Couldn't save the trade. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {saved && (
          <Card style={styles.savedCard}>
            <Text style={styles.savedTitle}>{saved.pending ? "Trade saved — syncs when you're back online" : "Trade recorded"}</Text>
            <Text style={styles.meta}>
              Out {money(toCents(saved.value_out))} · In {money(toCents(saved.value_in))} · {cashLabel(toCents(saved.cash_amount))}
              {saved.profit != null ? ` · Profit ${money(toCents(saved.profit))}` : ""}
            </Text>
            <Button label="View inventory" variant="secondary" size="sm" onPress={() => router.push("/inventory")} />
          </Card>
        )}

        <SectionLabel>You give</SectionLabel>
        <TextInput
          accessibilityLabel="Search your inventory for a pair to give"
          style={styles.input}
          placeholder="Search your pairs"
          placeholderTextColor={COLORS.textSoft}
          value={query}
          onChangeText={setQuery}
        />
        {results.map((item) => (
          <Pressable key={item.id} style={styles.result} onPress={() => addGive(item)} accessibilityRole="button" accessibilityLabel={`Give ${item.name}`}>
            <Text style={styles.resultName} numberOfLines={1}>{item.name}{item.size ? ` · ${item.size}` : ""}</Text>
            <Text style={styles.meta}>{item.expected_sell_price ? `$${item.expected_sell_price}` : ""}</Text>
          </Pressable>
        ))}
        {give.map((row) => (
          <Card key={row.key} style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.resultName} numberOfLines={1}>{row.item.name}{row.item.size ? ` · ${row.item.size}` : ""}</Text>
              <Text style={styles.meta}>{row.item.buy_price ? `Cost $${row.item.buy_price}` : "Cost unknown"}</Text>
            </View>
            <TextInput
              accessibilityLabel={`Trade value for ${row.item.name}`}
              style={[styles.input, styles.money]}
              keyboardType="decimal-pad"
              placeholder="Value"
              placeholderTextColor={COLORS.textSoft}
              value={row.value}
              onChangeText={(value) => setGive((rows) => rows.map((r) => (r.key === row.key ? { ...r, value } : r)))}
            />
            <IconButton icon="close" label={`Remove ${row.item.name}`} onPress={() => setGive((rows) => rows.filter((r) => r.key !== row.key))} />
          </Card>
        ))}

        <SectionLabel>You get</SectionLabel>
        {get.map((row, index) => (
          <Card key={row.key} style={styles.row}>
            <View style={[styles.flex, { gap: SPACING.xs }]}>
              <TextInput
                accessibilityLabel={`Name of pair ${index + 1} you get`}
                style={styles.input}
                placeholder="e.g. Jordan 11 Concord"
                placeholderTextColor={COLORS.textSoft}
                value={row.name}
                onChangeText={(name) => editGet(row.key, { name })}
              />
              <View style={styles.inline}>
                <TextInput
                  accessibilityLabel={`Size of pair ${index + 1} you get`}
                  style={[styles.input, styles.flex]}
                  placeholder="Size"
                  placeholderTextColor={COLORS.textSoft}
                  value={row.size}
                  onChangeText={(size) => editGet(row.key, { size })}
                />
                <TextInput
                  accessibilityLabel={`Trade value of pair ${index + 1} you get`}
                  style={[styles.input, styles.money]}
                  keyboardType="decimal-pad"
                  placeholder="Value"
                  placeholderTextColor={COLORS.textSoft}
                  value={row.value}
                  onChangeText={(value) => editGet(row.key, { value })}
                />
              </View>
              {row.name.trim() !== "" && bases[filledGet.indexOf(row)] !== undefined && (
                <Text style={styles.meta}>Goes into inventory at cost {money(bases[filledGet.indexOf(row)])}</Text>
              )}
            </View>
            {get.length > 1 && (
              <IconButton icon="close" label={`Remove pair ${index + 1} you get`} onPress={() => setGet((rows) => rows.filter((r) => r.key !== row.key))} />
            )}
          </Card>
        ))}
        <Button label="Add another pair" variant="secondary" leadingIcon="add" onPress={() => setGet((rows) => [...rows, blankGet()])} />

        <SectionLabel>Cash</SectionLabel>
        <View style={styles.inline}>
          {[true, false].map((theyPay) => {
            const active = cashCents === 0 ? false : (cashCents > 0) === theyPay;
            return (
              <Pressable
                key={String(theyPay)}
                style={[styles.toggle, active && styles.toggleOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setCashOverride({ amount: centsToString(Math.abs(cashCents)), theyPay })}
              >
                <Text style={[styles.toggleText, active && styles.toggleTextOn]}>{theyPay ? "They pay me" : "I pay them"}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.inline}>
          <TextInput
            accessibilityLabel="Cash amount"
            style={[styles.input, styles.flex]}
            keyboardType="decimal-pad"
            value={centsToString(Math.abs(cashCents))}
            onChangeText={(amount) => setCashOverride({ amount, theyPay: cashOverride ? cashOverride.theyPay : cashCents >= 0 })}
          />
          {cashOverride && <Button label="Auto" size="sm" variant="ghost" onPress={() => setCashOverride(null)} />}
        </View>
        {cashCents !== 0 && (
          <View style={styles.chips}>
            {METHODS.map((m) => (
              <Pressable
                key={m.id}
                style={[styles.chip, method === m.id && styles.toggleOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: method === m.id }}
                onPress={() => setMethod(m.id)}
              >
                <Text style={[styles.toggleText, method === m.id && styles.toggleTextOn]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Card style={styles.summary}>
          <Text style={styles.summaryHead}>{cashLabel(cashCents)}</Text>
          <Text style={styles.meta}>You give {money(summary.outCents)} · You get {money(summary.inCents)}</Text>
          {summary.profitCents !== null && give.length > 0 && (
            <Text style={[styles.profit, { color: summary.profitCents >= 0 ? COLORS.success : COLORS.danger }]}>
              {summary.profitCents >= 0 ? "Profit" : "Loss"} on pairs you give: {money(summary.profitCents)}
            </Text>
          )}
          {filledGet.length > 0 && <Text style={styles.meta}>New pairs cost you {money(summary.basisCents)} in total</Text>}
        </Card>

        {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
        <Button testID="record-trade" label="Record trade" size="lg" fullWidth loading={saving} onPress={() => void save()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: SPACING.md, gap: SPACING.sm, paddingBottom: SPACING.xl * 2 },
  input: {
    minHeight: 48, borderRadius: RADII.md, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.card, color: COLORS.text, paddingHorizontal: SPACING.sm, fontSize: 16,
  },
  money: { width: 104, textAlign: "right" },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  inline: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  result: {
    minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: SPACING.sm, borderRadius: RADII.md, backgroundColor: COLORS.cardAlt,
  },
  resultName: { ...TYPE.body, color: COLORS.text, fontWeight: "600", flexShrink: 1 },
  meta: { ...TYPE.caption, color: COLORS.textSoft },
  toggle: {
    flex: 1, minHeight: 52, borderRadius: RADII.md, borderWidth: 1, borderColor: COLORS.border,
    alignItems: "center", justifyContent: "center", backgroundColor: COLORS.card,
  },
  toggleOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  toggleText: { ...TYPE.body, color: COLORS.text, fontWeight: "600" },
  toggleTextOn: { color: "#FFFFFF" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  chip: {
    minHeight: 48, minWidth: 72, paddingHorizontal: SPACING.sm, borderRadius: RADII.pill, borderWidth: 1,
    borderColor: COLORS.border, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.card,
  },
  summary: { gap: SPACING.xs },
  summaryHead: { ...TYPE.title, color: COLORS.text },
  profit: { ...TYPE.body, fontWeight: "700" },
  savedCard: { gap: SPACING.xs, borderColor: COLORS.success, borderWidth: 1 },
  savedTitle: { ...TYPE.body, color: COLORS.text, fontWeight: "700" },
  error: { ...TYPE.body, color: COLORS.danger },
});
