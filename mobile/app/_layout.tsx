/**
 * Root layout — wraps entire app with AuthProvider and sets up routing.
 */
import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../context/auth";
import { View, ActivityIndicator, StyleSheet } from "react-native";

function RootLayoutNav() {
    const { isAuthenticated, isLoading } = useAuth();
    const segments = useSegments();
    const router = useRouter();

    useEffect(() => {
        if (isLoading) return;

        const inAuthGroup = segments[0] === "(auth)";

        if (!isAuthenticated && !inAuthGroup) {
            router.replace("/(auth)/login");
        } else if (isAuthenticated && inAuthGroup) {
            router.replace("/(tabs)/dashboard");
        }
    }, [isAuthenticated, isLoading, segments]);

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
        <AuthProvider>
            <StatusBar style="light" />
            <RootLayoutNav />
        </AuthProvider>
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
