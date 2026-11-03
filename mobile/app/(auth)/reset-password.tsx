import { useState } from "react";
import {
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

import { COLORS } from "../../theme/tokens";
import { Button } from "../../components/Button";
export default function ResetPasswordScreen() {
    const params = useLocalSearchParams<{ token?: string | string[] }>();
    const token = Array.isArray(params.token) ? params.token[0] : params.token;
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleReset = async () => {
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
            await resetPassword(token!, password);
            Alert.alert("Password reset", "You can now sign in with your new password.", [
                { text: "Sign In", onPress: () => router.replace("/(auth)/login") },
            ]);
        } catch (error: any) {
            // Expired or already-used links are the common failure; let the
            // user get a fresh email right here instead of contacting support.
            Alert.alert(
                "Reset failed",
                error.message || "This reset link is invalid or has expired.",
                [
                    { text: "Request New Link", onPress: () => router.replace("/(auth)/forgot-password") },
                    { text: "OK", style: "cancel" },
                ]
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
                    <TouchableOpacity accessibilityRole="link" style={styles.button}>
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
                    accessibilityLabel="New Password"
                    style={styles.input}
                    placeholder="New password"
                    placeholderTextColor="#8C8C96"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                />

                <Text style={styles.label}>Confirm Password</Text>
                <TextInput
                    accessibilityLabel="Confirm Password"
                    style={styles.input}
                    placeholder="Re-enter new password"
                    placeholderTextColor="#8C8C96"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                    autoCapitalize="none"
                />

                <Button label="Reset Password" onPress={handleReset} loading={loading} size="lg" fullWidth style={styles.buttonSpacing} />
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0E0E11" },
    centered: { justifyContent: "center", paddingHorizontal: 32 },
    content: { flex: 1, justifyContent: "center", paddingHorizontal: 32 },
    title: { color: "#FFFFFF", fontSize: 30, fontWeight: "600", marginBottom: 12 },
    subtitle: { color: "#A6A6B0", fontSize: 16, lineHeight: 23, marginBottom: 28 },
    label: {
        color: "#A6A6B0",
        fontSize: 13,
        fontWeight: "600",
        marginBottom: 8,
        marginTop: 12,
    },
    input: {
        backgroundColor: "#1C1C22",
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        color: "#FFFFFF",
        fontSize: 16,
        borderWidth: 1,
        borderColor: "#2C2C34",
    },
    button: {
        backgroundColor: COLORS.primary,
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 24,
    },
    buttonSpacing: { marginTop: 24 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
