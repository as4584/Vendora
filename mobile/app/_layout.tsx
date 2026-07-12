/**
 * Root layout — wraps entire app with AuthProvider and sets up routing.
 */
import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../context/auth";
import { NetworkProvider } from "../context/network";
import { OfflineBanner } from "../components/OfflineBanner";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

function RootLayoutNav() {
    const { isAuthenticated, isLoading } = useAuth();
    const segments = useSegments();
    const { replace } = useRouter();

    useEffect(() => {
        if (isLoading) return;

        const inAuthGroup = segments[0] === "(auth)";
        const inPublicSeller = segments[0] === "seller";

        if (!isAuthenticated && !inAuthGroup && !inPublicSeller) {
            replace("/(auth)/login");
        } else if (isAuthenticated && inAuthGroup) {
            replace("/(tabs)/dashboard");
        }
    }, [isAuthenticated, isLoading, replace, segments]);

    if (isLoading) {
        return (
            <View style={styles.loader}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    return <Slot />;
}

export default function RootLayout() {
    return (
        <SafeAreaProvider>
            <AuthProvider>
                <NetworkProvider>
                    <StatusBar style="light" />
                    <OfflineBanner />
                    <RootLayoutNav />
                </NetworkProvider>
            </AuthProvider>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    loader: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#0A0A1A",
    },
});
