import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import { Card, HeaderTitle, Pill, SectionLabel } from "../../components/ui";
import * as api from "../../services/api";
import { COLORS, SPACING } from "../../theme/tokens";
import { formatCurrency } from "../../utils/inventory";

export default function SellerProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [profile, setProfile] = useState<api.SellerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (id) api.getSellerProfile(id).then(setProfile).catch((reason: any) => setError(reason?.message || "Seller profile unavailable.")); }, [id]);
  if (error) return <View testID="seller-error" style={styles.center}><Text style={styles.error}>{error}</Text></View>;
  if (!profile) return <View testID="seller-loading" style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>;
  return <ScrollView testID="seller-content" style={styles.container} contentContainerStyle={styles.content}>
    <HeaderTitle title={profile.seller.business_name} subtitle={profile.seller.member_since ? `Vendora seller since ${new Date(profile.seller.member_since).getFullYear()}` : "Vendora seller"} right={profile.seller.verified ? <Pill label="✓ VERIFIED" tone="success" /> : undefined} />
    <Card><SectionLabel>Seller activity</SectionLabel><View style={styles.stats}><Stat value={profile.stats.items_sold} label="Items sold" /><Stat value={profile.stats.total_transactions} label="Transactions" /><Stat value={profile.stats.total_items} label="Items managed" /></View></Card>
    <SectionLabel>Available listings</SectionLabel>
    {profile.listings.length ? profile.listings.map((listing) => <Card key={listing.id} style={styles.listing}><View style={styles.row}><Text style={styles.name}>{listing.name}</Text><Text style={styles.price}>{listing.price ? formatCurrency(listing.price) : "Ask seller"}</Text></View><Text style={styles.meta}>{[listing.category, listing.size, listing.color, listing.condition].filter(Boolean).join(" · ") || "Listing details available from seller"}</Text><Pill label={listing.status.replace("_", " ").toUpperCase()} tone="info" /></Card>) : <Card><Text style={styles.meta}>No public listings right now.</Text></Card>}
    <Text style={styles.disclaimer}>{profile.disclaimer}</Text>
  </ScrollView>;
}
function Stat({ value, label }: { value: number; label: string }) { return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>; }
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: COLORS.bg }, content: { padding: SPACING.lg, gap: SPACING.md, paddingBottom: 48 }, center: { flex: 1, justifyContent: "center", alignItems: "center", padding: SPACING.lg, backgroundColor: COLORS.bg }, error: { color: COLORS.danger, textAlign: "center" }, stats: { flexDirection: "row", justifyContent: "space-between", gap: SPACING.sm, marginTop: SPACING.sm }, stat: { flex: 1 }, statValue: { color: COLORS.text, fontSize: 22, fontWeight: "800" }, statLabel: { color: COLORS.textMuted, fontSize: 11, marginTop: 3 }, listing: { gap: SPACING.sm }, row: { flexDirection: "row", justifyContent: "space-between", gap: SPACING.sm }, name: { color: COLORS.text, fontSize: 16, fontWeight: "800", flex: 1 }, price: { color: COLORS.success, fontWeight: "800" }, meta: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18 }, disclaimer: { color: COLORS.textMuted, fontSize: 10, lineHeight: 16 } });
