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
    Image,
} from "react-native";
import { Link } from "expo-router";
import { useAuth } from "../../context/auth";
import { COLORS } from "../../theme/tokens";
import { Icon } from "../../components/ui";

import { Button } from "../../components/Button";
export default function LoginScreen() {
    const { signIn } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

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
                    <Image
                        source={require("../../assets/brand/vendora-logo.png")}
                        style={styles.brandLogo}
                        resizeMode="contain"
                        accessibilityLabel="Vendora logo"
                    />
                    <Text style={styles.brandName}>Vendora</Text>
                    <Text style={styles.tagline}>Inventory & Business Suite</Text>
                </View>

                {/* Form */}
                <View style={styles.form}>
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

                    <Text style={styles.label}>Password</Text>
                    <View style={styles.passwordRow}>
                        <TextInput
                            accessibilityLabel="Password"
                            style={[styles.input, styles.inputInRow]}
                            placeholder="••••••••"
                            placeholderTextColor="#555"
                            value={password}
                            onChangeText={setPassword}
                            secureTextEntry={!showPassword}
                        />
                        <TouchableOpacity
                            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                            accessibilityRole="button"
                            style={styles.eyeBtn}
                            onPress={() => setShowPassword((v) => !v)}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <Icon name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={COLORS.textMuted} />
                        </TouchableOpacity>
                    </View>

                    <Link href="/(auth)/forgot-password" asChild>
                        <TouchableOpacity
                            accessibilityRole="link"
                            testID="forgot-password-link"
                            style={styles.forgotPasswordLink}
                        >
                            <Text style={styles.forgotPasswordText}>Forgot password?</Text>
                        </TouchableOpacity>
                    </Link>

                    <Button label="Sign In" onPress={handleLogin} loading={loading} size="lg" fullWidth style={styles.buttonSpacing} />

                    <Link href="/(auth)/register" asChild>
                        <TouchableOpacity accessibilityRole="link" style={styles.linkContainer}>
                            <Text style={styles.linkText}>
                                Don&apos;t have an account?{" "}
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
        backgroundColor: COLORS.bg,
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
    brandLogo: {
        width: 88,
        height: 88,
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
        color: COLORS.primary,
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
    // The row draws the border; the field inside must not draw a second one.
    inputInRow: { flex: 1, marginBottom: 0, borderWidth: 0, backgroundColor: "transparent" },
    passwordRow: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        paddingRight: 4,
    },
    eyeBtn: {
        paddingHorizontal: 12,
        paddingVertical: 14,
    },
    eyeIcon: {
        fontSize: 18,
    },
    forgotPasswordLink: {
        alignSelf: "flex-end",
        paddingVertical: 10,
        paddingLeft: 16,
    },
    forgotPasswordText: {
        color: "#8F82FF",
        fontSize: 14,
        fontWeight: "600",
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
        color: COLORS.primary,
        fontWeight: "600",
    },
});
