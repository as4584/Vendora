import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Icon, IconCircle, type IconName } from "../../components/ui";
import { COLORS, RADII, SPACING } from "../../theme/tokens";

type MoreLink = { label: string; helper: string; icon: IconName; route: string };

const LINKS: MoreLink[] = [
  { label: "Invoices", helper: "Create and share branded invoices", icon: "receipt-outline", route: "/inventory/invoices" },
  { label: "Sync Center", helper: "Provider syncs & reconciliation", icon: "sync-outline", route: "/settings/sync-center" },
  { label: "Advanced Analytics", helper: "Revenue, sell-through, top categories", icon: "bar-chart-outline", route: "/settings/analytics" },
  { label: "Plans & Billing", helper: "Manage your subscription", icon: "card-outline", route: "/settings/subscription" },
  { label: "Settings", helper: "Account, branding & integrations", icon: "settings-outline", route: "/settings" },
  { label: "Support", helper: "Get help from the Vendora team", icon: "help-buoy-outline", route: "/settings/support" },
];

export default function MoreScreen() {
  const router = useRouter();
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {LINKS.map((link) => (
        <TouchableOpacity
          key={link.route}
          style={styles.row}
          activeOpacity={0.85}
          onPress={() => router.push(link.route as any)}
        >
          <IconCircle name={link.icon} />
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>{link.label}</Text>
            <Text style={styles.rowHelper}>{link.helper}</Text>
          </View>
          <Icon name="chevron-forward" size={18} color={COLORS.textSoft} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, gap: SPACING.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  rowText: { flex: 1, gap: 3 },
  rowLabel: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  rowHelper: { color: COLORS.textMuted, fontSize: 12 },
});
