import { Tabs } from "expo-router";
import { View, StyleSheet, Text, TouchableOpacity, GestureResponderEvent } from "react-native";
import { COLORS, FONT_SCALE } from "../../theme/tokens";
import { Icon, type IconName } from "../../components/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function renderTabIcon(name: IconName, nameActive: IconName) {
  const TabIcon = ({ focused }: { focused: boolean }) => (
    <Icon name={focused ? nameActive : name} size={24} color={focused ? COLORS.primaryBright : COLORS.textSoft} />
  );
  TabIcon.displayName = `TabIcon(${String(name)})`;
  return TabIcon;
}

/** Floating center "+" button used for the Add Stock tab. */
function AddFab({ onPress }: { onPress?: (e: GestureResponderEvent) => void }) {
  return (
    <TouchableOpacity style={styles.fabWrap} activeOpacity={0.85} onPress={onPress} accessibilityRole="button" accessibilityLabel="Add stock">
      <View style={styles.fab}>
        <Icon name="add" size={30} color="#FFFFFF" />
      </View>
    </TouchableOpacity>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 10);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.bg },
        headerShadowVisible: false,
        headerTintColor: COLORS.text,
        headerTitleStyle: { fontWeight: "600", fontSize: 17 },
        // iPad / wide screens: keep content at a readable phone-to-tablet width.
        sceneStyle: { backgroundColor: COLORS.bg, width: "100%", maxWidth: 760, alignSelf: "center" },
        tabBarStyle: {
          backgroundColor: COLORS.bgElevated,
          borderTopColor: COLORS.border,
          borderTopWidth: 1,
          height: 70 + bottomInset,
          paddingTop: 6,
          paddingBottom: bottomInset,
        },
        tabBarActiveTintColor: COLORS.primaryBright,
        tabBarInactiveTintColor: COLORS.textSoft,
        tabBarLabelStyle: styles.tabLabel,
        // Dynamic Type: labels grow a little, but the fixed-height bar never clips them.
        tabBarLabel: ({ color, children }) => (
          <Text maxFontSizeMultiplier={FONT_SCALE.chrome} numberOfLines={1} style={[styles.tabLabel, { color }]}>
            {children}
          </Text>
        ),
        tabBarItemStyle: { paddingVertical: 2 },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{ title: "Home", headerShown: false, tabBarIcon: renderTabIcon("home-outline", "home") }}
      />
      <Tabs.Screen
        name="inventory/index"
        options={{ title: "Inventory", headerShown: false, tabBarIcon: renderTabIcon("cube-outline", "cube") }}
      />
      <Tabs.Screen
        name="inventory/add"
        options={{
          title: "",
          headerTitle: "Add Stock",
          tabBarButton: (props) => <AddFab onPress={props.onPress ?? undefined} />,
        }}
      />
      <Tabs.Screen
        name="inventory/sale"
        options={{ title: "Sales", headerTitle: "Quick Sale", tabBarIcon: renderTabIcon("pricetag-outline", "pricetag") }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", headerTitle: "More", tabBarIcon: renderTabIcon("grid-outline", "grid") }}
      />

      {/* Hidden routes — reachable via More or in-app navigation */}
      <Tabs.Screen name="inventory/invoices" options={{ href: null, headerTitle: "Invoices" }} />
      <Tabs.Screen name="settings" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="inventory/[id]" options={{ href: null, headerTitle: "" }} />
      <Tabs.Screen name="inventory/edit" options={{ href: null, headerTitle: "Edit Item" }} />
      <Tabs.Screen name="inventory/invoice-preview" options={{ href: null, headerTitle: "Invoice Preview" }} />
      <Tabs.Screen name="inventory/components/ItemQuickSheet" options={{ href: null }} />
      <Tabs.Screen name="inventory/import" options={{ href: null, headerTitle: "Import Inventory" }} />
      <Tabs.Screen name="settings/sync-center" options={{ href: null, headerTitle: "Sync Center" }} />
      <Tabs.Screen name="settings/subscription" options={{ href: null, headerTitle: "Plans & Billing" }} />
      <Tabs.Screen name="settings/analytics" options={{ href: null, headerTitle: "Advanced Analytics" }} />
      <Tabs.Screen name="settings/support" options={{ href: null, headerTitle: "Support" }} />
      <Tabs.Screen name="settings/show-summary" options={{ href: null, headerTitle: "Show Summary" }} />
      <Tabs.Screen name="customers/index" options={{ href: null, headerTitle: "Customers" }} />
      <Tabs.Screen name="customers/[id]" options={{ href: null, headerTitle: "Customer" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabLabel: { fontSize: 11, fontWeight: "500" },
  fabWrap: {
    top: -18,
    justifyContent: "center",
    alignItems: "center",
    width: 64,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.primary,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: COLORS.bg,
  },
});
