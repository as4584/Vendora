import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as api from "../../../services/api";
import { useAuth } from "../../../context/auth";
import { ActionButton } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCompactDate, formatCurrency } from "../../../utils/inventory";

const DEFAULT_ACCENT = "#3B7BDB";

/** Read-only visual preview of an invoice — see it before sending, no share sheet. */
export default function InvoicePreviewScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [invoice, setInvoice] = useState<api.InvoiceData | null>(null);
  const [loading, setLoading] = useState(true);

  const accent = (user as any)?.invoice_accent_color || DEFAULT_ACCENT;
  const bizName = user?.business_name || user?.email?.split("@")[0] || "Your Business";

  useEffect(() => {
    if (!id) return;
    api.getInvoice(id)
      .then(setInvoice)
      .catch(() => setInvoice(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }
  if (!invoice) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Invoice not found.</Text>
        <ActionButton label="Back" onPress={() => router.back()} tone="secondary" compact />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.topbar}>
        <ActionButton label="Close" onPress={() => router.back()} tone="ghost" compact />
      </View>

      {/* Paper — mirrors the PDF layout */}
      <View style={styles.paper}>
        <View style={[styles.accentBar, { backgroundColor: accent }]} />
        <View style={styles.paperBody}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <View style={[styles.logo, { backgroundColor: accent }]}>
                <Text style={styles.logoText}>
                  {bizName.split(" ").slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "V"}
                </Text>
              </View>
              <Text style={styles.bizName}>{bizName}</Text>
              {!!(user as any)?.business_address && <Text style={styles.small}>{(user as any).business_address}</Text>}
              {!!(user as any)?.business_phone && <Text style={styles.small}>{(user as any).business_phone}</Text>}
              {!!user?.email && <Text style={styles.small}>{user.email}</Text>}
            </View>
            <Text style={styles.invoiceWord}>INVOICE</Text>
          </View>

          <View style={styles.sep} />

          <View style={styles.metaRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: accent }]}>BILL TO</Text>
              <Text style={styles.billName}>{invoice.customer_name}</Text>
              {!!invoice.customer_email && <Text style={styles.small}>{invoice.customer_email}</Text>}
            </View>
            <View>
              <MetaLine label="DATE" value={formatCompactDate(invoice.created_at)} accent={accent} />
              <MetaLine label="STATUS" value={invoice.status.toUpperCase()} accent={accent} />
            </View>
          </View>

          {/* Line items */}
          <View style={[styles.thead, { backgroundColor: accent }]}>
            <Text style={[styles.th, { flex: 3 }]}>Description</Text>
            <Text style={[styles.th, styles.right]}>Qty</Text>
            <Text style={[styles.th, styles.right]}>Unit</Text>
            <Text style={[styles.th, styles.right]}>Amount</Text>
          </View>
          {invoice.items.map((it) => (
            <View key={it.id} style={styles.trow}>
              <View style={{ flex: 3 }}>
                <Text style={styles.tdBold}>{it.description}</Text>
                {!!it.size_label && <Text style={styles.small}>Size: {it.size_label}</Text>}
              </View>
              <Text style={[styles.td, styles.right]}>{it.quantity}</Text>
              <Text style={[styles.td, styles.right]}>{formatCurrency(it.unit_price)}</Text>
              <Text style={[styles.td, styles.right]}>{formatCurrency(it.line_total)}</Text>
            </View>
          ))}

          {/* Totals */}
          <View style={styles.totals}>
            <TotalLine label="Subtotal" value={formatCurrency(invoice.subtotal)} />
            {Number(invoice.tax) > 0 && <TotalLine label="Tax" value={formatCurrency(invoice.tax)} />}
            {Number(invoice.shipping) > 0 && <TotalLine label="Shipping" value={formatCurrency(invoice.shipping)} />}
            {Number(invoice.discount) > 0 && <TotalLine label="Discount" value={`-${formatCurrency(invoice.discount)}`} />}
            <TotalLine label="Total" value={formatCurrency(invoice.total)} bold />
          </View>

          <View style={styles.balanceBar}>
            <Text style={styles.balanceText}>BALANCE DUE</Text>
            <Text style={styles.balanceText}>
              {formatCurrency(invoice.status === "paid" ? "0" : invoice.total)}
            </Text>
          </View>

          {!!invoice.notes && <Text style={styles.notes}>Notes: {invoice.notes}</Text>}
        </View>
      </View>
    </ScrollView>
  );
}

function MetaLine({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={styles.metaLine}>
      <Text style={[styles.label, { color: accent, width: 54 }]}>{label}</Text>
      <Text style={styles.metaVal}>{value}</Text>
    </View>
  );
}
function TotalLine({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.totalLine}>
      <Text style={[styles.totalLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.totalVal, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const INK = "#1e1e1e";
const MID = "#6e6e6e";
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 48 },
  center: { flex: 1, backgroundColor: COLORS.bg, alignItems: "center", justifyContent: "center", gap: SPACING.md },
  muted: { color: COLORS.textMuted },
  topbar: { flexDirection: "row", justifyContent: "flex-end", marginBottom: SPACING.sm },
  paper: { backgroundColor: "#fff", borderRadius: 10, overflow: "hidden" },
  accentBar: { height: 8 },
  paperBody: { padding: SPACING.lg },
  headerRow: { flexDirection: "row", alignItems: "flex-start" },
  logo: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800" },
  bizName: { color: INK, fontWeight: "800", fontSize: 15, marginTop: 6 },
  invoiceWord: { color: INK, fontWeight: "900", fontSize: 26 },
  small: { color: MID, fontSize: 11, marginTop: 2 },
  sep: { height: 1, backgroundColor: "#e2e2e2", marginVertical: SPACING.md },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: SPACING.md },
  label: { fontSize: 9, fontWeight: "800" },
  billName: { color: INK, fontWeight: "800", fontSize: 14, marginTop: 2 },
  metaLine: { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  metaVal: { color: INK, fontSize: 11, fontWeight: "600" },
  thead: { flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, borderRadius: 4 },
  th: { color: "#fff", fontWeight: "800", fontSize: 11, flex: 1 },
  right: { textAlign: "right" },
  trow: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: "#eee" },
  td: { color: INK, fontSize: 12, flex: 1 },
  tdBold: { color: INK, fontSize: 12, fontWeight: "700" },
  totals: { alignItems: "flex-end", marginTop: SPACING.md, gap: 4 },
  totalLine: { flexDirection: "row", gap: SPACING.xl, minWidth: 200, justifyContent: "space-between" },
  totalLabel: { color: MID, fontSize: 12 },
  totalVal: { color: INK, fontSize: 12 },
  bold: { fontWeight: "800", color: INK },
  balanceBar: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#000", padding: 10, borderRadius: 4, marginTop: SPACING.md },
  balanceText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  notes: { color: MID, fontSize: 11, marginTop: SPACING.md, fontStyle: "italic" },
});
