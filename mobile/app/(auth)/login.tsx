/**
 * Login Screen
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
} from "react-native";
import { Link } from "expo-router";
import { useAuth } from "../../context/auth";

export default function LoginScreen() {
    const { signIn } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleLogin = async () => {
        if (!email.trim() || !password.trim()) {
            Alert.alert("Missing Fields", "Please enter your email and password.");
            return;
        }
        setLoading(true);
        try {
            await signIn(email.trim(), password);
        } catch (err: any) {
            Alert.alert("Login Failed", err.message || "Invalid credentials.");
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
                {/* Logo / Brand */}
                <View style={styles.brandContainer}>
                    <Text style={styles.brandIcon}>📦</Text>
                    <Text style={styles.brandName}>Vendora</Text>
                    <Text style={styles.tagline}>Your Reseller OS</Text>
                </View>

                {/* Form */}
                <View style={styles.form}>
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
                        placeholder="••••••••"
                        placeholderTextColor="#555"
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                    />

                    <TouchableOpacity
                        style={[styles.button, loading && styles.buttonDisabled]}
                        onPress={handleLogin}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.buttonText}>Sign In</Text>
                        )}
                    </TouchableOpacity>

                    <Link href="/(auth)/register" asChild>
                        <TouchableOpacity style={styles.linkContainer}>
                            <Text style={styles.linkText}>
                                Don't have an account?{" "}
                                <Text style={styles.linkHighlight}>Sign Up</Text>
                            </Text>
                        </TouchableOpacity>
                    </Link>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    content: {
        flex: 1,
        justifyContent: "center",
        paddingHorizontal: 32,
    },
    brandContainer: {
        alignItems: "center",
        marginBottom: 48,
    },
    brandIcon: {
        fontSize: 64,
        marginBottom: 8,
    },
    brandName: {
        fontSize: 36,
        fontWeight: "800",
        color: "#FFFFFF",
        letterSpacing: 2,
    },
    tagline: {
        fontSize: 14,
        color: "#6C5CE7",
        marginTop: 4,
        letterSpacing: 1,
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
    linkContainer: {
        alignItems: "center",
        marginTop: 20,
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
