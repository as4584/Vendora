/**
 * eBay comps. Shows sold prices only when the backend says the data is sold
 * (kind "sold"); otherwise the numbers are labelled as current asking prices.
 * Pass itemId (item detail) or query (add screen).
 */
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { ProUpsell, isProRequired } from "./ProUpsell";
import { COLORS, SPACING, TYPE } from "../theme/tokens";
import { errorMessage } from "../services/errors";
import { VERDICT_LABELS, buyCheck, dollars } from "../utils/buyCheck";

type Props = {
  itemId?: string;
  query?: string;
  onUsePrice?: (price: string) => void;
  /** What the seller would pay; adds profit and a buy verdict. */
  buyPrice?: string;
  /** Load automatically whenever this changes to a value (e.g. a new scan). */
  autoLoadKey?: string;
};

export function compsHeadline(comps: api.EbayComps): string {
  return comps.kind === "sold" ? "Recent eBay sold prices" : "Current eBay asking prices (not sold prices)";
}

export function EbayCompsCard({ itemId, query, onUsePrice, buyPrice = "", autoLoadKey }: Props) {
  const [comps, setComps] = useState<api.EbayComps | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      if (itemId) setComps(await api.getItemEbayComps(itemId));
      else if (query && query.trim().length >= 2) setComps(await api.searchEbayComps(query.trim()));
      else setError("Enter an item name first.");
    } catch (err: any) {
      if (isProRequired(err)) { setLocked(true); return; }
      setError(errorMessage(err, "eBay prices are unavailable right now."));
    } finally {
      setLoading(false);
    }
  };

  // A fresh scan checks prices without a tap, so the answer is there in-store.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (autoLoadKey) void load(); }, [autoLoadKey]);

  const check = comps?.summary ? buyCheck(comps.summary, buyPrice) : null;
  const shownCost = buyPrice.trim().replace(/^\$/, "");

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
              {check ? (
                <View testID="buy-check" style={styles.check}>
                  <Text style={styles.checkLine}>
                    {`After eBay fees you'd keep ${dollars(check.netLowCents)}–${dollars(check.netHighCents)} (typical ${dollars(check.netMedianCents)}).`}
                  </Text>
                  {check.verdict && check.profitLowCents !== null && check.profitHighCents !== null ? (
                    <View style={styles.verdictRow}>
                      <Pill label={VERDICT_LABELS[check.verdict]} tone={check.verdict === "good" ? "success" : check.verdict === "thin" ? "warning" : "danger"} />
                      <Text style={styles.checkLine}>
                        {`Profit at $${shownCost}: ${dollars(check.profitLowCents)} to ${dollars(check.profitHighCents)}`}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.muted}>Enter what you&apos;d pay to see your profit.</Text>
                  )}
                  {comps.kind !== "sold" ? <Text style={styles.muted}>Based on asking prices, so real sale prices may be lower.</Text> : null}
                </View>
              ) : null}
              {onUsePrice ? (
                <Button label={`Use $${comps.summary.median}`} size="sm" variant="secondary" onPress={() => onUsePrice(comps.summary!.median)} />
              ) : null}
            </>
          ) : (
            <Text style={styles.muted}>No matching eBay listings found.</Text>
          )}
        </View>
      ) : null}
      {locked ? <ProUpsell testID="ebay-comps-upsell" message="See what this item sells for on eBay before you set a price. eBay comps are part of Pro." /> : null}
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
  check: { gap: SPACING.xxs, marginTop: SPACING.xs },
  checkLine: { ...TYPE.footnote, color: COLORS.text, flexShrink: 1 },
  verdictRow: { flexDirection: "row", alignItems: "center", gap: SPACING.xs, flexWrap: "wrap" },
});
