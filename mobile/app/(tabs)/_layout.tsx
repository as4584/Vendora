import { Tabs } from "expo-router";
import { COLORS } from "../../theme/tokens";
import { TabGlyph } from "../../components/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function renderTabGlyph(glyph: string) {
  return ({ focused }: { focused: boolean }) => (
    <TabGlyph glyph={glyph} active={focused} />
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
        headerTitleStyle: { fontWeight: "800", fontSize: 18 },
        sceneStyle: { backgroundColor: COLORS.bg },
        tabBarStyle: {
          backgroundColor: COLORS.bg,
          borderTopColor: COLORS.border,
          borderTopWidth: 1,
          height: 62 + bottomInset,
          paddingTop: 8,
          paddingBottom: bottomInset,
        },
        tabBarActiveTintColor: COLORS.text,
        tabBarInactiveTintColor: COLORS.textSoft,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "700" },
        tabBarItemStyle: {
          paddingVertical: 4,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dash",
          headerTitle: "Dashboard",
          tabBarIcon: renderTabGlyph("D"),
        }}
      />
      <Tabs.Screen
        name="inventory/index"
        options={{
          title: "Invent",
          headerTitle: "Inventory",
          tabBarIcon: renderTabGlyph("I"),
        }}
      />
      <Tabs.Screen
        name="inventory/sale"
        options={{
          title: "Quick",
          headerTitle: "Quick Sale",
          tabBarIcon: renderTabGlyph("Q"),
        }}
      />
      <Tabs.Screen
        name="inventory/invoices"
        options={{
          title: "Invoices",
          headerTitle: "Invoices",
          tabBarIcon: renderTabGlyph("N"),
        }}
      />
      <Tabs.Screen
        name="inventory/add"
        options={{
          title: "Add",
          headerTitle: "Add Stock",
          tabBarIcon: renderTabGlyph("+"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          headerTitle: "Settings",
          tabBarIcon: renderTabGlyph("S"),
        }}
      />
      <Tabs.Screen name="inventory/[id]" options={{ href: null, headerTitle: "Inventory Detail" }} />
      <Tabs.Screen name="inventory/import" options={{ href: null, headerTitle: "Import Inventory" }} />
      <Tabs.Screen name="settings/sync-center" options={{ href: null, headerTitle: "Sync Center" }} />
    </Tabs>
  );
}
