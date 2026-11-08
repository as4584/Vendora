import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as api from "../../../services/api";
import { Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { Button } from "../../../components/Button";
import { COLORS, FONT_SCALE, SPACING, TYPE } from "../../../theme/tokens";
import { formatCompactDate, formatCurrency } from "../../../utils/inventory";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", sent: "Sent", partially_paid: "Part paid", paid: "Paid", cancelled: "Void",
};

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<api.CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", notes: "", tax_exempt: false });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const detail = await api.getCustomer(id);
      setCustomer(detail);
      setForm({
        name: detail.name, email: detail.email || "", phone: detail.phone || "",
        address: detail.address || "", notes: detail.notes || "", tax_exempt: detail.tax_exempt,
      });
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Could not load this customer.");
    }
  }, [id]);

  // Fetch-on-mount: load's state updates are the point of the effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!customer) return;
    if (!form.name.trim()) { Alert.alert("Name required", "A customer needs a name."); return; }
    setSaving(true);
    try {
      await api.updateCustomer(customer.id, { ...form, name: form.name.trim() });
      setEditing(false);
      await load();
    } catch (err: any) {
      Alert.alert("Save failed", err?.message || "Could not update the customer.");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <View style={styles.center}><Text style={styles.meta}>{error}</Text></View>;
  if (!customer) return <View style={styles.center}><ActivityIndicator size="large" color={COLORS.primary} /></View>;

  const field = (key: "name" | "email" | "phone" | "address" | "notes", label: string, extra: object = {}) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={label}
      placeholderTextColor={COLORS.textSoft}
      style={styles.input}
      value={form[key]}
      onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
      {...extra}
    />
  );

  return (
    <ScrollView testID="customer-detail" style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <HeaderTitle title={customer.name} subtitle={[customer.email, customer.phone].filter(Boolean).join(" · ") || "No contact details"} />

      <View style={styles.stats}>
        <Card style={styles.stat}>
          <Text style={styles.statLabel}>Total spent</Text>
          <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.statValue}>{formatCurrency(customer.total_spent)}</Text>
        </Card>
        <Card style={styles.stat}>
          <Text style={styles.statLabel}>Purchases</Text>
          <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.statValue}>{customer.order_count}</Text>
        </Card>
        <Card style={styles.stat}>
          <Text style={styles.statLabel}>Last purchase</Text>
          <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.statValueSmall}>
            {customer.last_purchase_at ? formatCompactDate(customer.last_purchase_at) : "None yet"}
          </Text>
        </Card>
      </View>

      <Card style={styles.stack}>
        <SectionLabel>Details</SectionLabel>
        {editing ? (
          <>
            {field("name", "Name")}
            {field("email", "Email", { autoCapitalize: "none", keyboardType: "email-address" })}
            {field("phone", "Phone", { keyboardType: "phone-pad" })}
            {field("address", "Address")}
            {field("notes", "Notes")}
            <View style={styles.switchRow}>
              <Text style={styles.body}>Tax exempt (no sales tax at checkout)</Text>
              <Switch
                accessibilityLabel="Tax exempt"
                value={form.tax_exempt}
                onValueChange={(v) => setForm((f) => ({ ...f, tax_exempt: v }))}
                trackColor={{ true: COLORS.primary, false: COLORS.border }}
              />
            </View>
            <Button label="Save" onPress={save} loading={saving} fullWidth />
            <Button label="Cancel" variant="ghost" onPress={() => setEditing(false)} fullWidth />
          </>
        ) : (
          <>
            <Text style={styles.body}>{customer.address || "No address"}</Text>
            {customer.notes ? <Text style={styles.meta}>{customer.notes}</Text> : null}
            {customer.tax_exempt ? <Pill label="Tax exempt" tone="info" /> : null}
            <Button label="Edit details" size="sm" variant="secondary" leadingIcon="create-outline" onPress={() => setEditing(true)} />
          </>
        )}
      </Card>

      <Card style={styles.stack}>
        <SectionLabel>Purchase history</SectionLabel>
        {customer.invoices.length === 0 && customer.orders.length === 0 ? (
          <Text style={styles.meta}>No purchases yet.</Text>
        ) : null}
        {customer.orders.map((o) => (
          <View key={o.transaction_id} style={styles.histRow}>
            <View style={styles.flex}>
              <Text style={styles.body}>Checkout · {o.item_count} {o.item_count === 1 ? "item" : "items"}</Text>
              <Text style={styles.meta}>{formatCompactDate(o.created_at)}</Text>
            </View>
            {o.refunded ? <Pill label="Refunded" tone="warning" /> : null}
            <Text style={styles.amount}>{formatCurrency(o.total)}</Text>
          </View>
        ))}
        {customer.invoices.map((inv) => (
          <View key={inv.id} style={styles.histRow}>
            <View style={styles.flex}>
              <Text style={styles.body}>Invoice {inv.invoice_number}</Text>
              <Text style={styles.meta}>{formatCompactDate(inv.created_at)} · paid {formatCurrency(inv.amount_paid)}</Text>
            </View>
            <Pill label={STATUS_LABEL[inv.status] || inv.status} tone={inv.status === "paid" ? "success" : inv.status === "cancelled" ? "neutral" : "warning"} />
            <Text style={styles.amount}>{formatCurrency(inv.total)}</Text>
          </View>
        ))}
      </Card>

      <Button
        label="New invoice for this customer"
        leadingIcon="receipt-outline"
        onPress={() => router.push({ pathname: "/inventory/invoices" as any, params: { customer: customer.id } })}
        fullWidth
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: { flex: 1, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center", padding: SPACING.lg },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  stat: { flexGrow: 1, flexBasis: 100, gap: 4 },
  statLabel: { ...TYPE.caption, color: COLORS.textMuted },
  statValue: { ...TYPE.title, color: COLORS.text },
  statValueSmall: { ...TYPE.headline, color: COLORS.text },
  stack: { gap: SPACING.sm },
  flex: { flex: 1, minWidth: 0 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm },
  histRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING.sm, paddingVertical: SPACING.xs, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  body: { ...TYPE.subhead, color: COLORS.text, flexShrink: 1 },
  meta: { ...TYPE.footnote, color: COLORS.textMuted },
  amount: { ...TYPE.callout, color: COLORS.text },
  input: {
    ...TYPE.body,
    color: COLORS.text,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    paddingHorizontal: SPACING.sm,
    minHeight: 48,
  },
});
