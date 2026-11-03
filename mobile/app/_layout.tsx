/**
 * Root layout — wraps entire app with AuthProvider and sets up routing.
 */
import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../context/auth";
import { NetworkProvider } from "../context/network";
import { OfflineBanner } from "../components/OfflineBanner";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { COLORS } from "../theme/tokens";
// Navigation theme: dark everywhere, so wide screens (iPad) and screen
// transitions never show the default light background behind content.
// (react-navigation is vendored inside expo-router in SDK 57.)
import { DarkTheme, ThemeProvider } from "expo-router/build/react-navigation/native";

const NAV_THEME = {
    ...DarkTheme,
    colors: {
        ...DarkTheme.colors,
        primary: COLORS.primary,
        background: COLORS.bg,
        card: COLORS.bgElevated,
        text: COLORS.text,
        border: COLORS.border,
    },
};
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
        } else if (isAuthenticated && inAuthGroup && (segments as string[])[1] !== "reset-password") {
            // A reset link must open the reset screen even while signed in.
            replace("/(tabs)/dashboard");
        }
    }, [isAuthenticated, isLoading, replace, segments]);

    if (isLoading) {
        return (
            <View style={styles.loader}>
                <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
        );
    }

    return <Slot />;
}

export default function RootLayout() {
    // Web: paint the page itself dark, so the area beside the capped-width
    // content on wide screens matches the app instead of showing white.
    useEffect(() => {
        if (Platform.OS === "web" && typeof document !== "undefined") {
            document.documentElement.style.backgroundColor = COLORS.bg;
            document.body.style.backgroundColor = COLORS.bg;
        }
    }, []);
    return (
        <SafeAreaProvider>
            <AuthProvider>
                <NetworkProvider>
                    <ThemeProvider value={NAV_THEME}>
                        <StatusBar style="light" />
                        <OfflineBanner />
                        <RootLayoutNav />
                    </ThemeProvider>
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
        backgroundColor: "#0E0E11",
    },
});
