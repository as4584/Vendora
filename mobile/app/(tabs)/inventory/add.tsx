/**
 * Add Item Screen
 *
 * Form for creating a new inventory item.
 */
import { useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    Alert,
    ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";

export default function AddItemScreen() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);

    const [name, setName] = useState("");
    const [category, setCategory] = useState("");
    const [sku, setSku] = useState("");
    const [size, setSize] = useState("");
    const [color, setColor] = useState("");
    const [condition, setCondition] = useState("");
    const [buyPrice, setBuyPrice] = useState("");
    const [expectedPrice, setExpectedPrice] = useState("");
    const [platform, setPlatform] = useState("");

    const handleSubmit = async () => {
        if (!name.trim()) {
            Alert.alert("Required", "Item name is required.");
            return;
        }

        setLoading(true);
        try {
            const payload: api.CreateItemPayload = {
                name: name.trim(),
                category: category.trim() || undefined,
                sku: sku.trim() || undefined,
                size: size.trim() || undefined,
                color: color.trim() || undefined,
                condition: condition.trim() || undefined,
                buy_price: buyPrice.trim() || undefined,
                expected_sell_price: expectedPrice.trim() || undefined,
                platform: platform.trim() || undefined,
            };

            await api.createItem(payload);
            Alert.alert("Success", "Item added to inventory!", [
                { text: "OK", onPress: () => router.replace("/(tabs)/inventory") },
            ]);
        } catch (err: any) {
            if (err.detail?.error === "tier_limit_reached") {
                Alert.alert(
                    "Tier Limit Reached",
                    err.detail.message || "Upgrade to Pro for unlimited inventory."
                );
            } else {
                Alert.alert("Error", err.message || "Failed to create item.");
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
        >
            {/* Required */}
            <Text style={styles.sectionTitle}>Required</Text>
            <Text style={styles.label}>Item Name</Text>
            <TextInput
                style={styles.input}
                placeholder="e.g. Jordan 1 Retro High OG"
                placeholderTextColor="#555"
                value={name}
                onChangeText={setName}
            />

            {/* Details */}
            <Text style={styles.sectionTitle}>Details</Text>

            <View style={styles.row}>
                <View style={styles.halfField}>
                    <Text style={styles.label}>Category</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="sneakers"
                        placeholderTextColor="#555"
                        value={category}
                        onChangeText={setCategory}
                    />
                </View>
                <View style={styles.halfField}>
                    <Text style={styles.label}>SKU</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="SKU-001"
                        placeholderTextColor="#555"
                        value={sku}
                        onChangeText={setSku}
                    />
                </View>
            </View>

            <View style={styles.row}>
                <View style={styles.halfField}>
                    <Text style={styles.label}>Size</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="10"
                        placeholderTextColor="#555"
                        value={size}
                        onChangeText={setSize}
                    />
                </View>
                <View style={styles.halfField}>
                    <Text style={styles.label}>Color</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="red/black"
                        placeholderTextColor="#555"
                        value={color}
                        onChangeText={setColor}
                    />
                </View>
            </View>

            <Text style={styles.label}>Condition</Text>
            <TextInput
                style={styles.input}
                placeholder="new, used, refurbished"
                placeholderTextColor="#555"
                value={condition}
                onChangeText={setCondition}
            />

            {/* Pricing */}
            <Text style={styles.sectionTitle}>Pricing</Text>

            <View style={styles.row}>
                <View style={styles.halfField}>
                    <Text style={styles.label}>Buy Price ($)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="0.00"
                        placeholderTextColor="#555"
                        value={buyPrice}
                        onChangeText={setBuyPrice}
                        keyboardType="decimal-pad"
                    />
                </View>
                <View style={styles.halfField}>
                    <Text style={styles.label}>Expected Sell ($)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="0.00"
                        placeholderTextColor="#555"
                        value={expectedPrice}
                        onChangeText={setExpectedPrice}
                        keyboardType="decimal-pad"
                    />
                </View>
            </View>

            <Text style={styles.label}>Platform</Text>
            <TextInput
                style={styles.input}
                placeholder="eBay, StockX, Mercari..."
                placeholderTextColor="#555"
                value={platform}
                onChangeText={setPlatform}
            />

            {/* Submit */}
            <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={loading}
            >
                {loading ? (
                    <ActivityIndicator color="#fff" />
                ) : (
                    <Text style={styles.buttonText}>Add to Inventory</Text>
                )}
            </TouchableOpacity>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    content: {
        padding: 20,
        paddingBottom: 40,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: "800",
        color: "#6C5CE7",
        marginTop: 20,
        marginBottom: 8,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    label: {
        color: "#999",
        fontSize: 12,
        fontWeight: "600",
        marginBottom: 6,
        marginTop: 8,
        textTransform: "uppercase",
        letterSpacing: 0.5,
    },
    input: {
        backgroundColor: "#1A1A2E",
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: "#FFFFFF",
        fontSize: 15,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    row: {
        flexDirection: "row",
        gap: 12,
    },
    halfField: {
        flex: 1,
    },
    button: {
        backgroundColor: "#6C5CE7",
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 28,
    },
    buttonDisabled: {
        opacity: 0.6,
    },
    buttonText: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: "700",
    },
});
