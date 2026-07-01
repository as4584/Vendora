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
import { Link } from "expo-router";

import { requestPasswordReset } from "../../services/api";

export default function ForgotPasswordScreen() {
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = async () => {
        if (!email.trim()) {
            Alert.alert("Email required", "Enter the email address for your Vendora account.");
            return;
        }
        setLoading(true);
        try {
            await requestPasswordReset(email.trim());
            setSubmitted(true);
        } catch (error: any) {
            Alert.alert(
                "Could not send reset email",
                error.message || "Please try again in a moment."
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
            <View style={styles.content}>
                <Text style={styles.title}>Reset your password</Text>
                <Text style={styles.subtitle}>
                    Enter your account email and we’ll send you a secure reset link.
                </Text>

                {submitted ? (
                    <View style={styles.successCard}>
                        <Text style={styles.successTitle}>Check your email</Text>
                        <Text style={styles.successText}>
                            If a Vendora account exists for {email.trim()}, a reset link is on its way.
                        </Text>
                    </View>
                ) : (
                    <>
                        <Text style={styles.label}>Email</Text>
                        <TextInput
                            accessibilityLabel="Email"
                            style={styles.input}
                            placeholder="you@example.com"
                            placeholderTextColor="#555"
                            value={email}
                            onChangeText={setEmail}
                            keyboardType="email-address"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity
                            accessibilityRole="button"
                            style={[styles.button, loading && styles.buttonDisabled]}
                            onPress={handleSubmit}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color="#fff" />
                            ) : (
                                <Text style={styles.buttonText}>Send Reset Link</Text>
                            )}
                        </TouchableOpacity>
                    </>
                )}

                <Link href="/(auth)/login" asChild>
                    <TouchableOpacity accessibilityRole="link" style={styles.backLink}>
                        <Text style={styles.backText}>Back to sign in</Text>
                    </TouchableOpacity>
                </Link>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    content: { flex: 1, justifyContent: "center", paddingHorizontal: 32 },
    title: { color: "#FFFFFF", fontSize: 30, fontWeight: "800", marginBottom: 12 },
    subtitle: { color: "#999", fontSize: 16, lineHeight: 23, marginBottom: 28 },
    label: {
        color: "#999",
        fontSize: 13,
        fontWeight: "600",
        marginBottom: 8,
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
        marginTop: 20,
    },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
    successCard: {
        backgroundColor: "#15152A",
        borderColor: "#3E356F",
        borderWidth: 1,
        borderRadius: 14,
        padding: 20,
    },
    successTitle: { color: "#FFFFFF", fontSize: 19, fontWeight: "700", marginBottom: 8 },
    successText: { color: "#AAA", fontSize: 15, lineHeight: 22 },
    backLink: { alignItems: "center", marginTop: 24, paddingVertical: 8 },
    backText: { color: "#8F82FF", fontSize: 14, fontWeight: "600" },
});
