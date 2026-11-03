import { useState } from "react";
import { Alert, Modal, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import * as api from "../services/api";
import { downloadAndShareRemote } from "../utils/fileActions";
import { Button } from "./Button";
import { Icon } from "./ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";
import { buildReceiptText, formatCents, paymentLabel, type ReceiptData } from "../utils/checkout";

/**
 * Post-sale receipt: what was sold, totals, how it was paid, and a Share
 * button that hands a plain-text receipt to the native share sheet.
 */
export function ReceiptSheet({
  receipt,
  onNewSale,
  onDone,
}: {
  receipt: ReceiptData | null;
  onNewSale: () => void;
  onDone: () => void;
}) {
  const [pdfBusy, setPdfBusy] = useState(false);
  const share = async () => {
    if (!receipt) return;
    try {
      await Share.share({ message: buildReceiptText(receipt), title: "Receipt" });
    } catch {
      // Dismissed or unavailable: nothing to do.
    }
  };
  const sharePdf = async () => {
    if (!receipt?.orderId || pdfBusy) return;
    setPdfBusy(true);
    try {
      const token = await api.getToken();
      await downloadAndShareRemote(
        api.orderReceiptPdfUrl(receipt.orderId),
        `receipt-${receipt.orderId.slice(0, 8)}.pdf`,
        token,
        "application/pdf",
        (status) => `Could not get the PDF receipt (${status}).`,
      );
    } catch (err: any) {
      Alert.alert("PDF receipt", err?.message || "Could not share the PDF receipt.");
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <Modal visible={!!receipt} animationType="slide" transparent onRequestClose={onDone}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          {receipt ? (
            <ScrollView contentContainerStyle={styles.content}>
              <View style={styles.hero}>
                <View style={[styles.badge, receipt.pending && styles.badgePending]}>
                  <Icon
                    name={receipt.pending ? "cloud-offline-outline" : "checkmark"}
                    size={28}
                    color={receipt.pending ? COLORS.warning : COLORS.success}
                  />
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                  {receipt.pending ? "Sale saved offline" : "Sale complete"}
                </Text>
                <Text style={styles.total}>{formatCents(receipt.total)}</Text>
                {receipt.pending ? (
                  <Text style={styles.helper}>Stock is updated on this device. The sale syncs when you are back online.</Text>
                ) : null}
              </View>

              <View style={styles.block}>
                {receipt.lines.map((line, index) => (
                  <View key={`${line.name}-${index}`} style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.rowLabel} numberOfLines={2}>{line.name}</Text>
                      <Text style={styles.rowMeta}>
                        {line.size ? `Size ${line.size} · ` : ""}
                        {line.qty} x {formatCents(line.unitCents)}
                      </Text>
                    </View>
                    <Text style={styles.rowValue}>{formatCents(line.unitCents * line.qty)}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.block}>
                <TotalRow label="Subtotal" value={formatCents(receipt.subtotal)} />
                {receipt.discount > 0 ? <TotalRow label="Discount" value={`-${formatCents(receipt.discount)}`} /> : null}
                {receipt.tax > 0 ? (
                  <TotalRow label={`Tax${receipt.taxRate ? ` (${receipt.taxRate}%)` : ""}`} value={formatCents(receipt.tax)} />
                ) : null}
                <TotalRow label="Total" value={formatCents(receipt.total)} strong />
                {receipt.payments.map((p, index) => (
                  <TotalRow key={`${p.method}-${index}`} label={`Paid · ${paymentLabel(p.method)}`} value={formatCents(p.cents)} />
                ))}
              </View>

              <View style={styles.actions}>
                <Button label="Share receipt" leadingIcon="share-outline" onPress={share} fullWidth size="lg" />
                {receipt.orderId && !receipt.pending ? (
                  <Button
                    label="Share PDF"
                    variant="secondary"
                    leadingIcon="document-text-outline"
                    onPress={sharePdf}
                    loading={pdfBusy}
                    fullWidth
                  />
                ) : null}
                <Button label="New sale" variant="secondary" leadingIcon="add" onPress={onNewSale} fullWidth />
                <Button label="Done" variant="ghost" onPress={onDone} fullWidth />
              </View>
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function TotalRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, !strong && styles.rowLabelMuted]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    maxHeight: "92%",
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADII.lg,
    borderTopRightRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: SPACING.xl },
  hero: { alignItems: "center", gap: SPACING.xs },
  badge: {
    width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center",
    backgroundColor: COLORS.bgElevated, borderWidth: 1, borderColor: COLORS.success,
  },
  badgePending: { borderColor: COLORS.warning },
  title: { ...TYPE.headline, color: COLORS.text, marginTop: SPACING.xs },
  total: { ...TYPE.largeTitle, color: COLORS.text },
  helper: { ...TYPE.footnote, color: COLORS.textMuted, textAlign: "center" },
  block: {
    backgroundColor: COLORS.bgElevated, borderRadius: RADII.md, borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs,
  },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, paddingVertical: SPACING.xs },
  rowMain: { flex: 1 },
  rowLabel: { ...TYPE.callout, color: COLORS.text, flexShrink: 1 },
  rowLabelMuted: { color: COLORS.textMuted, fontWeight: "500", flex: 1 },
  rowMeta: { ...TYPE.footnote, color: COLORS.textMuted, marginTop: 2 },
  rowValue: { ...TYPE.callout, color: COLORS.text, fontVariant: ["tabular-nums"] },
  rowValueStrong: { ...TYPE.headline },
  actions: { gap: SPACING.sm },
});
