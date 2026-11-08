/**
 * Sync Center: eBay payouts reconciled against imported orders, plus the
 * per-order fee breakdown (final value, ads, shipping label, other).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { COLORS, SPACING, TYPE } from "../theme/tokens";
import { errorMessage } from "../services/errors";

const money = (v: string | null) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);

export function feeParts(f: api.EbayOrderFees): string {
  const parts: string[] = [];
  if (Number(f.final_value_fee)) parts.push(`Final value ${money(f.final_value_fee)}`);
  if (Number(f.ad_fee)) parts.push(`Ads ${money(f.ad_fee)}`);
  if (Number(f.shipping_label)) parts.push(`Label ${money(f.shipping_label)}`);
  if (Number(f.other_fees)) parts.push(`Other ${money(f.other_fees)}`);
  return parts.length ? parts.join(" · ") : "No fees";
}

export function EbayPayouts({ connected }: { connected: boolean }) {
  const [payouts, setPayouts] = useState<api.EbayPayout[]>([]);
  const [fees, setFees] = useState<api.EbayOrderFees[]>([]);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const [p, f] = await Promise.all([
      api.listEbayPayouts().catch(() => [] as api.EbayPayout[]),
      api.listEbayFees().catch(() => [] as api.EbayOrderFees[]),
    ]);
    setPayouts(p);
    setFees(f);
  }, []);

  useEffect(() => {
    // Fetch-on-mount: load's state updates are the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (connected) void load();
  }, [connected, load]);

  if (!connected) return null;

  const sync = async () => {
    setSyncing(true);
    try {
      await api.syncEbayFinances();
      await load();
    } catch (err: any) {
      Alert.alert("eBay fees unavailable", errorMessage(err, "Try again later."));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <SectionLabel>eBay Payouts</SectionLabel>
      <Card style={styles.stack}>
        {payouts.length === 0 ? (
          <Text style={styles.muted}>Sync eBay fees to see payouts and the real profit on each order.</Text>
        ) : (
          payouts.slice(0, 5).map((p) => (
            <View key={p.payout_id} style={styles.row}>
              <View style={styles.text}>
                <Text style={styles.title}>{`${money(p.amount)} payout`}</Text>
                <Text style={styles.muted}>
                  {p.reconciled
                    ? `Matches ${p.orders_matched} order${p.orders_matched === 1 ? "" : "s"}`
                    : p.orders_missing > 0
                      ? `${p.orders_missing} order${p.orders_missing === 1 ? "" : "s"} not imported yet`
                      : `Off by ${money(p.difference)}`}
                </Text>
              </View>
              <Pill label={p.reconciled ? "Reconciled" : "Check"} tone={p.reconciled ? "success" : "warning"} />
            </View>
          ))
        )}
        {fees.slice(0, 5).map((f) => (
          <View key={f.order_id} style={styles.feeRow}>
            <Text style={styles.title}>{`Order ${f.order_id}: ${money(f.gross)} sold, ${money(f.net)} net`}</Text>
            <Text style={styles.muted}>{feeParts(f)}</Text>
          </View>
        ))}
        <Button testID="ebay-fees-sync" label="Sync eBay fees" size="sm" variant="secondary" onPress={sync} loading={syncing} />
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACING.sm },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  feeRow: { gap: SPACING.xxs, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.xs },
  text: { flex: 1, gap: 2 },
  title: { ...TYPE.callout, color: COLORS.text },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
});
