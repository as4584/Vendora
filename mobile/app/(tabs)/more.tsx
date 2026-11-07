import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Icon, IconCircle, type IconName } from "../../components/ui";
import { COLORS, RADII, SPACING, TYPE } from "../../theme/tokens";

type MoreLink = { label: string; helper: string; icon: IconName; route: string };

const LINKS: MoreLink[] = [
  { label: "Show Summary", helper: "Close out the show: cash box, profit, top items", icon: "storefront-outline", route: "/settings/show-summary" },
  { label: "Customers", helper: "Buyers, purchase history and totals", icon: "people-outline", route: "/customers" },
  { label: "Invoices", helper: "Create and share branded invoices", icon: "receipt-outline", route: "/inventory/invoices" },
  { label: "Sync Center", helper: "Provider syncs & reconciliation", icon: "sync-outline", route: "/settings/sync-center" },
  { label: "Advanced Analytics", helper: "Revenue, sell-through, top categories", icon: "bar-chart-outline", route: "/settings/analytics" },
  { label: "Plans & Billing", helper: "Manage your subscription", icon: "card-outline", route: "/settings/subscription" },
  { label: "Settings", helper: "Account, branding & integrations", icon: "settings-outline", route: "/settings" },
  { label: "Support", helper: "Get help from the Resqlo team", icon: "help-buoy-outline", route: "/settings/support" },
];

const GROUPS = [
  { title: "Sales & customers", routes: ["/customers", "/inventory/invoices"] },
  { title: "Business tools", routes: ["/settings/sync-center", "/settings/analytics"] },
  { title: "Account & help", routes: ["/settings/subscription", "/settings", "/settings/support"] },
];

export default function MoreScreen() {
  const router = useRouter();
  const summary = LINKS[0];
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>Everything behind your table.</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Show Summary" style={styles.featured} activeOpacity={0.85} onPress={() => router.push(summary.route as any)}>
        <View style={styles.featuredTop}>
          <IconCircle name={summary.icon} />
          <Text style={styles.eyebrow}>END OF SHOW</Text>
          <Icon name="arrow-forward" size={18} color={COLORS.primaryBright} />
        </View>
        <Text style={styles.featuredTitle}>{summary.label}</Text>
        <Text style={styles.featuredHelper}>Count the cash box. See what sold.</Text>
      </TouchableOpacity>
      {GROUPS.map(group => (
        <View key={group.title} style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>{group.title}</Text>
          <View style={styles.group}>
            {group.routes.map((route, index) => {
              const link = LINKS.find(item => item.route === route)!;
              return (
        <TouchableOpacity
          key={link.route}
          accessibilityRole="button"
          accessibilityLabel={link.label}
          style={[styles.row, index > 0 && styles.rowDivider]}
          activeOpacity={0.85}
          onPress={() => router.push(link.route as any)}
        >
          <IconCircle name={link.icon} size={34} tone="muted" />
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>{link.label}</Text>
            <Text style={styles.rowHelper}>{link.helper}</Text>
          </View>
          <Icon name="chevron-forward" size={18} color={COLORS.textSoft} />
        </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: SPACING.xl, gap: SPACING.lg },
  intro: { ...TYPE.subhead, color: COLORS.textMuted },
  featured: { borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: RADII.lg, backgroundColor: COLORS.card, padding: SPACING.lg, gap: SPACING.sm },
  featuredTop: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  eyebrow: { ...TYPE.caption, color: COLORS.primaryBright, letterSpacing: 1.2, flex: 1 },
  featuredTitle: { ...TYPE.title, color: COLORS.text },
  featuredHelper: { ...TYPE.footnote, color: COLORS.textMuted },
  section: { gap: SPACING.xs },
  sectionTitle: { ...TYPE.caption, color: COLORS.textSoft, marginLeft: 4 },
  group: { borderRadius: RADII.lg, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.card, overflow: "hidden" },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    padding: SPACING.md,
  },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  rowLabel: { ...TYPE.callout, color: COLORS.text },
  rowHelper: { ...TYPE.caption, color: COLORS.textMuted, fontWeight: "400" },
});
