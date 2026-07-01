import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { useAuth } from "../../../context/auth";
import * as api from "../../../services/api";
import { COLORS, SPACING } from "../../../theme/tokens";

export default function SubscriptionScreen() {
  const { refreshUser } = useAuth();
  const [status, setStatus] = useState<api.SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  const load = async () => {
    try { setStatus(await api.getSubscriptionStatus()); }
    catch (error: any) { Alert.alert("Billing unavailable", error?.message || "Could not load billing status."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
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

  const manageBilling = async () => {
    setWorking("portal");
    try {
      const { portal_url } = await api.createBillingPortal();
      await WebBrowser.openBrowserAsync(portal_url);
      await Promise.all([load(), refreshUser()]);
    } catch (error: any) { Alert.alert("Billing unavailable", error?.message || "Could not open billing management."); }
    finally { setWorking(null); }
  };

  if (loading) return <View testID="subscription-loading" style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>;

  return (
    <ScrollView testID="subscription-content" style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle title="Plans & Billing" subtitle="Upgrade securely with Stripe. Changes activate after Stripe confirms payment." />
      <Card style={styles.card}>
        <View style={styles.row}><SectionLabel>Current access</SectionLabel><Pill label={status?.is_partner ? "PARTNER" : status?.tier.toUpperCase() || "FREE"} tone="primary" /></View>
        <Text style={styles.muted}>Billing status: {status?.status || "none"}</Text>
        {status?.current_period_end ? <Text style={styles.muted}>Current period ends {new Date(status.current_period_end).toLocaleDateString()}</Text> : null}
        {status?.managed_billing ? <ActionButton label={working === "portal" ? "Opening..." : "Manage Billing"} onPress={manageBilling} disabled={!!working} tone="secondary" /> : null}
      </Card>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.bg },
  card: { gap: SPACING.sm }, row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  muted: { color: COLORS.textMuted, fontSize: 12 }, copy: { color: COLORS.textSoft, fontSize: 14, lineHeight: 21 },
  legal: { color: COLORS.textMuted, fontSize: 11, lineHeight: 17 },
});
