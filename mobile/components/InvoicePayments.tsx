/**
 * Balance + payment history + "Record payment" form for one invoice.
 * Partial and full payments; the server rejects overpayment, and the form
 * checks it first so the seller sees the reason before a round trip.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "../services/api";
import { invoiceBalance, invoicePaid } from "../utils/invoices";
import { Button, triggerHaptic } from "./Button";
import { Icon } from "./ui";
import { COLORS, MIN_TOUCH, RADII, SPACING, TYPE } from "../theme/tokens";
import { formatCurrency, formatShortDateTime } from "../utils/inventory";

export const PAYMENT_METHODS: { value: api.InvoicePaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "zelle", label: "Zelle" },
  { value: "venmo", label: "Venmo" },
  { value: "cashapp", label: "Cash App" },
  { value: "paypal", label: "PayPal" },
  { value: "stripe", label: "Stripe" },
  { value: "other", label: "Other" },
];

export function methodLabel(method: string): string {
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method;
}

/** Status shown to people, not the enum. */
export function invoiceStatusLabel(invoice: api.InvoiceData): string {
  if (invoice._pending) return "PENDING SYNC";
  if (invoice.status === "partially_paid") return "PART PAID";
  if (invoice.status === "cancelled") return "VOID";
  return invoice.status.toUpperCase();
}

export function invoiceStatusTone(invoice: api.InvoiceData): "success" | "info" | "warning" | "neutral" {
  if (invoice._pending || invoice.status === "cancelled") return "neutral";
  if (invoice.status === "paid") return "success";
  if (invoice.status === "sent" || invoice.status === "partially_paid") return "info";
  return "warning";
}

/** Parse "12.5" / "$12.50" into cents, or null when not a positive amount. */
export function parseAmountCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

const PAYABLE = new Set(["draft", "sent", "partially_paid"]);

export function InvoicePayments({
  invoice,
  onRecorded,
}: {
  invoice: api.InvoiceData;
  onRecorded: (updated: api.InvoiceData) => void;
}) {
  const balance = invoiceBalance(invoice);
  const paid = invoicePaid(invoice);
  const payments = invoice.payments ?? [];
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<api.InvoicePaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canPay = !invoice._pending && PAYABLE.has(invoice.status) && balance > 0;

  const startPayment = () => {
    setAmount(balance.toFixed(2));
    setMethod("cash");
    setNote("");
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    const cents = parseAmountCents(amount);
    if (cents == null) {
      setError("Enter an amount more than $0.00.");
      return;
    }
    if (cents > Math.round(balance * 100)) {
      setError(`That's more than the ${formatCurrency(balance.toFixed(2))} balance due.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.recordInvoicePayment(invoice.id, {
        amount: (cents / 100).toFixed(2),
        method,
        note: note.trim() || undefined,
      });
      triggerHaptic(updated.status === "paid" ? "success" : "light");
      setOpen(false);
      onRecorded(updated);
    } catch (err: any) {
      setError(err?.message || "Could not record the payment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.wrap} testID="invoice-payments">
      <View style={styles.summary}>
        <SummaryCell label="Total" value={formatCurrency(invoice.total)} />
        <SummaryCell label="Paid" value={formatCurrency(paid.toFixed(2))} />
        <SummaryCell label="Balance due" value={formatCurrency(balance.toFixed(2))} strong={balance > 0} />
      </View>

      {payments.length > 0 ? (
        <View style={styles.history} accessibilityLabel="Payment history">
          {payments.map((p) => (
            <View key={p.id} style={styles.historyRow}>
              <Icon name="checkmark-circle" size={18} color={COLORS.success} />
              <View style={styles.historyText}>
                <Text style={styles.historyTitle} numberOfLines={2}>
                  {methodLabel(p.method)} · {formatShortDateTime(p.created_at)}
                </Text>
                {p.note ? (
                  <Text style={styles.historyNote} numberOfLines={2}>
                    {p.note}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.historyAmount}>{formatCurrency(p.amount)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {invoice._pending ? (
        <Text style={styles.hint}>Payments open once this invoice syncs and gets its number.</Text>
      ) : null}

      {canPay && !open ? (
        <Button label="Record payment" leadingIcon="cash-outline" onPress={startPayment} fullWidth />
      ) : null}

      {open ? (
        <View style={styles.form}>
          <Text style={styles.fieldLabel}>Amount</Text>
          <TextInput
            accessibilityLabel="Payment amount"
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={COLORS.textSoft}
          />
          <Text style={styles.fieldLabel}>Method</Text>
          <View style={styles.methods}>
            {PAYMENT_METHODS.map((m) => {
              const selected = m.value === method;
              return (
                <Pressable
                  key={m.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={m.label}
                  onPress={() => setMethod(m.value)}
                  style={[styles.methodChip, selected && styles.methodChipOn]}
                >
                  <Text style={[styles.methodText, selected && styles.methodTextOn]}>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.fieldLabel}>Note</Text>
          <TextInput
            accessibilityLabel="Payment note"
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="Optional, e.g. deposit"
            placeholderTextColor={COLORS.textSoft}
            maxLength={500}
          />
          {error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <View style={styles.formActions}>
            <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} style={styles.flex} />
            <Button label="Save payment" onPress={save} loading={saving} disabled={saving} style={styles.flex} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SummaryCell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.cellValue, strong && styles.cellStrong]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  summary: {
    flexDirection: "row",
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.cardAlt,
    overflow: "hidden",
  },
  cell: { flex: 1, minWidth: 0, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm, gap: 2 },
  cellLabel: { ...TYPE.caption, color: COLORS.textMuted },
  cellValue: { ...TYPE.callout, color: COLORS.text },
  cellStrong: { color: COLORS.warning },
  history: {
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  historyText: { flex: 1, minWidth: 0 },
  historyTitle: { ...TYPE.footnote, color: COLORS.text },
  historyNote: { ...TYPE.caption, color: COLORS.textMuted, marginTop: 2 },
  historyAmount: { ...TYPE.callout, color: COLORS.success },
  hint: { ...TYPE.footnote, color: COLORS.textMuted },
  form: {
    gap: SPACING.xs,
    padding: SPACING.md,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
  },
  fieldLabel: { ...TYPE.caption, color: COLORS.textMuted, marginTop: SPACING.xs },
  input: {
    minHeight: MIN_TOUCH,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADII.md,
    color: COLORS.text,
    paddingHorizontal: 14,
    ...TYPE.body,
  },
  methods: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  methodChip: {
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  methodChipOn: { borderColor: COLORS.primary, backgroundColor: COLORS.primarySoft },
  methodText: { ...TYPE.footnote, color: COLORS.textMuted },
  methodTextOn: { color: COLORS.text },
  error: { ...TYPE.footnote, color: COLORS.danger },
  formActions: { flexDirection: "row", gap: SPACING.sm, marginTop: SPACING.sm },
  flex: { flex: 1 },
});
