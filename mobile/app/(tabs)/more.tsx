import { useEffect, useState } from "react";
import * as api from "../../services/api";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Icon, IconCircle, SectionLabel, type IconName } from "../../components/ui";
import { COLORS, RADII, SPACING } from "../../theme/tokens";

type MoreLink = { label: string; helper: string; icon: IconName; route: string };
type Group = { title: string; links: MoreLink[] };

const LINKS: MoreLink[] = [
  { label: "Show Summary", helper: "Close out the show: cash box, profit, top items", icon: "storefront-outline", route: "/settings/show-summary" },
  { label: "Trade", helper: "Swap pairs plus cash in one step", icon: "swap-horizontal-outline", route: "/inventory/trade" },
  { label: "Price Labels", helper: "Print tags with a scan-to-sell QR", icon: "pricetags-outline", route: "/inventory/labels" },
  { label: "Customers", helper: "Buyers, purchase history and totals", icon: "people-outline", route: "/customers" },
  { label: "Invoices", helper: "Create and share branded invoices", icon: "receipt-outline", route: "/inventory/invoices" },
  { label: "Sync Center", helper: "Provider syncs & reconciliation", icon: "sync-outline", route: "/settings/sync-center" },
  { label: "Advanced Analytics", helper: "Revenue, sell-through, top categories", icon: "bar-chart-outline", route: "/settings/analytics" },
  { label: "Tax Pack", helper: "Year-end profit by platform, CSV for your accountant", icon: "document-text-outline", route: "/settings/tax-pack" },
  { label: "Plans & Billing", helper: "Manage your subscription", icon: "card-outline", route: "/settings/subscription" },
  { label: "Settings", helper: "Account, branding & integrations", icon: "settings-outline", route: "/settings" },
  { label: "Support", helper: "Get help from the Resqlo team", icon: "help-buoy-outline", route: "/settings/support" },
// Plain words, one job per row. Grouped by what the seller wants to do.
const START_STEPS: MoreLink[] = [
  { label: "1. Bring in your inventory", helper: "Upload your Excel or CSV sheet, photos and all", icon: "cloud-upload-outline", route: "/inventory/import" },
  { label: "2. Add or scan an item", helper: "Point the camera at any barcode or box label", icon: "scan-outline", route: "/inventory/add" },
  { label: "3. Make a sale", helper: "Scan it, set the price, done. Profit is tracked for you", icon: "cash-outline", route: "/inventory/sale" },
];

const GROUPS: Group[] = [
  {
    title: "Selling",
    links: [
      { label: "Customers", helper: "Who bought what, and how much they spent", icon: "people-outline", route: "/customers" },
      { label: "Invoices", helper: "Send a receipt with your logo", icon: "receipt-outline", route: "/inventory/invoices" },
      { label: "Show Summary", helper: "After an event: cash, profit and best sellers", icon: "storefront-outline", route: "/settings/show-summary" },
    ],
  },
  {
    title: "Your numbers",
    links: [
      { label: "Advanced Analytics", helper: "What sells, what sits, and what you made", icon: "bar-chart-outline", route: "/settings/analytics" },
    ],
  },
  {
    title: "Connect & scan",
    links: [
      { label: "Sync Center", helper: "Link Square, Clover, eBay, StockX or Sheets", icon: "sync-outline", route: "/settings/sync-center" },
      { label: "Barcode Rules", helper: "Use your store's own tags? Teach the scanner here", icon: "barcode-outline", route: "/settings/barcode-rules" },
    ],
  },
  {
    title: "Account & help",
    links: [
      { label: "Settings", helper: "Your name, logo, password and connected apps", icon: "settings-outline", route: "/settings" },
      { label: "Plans & Billing", helper: "Your plan and payments", icon: "card-outline", route: "/settings/subscription" },
      { label: "Support", helper: "Stuck? Message us and a real person helps", icon: "help-buoy-outline", route: "/settings/support" },
    ],
  },
];

const ADMIN_LINK: MoreLink = {
  label: "Catalog Admin", helper: "Fix wrong entries in the Resqlo catalog", icon: "construct-outline", route: "/settings/catalog-admin",
};

export default function MoreScreen() {
  const router = useRouter();
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.isCatalogAdmin().then((yes) => {
      if (!cancelled) setAdmin(yes);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const groups = admin ? [...GROUPS, { title: "Admin", links: [ADMIN_LINK] }] : GROUPS;
  const row = (link: MoreLink, big = false) => (
    <TouchableOpacity
      key={link.route}
      style={[styles.row, big && styles.bigRow]}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityHint={link.helper}
      onPress={() => router.push(link.route)}
    >
      <IconCircle name={link.icon} />
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, big && styles.bigLabel]}>{link.label}</Text>
        <Text style={styles.rowHelper}>{link.helper}</Text>
      </View>
      <Icon name="chevron-forward" size={18} color={COLORS.textSoft} />
    </TouchableOpacity>
  );
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.startCard}>
        <Text style={styles.startTitle}>Start here</Text>
        <Text style={styles.startHelper}>Three steps and you&apos;re running.</Text>
        {START_STEPS.map((step) => row(step, true))}
      </View>
      {groups.map((group) => (
        <View key={group.title} style={styles.group}>
          <SectionLabel>{group.title}</SectionLabel>
          {group.links.map((link) => row(link))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, gap: SPACING.lg },
  group: { gap: SPACING.sm },
  startCard: {
    gap: SPACING.sm,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: SPACING.md,
  },
  startTitle: { color: COLORS.text, fontSize: 20, fontWeight: "700" },
  startHelper: { color: COLORS.textMuted, fontSize: 14, marginBottom: SPACING.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    minHeight: 64,
  },
  bigRow: { backgroundColor: COLORS.bg },
  rowText: { flex: 1, gap: 3 },
  rowLabel: { color: COLORS.text, fontSize: 16, fontWeight: "600" },
  bigLabel: { fontSize: 17 },
  rowHelper: { color: COLORS.textMuted, fontSize: 13 },
});
