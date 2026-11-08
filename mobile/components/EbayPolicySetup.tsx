/**
 * One-tap eBay business-policy setup. Opts the seller in and creates
 * "Resqlo default" shipping, payment and return policies (existing ones are
 * reused), so new sellers can list without visiting eBay Seller Hub.
 *
 * Used in the List on eBay sheet when listing fails for missing policies,
 * and in Settings > Sync center.
 */
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

export const DEFAULT_FLAT_SHIPPING = "12.00";

export function policySummary(freeShipping: boolean, acceptReturns: boolean): string[] {
  return [
    freeShipping
      ? "Shipping: USPS Priority, free to the buyer, ships within 2 business days"
      : `Shipping: USPS Priority, buyer pays $${DEFAULT_FLAT_SHIPPING}, ships within 2 business days`,
    "Payment: paid immediately through eBay",
    acceptReturns ? "Returns: 30 days, buyer pays return shipping, money back" : "Returns: not accepted",
  ];
}

/** True when an API error means the seller is missing eBay business policies. */
export function isMissingPoliciesError(err: any): boolean {
  return err?.detail?.error === "ebay_policies_missing";
}

type Props = { onDone?: (result: api.EbayPolicySetupResult) => void; testIDPrefix?: string };

export function EbayPolicySetup({ onDone, testIDPrefix = "ebay-policy" }: Props) {
  const [freeShipping, setFreeShipping] = useState(false);
  const [acceptReturns, setAcceptReturns] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setupEbayPolicies({ free_shipping: freeShipping, returns_accepted: acceptReturns });
      onDone?.(result);
    } catch (err: any) {
      setError(err?.detail?.message || err?.message || "Could not set up eBay policies. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID={`${testIDPrefix}-setup`} style={styles.box}>
      <Text style={styles.title}>eBay needs shipping, payment and return policies</Text>
      <Text style={styles.muted}>Resqlo can create them for you with these defaults:</Text>
      {policySummary(freeShipping, acceptReturns).map((line) => (
        <Text key={line} style={styles.line}>{line}</Text>
      ))}
      <View style={styles.switchRow}>
        <Text style={styles.body}>Free shipping</Text>
        <Switch
          testID={`${testIDPrefix}-free-shipping`}
          accessibilityLabel="Free shipping"
          value={freeShipping}
          onValueChange={setFreeShipping}
          trackColor={{ true: COLORS.primary, false: COLORS.border }}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.body}>Accept returns</Text>
        <Switch
          testID={`${testIDPrefix}-accept-returns`}
          accessibilityLabel="Accept returns"
          value={acceptReturns}
          onValueChange={setAcceptReturns}
          trackColor={{ true: COLORS.primary, false: COLORS.border }}
        />
      </View>
      {error ? <Text testID={`${testIDPrefix}-error`} style={styles.error}>{error}</Text> : null}
      <Button
        testID={`${testIDPrefix}-submit`}
        label="Set up selling policies for me"
        leadingIcon="shield-checkmark-outline"
        onPress={run}
        loading={busy}
        fullWidth
      />
    </View>
  );
}

/** Settings card: shows existing policies or offers the one-tap setup. */
export function EbayPoliciesCard({ connected }: { connected: boolean }) {
  const [overview, setOverview] = useState<api.EbayPolicyOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api.getEbayPolicies());
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.detail?.message || err?.message || "Could not check eBay policies.");
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    // Fetch-on-mount: load's state updates are the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [connected, load]);

  if (!connected) return null;

  const policies = overview ? Object.values(overview.policies).filter(Boolean) as api.EbayPolicySummary[] : [];

  return (
    <>
      <SectionLabel>eBay Selling Policies</SectionLabel>
      <Card style={styles.stack}>
        {loadError ? (
          <Text testID="ebay-policies-load-error" style={styles.error}>{loadError}</Text>
        ) : !overview ? (
          <Text style={styles.muted}>Checking eBay policies…</Text>
        ) : overview.ready ? (
          <View testID="ebay-policies-ready" style={styles.stack}>
            <Pill label="Ready to list" tone="success" />
            {policies.map((p) => (
              <Text key={p.label} style={styles.line}>{`${p.label[0].toUpperCase()}${p.label.slice(1)}: ${p.name}`}</Text>
            ))}
          </View>
        ) : (
          <EbayPolicySetup testIDPrefix="settings-ebay-policy" onDone={() => void load()} />
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: SPACING.xs,
    padding: SPACING.sm,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
  },
  stack: { gap: SPACING.sm },
  title: { ...TYPE.callout, color: COLORS.text },
  body: { ...TYPE.body, color: COLORS.text, flex: 1 },
  line: { ...TYPE.footnote, color: COLORS.text },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
  error: { ...TYPE.footnote, color: COLORS.danger },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm },
});
