import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Card, Icon, SectionLabel } from "../../../components/ui";
import { Button, triggerHaptic } from "../../../components/Button";
import * as api from "../../../services/api";
import { COLORS, RADII, SPACING, TYPE } from "../../../theme/tokens";
import { buildShowSummaryText, formatCents, paymentLabel, toSignedCents } from "../../../utils/checkout";

type Window = "show" | "today" | "week";

const WINDOWS: { key: Window; label: string }[] = [
  { key: "show", label: "This show" },
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
];

function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function windowSince(win: Window, showStart: string | null): string | undefined {
  if (win === "show") return showStart ?? startOfToday().toISOString();
  if (win === "today") return startOfToday().toISOString();
  const d = startOfToday();
  d.setDate(d.getDate() - 6);
  return d.toISOString();
}

const money = (value: string) => formatCents(toSignedCents(value));
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

export default function ShowSummaryScreen() {
  const [win, setWin] = useState<Window>("show");
  const [showStart, setShowStart] = useState<string | null>(null);
  const [data, setData] = useState<api.ShowSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which: Window, start: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const summary = await api.getShowSummary({ since: windowSince(which, start) });
      setData(summary);
      setShowStart(summary.show_started_at);
    } catch (err: any) {
      setError(err?.message || "Could not load the summary.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // First load: the server applies the saved show start when no window is
    // sent; without one it falls back to the seller's local midnight (tz offset).
    api
      .getShowSummary({ tzOffsetMinutes: new Date().getTimezoneOffset() })
      .then((summary) => {
        setData(summary);
        setShowStart(summary.show_started_at);
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err?.message || "Could not load the summary.");
        setLoading(false);
      });
  }, [load]);

  const pick = (next: Window) => {
    triggerHaptic("light");
    setWin(next);
    load(next, showStart);
  };

  const startShow = async () => {
    setBusy(true);
    try {
      const summary = await api.startShow();
      setShowStart(summary.show_started_at);
      setData(summary);
      setWin("show");
      triggerHaptic("success");
    } catch (err: any) {
      Alert.alert("Couldn't start the show", err?.message || "Try again when you're online.");
    } finally {
      setBusy(false);
    }
  };

  const endShow = () => {
    Alert.alert("End this show?", "The summary will go back to counting from midnight. Your sales are not changed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "End show",
        style: "destructive",
        onPress: async () => {
          try {
            await api.endShow();
            setShowStart(null);
            setWin("today");
            load("today", null);
          } catch (err: any) {
            Alert.alert("Couldn't end the show", err?.message || "Try again when you're online.");
          }
        },
      },
    ]);
  };

  const share = async () => {
    if (!data) return;
    const title = win === "show" && showStart ? `Show summary since ${timeLabel(showStart)}` : `Sales summary since ${timeLabel(data.since)}`;
    try {
      await Share.share({ message: buildShowSummaryText(data, title), title: "Show summary" });
    } catch {
      // Dismissed.
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.segment} accessibilityRole="tablist">
        {WINDOWS.map((w) => (
          <TouchableOpacity
            key={w.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: win === w.key }}
            onPress={() => pick(w.key)}
            style={[styles.segmentItem, win === w.key && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, win === w.key && styles.segmentTextActive]}>{w.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Card style={styles.showCard}>
        <Icon name={showStart ? "storefront" : "storefront-outline"} size={22} color={showStart ? COLORS.success : COLORS.textMuted} />
        <View style={styles.flex}>
          <Text style={styles.showTitle}>{showStart ? "Show in progress" : "No show running"}</Text>
          <Text style={styles.helper}>
            {showStart ? `Started ${timeLabel(showStart)}` : "Start a show to count sales from the moment you open."}
          </Text>
        </View>
        {showStart ? (
          <Button label="End" size="sm" variant="secondary" onPress={endShow} />
        ) : (
          <Button label="Start" size="sm" onPress={startShow} loading={busy} disabled={busy} />
        )}
      </Card>

      {loading ? (
        <View style={styles.center} testID="show-summary-loading"><ActivityIndicator color={COLORS.primary} /></View>
      ) : !data ? (
        <Card><Text style={styles.helper}>{error || "The summary is unavailable."}</Text></Card>
      ) : (
        <>
          <Card style={styles.hero}>
            <Text style={styles.heroLabel}>Profit</Text>
            <Text style={[styles.heroValue, toSignedCents(data.profit) < 0 && { color: COLORS.danger }]}>{money(data.profit)}</Text>
            <Text style={styles.helper}>
              {data.orders} order{data.orders === 1 ? "" : "s"} · {data.units_sold} unit{data.units_sold === 1 ? "" : "s"} sold
            </Text>
          </Card>

          <Card style={styles.rows}>
            <SectionLabel>Breakdown</SectionLabel>
            <Row label="Sales" value={money(data.subtotal)} />
            {toSignedCents(data.discounts) > 0 ? <Row label="Discounts" value={`-${money(data.discounts)}`} /> : null}
            <Row label="Net sales" value={money(data.net_sales)} strong />
            {data.refund_count > 0 ? (
              <Row label={`Refunds · ${data.refund_count}`} value={`-${money(data.refunds)}`} tone="danger" />
            ) : null}
            <Row label="Fees" value={`-${money(data.fees)}`} />
            <Row label="Cost of goods" value={`-${money(data.cost_of_goods)}`} />
            <Row label="Profit" value={money(data.profit)} strong />
            <View style={styles.divider} />
            <Row label="Sales tax collected" value={money(data.tax_collected)} />
            <Text style={styles.footnote}>Tax is money you owe the state, so it is not counted as profit.</Text>
            {data.sales_missing_cost > 0 ? (
              <Text style={styles.footnote}>
                {data.sales_missing_cost} sale{data.sales_missing_cost === 1 ? "" : "s"} had no buy price, so profit may be high.
              </Text>
            ) : null}
          </Card>

          <Card style={styles.rows}>
            <SectionLabel>Count the cash box</SectionLabel>
            {data.payments.length === 0 ? <Text style={styles.helper}>No payments in this window.</Text> : null}
            {data.payments.map((p) => (
              <Row
                key={p.method}
                label={`${paymentLabel(p.method)}${toSignedCents(p.refunded) > 0 ? ` (after ${money(p.refunded)} refunded)` : ""}`}
                value={money(p.net)}
                strong={p.method === "cash"}
              />
            ))}
            <View style={styles.divider} />
            <Row label="Total taken in" value={money(data.collected)} strong />
          </Card>

          <Card style={styles.rows}>
            <SectionLabel>Top items</SectionLabel>
            {data.top_items.length === 0 ? <Text style={styles.helper}>Nothing sold yet.</Text> : null}
            {data.top_items.map((item, index) => (
              <View key={item.item_id} style={styles.topRow}>
                <Text style={styles.rank}>{index + 1}</Text>
                <View style={styles.flex}>
                  <Text style={styles.rowLabel} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.footnote}>{item.units} sold</Text>
                </View>
                <Text style={styles.rowValue}>{money(item.revenue)}</Text>
              </View>
            ))}
          </Card>

          <Button label="Share summary" leadingIcon="share-outline" onPress={share} size="lg" fullWidth />
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, strong = false, tone }: { label: string; value: string; strong?: boolean; tone?: "danger" }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, !strong && styles.rowLabelMuted]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong, tone === "danger" && { color: COLORS.danger }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: 48, width: "100%", maxWidth: 720, alignSelf: "center" },
  center: { paddingVertical: SPACING.xl, alignItems: "center" },
  flex: { flex: 1 },
  segment: {
    flexDirection: "row",
    backgroundColor: COLORS.bgElevated,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 4,
    gap: 4,
  },
  segmentItem: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: RADII.sm },
  segmentActive: { backgroundColor: COLORS.primary },
  segmentText: { ...TYPE.footnote, color: COLORS.textMuted, fontWeight: "700" },
  segmentTextActive: { color: COLORS.text },
  showCard: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  showTitle: { ...TYPE.callout, color: COLORS.text },
  helper: { ...TYPE.footnote, color: COLORS.textMuted },
  footnote: { ...TYPE.footnote, color: COLORS.textSoft },
  hero: { alignItems: "center", gap: 4, paddingVertical: SPACING.lg },
  heroLabel: { ...TYPE.footnote, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: 0.6 },
  heroValue: { ...TYPE.largeTitle, color: COLORS.success, fontVariant: ["tabular-nums"] },
  rows: { gap: SPACING.xs },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm, minHeight: 28 },
  rowLabel: { ...TYPE.callout, color: COLORS.text, flexShrink: 1 },
  rowLabelMuted: { color: COLORS.textMuted, fontWeight: "500" },
  rowValue: { ...TYPE.callout, color: COLORS.text, fontVariant: ["tabular-nums"] },
  rowValueStrong: { ...TYPE.headline },
  divider: { height: 1, backgroundColor: COLORS.border, marginVertical: SPACING.xs },
  topRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, paddingVertical: 4 },
  rank: {
    width: 26, height: 26, borderRadius: 13, textAlign: "center", lineHeight: 26, overflow: "hidden",
    backgroundColor: COLORS.primarySoft, color: COLORS.primaryBright, fontWeight: "800", fontSize: 13,
  },
});
