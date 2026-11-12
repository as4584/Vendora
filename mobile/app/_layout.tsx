/**
 * Root layout — wraps entire app with AuthProvider and sets up routing.
 */
import { useEffect, useState } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../context/auth";
import { NetworkProvider } from "../context/network";
import { OfflineBanner } from "../components/OfflineBanner";
import { View, ActivityIndicator, Platform, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { COLORS, IS_LIGHT } from "../theme/tokens";
import { useSchemeReload } from "../theme/useSchemeReload";
import { Backdrop } from "../components/Backdrop";
import { identify, initCrashReporting, track } from "../services/telemetry";
import { maybePromptSaleAlerts, syncPushToken } from "../services/pushAlerts";
import { allowedDuringOnboarding, checkOnboarding, subscribeOnboarding, type OnboardingState } from "../services/onboarding";
// react-navigation is vendored inside expo-router in SDK 57.
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/build/react-navigation/native";

initCrashReporting();
// Navigation theme follows the phone's light/dark setting, painted with our
// tokens so screen transitions never flash a mismatched background.
const BASE_NAV = IS_LIGHT ? DefaultTheme : DarkTheme;
const NAV_THEME = {
    ...BASE_NAV,
    colors: {
        ...BASE_NAV.colors,
        primary: COLORS.primary,
        background: COLORS.bg,
        card: COLORS.bgElevated,
        text: COLORS.text,
        border: COLORS.border,
    },
};
function RootLayoutNav() {
    const { isAuthenticated, isLoading, user } = useAuth();
    const segments = useSegments();
    const { replace } = useRouter();
    const userId = user?.id ? String(user.id) : null;
    const [onboarding, setOnboarding] = useState<OnboardingState>("unknown");

    useEffect(() => subscribeOnboarding(setOnboarding), []);
    useEffect(() => {
        let live = true;
        if (!userId) return;
        void checkOnboarding(userId).then((s) => live && setOnboarding(s));
        return () => {
            live = false;
        };
    }, [userId]);

    useEffect(() => {
        identify(userId);
        if (!userId) return;
        track("app_open");
        void syncPushToken().then((on) => (on ? undefined : maybePromptSaleAlerts(userId)));
    }, [userId]);

    useEffect(() => {
        if (isLoading) return;

        const inAuthGroup = segments[0] === "(auth)";
        const inPublicSeller = segments[0] === "seller";

        if (!isAuthenticated && !inAuthGroup && !inPublicSeller) {
            replace("/(auth)/login");
        } else if (isAuthenticated && onboarding === "needed" && !allowedDuringOnboarding(segments as string[])) {
            // New seller: setup (get inventory in) comes before the rest of the app.
            replace("/onboarding");
        } else if (isAuthenticated && inAuthGroup && (segments as string[])[1] !== "reset-password") {
            // A reset link must open the reset screen even while signed in.
            replace(onboarding === "needed" ? "/onboarding" : "/(tabs)/dashboard");
        }
    }, [isAuthenticated, isLoading, onboarding, replace, segments]);

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
    useSchemeReload();
    // Web: paint the page itself in the app background, so the area beside the capped-width
    // content on wide screens matches the app instead of showing white.
    useEffect(() => {
        if (Platform.OS === "web" && typeof document !== "undefined") {
            document.documentElement.style.backgroundColor = COLORS.canvas;
            document.body.style.backgroundColor = COLORS.canvas;
        }
    }, []);
    return (
        <SafeAreaProvider>
          <Backdrop>
            <AuthProvider>
                <NetworkProvider>
                    <ThemeProvider value={NAV_THEME}>
                        <StatusBar style={IS_LIGHT ? "dark" : "light"} />
                        <OfflineBanner />
                        <RootLayoutNav />
                    </ThemeProvider>
                </NetworkProvider>
            </AuthProvider>
          </Backdrop>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    loader: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: COLORS.bg,
    },
});
