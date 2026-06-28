import { useState } from "react";
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { Link, router, useLocalSearchParams } from "expo-router";

import { resetPassword } from "../../services/api";

export default function ResetPasswordScreen() {
    const params = useLocalSearchParams<{ token?: string | string[] }>();
    const token = Array.isArray(params.token) ? params.token[0] : params.token;
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleReset = async () => {
        if (!token) {
            Alert.alert("Invalid link", "Request a new password reset email.");
            return;
        }
        if (password.length < 8) {
            Alert.alert("Weak password", "Your password must be at least 8 characters.");
            return;
        }
        if (password !== confirmPassword) {
            Alert.alert("Passwords do not match", "Enter the same password in both fields.");
            return;
        }

        setLoading(true);
        try {
            await resetPassword(token, password);
            Alert.alert("Password reset", "You can now sign in with your new password.", [
                { text: "Sign In", onPress: () => router.replace("/(auth)/login") },
            ]);
        } catch (error: any) {
            Alert.alert(
                "Reset failed",
                error.message || "This reset link is invalid or has expired."
            );
        } finally {
            setLoading(false);
        }
    };

    if (!token) {
        return (
            <View style={[styles.container, styles.centered]}>
                <Text style={styles.title}>Reset link unavailable</Text>
                <Text style={styles.subtitle}>
                    This link is missing its secure token. Request a new email and try again.
                </Text>
                <Link href="/(auth)/forgot-password" asChild>
                    <TouchableOpacity style={styles.button}>
                        <Text style={styles.buttonText}>Request New Link</Text>
                    </TouchableOpacity>
                </Link>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
            <View style={styles.content}>
                <Text style={styles.title}>Choose a new password</Text>
                <Text style={styles.subtitle}>Use at least 8 characters.</Text>

                <Text style={styles.label}>New Password</Text>
                <TextInput
                    style={styles.input}
                    placeholder="New password"
                    placeholderTextColor="#555"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                />

                <Text style={styles.label}>Confirm Password</Text>
                <TextInput
                    style={styles.input}
                    placeholder="Re-enter new password"
                    placeholderTextColor="#555"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                    autoCapitalize="none"
                />

                <TouchableOpacity
                    style={[styles.button, loading && styles.buttonDisabled]}
                    onPress={handleReset}
                    disabled={loading}
                >
                    {loading ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <Text style={styles.buttonText}>Reset Password</Text>
                    )}
                </TouchableOpacity>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    centered: { justifyContent: "center", paddingHorizontal: 32 },
    content: { flex: 1, justifyContent: "center", paddingHorizontal: 32 },
    title: { color: "#FFFFFF", fontSize: 30, fontWeight: "800", marginBottom: 12 },
    subtitle: { color: "#999", fontSize: 16, lineHeight: 23, marginBottom: 28 },
    label: {
        color: "#999",
        fontSize: 13,
        fontWeight: "600",
        marginBottom: 8,
        marginTop: 12,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    input: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        color: "#FFFFFF",
        fontSize: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    button: {
        backgroundColor: "#6C5CE7",
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 24,
    },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
