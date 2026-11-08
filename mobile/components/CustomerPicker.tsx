/**
 * Quick-pick a customer at checkout or on an invoice: search the seller's
 * customers (works offline from the last list seen), or add a new one inline.
 */
import { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { COLORS, FONT_SCALE, RADII, SPACING, TYPE } from "../theme/tokens";

export function customerContact(c: Pick<api.Customer, "email" | "phone">): string {
  return [c.email, c.phone].filter(Boolean).join(" · ") || "No contact details";
}

export function CustomerPicker({
  selected,
  onChange,
  label = "Customer",
}: {
  selected: api.Customer | null;
  onChange: (customer: api.Customer | null) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      api.listCustomers(query)
        .then((items) => { if (live) { setResults(items); setError(null); } })
        .catch((err: any) => { if (live) setError(err?.message || "Could not load customers."); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [open, query]);

  const pick = (customer: api.Customer) => {
    onChange(customer);
    setOpen(false);
    setQuery("");
  };

  const save = async () => {
    if (!name.trim()) { setError("Enter the customer's name."); return; }
    setSaving(true);
    try {
      const created = await api.createCustomer({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setAdding(false);
      setName(""); setEmail(""); setPhone("");
      pick(created);
    } catch (err: any) {
      setError(err?.message || "Could not save the customer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.wrap}>
      {selected ? (
        <View testID="customer-picked" style={styles.selected}>
          <View style={styles.flex}>
            <Text maxFontSizeMultiplier={FONT_SCALE.control} style={styles.name} numberOfLines={1}>{selected.name}</Text>
            <Text maxFontSizeMultiplier={FONT_SCALE.control} style={styles.meta} numberOfLines={1}>
              {customerContact(selected)}{selected.tax_exempt ? " · Tax exempt" : ""}
            </Text>
          </View>
          <Button label="Change" size="sm" variant="secondary" onPress={() => setOpen(true)} />
          <Button label="Clear" size="sm" variant="ghost" onPress={() => onChange(null)} accessibilityLabel="Clear customer" />
        </View>
      ) : (
        <Button
          testID="customer-pick-button"
          label={`Pick ${label.toLowerCase()}`}
          size="sm"
          variant="secondary"
          leadingIcon="person-add-outline"
          onPress={() => setOpen(true)}
        />
      )}

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View testID="customer-picker-sheet" style={styles.sheet} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <Text accessibilityRole="header" style={styles.title}>{adding ? "New customer" : `Pick ${label.toLowerCase()}`}</Text>
              {adding ? (
                <>
                  <TextInput accessibilityLabel="New customer name" placeholder="Name" placeholderTextColor={COLORS.textSoft} style={styles.input} value={name} onChangeText={setName} />
                  <TextInput accessibilityLabel="New customer email" placeholder="Email (optional)" placeholderTextColor={COLORS.textSoft} style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
                  <TextInput accessibilityLabel="New customer phone" placeholder="Phone (optional)" placeholderTextColor={COLORS.textSoft} style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
                  {error ? <Text style={styles.error}>{error}</Text> : null}
                  <Button label="Save customer" onPress={save} loading={saving} fullWidth />
                  <Button label="Back" variant="ghost" onPress={() => { setAdding(false); setError(null); }} fullWidth />
                </>
              ) : (
                <>
                  <TextInput
                    accessibilityLabel="Search customers"
                    placeholder="Search name, email or phone"
                    placeholderTextColor={COLORS.textSoft}
                    style={styles.input}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                  />
                  {error ? <Text style={styles.error}>{error}</Text> : null}
                  {!loading && results.length === 0 ? (
                    <Text style={styles.meta}>{query.trim() ? "No customers match." : "No customers yet. Add one below."}</Text>
                  ) : null}
                  {results.slice(0, 30).map((c) => (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.row}
                      onPress={() => pick(c)}
                      accessibilityRole="button"
                      accessibilityLabel={`Pick ${c.name}`}
                    >
                      <Text style={styles.name} numberOfLines={1}>{c.name}</Text>
                      <Text style={styles.meta} numberOfLines={1}>{customerContact(c)}</Text>
                    </TouchableOpacity>
                  ))}
                  <Button label="Add new customer" variant="secondary" leadingIcon="add" onPress={() => { setAdding(true); setName(query); setError(null); }} fullWidth />
                  <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} fullWidth />
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.xs },
  flex: { flex: 1, minWidth: 0 },
  selected: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
  },
  name: { ...TYPE.callout, color: COLORS.text },
  meta: { ...TYPE.footnote, color: COLORS.textMuted },
  error: { ...TYPE.footnote, color: COLORS.danger },
  title: { ...TYPE.headline, color: COLORS.text },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: COLORS.overlay },
  sheet: {
    maxHeight: "92%",
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  sheetContent: { padding: SPACING.lg, gap: SPACING.sm, paddingBottom: SPACING.xl },
  row: { paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: COLORS.border, minHeight: 44 },
  input: {
    ...TYPE.body,
    color: COLORS.text,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.sm,
    minHeight: 48,
  },
});
