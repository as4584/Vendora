/**
 * Invoice Creation Screen — Sprint 3
 *
 * Create invoices with customer info, line items, tax/shipping/discount.
 * Pro users can send via Stripe; all users can create and track.
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

interface LineItemDraft {
    description: string;
    quantity: string;
    unit_price: string;
    inventory_item_id?: string;
}

const STATUS_COLORS: Record<string, string> = {
    draft: "#FDCB6E",
    sent: "#0984E3",
    paid: "#00B894",
    cancelled: "#E17055",
};

export default function InvoicesScreen() {
    const router = useRouter();
    const [view, setView] = useState<"list" | "create">("list");
    const [invoices, setInvoices] = useState<api.InvoiceData[]>([]);
    const [loading, setLoading] = useState(true);

    // Create form state
    const [customerName, setCustomerName] = useState("");
    const [customerEmail, setCustomerEmail] = useState("");
    const [lineItems, setLineItems] = useState<LineItemDraft[]>([
        { description: "", quantity: "1", unit_price: "" },
    ]);
    const [tax, setTax] = useState("");
    const [shipping, setShipping] = useState("");
    const [discount, setDiscount] = useState("");
    const [notes, setNotes] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const fetchInvoices = useCallback(async () => {
        try {
            const data = await api.listInvoices(1, 50);
            setInvoices(data.items);
        } catch (err: any) {
            Alert.alert("Error", err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchInvoices();
    }, []);

    const addLineItem = () => {
        setLineItems([...lineItems, { description: "", quantity: "1", unit_price: "" }]);
    };

    const removeLineItem = (index: number) => {
        if (lineItems.length <= 1) return;
        setLineItems(lineItems.filter((_, i) => i !== index));
    };

    const updateLineItem = (index: number, field: keyof LineItemDraft, value: string) => {
        const updated = [...lineItems];
        updated[index] = { ...updated[index], [field]: value };
        setLineItems(updated);
    };

    const calculateSubtotal = (): number => {
        return lineItems.reduce((sum, item) => {
            const qty = parseInt(item.quantity) || 0;
            const price = parseFloat(item.unit_price) || 0;
            return sum + qty * price;
        }, 0);
    };

    const calculateTotal = (): number => {
        const sub = calculateSubtotal();
        return sub + (parseFloat(tax) || 0) + (parseFloat(shipping) || 0) - (parseFloat(discount) || 0);
    };

    const handleCreate = async () => {
        if (!customerName.trim()) {
            Alert.alert("Required", "Enter customer name.");
            return;
        }
        if (lineItems.some((li) => !li.description.trim() || !li.unit_price.trim())) {
            Alert.alert("Required", "Fill in all line item descriptions and prices.");
            return;
        }

        setSubmitting(true);
        try {
            const payload: api.CreateInvoicePayload = {
                customer_name: customerName.trim(),
                customer_email: customerEmail.trim() || undefined,
                items: lineItems.map((li) => ({
                    description: li.description.trim(),
                    quantity: parseInt(li.quantity) || 1,
                    unit_price: li.unit_price.trim(),
                    inventory_item_id: li.inventory_item_id,
                })),
                tax: tax.trim() || undefined,
                shipping: shipping.trim() || undefined,
                discount: discount.trim() || undefined,
                notes: notes.trim() || undefined,
            };

            const invoice = await api.createInvoice(payload);
            Alert.alert(
                "🧾 Invoice Created!",
                `$${invoice.total} invoice for ${invoice.customer_name}`,
                [
                    {
                        text: "Send to Customer",
                        onPress: async () => {
                            try {
                                await api.updateInvoiceStatus(invoice.id, "sent");
                                Alert.alert("✅", "Invoice marked as sent!");
                            } catch (err: any) {
                                Alert.alert("Error", err.message);
                            }
                            setView("list");
                            fetchInvoices();
                        },
                    },
                    {
                        text: "Keep as Draft",
                        onPress: () => {
                            setView("list");
                            fetchInvoices();
                        },
                    },
                ]
            );

            // Reset form
            setCustomerName("");
            setCustomerEmail("");
            setLineItems([{ description: "", quantity: "1", unit_price: "" }]);
            setTax("");
            setShipping("");
            setDiscount("");
            setNotes("");
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to create invoice.");
        } finally {
            setSubmitting(false);
        }
    };

    const handleStatusAction = async (invoice: api.InvoiceData) => {
        const actions: { text: string; target: string }[] = [];
        if (invoice.status === "draft") actions.push({ text: "Send", target: "sent" });
        if (invoice.status === "sent") {
            actions.push({ text: "Mark Paid", target: "paid" });
            actions.push({ text: "Cancel", target: "cancelled" });
        }
        if (actions.length === 0) return;

        Alert.alert(
            `Invoice #${invoice.id.slice(0, 8)}`,
            `Status: ${invoice.status}\nTotal: $${invoice.total}`,
            [
                ...actions.map((a) => ({
                    text: a.text,
                    onPress: async () => {
                        try {
                            await api.updateInvoiceStatus(invoice.id, a.target);
                            fetchInvoices();
                        } catch (err: any) {
                            Alert.alert("Error", err.message);
                        }
                    },
                })),
                { text: "Close", style: "cancel" as const },
            ]
        );
    };

    // ─── Create View ───
    if (view === "create") {
        return (
            <ScrollView style={styles.container} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
                <Text style={styles.sectionTitle}>Customer</Text>
                <TextInput
                    style={styles.input}
                    placeholder="Customer Name *"
                    placeholderTextColor="#555"
                    value={customerName}
                    onChangeText={setCustomerName}
                />
                <TextInput
                    style={styles.input}
                    placeholder="Email (optional)"
                    placeholderTextColor="#555"
                    value={customerEmail}
                    onChangeText={setCustomerEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                />

                <Text style={styles.sectionTitle}>Line Items</Text>
                {lineItems.map((item, i) => (
                    <View key={i} style={styles.lineItemCard}>
                        <TextInput
                            style={styles.input}
                            placeholder="Description *"
                            placeholderTextColor="#555"
                            value={item.description}
                            onChangeText={(v) => updateLineItem(i, "description", v)}
                        />
                        <View style={styles.lineItemRow}>
                            <TextInput
                                style={[styles.input, { flex: 1 }]}
                                placeholder="Qty"
                                placeholderTextColor="#555"
                                value={item.quantity}
                                onChangeText={(v) => updateLineItem(i, "quantity", v)}
                                keyboardType="number-pad"
                            />
                            <TextInput
                                style={[styles.input, { flex: 2, marginLeft: 8 }]}
                                placeholder="Unit Price"
                                placeholderTextColor="#555"
                                value={item.unit_price}
                                onChangeText={(v) => updateLineItem(i, "unit_price", v)}
                                keyboardType="decimal-pad"
                            />
                            {lineItems.length > 1 && (
                                <TouchableOpacity
                                    style={styles.removeBtn}
                                    onPress={() => removeLineItem(i)}
                                >
                                    <Text style={styles.removeBtnText}>✕</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                ))}
                <TouchableOpacity style={styles.addItemBtn} onPress={addLineItem}>
                    <Text style={styles.addItemText}>+ Add Line Item</Text>
                </TouchableOpacity>

                <Text style={styles.sectionTitle}>Adjustments</Text>
                <View style={styles.adjustRow}>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.adjustLabel}>Tax</Text>
                        <TextInput style={styles.input} placeholder="0.00" placeholderTextColor="#555"
                            value={tax} onChangeText={setTax} keyboardType="decimal-pad" />
                    </View>
                    <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={styles.adjustLabel}>Shipping</Text>
                        <TextInput style={styles.input} placeholder="0.00" placeholderTextColor="#555"
                            value={shipping} onChangeText={setShipping} keyboardType="decimal-pad" />
                    </View>
                    <View style={{ flex: 1, marginLeft: 8 }}>
                        <Text style={styles.adjustLabel}>Discount</Text>
                        <TextInput style={styles.input} placeholder="0.00" placeholderTextColor="#555"
                            value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" />
                    </View>
                </View>

                {/* Totals preview */}
                <View style={styles.totalsCard}>
                    <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>Subtotal</Text>
                        <Text style={styles.totalValue}>${calculateSubtotal().toFixed(2)}</Text>
                    </View>
                    <View style={styles.totalRow}>
                        <Text style={styles.totalLabel}>Total</Text>
                        <Text style={[styles.totalValue, { fontSize: 24, color: "#00B894" }]}>
                            ${calculateTotal().toFixed(2)}
                        </Text>
                    </View>
                </View>

                <TextInput
                    style={[styles.input, { height: 60 }]}
                    placeholder="Notes (optional)"
                    placeholderTextColor="#555"
                    value={notes}
                    onChangeText={setNotes}
                    multiline
                />

                <TouchableOpacity
                    style={[styles.submitButton, submitting && { opacity: 0.6 }]}
                    onPress={handleCreate}
                    disabled={submitting}
                >
                    {submitting ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <Text style={styles.submitText}>🧾 Create Invoice</Text>
                    )}
                </TouchableOpacity>
            </ScrollView>
        );
    }

    // ─── List View ───
    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <Text style={styles.headerTitle}>Invoices</Text>
                <TouchableOpacity style={styles.newBtn} onPress={() => setView("create")}>
                    <Text style={styles.newBtnText}>+ New</Text>
                </TouchableOpacity>
            </View>

            {loading ? (
                <ActivityIndicator size="large" color="#6C5CE7" style={{ marginTop: 40 }} />
            ) : invoices.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>🧾</Text>
                    <Text style={styles.emptyText}>No invoices yet</Text>
                    <Text style={styles.emptySubtext}>Create your first invoice to get paid</Text>
                </View>
            ) : (
                <FlatList
                    data={invoices}
                    keyExtractor={(inv) => inv.id}
                    contentContainerStyle={styles.listContent}
                    renderItem={({ item: inv }) => (
                        <TouchableOpacity
                            style={styles.invoiceCard}
                            onPress={() => handleStatusAction(inv)}
                            activeOpacity={0.7}
                        >
                            <View style={styles.invoiceRow}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.invoiceName}>{inv.customer_name}</Text>
                                    <Text style={styles.invoiceDate}>
                                        {new Date(inv.created_at).toLocaleDateString()}
                                    </Text>
                                </View>
                                <View style={styles.invoiceRight}>
                                    <Text style={styles.invoiceTotal}>${inv.total}</Text>
                                    <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[inv.status] + "30" }]}>
                                        <Text style={[styles.statusText, { color: STATUS_COLORS[inv.status] }]}>
                                            {inv.status.toUpperCase()}
                                        </Text>
                                    </View>
                                </View>
                            </View>
                        </TouchableOpacity>
                    )}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: "#0A0A1A",
    },
    formContent: {
        padding: 20,
        paddingBottom: 40,
    },
    headerRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 12,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: "800",
        color: "#FFFFFF",
    },
    newBtn: {
        backgroundColor: "#6C5CE7",
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    newBtnText: {
        color: "#fff",
        fontWeight: "700",
        fontSize: 14,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: "800",
        color: "#FFFFFF",
        marginTop: 20,
        marginBottom: 10,
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
        marginBottom: 8,
    },
    lineItemCard: {
        backgroundColor: "#12122A",
        borderRadius: 12,
        padding: 12,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    lineItemRow: {
        flexDirection: "row",
        alignItems: "center",
    },
    removeBtn: {
        marginLeft: 8,
        padding: 8,
    },
    removeBtnText: {
        color: "#E17055",
        fontSize: 18,
        fontWeight: "700",
    },
    addItemBtn: {
        alignItems: "center",
        paddingVertical: 12,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: "#6C5CE7",
        borderStyle: "dashed",
    },
    addItemText: {
        color: "#6C5CE7",
        fontWeight: "700",
        fontSize: 14,
    },
    adjustRow: {
        flexDirection: "row",
    },
    adjustLabel: {
        color: "#888",
        fontSize: 11,
        fontWeight: "600",
        marginBottom: 4,
    },
    totalsCard: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 16,
        marginTop: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    totalRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginVertical: 4,
    },
    totalLabel: {
        color: "#888",
        fontSize: 14,
        fontWeight: "600",
    },
    totalValue: {
        color: "#FFFFFF",
        fontSize: 18,
        fontWeight: "800",
    },
    submitButton: {
        backgroundColor: "#6C5CE7",
        borderRadius: 14,
        paddingVertical: 18,
        alignItems: "center",
        marginTop: 20,
    },
    submitText: {
        color: "#FFFFFF",
        fontSize: 18,
        fontWeight: "800",
    },
    listContent: {
        padding: 16,
        gap: 10,
    },
    invoiceCard: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    invoiceRow: {
        flexDirection: "row",
        alignItems: "center",
    },
    invoiceName: {
        fontSize: 15,
        fontWeight: "700",
        color: "#FFFFFF",
    },
    invoiceDate: {
        fontSize: 12,
        color: "#888",
        marginTop: 2,
    },
    invoiceRight: {
        alignItems: "flex-end",
    },
    invoiceTotal: {
        fontSize: 18,
        fontWeight: "800",
        color: "#FFFFFF",
    },
    statusBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        marginTop: 4,
    },
    statusText: {
        fontSize: 10,
        fontWeight: "800",
        letterSpacing: 0.5,
    },
    emptyContainer: {
        alignItems: "center",
        marginTop: 80,
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
