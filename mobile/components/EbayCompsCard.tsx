/**
 * eBay comps. Shows sold prices only when the backend says the data is sold
 * (kind "sold"); otherwise the numbers are labelled as current asking prices.
 * Pass itemId (item detail) or query (add screen).
 */
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { COLORS, SPACING, TYPE } from "../theme/tokens";

type Props = { itemId?: string; query?: string; onUsePrice?: (price: string) => void };

export function compsHeadline(comps: api.EbayComps): string {
  return comps.kind === "sold" ? "Recent eBay sold prices" : "Current eBay asking prices (not sold prices)";
}

export function EbayCompsCard({ itemId, query, onUsePrice }: Props) {
  const [comps, setComps] = useState<api.EbayComps | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (itemId) setComps(await api.getItemEbayComps(itemId));
      else if (query && query.trim().length >= 2) setComps(await api.searchEbayComps(query.trim()));
      else setError("Enter an item name first.");
    } catch (err: any) {
      setError(err?.detail?.message || err?.message || "eBay prices are unavailable right now.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <View style={styles.header}>
        <SectionLabel>eBay comps</SectionLabel>
        {comps ? <Pill label={comps.kind === "sold" ? "Sold" : "Asks"} tone={comps.kind === "sold" ? "success" : "info"} /> : null}
      </View>
      {comps ? (
        <View testID="ebay-comps-result" style={styles.stack}>
          <Text style={styles.muted}>{compsHeadline(comps)}</Text>
          {comps.summary ? (
            <>
              <View style={styles.grid}>
                <Stat label="Low" value={comps.summary.low} />
                <Stat label="Median" value={comps.summary.median} />
                <Stat label="High" value={comps.summary.high} />
              </View>
              <Text style={styles.muted}>{`${comps.count} ${comps.kind === "sold" ? "sales" : "listings"}`}</Text>
              {onUsePrice ? (
                <Button label={`Use $${comps.summary.median}`} size="sm" variant="secondary" onPress={() => onUsePrice(comps.summary!.median)} />
              ) : null}
            </>
          ) : (
            <Text style={styles.muted}>No matching eBay listings found.</Text>
          )}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.action}>
        <Button
          testID="ebay-comps-button"
          label={comps ? "Refresh eBay prices" : "Check eBay prices"}
          size="sm"
          variant="secondary"
          onPress={() => void load()}
          loading={loading}
        />
      </View>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{`$${Number(value).toFixed(0)}`}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SPACING.xs },
  stack: { gap: SPACING.xs },
  grid: { flexDirection: "row", gap: SPACING.sm },
  stat: { flex: 1, alignItems: "center", gap: SPACING.xxs },
  statValue: { ...TYPE.headline, color: COLORS.text, fontVariant: ["tabular-nums"] },
  statLabel: { ...TYPE.caption, color: COLORS.textMuted },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
  error: { ...TYPE.footnote, color: COLORS.danger, marginTop: SPACING.xs },
  action: { marginTop: SPACING.sm, flexDirection: "row" },
});
