import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { useAuth } from "../../../context/auth";
import * as api from "../../../services/api";
import * as iap from "../../../services/purchases";
import { COLORS, SPACING } from "../../../theme/tokens";

const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const PRIVACY_URL = "https://vendora.lexmakesit.com/privacy";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function SubscriptionScreen() {
  const { refreshUser, user } = useAuth();
  const useApple = iap.iapEnabled();
  const [plans, setPlans] = useState<iap.StorePlan[]>([]);
  const [status, setStatus] = useState<api.SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await api.getSubscriptionStatus());
      if (useApple && user) {
        try { setPlans(await iap.loadPlans(user.id)); }
        catch { setPlans([]); }
      }
    }
    catch (error: any) { setLoadError(error?.message || "Could not load billing status."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
    // Load once on mount; load() reads the latest user via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCheckout = async (plan: "pro" | "partner") => {
    setWorking(plan);
    try {
      const { checkout_url } = await api.createSubscriptionCheckout(plan);
      await WebBrowser.openBrowserAsync(checkout_url);
      await Promise.all([load(), refreshUser()]);
    } catch (error: any) {
      Alert.alert("Upgrade unavailable", error?.message || "Could not start secure checkout.");
    } finally { setWorking(null); }
  };

  // Apple confirms instantly, but the tier is set by the RevenueCat webhook,
  // so poll the backend briefly until it catches up.
  const waitForUpgrade = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = await api.getSubscriptionStatus();
      setStatus(next);
      if (next.tier === "pro") break;
      await sleep(1500);
    }
    await refreshUser();
  };

  const buyApple = async (plan: iap.StorePlan) => {
    setWorking(plan.id);
    try {
      if (await iap.buy(plan)) await waitForUpgrade();
    } catch (error: any) {
      Alert.alert("Purchase failed", error?.message || "Apple could not complete the purchase.");
    } finally { setWorking(null); }
  };

  const restoreApple = async () => {
    if (!user) return;
    setWorking("restore");
    try {
      const found = await iap.restore(user.id);
      if (found) await waitForUpgrade();
      else Alert.alert("Nothing to restore", "No active Resqlo subscription was found for this Apple ID.");
    } catch (error: any) {
      Alert.alert("Restore failed", error?.message || "Could not restore purchases.");
    } finally { setWorking(null); }
  };

  const manageBilling = async () => {
    if (status?.provider === "apple" && useApple) {
      try { await iap.manageSubscriptions(); } catch { await Linking.openURL("https://apps.apple.com/account/subscriptions"); }
      return;
    }
    setWorking("portal");
    try {
      const { portal_url } = await api.createBillingPortal();
      await WebBrowser.openBrowserAsync(portal_url);
      await Promise.all([load(), refreshUser()]);
    } catch (error: any) { Alert.alert("Billing unavailable", error?.message || "Could not open billing management."); }
    finally { setWorking(null); }
  };

  if (loading) return <View testID="subscription-loading" style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>;

  if (loadError) return (
    <View testID="subscription-error" style={styles.center}>
      <Text style={styles.errorTitle}>Billing unavailable</Text>
      <Text style={styles.muted}>{loadError}</Text>
      <ActionButton label="Retry" onPress={load} />
    </View>
  );

  return (
    <ScrollView testID="subscription-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Plans & Billing" subtitle={useApple ? "Subscribe with your Apple ID. Access works on every device you sign in to." : "Upgrade securely with Stripe. Changes activate after Stripe confirms payment."} />
      <Card style={styles.card}>
        <View style={styles.row}><SectionLabel>Current access</SectionLabel><Pill label={status?.is_partner ? "PARTNER" : (status?.tier ?? "free").toUpperCase()} tone="primary" /></View>
        <Text style={styles.muted}>Billing status: {status?.status || "none"}</Text>
        {status?.current_period_end ? <Text style={styles.muted}>Current period ends {new Date(status.current_period_end).toLocaleDateString()}</Text> : null}
        {status?.managed_billing || (useApple && status?.provider === "apple") ? <ActionButton label={working === "portal" ? "Opening..." : status?.provider === "apple" && useApple ? "Manage Subscription" : "Manage Billing"} onPress={manageBilling} disabled={!!working} tone="secondary" /> : null}
      </Card>
      {status?.tier !== "pro" ? (
        <Card style={styles.card}>
          <View testID="pro-compare" />
          <SectionLabel>What Pro unlocks</SectionLabel>
          {PRO_COMPARE.map(([feature, free, pro]) => (
            <View key={feature} style={styles.compareRow}>
              <Text style={styles.compareFeature}>{feature}</Text>
              <Text style={styles.compareFree}>{free}</Text>
              <Text style={styles.comparePro}>{pro}</Text>
            </View>
          ))}
          <Text style={styles.muted}>One extra sale a month at a show usually covers Pro.</Text>
        </Card>
      ) : null}
      {useApple ? (
        <>
          {plans.length === 0 ? <Card style={styles.card}><Text style={styles.copy}>Plans are unavailable right now. Please try again later.</Text></Card> : null}
          {plans.map((plan) => {
            const partner = plan.productId.includes("partner");
            const active = partner ? status?.is_partner : status?.tier === "pro" && !status?.is_partner;
            return (
              <Card key={plan.id} style={styles.card}>
                <SectionLabel>{`${partner ? "Pro + Partner" : "Pro"} · ${plan.price}/${plan.period}`}</SectionLabel>
                <Text style={styles.copy}>{partner
                  ? "Everything in Pro, plus a public storefront, verified badge, and priority support."
                  : "Unlimited inventory, invoices, barcode tools, exports, Stripe payments, and advanced analytics."}</Text>
                {plan.trial && !active ? <Text style={styles.muted}>{`${plan.trial}, then ${plan.price}/${plan.period}. Cancel before it ends and you won't be charged.`}</Text> : null}
                {active ? <Pill label="Active" tone="success" /> : <ActionButton label={working === plan.id ? "Waiting for Apple..." : plan.trial ? `Start ${plan.trial}` : `Subscribe ${plan.price}/${plan.period}`} onPress={() => buyApple(plan)} disabled={!!working} />}
              </Card>
            );
          })}
          <ActionButton label={working === "restore" ? "Restoring..." : "Restore Purchases"} onPress={restoreApple} disabled={!!working} tone="ghost" />
          <Text style={styles.legal}>Payment is charged to your Apple ID at confirmation. Subscriptions renew automatically at the same price unless canceled at least 24 hours before the end of the current period. Manage or cancel any time in your App Store account settings.</Text>
          <View style={styles.links}>
            <Text style={styles.link} onPress={() => Linking.openURL(TERMS_URL)}>Terms of Use</Text>
            <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_URL)}>Privacy Policy</Text>
          </View>
        </>
      ) : (
        <>
          <Card style={styles.card}>
            <SectionLabel>Pro · $20/month</SectionLabel>
            <Text style={styles.copy}>Unlimited inventory, invoices, barcode tools, exports, Stripe payments, and advanced analytics.</Text>
            {status?.tier !== "pro" ? <ActionButton label={working === "pro" ? "Opening checkout..." : "Upgrade to Pro"} onPress={() => openCheckout("pro")} disabled={!!working} /> : <Pill label="Active" tone="success" />}
          </Card>
          <Card style={styles.card}>
            <SectionLabel>Partner · +$5/month</SectionLabel>
            <Text style={styles.copy}>Adds a public storefront, verified badge, and priority in-app support. Includes Pro when needed.</Text>
            {!status?.is_partner ? <ActionButton label={working === "partner" ? "Opening checkout..." : "Add Partner"} onPress={() => openCheckout("partner")} disabled={!!working} /> : <Pill label="Active" tone="success" />}
          </Card>
          <Text style={styles.legal}>Subscriptions renew until canceled. Manage cancellation and payment methods through Stripe Billing.</Text>
        </>
      )}
    </ScrollView>
  );
}

export const PRO_COMPARE: [string, string, string][] = [
  ["Inventory items", "25", "Unlimited"],
  ["CSV / spreadsheet exports", "—", "Included"],
  ["Advanced analytics & trends", "—", "Included"],
  ["Price suggestions & eBay comps", "—", "Included"],
  ["Stripe card payments", "—", "Included"],
];

const styles = StyleSheet.create({
  compareRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  compareFeature: { flex: 2, color: COLORS.textSoft, fontSize: 13 },
  compareFree: { flex: 1, color: COLORS.textMuted, fontSize: 13, textAlign: "center" },
  comparePro: { flex: 1, color: COLORS.primary, fontSize: 13, fontWeight: "600", textAlign: "center" },
  container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg, padding: SPACING.lg, gap: SPACING.sm },
  errorTitle: { color: COLORS.text, fontSize: 18, fontWeight: "600" },
  card: { gap: SPACING.sm }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  muted: { color: COLORS.textMuted, fontSize: 12 }, copy: { color: COLORS.textSoft, fontSize: 14, lineHeight: 21 },
  legal: { color: COLORS.textMuted, fontSize: 11, lineHeight: 17 },
  links: { flexDirection: "row", gap: SPACING.lg },
  link: { color: COLORS.primary, fontSize: 12, textDecorationLine: "underline" },
});
