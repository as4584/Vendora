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
    ActivityIndicator,
    ScrollView,
} from "react-native";
import { Link } from "expo-router";
import { useAuth } from "../../context/auth";

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
                    <Text style={styles.brandIcon}>📦</Text>
                    <Text style={styles.brandName}>Join Vendora</Text>
                    <Text style={styles.tagline}>Start selling smarter</Text>
                </View>

                {/* Form */}
                <View style={styles.form}>
                    <Text style={styles.label}>Business Name (optional)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="My Resale Shop"
                        placeholderTextColor="#555"
                        value={businessName}
                        onChangeText={setBusinessName}
                    />

                    <Text style={styles.label}>Email</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="you@example.com"
                        placeholderTextColor="#555"
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />

                    <Text style={styles.label}>Password</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="Min 8 characters"
                        placeholderTextColor="#555"
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                    />

                    <Text style={styles.label}>Confirm Password</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="Re-enter password"
                        placeholderTextColor="#555"
                        value={confirmPassword}
                        onChangeText={setConfirmPassword}
                        secureTextEntry
                    />

                    <TouchableOpacity
                        style={[styles.button, loading && styles.buttonDisabled]}
                        onPress={handleRegister}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.buttonText}>Create Account</Text>
                        )}
                    </TouchableOpacity>

                    {/* Tier info */}
                    <View style={styles.tierBadge}>
                        <Text style={styles.tierText}>🆓 Free Tier — 25 items, no credit card needed</Text>
                    </View>

                    <Link href="/(auth)/login" asChild>
                        <TouchableOpacity style={styles.linkContainer}>
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
        backgroundColor: "#0A0A1A",
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
        fontWeight: "800",
        color: "#FFFFFF",
        letterSpacing: 1,
    },
    tagline: {
        fontSize: 14,
        color: "#6C5CE7",
        marginTop: 4,
    },
    form: {
        gap: 4,
    },
    label: {
        color: "#999",
        fontSize: 13,
        fontWeight: "600",
        marginBottom: 6,
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
    buttonDisabled: {
        opacity: 0.6,
    },
    buttonText: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "700",
    },
    tierBadge: {
        backgroundColor: "#1A1A2E",
        borderRadius: 8,
        padding: 12,
        marginTop: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        alignItems: "center",
    },
    tierText: {
        color: "#6C5CE7",
        fontSize: 13,
        fontWeight: "500",
    },
    linkContainer: {
        alignItems: "center",
        marginTop: 16,
    },
    linkText: {
        color: "#888",
        fontSize: 14,
    },
    linkHighlight: {
        color: "#6C5CE7",
        fontWeight: "600",
    },
});
