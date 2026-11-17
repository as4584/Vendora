/**
 * Register Screen
 */
import { useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    Alert,
    ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useAuth } from "../../context/auth";

import { BRAND, COLORS } from "../../theme/tokens";
import { Button } from "../../components/Button";
export default function RegisterScreen() {
    const { signUp } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [businessName, setBusinessName] = useState("");
    const [loading, setLoading] = useState(false);

    const handleRegister = async () => {
        if (!email.trim() || !password.trim()) {
            Alert.alert("Missing Fields", "Email and password are required.");
            return;
        }
        if (password.length < 8) {
            Alert.alert("Weak Password", "Password must be at least 8 characters.");
            return;
        }
        if (password !== confirmPassword) {
            Alert.alert("Password Mismatch", "Passwords don't match.");
            return;
        }

        setLoading(true);
        try {
            await signUp(email.trim(), password, businessName.trim() || undefined);
        } catch (err: any) {
            Alert.alert("Registration Failed", err.message || "Something went wrong.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
            >
                {/* Brand */}
                <View style={styles.brandContainer}>
                    <Ionicons name="cube-outline" size={28} color={COLORS.text} />
                    <Text style={styles.brandName}>Join Resqlo</Text>
                    <Text style={styles.tagline}>Start selling smarter</Text>
                </View>

                {/* Form */}
                <View style={styles.form}>
                    <Text style={styles.label}>Business Name (optional)</Text>
                    <TextInput
                        accessibilityLabel="Business Name"
                        style={styles.input}
                        placeholder="My Resale Shop"
                        placeholderTextColor={COLORS.textSoft}
                        value={businessName}
                        onChangeText={setBusinessName}
                    />

                    <Text style={styles.label}>Email</Text>
                    <TextInput
                        accessibilityLabel="Email"
                        style={styles.input}
                        placeholder="you@example.com"
                        placeholderTextColor={COLORS.textSoft}
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />

                    <Text style={styles.label}>Password</Text>
                    <TextInput
                        accessibilityLabel="Password"
                        style={styles.input}
                        placeholder="Min 8 characters"
                        placeholderTextColor={COLORS.textSoft}
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                    />

                    <Text style={styles.label}>Confirm Password</Text>
                    <TextInput
                        accessibilityLabel="Confirm Password"
                        style={styles.input}
                        placeholder="Re-enter password"
                        placeholderTextColor={COLORS.textSoft}
                        value={confirmPassword}
                        onChangeText={setConfirmPassword}
                        secureTextEntry
                    />

                    <Button label="Create Account" onPress={handleRegister} loading={loading} size="lg" fullWidth style={styles.buttonSpacing} />

                    {/* Tier info */}
                    <View style={styles.tierBadge}>
                        <Text style={styles.tierText}>Free plan: 25 items, no card needed</Text>
                    </View>

                    <Link href="/(auth)/login" asChild>
                        <TouchableOpacity accessibilityRole="link" style={styles.linkContainer}>
                            <Text style={styles.linkText}>
                                Already have an account?{" "}
                                <Text style={styles.linkHighlight}>Sign In</Text>
                            </Text>
                        </TouchableOpacity>
                    </Link>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.bg,
    },
    content: {
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 32,
        paddingVertical: 48,
    },
    brandContainer: {
        alignItems: "center",
        marginBottom: 36,
    },
    brandIcon: {
        fontSize: 48,
        marginBottom: 8,
    },
    brandName: {
        fontSize: 28,
        fontWeight: "600",
        color: COLORS.text,
    },
    tagline: {
        fontSize: 15,
        color: COLORS.textMuted,
        marginTop: 4,
    },
    form: {
        gap: 4,
    },
    label: {
        color: COLORS.textMuted,
        fontSize: 13,
        fontWeight: "600",
        marginBottom: 6,
        marginTop: 12,
    },
    input: {
        backgroundColor: COLORS.card,
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        color: COLORS.text,
        fontSize: 16,
        borderWidth: 1,
        borderColor: COLORS.borderStrong,
    },
    button: {
        backgroundColor: COLORS.primary,
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 24,
    },
    buttonSpacing: { marginTop: 24 },
    buttonDisabled: {
        opacity: 0.6,
    },
    buttonText: {
        color: BRAND.onPrimary,
        fontSize: 16,
        fontWeight: "600",
    },
    tierBadge: {
        backgroundColor: COLORS.card,
        borderRadius: 8,
        padding: 12,
        marginTop: 16,
        borderWidth: 1,
        borderColor: COLORS.borderStrong,
        alignItems: "center",
    },
    tierText: {
        color: COLORS.primary,
        fontSize: 13,
        fontWeight: "500",
    },
    linkContainer: {
        alignItems: "center",
        marginTop: 16,
    },
    linkText: {
        color: COLORS.textMuted,
        fontSize: 14,
    },
    linkHighlight: {
        color: COLORS.primary,
        fontWeight: "600",
    },
});
