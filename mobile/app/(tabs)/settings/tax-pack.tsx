/**
 * Tax pack — the year's profit and loss, by sales channel (to check against
 * each platform's 1099-K), with a CSV for an accountant. Pro feature.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card } from "../../../components/ui";
import { ProUpsell, isProRequired } from "../../../components/ProUpsell";
import { errorMessage } from "../../../services/errors";
import { downloadAndShareRemote } from "../../../utils/fileActions";
import { COLORS, SPACING } from "../../../theme/tokens";

const money = (v: string) => {
  const n = Number(v);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function TaxPackScreen() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<api.TaxSummary | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useFocusEffect(useCallback(() => {
    let live = true;
    setData(null);
    setError(null);
    api.getTaxSummary(year)
      .then((d) => { if (live) setData(d); })
      .catch((err) => {
        if (!live) return;
        if (isProRequired(err)) setLocked(true);
        else setError(errorMessage(err, "Couldn't load your tax summary."));
      });
    return () => { live = false; };
  }, [year]));

  const share = async () => {
    setSharing(true);
    try {
      const token = await api.getToken();
      await downloadAndShareRemote(api.taxPackCsvUrl(year), `resqlo_tax_pack_${year}.csv`, token);
    } catch (err) {
      Alert.alert("Export failed", errorMessage(err, "Could not build the tax pack."));
    } finally {
      setSharing(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }}>
      <Text accessibilityRole="header" style={styles.title}>Tax pack</Text>
      <View style={styles.chips}>
        {[thisYear, thisYear - 1].map((y) => (
          <TouchableOpacity key={y} accessibilityRole="button" accessibilityState={{ selected: year === y }}
            onPress={() => setYear(y)} style={[styles.chip, year === y && styles.chipActive]}>
            <Text style={[styles.chipText, year === y && styles.chipTextActive]}>{y}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {locked ? (
        <ProUpsell testID="tax-pack-upsell" message="Get a year-end profit report by platform, ready for your accountant. Tax pack is part of Pro." />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : !data ? (
        <ActivityIndicator color={COLORS.primaryBright} />
      ) : (
        <>
          <Card>
            <Row label="Gross sales" value={money(data.gross_sales)} />
            <Row label="Refunds" value={`-${money(data.refunds)}`} />
            <Row label="Fees" value={`-${money(data.fees)}`} />
            <Row label="Cost of goods" value={`-${money(data.cost_of_goods)}`} />
            <View style={styles.divider} />
            <Row label="Net profit" value={money(data.net_profit)} strong />
            <Text style={styles.muted}>{data.sales_count} sale{data.sales_count === 1 ? "" : "s"}</Text>
            {data.sales_missing_cost > 0 ? (
              <Text style={styles.warn}>
                {data.sales_missing_cost} sale{data.sales_missing_cost === 1 ? " has" : "s have"} no cost recorded, so profit may be overstated.
              </Text>
            ) : null}
          </Card>

          {data.by_channel.length ? (
            <Card>
              <Text style={styles.section}>By platform</Text>
              <Text style={styles.muted}>Compare gross sales with each platform&apos;s 1099-K.</Text>
              {data.by_channel.map((c) => (
                <Row key={c.channel} label={`${c.label} · ${c.sales_count}`} value={money(c.gross_sales)} />
              ))}
            </Card>
          ) : null}

          <ActionButton label={sharing ? "Building..." : "Share CSV for your accountant"} onPress={() => void share()} disabled={sharing} />
          <Text style={styles.muted}>
            The CSV has the summary, platform and monthly totals, and every sale. Business expenses (supplies, mileage) aren&apos;t tracked in Resqlo yet.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "700" },
  section: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  muted: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  warn: { color: COLORS.warning, fontSize: 13, lineHeight: 19, marginTop: 4 },
  error: { color: COLORS.danger, fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: COLORS.textMuted, fontSize: 14 },
  rowValue: { color: COLORS.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  strong: { color: COLORS.text, fontWeight: "700", fontSize: 16 },
  divider: { height: 1, backgroundColor: COLORS.border, marginVertical: SPACING.xs },
  chips: { flexDirection: "row", gap: SPACING.xs },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
});
