import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as api from "../services/api";
import { errorMessage } from "../services/errors";
import { Button } from "./Button";
import { Card, Icon, SectionLabel } from "./ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

/** Store barcodes that point at this item, beyond its UPC and SKU. */
export function LinkedBarcodes({ itemId }: { itemId: string }) {
  const [codes, setCodes] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listItemBarcodes(itemId)
      .then((links) => {
        if (!cancelled) setCodes(links.map((l) => l.code));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const add = async () => {
    const code = draft.trim();
    if (!code) return;
    setBusy(true);
    try {
      const link = await api.linkBarcode(itemId, code);
      setCodes((list) => (list.includes(link.code) ? list : [...list, link.code]));
      setDraft("");
    } catch (err) {
      Alert.alert("Couldn't link barcode", errorMessage(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string) => {
    try {
      await api.unlinkBarcode(itemId, code);
      setCodes((list) => list.filter((c) => c !== code));
    } catch (err) {
      Alert.alert("Couldn't remove barcode", errorMessage(err, "Try again."));
    }
  };

  return (
    <Card>
      <SectionLabel>Store barcodes</SectionLabel>
      <Text style={styles.helper}>Extra tags that scan to this item, like a shelf tag or another store&apos;s sticker.</Text>
      <View style={styles.chips}>
        {codes.map((code) => (
          <View key={code} style={styles.chip}>
            <Text style={styles.chipText}>{code}</Text>
            <TouchableOpacity onPress={() => void remove(code)} accessibilityLabel={`Remove ${code}`} hitSlop={12}>
              <Icon name="close-circle" size={18} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a barcode"
          placeholderTextColor={COLORS.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.input}
          testID="linked-barcode-input"
          onSubmitEditing={() => void add()}
        />
        <Button label="Link" size="sm" onPress={() => void add()} loading={busy} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  helper: { ...TYPE.caption, color: COLORS.textMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginVertical: SPACING.xs },
  chip: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xxs, paddingHorizontal: SPACING.sm,
    minHeight: 32, borderRadius: RADII.sm, backgroundColor: COLORS.cardAlt,
  },
  chipText: { ...TYPE.caption, color: COLORS.text, fontWeight: "600" },
  row: { flexDirection: "row", gap: SPACING.sm, alignItems: "center" },
  input: {
    flex: 1, borderWidth: 1, borderColor: COLORS.border, borderRadius: RADII.md,
    paddingHorizontal: SPACING.sm, minHeight: 44, color: COLORS.text,
  },
});
