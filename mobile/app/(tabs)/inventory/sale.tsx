/**
 * Quick Sale Screen — Sprint 2
 *
 * Fast flow: select item → enter amount → log sale in <5 seconds.
 * Supports both linked-item sales and standalone payment logging.
 */
import { useCallback, useEffect, useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    Alert,
    ActivityIndicator,
    FlatList,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";

const PAYMENT_METHODS = [
    { key: "cash", label: "💵 Cash", color: "#00B894" },
    { key: "venmo", label: "💜 Venmo", color: "#3D95CE" },
    { key: "cashapp", label: "💚 CashApp", color: "#00D632" },
    { key: "paypal", label: "💙 PayPal", color: "#003087" },
    { key: "zelle", label: "💜 Zelle", color: "#6C1CD3" },
    { key: "stripe", label: "💳 Stripe", color: "#635BFF" },
    { key: "other", label: "📝 Other", color: "#636E72" },
];

export default function QuickSaleScreen() {
    const router = useRouter();
    const [step, setStep] = useState<"item" | "details">("item");
    const [selectedItem, setSelectedItem] = useState<api.InventoryItem | null>(null);
    const [items, setItems] = useState<api.InventoryItem[]>([]);
    const [loadingItems, setLoadingItems] = useState(true);

    // Sale details
    const [method, setMethod] = useState("cash");
    const [grossAmount, setGrossAmount] = useState("");
    const [feeAmount, setFeeAmount] = useState("");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const fetchItems = useCallback(async () => {
        try {
            const data = await api.listItems(1, 100);
            // Only show sellable items (in_stock or listed)
            setItems(data.items.filter((i) => ["in_stock", "listed"].includes(i.status)));
        } catch (err: any) {
            Alert.alert("Error", err.message);
        } finally {
            setLoadingItems(false);
        }
    }, []);

    useEffect(() => {
        fetchItems();
    }, []);

    const handleSelectItem = (item: api.InventoryItem) => {
        setSelectedItem(item);
        // Pre-fill amount from expected sell price
        if (item.expected_sell_price) {
            setGrossAmount(item.expected_sell_price);
        }
        setStep("details");
    };

    const handleSkipItem = () => {
        setSelectedItem(null);
        setStep("details");
    };

    const handleSubmit = async () => {
        if (!grossAmount.trim() || parseFloat(grossAmount) <= 0) {
            Alert.alert("Required", "Enter the sale amount.");
            return;
        }

        const fee = feeAmount.trim() ? feeAmount.trim() : "0.00";
        if (parseFloat(fee) > parseFloat(grossAmount)) {
            Alert.alert("Invalid", "Fee cannot exceed sale amount.");
            return;
        }

        setSubmitting(true);
        try {
            const payload: api.CreateTransactionPayload = {
                method,
                gross_amount: grossAmount.trim(),
                fee_amount: fee,
                notes: notes.trim() || undefined,
            };
            if (selectedItem) {
                payload.item_id = selectedItem.id;
            }

            const txn = await api.createTransaction(payload);

            const net = parseFloat(txn.net_amount).toFixed(2);
            Alert.alert(
                "💰 Sale Logged!",
                `$${txn.gross_amount} received → $${net} net${selectedItem ? `\n${selectedItem.name} moved to Sold` : ""}`,
                [
                    {
                        text: "View Dashboard",
                        onPress: () => router.replace("/(tabs)/dashboard"),
                    },
                    {
                        text: "New Sale",
                        onPress: () => {
                            setStep("item");
                            setSelectedItem(null);
                            setGrossAmount("");
                            setFeeAmount("");
                            setNotes("");
                            fetchItems();
                        },
                    },
                ]
            );
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to log sale.");
        } finally {
            setSubmitting(false);
        }
    };

    // Step 1: Item selection
    if (step === "item") {
        return (
            <View style={styles.container}>
                <Text style={styles.stepTitle}>Step 1: Select Item (Optional)</Text>
                <Text style={styles.stepSubtitle}>
                    Link this sale to an inventory item, or skip for a standalone log.
                </Text>

                <TouchableOpacity style={styles.skipButton} onPress={handleSkipItem}>
                    <Text style={styles.skipText}>Skip — Log Without Item</Text>
                </TouchableOpacity>

                {loadingItems ? (
                    <ActivityIndicator size="large" color="#6C5CE7" style={{ marginTop: 32 }} />
                ) : items.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyIcon}>📭</Text>
                        <Text style={styles.emptyText}>No sellable items</Text>
                        <Text style={styles.emptySubtext}>All items are already sold or archived</Text>
                    </View>
                ) : (
                    <FlatList
                        data={items}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={styles.itemList}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                style={styles.itemCard}
                                onPress={() => handleSelectItem(item)}
                                activeOpacity={0.7}
                            >
                                <View style={styles.itemRow}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.itemName} numberOfLines={1}>
                                            {item.name}
                                        </Text>
                                        {item.category && (
                                            <Text style={styles.itemMeta}>📁 {item.category}</Text>
                                        )}
                                    </View>
                                    <View style={styles.itemPrices}>
                                        {item.buy_price && (
                                            <Text style={styles.buyPrice}>Cost: ${item.buy_price}</Text>
                                        )}
                                        {item.expected_sell_price && (
                                            <Text style={styles.sellPrice}>Ask: ${item.expected_sell_price}</Text>
                                        )}
                                    </View>
                                </View>
                            </TouchableOpacity>
                        )}
                    />
                )}
            </View>
        );
    }

    // Step 2: Sale details
    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.detailsContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.stepTitle}>Step 2: Sale Details</Text>

            {selectedItem && (
                <View style={styles.selectedCard}>
                    <Text style={styles.selectedLabel}>SELLING</Text>
                    <Text style={styles.selectedName}>{selectedItem.name}</Text>
                    {selectedItem.buy_price && (
                        <Text style={styles.selectedMeta}>Cost: ${selectedItem.buy_price}</Text>
                    )}
                    <TouchableOpacity onPress={() => setStep("item")}>
                        <Text style={styles.changeItem}>Change Item</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* Payment Method */}
            <Text style={styles.label}>Payment Method</Text>
            <View style={styles.methodsGrid}>
                {PAYMENT_METHODS.map((pm) => (
                    <TouchableOpacity
                        key={pm.key}
                        style={[
                            styles.methodButton,
                            method === pm.key && { borderColor: pm.color, backgroundColor: `${pm.color}20` },
                        ]}
                        onPress={() => setMethod(pm.key)}
                    >
                        <Text
                            style={[
                                styles.methodText,
                                method === pm.key && { color: pm.color },
                            ]}
                        >
                            {pm.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* Amount */}
            <Text style={styles.label}>Sale Amount ($)</Text>
            <TextInput
                style={styles.amountInput}
                placeholder="0.00"
                placeholderTextColor="#555"
                value={grossAmount}
                onChangeText={setGrossAmount}
                keyboardType="decimal-pad"
                autoFocus={!selectedItem}
            />

            {/* Fee */}
            <Text style={styles.label}>Platform Fee (optional)</Text>
            <TextInput
                style={styles.input}
                placeholder="0.00"
                placeholderTextColor="#555"
                value={feeAmount}
                onChangeText={setFeeAmount}
                keyboardType="decimal-pad"
            />

            {/* Net preview */}
            {grossAmount.trim() && (
                <View style={styles.netPreview}>
                    <Text style={styles.netLabel}>Net Amount</Text>
                    <Text style={styles.netValue}>
                        ${(parseFloat(grossAmount || "0") - parseFloat(feeAmount || "0")).toFixed(2)}
                    </Text>
                    {selectedItem?.buy_price && (
                        <>
                            <Text style={styles.netLabel}>Estimated Profit</Text>
                            <Text style={[styles.netValue, { color: "#00B894" }]}>
                                ${(
                                    parseFloat(grossAmount || "0") -
                                    parseFloat(feeAmount || "0") -
                                    parseFloat(selectedItem.buy_price)
                                ).toFixed(2)}
                            </Text>
                        </>
                    )}
                </View>
            )}

            {/* Notes */}
            <Text style={styles.label}>Notes (optional)</Text>
            <TextInput
                style={[styles.input, { height: 60 }]}
                placeholder="Buyer info, tracking, etc."
                placeholderTextColor="#555"
                value={notes}
                onChangeText={setNotes}
                multiline
            />

            {/* Submit */}
            <TouchableOpacity
                style={[styles.submitButton, submitting && styles.submitDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
            >
                {submitting ? (
                    <ActivityIndicator color="#fff" />
                ) : (
                    <Text style={styles.submitText}>💰 Log Sale</Text>
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
    detailsContent: {
        padding: 20,
        paddingBottom: 40,
    },
    stepTitle: {
        fontSize: 20,
        fontWeight: "800",
        color: "#FFFFFF",
        marginTop: 16,
        marginHorizontal: 20,
    },
    stepSubtitle: {
        fontSize: 13,
        color: "#888",
        marginTop: 4,
        marginHorizontal: 20,
        marginBottom: 16,
    },
    skipButton: {
        marginHorizontal: 20,
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#6C5CE7",
        marginBottom: 12,
    },
    skipText: {
        color: "#6C5CE7",
        fontSize: 15,
        fontWeight: "700",
    },
    itemList: {
        padding: 16,
        gap: 10,
    },
    itemCard: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    itemRow: {
        flexDirection: "row",
        alignItems: "center",
    },
    itemName: {
        fontSize: 15,
        fontWeight: "700",
        color: "#FFFFFF",
    },
    itemMeta: {
        fontSize: 12,
        color: "#888",
        marginTop: 2,
    },
    itemPrices: {
        alignItems: "flex-end",
    },
    buyPrice: {
        fontSize: 12,
        color: "#888",
    },
    sellPrice: {
        fontSize: 13,
        color: "#00B894",
        fontWeight: "600",
    },
    selectedCard: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 16,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: "#6C5CE7",
    },
    selectedLabel: {
        fontSize: 10,
        fontWeight: "800",
        color: "#6C5CE7",
        letterSpacing: 1,
    },
    selectedName: {
        fontSize: 18,
        fontWeight: "700",
        color: "#FFFFFF",
        marginTop: 4,
    },
    selectedMeta: {
        fontSize: 13,
        color: "#888",
        marginTop: 4,
    },
    changeItem: {
        color: "#6C5CE7",
        fontSize: 13,
        fontWeight: "600",
        marginTop: 8,
    },
    label: {
        color: "#999",
        fontSize: 12,
        fontWeight: "600",
        marginBottom: 6,
        marginTop: 16,
        textTransform: "uppercase",
        letterSpacing: 0.5,
    },
    methodsGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
    },
    methodButton: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: "#2A2A4A",
        backgroundColor: "#1A1A2E",
    },
    methodText: {
        fontSize: 13,
        fontWeight: "600",
        color: "#888",
    },
    amountInput: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 16,
        color: "#FFFFFF",
        fontSize: 28,
        fontWeight: "800",
        borderWidth: 1,
        borderColor: "#2A2A4A",
        textAlign: "center",
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
    netPreview: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 16,
        marginTop: 12,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    netLabel: {
        color: "#888",
        fontSize: 11,
        fontWeight: "600",
        textTransform: "uppercase",
        marginBottom: 4,
        marginTop: 8,
    },
    netValue: {
        fontSize: 22,
        fontWeight: "800",
        color: "#FFFFFF",
    },
    submitButton: {
        backgroundColor: "#00B894",
        borderRadius: 14,
        paddingVertical: 18,
        alignItems: "center",
        marginTop: 28,
    },
    submitDisabled: {
        opacity: 0.6,
    },
    submitText: {
        color: "#FFFFFF",
        fontSize: 18,
        fontWeight: "800",
    },
    emptyContainer: {
        alignItems: "center",
        marginTop: 60,
    },
    emptyIcon: {
        fontSize: 48,
        marginBottom: 12,
    },
    emptyText: {
        fontSize: 16,
        fontWeight: "700",
        color: "#FFFFFF",
    },
    emptySubtext: {
        fontSize: 13,
        color: "#888",
        marginTop: 4,
    },
});
