import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as api from "../services/api";
import { ApiError } from "../services/api";
import { errorMessage } from "../services/errors";
import { Button, triggerHaptic } from "./Button";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

/**
 * A scan that matched nothing. Instead of a dead end, the seller decides:
 * link this store barcode to an item (once, forever), add it as new stock,
 * or write a rule for every code shaped like it.
 */
export function UnknownBarcodeSheet({
  code,
  onClose,
  onLinked,
  onAddNew,
  onMakeRule,
}: {
  code: string | null;
  onClose: () => void;
  onLinked: (item: api.InventoryItem) => void;
  onAddNew: (code: string) => void;
  onMakeRule: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.InventoryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const page = await api.listItems({ q: query.trim() || undefined, perPage: 8, availableOnly: true });
        if (!cancelled) setResults(page.items);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, query]);

  // A new scan starts with an empty search.
  const [shownCode, setShownCode] = useState(code);
  if (code !== shownCode) {
    setShownCode(code);
    setQuery("");
  }

  if (!code) return null;

  const link = async (item: api.InventoryItem, replace = false) => {
    setLinking(item.id);
    try {
      await api.linkBarcode(item.id, code, replace);
      triggerHaptic("success");
      onLinked(item);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !replace) {
        Alert.alert("Barcode already linked", errorMessage(err, "This barcode belongs to another item."), [
          { text: "Cancel", style: "cancel" },
          { text: `Move to ${item.name}`, onPress: () => void link(item, true) },
        ]);
      } else {
        Alert.alert("Couldn't link barcode", errorMessage(err, "Try again."));
      }
    } finally {
      setLinking(null);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="unknown-barcode-sheet">
          <Text style={styles.title}>New barcode</Text>
          <Text style={styles.code} selectable>{code}</Text>
          <Text style={styles.helper}>
            Pick the item this tag belongs to. Resqlo remembers it, so the next scan adds it straight to the cart.
          </Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search your stock"
            placeholderTextColor={COLORS.textMuted}
            style={styles.search}
            autoCorrect={false}
            testID="unknown-barcode-search"
          />
          <View style={styles.list}>
            {searching && results.length === 0 ? <ActivityIndicator color={COLORS.primary} /> : null}
            {!searching && results.length === 0 ? <Text style={styles.empty}>No matching items.</Text> : null}
            {results.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={styles.row}
                onPress={() => void link(item)}
                disabled={linking !== null}
                accessibilityRole="button"
                accessibilityLabel={`Link to ${item.name}`}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {[item.size && `Size ${item.size}`, item.sku, `${item.quantity} left`].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                {linking === item.id ? <ActivityIndicator color={COLORS.primary} /> : <Text style={styles.rowAction}>Link</Text>}
              </TouchableOpacity>
            ))}
          </View>
          <Button label="Add as new item" variant="secondary" leadingIcon="add-circle-outline" onPress={() => onAddNew(code)} fullWidth />
          <Button
            label="Make a rule for codes like this"
            variant="ghost"
            leadingIcon="git-branch-outline"
            onPress={() => onMakeRule(code)}
            fullWidth
          />
          <Button label="Skip" variant="ghost" onPress={onClose} fullWidth />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    backgroundColor: COLORS.bgElevated,
    borderTopLeftRadius: RADII.lg,
    borderTopRightRadius: RADII.lg,
    padding: SPACING.lg,
    gap: SPACING.sm,
    maxHeight: "88%",
  },
  title: { ...TYPE.title, color: COLORS.text },
  code: { fontFamily: "Courier", fontSize: 16, color: COLORS.text, letterSpacing: 1 },
  helper: { ...TYPE.caption, color: COLORS.textMuted },
  search: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.md,
    minHeight: 44,
    color: COLORS.text,
  },
  list: { gap: SPACING.xs, minHeight: 60 },
  empty: { ...TYPE.caption, color: COLORS.textMuted, textAlign: "center", paddingVertical: SPACING.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    borderRadius: RADII.md,
    backgroundColor: COLORS.card,
    gap: SPACING.sm,
  },
  rowText: { flex: 1 },
  rowName: { ...TYPE.body, color: COLORS.text, fontWeight: "600" },
  rowMeta: { ...TYPE.caption, color: COLORS.textMuted },
  rowAction: { ...TYPE.body, color: COLORS.primary, fontWeight: "700" },
});
