import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Card, Icon, SectionLabel } from "../../../components/ui";
import { Button } from "../../../components/Button";
import * as api from "../../../services/api";
import { errorMessage } from "../../../services/errors";
import { COLORS, RADII, SPACING, TYPE } from "../../../theme/tokens";

type Draft = { name: string; style_code: string; size: string; brand: string; category: string; color: string };

const FIELDS: { key: keyof Draft; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "style_code", label: "Style code" },
  { key: "size", label: "Size" },
  { key: "brand", label: "Brand" },
  { key: "category", label: "Category" },
  { key: "color", label: "Colorway" },
];

const toDraft = (p: api.AdminCatalogProduct): Draft => ({
  name: p.name, style_code: p.style_code, size: p.size ?? "",
  brand: p.brand ?? "", category: p.category ?? "", color: p.color ?? "",
});

const orNull = (v: string) => v.trim() || null;

/** Admin-only: find and fix wrong entries in the shared Resqlo catalog. */
export default function CatalogAdminScreen() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.AdminCatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<api.AdminCatalogProduct | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchCatalogAdmin(query.trim())
        .then((rows) => {
          if (!cancelled) setResults(rows);
        })
        .catch((err) => {
          if (!cancelled) Alert.alert("Couldn't search the catalog", errorMessage(err, "Try again."));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const open = (p: api.AdminCatalogProduct) => {
    setEditing(p);
    setDraft(toDraft(p));
  };
  const close = () => {
    setEditing(null);
    setDraft(null);
  };
  const replace = (p: api.AdminCatalogProduct) => setResults((rows) => rows.map((r) => (r.rq_code === p.rq_code ? p : r)));

  const save = async () => {
    if (!editing || !draft) return;
    if (!draft.name.trim() || !draft.style_code.trim()) {
      Alert.alert("Missing details", "A name and a style code are required.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateCatalogProduct(editing.rq_code, {
        name: draft.name.trim(), style_code: draft.style_code.trim(), size: orNull(draft.size),
        brand: orNull(draft.brand), category: orNull(draft.category), color: orNull(draft.color),
      });
      replace(updated);
      close();
    } catch (err) {
      Alert.alert("Couldn't save", errorMessage(err, "Try again."));
    } finally {
      setSaving(false);
    }
  };

  const remove = (p: api.AdminCatalogProduct) => {
    Alert.alert(
      `Delete ${p.rq_code}?`,
      "It disappears for every store. It comes back if a store saves this shoe again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteCatalogProduct(p.rq_code);
              setResults((rows) => rows.filter((r) => r.rq_code !== p.rq_code));
              close();
            } catch (err) {
              Alert.alert("Couldn't delete", errorMessage(err, "Try again."));
            }
          },
        },
      ],
    );
  };

  const unlink = async (p: api.AdminCatalogProduct, code: string) => {
    try {
      await api.unlinkCatalogBarcode(code);
      const updated = { ...p, barcodes: p.barcodes.filter((c) => c !== code) };
      replace(updated);
      setEditing(updated);
    } catch (err) {
      Alert.alert("Couldn't remove barcode", errorMessage(err, "Try again."));
    }
  };

  if (editing && draft) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          <SectionLabel>{editing.rq_code}</SectionLabel>
          <Text style={styles.helper}>Changes apply to every store. The Resqlo code itself never changes.</Text>
          {FIELDS.map(({ key, label }) => (
            <View key={key} style={styles.field}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                value={draft[key]}
                onChangeText={(v) => setDraft({ ...draft, [key]: v })}
                accessibilityLabel={label}
                autoCapitalize={key === "style_code" ? "characters" : "words"}
                autoCorrect={false}
                style={styles.input}
              />
            </View>
          ))}
          <Button label="Save for every store" onPress={() => void save()} loading={saving} />
        </Card>
        <Card>
          <SectionLabel>Box barcodes</SectionLabel>
          {editing.barcodes.length === 0 ? (
            <Text style={styles.helper}>No barcodes point here yet.</Text>
          ) : (
            <Text style={styles.helper}>Remove a barcode that belongs to a different shoe.</Text>
          )}
          <View style={styles.chips}>
            {editing.barcodes.map((code) => (
              <View key={code} style={styles.chip}>
                <Text style={styles.chipText}>{code}</Text>
                <TouchableOpacity onPress={() => void unlink(editing, code)} accessibilityLabel={`Remove ${code}`} hitSlop={12}>
                  <Icon name="close-circle" size={18} color={COLORS.textMuted} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        </Card>
        <Button label="Delete this entry" variant="destructive" onPress={() => remove(editing)} />
        <Button label="Back to search" variant="secondary" onPress={close} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search name, style code, barcode or RQ code"
        placeholderTextColor={COLORS.textMuted}
        autoCorrect={false}
        style={styles.input}
        testID="catalog-admin-search"
      />
      {loading ? <ActivityIndicator color={COLORS.primary} /> : null}
      {!loading && results.length === 0 ? <Text style={styles.helper}>Nothing found.</Text> : null}
      {results.map((p) => (
        <TouchableOpacity key={p.rq_code} style={styles.row} onPress={() => open(p)} accessibilityLabel={`Edit ${p.name}`}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{p.name}</Text>
            <Text style={styles.helper}>
              {p.rq_code} · {p.style_code}
              {p.size ? ` · size ${p.size}` : ""} · {p.times_confirmed} confirmed
            </Text>
          </View>
          <Icon name="chevron-forward" size={18} color={COLORS.textSoft} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, gap: SPACING.sm },
  helper: { ...TYPE.caption, color: COLORS.textMuted },
  field: { gap: SPACING.xxs, marginTop: SPACING.sm },
  label: { ...TYPE.caption, color: COLORS.text, fontWeight: "600" },
  input: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: RADII.md, backgroundColor: COLORS.card,
    paddingHorizontal: SPACING.sm, minHeight: 44, color: COLORS.text,
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: SPACING.md, backgroundColor: COLORS.card,
    borderRadius: RADII.lg, borderWidth: 1, borderColor: COLORS.border, padding: SPACING.md,
  },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, marginTop: SPACING.xs },
  chip: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xxs, paddingHorizontal: SPACING.sm,
    minHeight: 32, borderRadius: RADII.sm, backgroundColor: COLORS.cardAlt,
  },
  chipText: { ...TYPE.caption, color: COLORS.text, fontWeight: "600" },
});
