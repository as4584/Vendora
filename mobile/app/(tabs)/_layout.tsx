/**
 * Tabs layout — bottom tab navigation for authenticated users.
 */
import { Tabs } from "expo-router";
import { Text } from "react-native";

export default function TabsLayout() {
    return (
        <Tabs
            screenOptions={{
                headerStyle: { backgroundColor: "#0A0A1A", elevation: 0, shadowOpacity: 0 },
                headerTintColor: "#FFFFFF",
                headerTitleStyle: { fontWeight: "700", fontSize: 18 },
                tabBarStyle: {
                    backgroundColor: "#0A0A1A",
                    borderTopColor: "#1A1A2E",
                    borderTopWidth: 1,
                    height: 60,
                    paddingBottom: 8,
                    paddingTop: 4,
                },
                tabBarActiveTintColor: "#6C5CE7",
                tabBarInactiveTintColor: "#666",
                tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
            }}
        >
            <Tabs.Screen
                name="inventory/index"
                options={{
                    title: "Inventory",
                    headerTitle: "My Inventory",
                    tabBarIcon: ({ color }) => (
                        <Text style={{ fontSize: 22 }}>📦</Text>
                    ),
                }}
            />
            <Tabs.Screen
                name="inventory/add"
                options={{
                    title: "Add Item",
                    headerTitle: "Add Item",
                    tabBarIcon: ({ color }) => (
                        <Text style={{ fontSize: 22 }}>➕</Text>
                    ),
                }}
            />
            <Tabs.Screen
                name="settings"
                options={{
                    title: "Settings",
                    headerTitle: "Settings",
                    tabBarIcon: ({ color }) => (
                        <Text style={{ fontSize: 22 }}>⚙️</Text>
                    ),
                }}
            />
            {/* Hide the dynamic [id] route from tab bar */}
            <Tabs.Screen
                name="inventory/[id]"
                options={{
                    href: null,
                    headerTitle: "Item Detail",
                }}
            />
        </Tabs>
    );
}
