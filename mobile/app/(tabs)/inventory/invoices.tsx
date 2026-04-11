/**
 * Invoice Creation Screen — Sprint 3 + Sprint 7 enhancements
 *
 * Create invoices with customer info, line items, tax/shipping/discount.
 * Send via email or share a link so the customer can view their invoice.
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
    Modal,
    KeyboardAvoidingView,
    Platform,
    Share,
    Image,
} from "react-native";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
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
    const [viewingInvoice, setViewingInvoice] = useState<api.InvoiceData | null>(null);
    const [isEditingPreview, setIsEditingPreview] = useState(false);
    const [previewSaving, setPreviewSaving] = useState(false);
    const [previewCustomerName, setPreviewCustomerName] = useState("");
    const [previewCustomerEmail, setPreviewCustomerEmail] = useState("");
    const [previewLineItems, setPreviewLineItems] = useState<LineItemDraft[]>([]);
    const [previewTax, setPreviewTax] = useState("");
    const [previewShipping, setPreviewShipping] = useState("");
    const [previewDiscount, setPreviewDiscount] = useState("");
    const [previewNotes, setPreviewNotes] = useState("");
    const [inventorySizeById, setInventorySizeById] = useState<Record<string, string>>({});
    const [sellerUser, setSellerUser] = useState<api.User | null>(null);

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
    const [activeLineIndex, setActiveLineIndex] = useState<number | null>(null);
    const [pickerMode, setPickerMode] = useState<"create" | "preview">("create");

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
        api.getMe().then(setSellerUser).catch(() => {});
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

    const [sendingId, setSendingId] = useState<string | null>(null);

    // ─── Inventory picker modal ───
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerSearch, setPickerSearch] = useState("");
    const [allInventory, setAllInventory] = useState<api.InventoryItem[]>([]);
    const [inventoryLoading, setInventoryLoading] = useState(false);

    const hydrateInvoiceItemSizes = async (invoice: api.InvoiceData) => {
        const ids = Array.from(
            new Set(
                invoice.items
                    .map((i) => i.inventory_item_id)
                    .filter((id): id is string => !!id)
            )
        ).filter((id) => !(id in inventorySizeById));

        if (ids.length === 0) return;

        const entries = await Promise.all(
            ids.map(async (id) => {
                try {
                    const inv = await api.getItem(id);
                    return [id, inv.size ?? ""] as const;
                } catch {
                    return [id, ""] as const;
                }
            })
        );

        setInventorySizeById((prev) => {
            const next = { ...prev };
            for (const [id, size] of entries) next[id] = size;
            return next;
        });
    };

    const openInvoicePreview = (invoice: api.InvoiceData) => {
        setViewingInvoice(invoice);
        setIsEditingPreview(false);
        setPreviewCustomerName(invoice.customer_name);
        setPreviewCustomerEmail(invoice.customer_email ?? "");
        setPreviewLineItems(
            invoice.items.map((item) => ({
                description: item.description,
                quantity: String(item.quantity),
                unit_price: item.unit_price,
                inventory_item_id: item.inventory_item_id ?? undefined,
            }))
        );
        setPreviewTax(invoice.tax ?? "0.00");
        setPreviewShipping(invoice.shipping ?? "0.00");
        setPreviewDiscount(invoice.discount ?? "0.00");
        setPreviewNotes(invoice.notes ?? "");
        hydrateInvoiceItemSizes(invoice);
    };

    const beginPreviewEdit = () => {
        if (!viewingInvoice) return;
        if (viewingInvoice.status === "paid" || viewingInvoice.status === "cancelled") {
            Alert.alert("Locked", "Paid or cancelled invoices cannot be edited.");
            return;
        }
        setIsEditingPreview(true);
    };

    const updatePreviewLineItem = (index: number, field: keyof LineItemDraft, value: string) => {
        setPreviewLineItems((prev) => {
            const updated = [...prev];
            updated[index] = { ...updated[index], [field]: value };
            return updated;
        });
    };

    const addPreviewLineItem = () => {
        setPreviewLineItems((prev) => [...prev, { description: "", quantity: "1", unit_price: "" }]);
    };

    const removePreviewLineItem = (index: number) => {
        if (previewLineItems.length <= 1) return;
        setPreviewLineItems((prev) => prev.filter((_, i) => i !== index));
    };

    const calculatePreviewSubtotal = (): number => {
        return previewLineItems.reduce((sum, item) => {
            const qty = parseInt(item.quantity) || 0;
            const price = parseFloat(item.unit_price) || 0;
            return sum + qty * price;
        }, 0);
    };

    const calculatePreviewTotal = (): number => {
        const sub = calculatePreviewSubtotal();
        return sub
            + (parseFloat(previewTax) || 0)
            + (parseFloat(previewShipping) || 0)
            - (parseFloat(previewDiscount) || 0);
    };

    const savePreviewEdits = async () => {
        if (!viewingInvoice) return;
        if (!previewCustomerName.trim()) {
            Alert.alert("Required", "Customer name is required.");
            return;
        }
        if (previewLineItems.some((li) => !li.description.trim() || !li.unit_price.trim())) {
            Alert.alert("Required", "Fill in all line item descriptions and prices.");
            return;
        }

        setPreviewSaving(true);
        try {
            const updated = await api.updateInvoice(viewingInvoice.id, {
                customer_name: previewCustomerName.trim(),
                customer_email: previewCustomerEmail.trim() || undefined,
                items: previewLineItems.map((li) => ({
                    description: li.description.trim(),
                    quantity: parseInt(li.quantity) || 1,
                    unit_price: li.unit_price.trim(),
                    inventory_item_id: li.inventory_item_id,
                })),
                tax: previewTax.trim() || "0.00",
                shipping: previewShipping.trim() || "0.00",
                discount: previewDiscount.trim() || "0.00",
                notes: previewNotes.trim() || undefined,
            });

            setInvoices((prev) => prev.map((inv) => (inv.id === updated.id ? updated : inv)));
            openInvoicePreview(updated);
            setIsEditingPreview(false);
            Alert.alert("Updated", "Invoice changes were saved.");
        } catch (err: any) {
            Alert.alert("Error", err.message || "Could not update invoice.");
        } finally {
            setPreviewSaving(false);
        }
    };

    const invoiceItemLabel = (item: api.InvoiceItem): string => {
        if (!item.inventory_item_id) return item.description;
        const sz = inventorySizeById[item.inventory_item_id];
        if (!sz) return item.description;
        return `${item.description} (Size: ${sz})`;
    };

    const loadInventory = async () => {
        setInventoryLoading(true);
        try {
            const data = await api.listItems(1, 50);
            setAllInventory(data.items);
        } catch {
            // silently ignore — user can still enter custom
        } finally {
            setInventoryLoading(false);
        }
    };

    const openPicker = (lineIndex?: number, mode: "create" | "preview" = "create") => {
        setActiveLineIndex(lineIndex ?? null);
        setPickerMode(mode);
        setPickerSearch("");
        setPickerOpen(true);
        loadInventory();
    };

    const filteredInventory = allInventory.filter((item) =>
        item.name.toLowerCase().includes(pickerSearch.toLowerCase())
    );

    const selectInventoryItem = (item: api.InventoryItem) => {
        const newLine: LineItemDraft = {
            description: item.name,
            quantity: "1",
            unit_price: item.expected_sell_price ?? "",
            inventory_item_id: item.id,
        };
        if (pickerMode === "preview") {
            if (activeLineIndex !== null) {
                setPreviewLineItems((prev) => {
                    const updated = [...prev];
                    updated[activeLineIndex] = newLine;
                    return updated;
                });
            } else {
                setPreviewLineItems((prev) => [...prev, newLine]);
            }
        } else {
            if (activeLineIndex !== null) {
                const updated = [...lineItems];
                updated[activeLineIndex] = newLine;
                setLineItems(updated);
            } else {
                setLineItems([...lineItems, newLine]);
            }
        }
        setPickerOpen(false);
        setActiveLineIndex(null);
    };

    const addCustomItem = () => {
        if (activeLineIndex !== null) {
            setPickerOpen(false);
            setActiveLineIndex(null);
        } else {
            if (pickerMode === "preview") {
                setPreviewLineItems((prev) => [...prev, { description: "", quantity: "1", unit_price: "" }]);
            } else {
                setLineItems([...lineItems, { description: "", quantity: "1", unit_price: "" }]);
            }
            setPickerOpen(false);
            setActiveLineIndex(null);
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

    // ─── Send invoice — PDF via share sheet, text fallback ───
    const handleSendInvoice = async (inv: api.InvoiceData) => {
        setSendingId(inv.id);
        try {
            let shared = false;
            // Try PDF first
            try {
                const result = await api.exportInvoicePdf(inv.id);
                const pdf_base64 = result?.pdf_base64;
                const filename = result?.filename ?? `invoice-${inv.id.slice(0, 8)}.pdf`;
                if (pdf_base64) {
                    const dir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? "";
                    const fileUri = dir + filename;
                    await FileSystem.writeAsStringAsync(fileUri, pdf_base64, {
                        encoding: "base64" as any,
                    });
                    await Sharing.shareAsync(fileUri, {
                        mimeType: "application/pdf",
                        dialogTitle: `Send Invoice to ${inv.customer_name}`,
                        UTI: "com.adobe.pdf",
                    });
                    shared = true;
                }
            } catch { /* fall through to text share */ }

            // Fallback: native share sheet with text summary
            if (!shared) {
                const lines = inv.items
                    .map((it) => `• ${it.description}  ×${it.quantity}  $${it.line_total}`)
                    .join("\n");
                const msg =
                    `INVOICE #${inv.id.slice(0, 8).toUpperCase()}\n` +
                    `To: ${inv.customer_name}${inv.customer_email ? ` <${inv.customer_email}>` : ""}\n` +
                    `Date: ${new Date(inv.created_at).toLocaleDateString()}\n\n` +
                    `${lines}\n\n` +
                    `Subtotal:  $${inv.subtotal}\n` +
                    (parseFloat(inv.tax ?? "0") > 0 ? `Tax:       $${inv.tax}\n` : "") +
                    (parseFloat(inv.shipping ?? "0") > 0 ? `Shipping:  $${inv.shipping}\n` : "") +
                    (parseFloat(inv.discount ?? "0") > 0 ? `Discount: -$${inv.discount}\n` : "") +
                    `Total:     $${inv.total}`;
                await Share.share(
                    { message: msg, title: `Invoice — ${inv.customer_name}` },
                    { dialogTitle: `Send Invoice to ${inv.customer_name}` }
                );
            }

            if (inv.status === "draft") {
                try {
                    await api.updateInvoiceStatus(inv.id, "sent");
                    fetchInvoices();
                } catch { }
            }
        } catch (err: any) {
            if ((err as any)?.code !== "ENOSHARE") {
                Alert.alert("Error", err.message || "Could not share invoice.");
            }
        } finally {
            setSendingId(null);
        }
    };

    // ─── Create View ───
    if (view === "create") {
        return (
            <View style={{ flex: 1, backgroundColor: "#0A0A1A" }}>
            <ScrollView style={styles.container} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
                {/* Back button */}
                <TouchableOpacity style={styles.backBtn} onPress={() => setView("list")}>
                    <Text style={styles.backBtnText}>← Back</Text>
                </TouchableOpacity>

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
                        {!item.inventory_item_id && (
                            <TouchableOpacity
                                style={styles.linkInventoryBtn}
                                onPress={() => openPicker(i)}
                            >
                                <Text style={styles.linkInventoryText}>📦 Link from inventory</Text>
                            </TouchableOpacity>
                        )}
                        {item.inventory_item_id && (
                            <View style={styles.linkedBadge}>
                                <Text style={styles.linkedBadgeText}>✓ From inventory</Text>
                            </View>
                        )}
                    </View>
                ))}
                <View style={styles.addItemRow}>
                    <TouchableOpacity style={styles.addItemBtnHalf} onPress={() => {
                        setLineItems([...lineItems, { description: "", quantity: "1", unit_price: "" }]);
                    }}>
                        <Text style={styles.addItemText}>✏️ Custom Item</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.addItemBtnHalf} onPress={() => openPicker()}>
                        <Text style={styles.addItemText}>📦 From Inventory</Text>
                    </TouchableOpacity>
                </View>

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

            {/* ─── Shared Inventory Picker Modal ─── */}
            <Modal
                visible={pickerOpen}
                transparent
                animationType="slide"
                onRequestClose={() => setPickerOpen(false)}
            >
                <KeyboardAvoidingView
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                    style={styles.modalOverlay}
                >
                    <View style={styles.modalSheet}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Add Item</Text>
                            <TouchableOpacity onPress={() => setPickerOpen(false)}>
                                <Text style={styles.modalClose}>✕</Text>
                            </TouchableOpacity>
                        </View>

                        <TextInput
                            style={styles.modalSearch}
                            placeholder="Search inventory..."
                            placeholderTextColor="#555"
                            value={pickerSearch}
                            onChangeText={setPickerSearch}
                            autoFocus
                        />

                        <TouchableOpacity style={styles.customItemRow} onPress={addCustomItem}>
                            <Text style={styles.customItemIcon}>✏️</Text>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.customItemTitle}>Custom Item</Text>
                                <Text style={styles.customItemSub}>Enter description & price manually</Text>
                            </View>
                            <Text style={styles.chevron}>›</Text>
                        </TouchableOpacity>

                        <View style={styles.divider} />

                        {inventoryLoading ? (
                            <ActivityIndicator color="#6C5CE7" style={{ marginTop: 20 }} />
                        ) : filteredInventory.length === 0 ? (
                            <Text style={styles.noResultsText}>
                                {pickerSearch ? "No items match your search" : "No inventory items yet"}
                            </Text>
                        ) : (
                            <FlatList
                                data={filteredInventory}
                                keyExtractor={(item) => item.id}
                                style={{ flex: 1 }}
                                keyboardShouldPersistTaps="handled"
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={styles.inventoryRow}
                                        onPress={() => selectInventoryItem(item)}
                                        activeOpacity={0.7}
                                    >
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.inventoryRowName}>{item.name}</Text>
                                            {item.sku && (
                                                <Text style={styles.inventoryRowSub}>SKU: {item.sku}</Text>
                                            )}
                                        </View>
                                        {item.expected_sell_price != null && (
                                            <Text style={styles.inventoryRowPrice}>
                                                ${parseFloat(item.expected_sell_price).toFixed(2)}
                                            </Text>
                                        )}
                                    </TouchableOpacity>
                                )}
                            />
                        )}
                    </View>
                </KeyboardAvoidingView>
            </Modal>
            </View>
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

                            {/* ─── Action buttons ─── */}
                            <View style={styles.actionRow}>
                                <TouchableOpacity
                                    style={styles.actionBtn}
                                    onPress={() => openInvoicePreview(inv)}
                                >
                                    <Text style={styles.actionBtnText}>👁 View</Text>
                                </TouchableOpacity>

                                {/* Send PDF */}
                                <TouchableOpacity
                                    style={[styles.actionBtn, styles.actionBtnSend]}
                                    onPress={() => handleSendInvoice(inv)}
                                    disabled={sendingId === inv.id}
                                >
                                    {sendingId === inv.id ? (
                                        <ActivityIndicator size="small" color="#6C5CE7" />
                                    ) : (
                                        <Text style={styles.actionBtnText}>📤 Send</Text>
                                    )}
                                </TouchableOpacity>
                            </View>
                        </TouchableOpacity>
                    )}
                />
            )}

            <Modal
                visible={!!viewingInvoice}
                transparent
                animationType="slide"
                onRequestClose={() => {
                    setViewingInvoice(null);
                    setIsEditingPreview(false);
                }}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.viewModalSheet}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>{isEditingPreview ? "Edit Invoice" : "Invoice Preview"}</Text>
                            <View style={styles.previewHeaderActions}>
                                {viewingInvoice && !isEditingPreview ? (
                                    <TouchableOpacity style={styles.previewEditBtn} onPress={beginPreviewEdit}>
                                        <Text style={styles.previewEditBtnText}>Edit</Text>
                                    </TouchableOpacity>
                                ) : null}
                                {isEditingPreview ? (
                                    <TouchableOpacity
                                        style={styles.previewCancelBtn}
                                        onPress={() => {
                                            if (viewingInvoice) openInvoicePreview(viewingInvoice);
                                            setIsEditingPreview(false);
                                        }}
                                    >
                                        <Text style={styles.previewCancelBtnText}>Cancel</Text>
                                    </TouchableOpacity>
                                ) : null}
                                <TouchableOpacity onPress={() => {
                                    setViewingInvoice(null);
                                    setIsEditingPreview(false);
                                }}>
                                    <Text style={styles.modalClose}>✕</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        {viewingInvoice && (
                            <ScrollView
                                style={{ maxHeight: "72%" }}
                                contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
                            >
                                {isEditingPreview ? (
                                    <>
                                        <Text style={styles.viewSectionTitle}>Customer</Text>
                                        <TextInput
                                            style={styles.input}
                                            placeholder="Customer Name *"
                                            placeholderTextColor="#555"
                                            value={previewCustomerName}
                                            onChangeText={setPreviewCustomerName}
                                        />
                                        <TextInput
                                            style={styles.input}
                                            placeholder="Email"
                                            placeholderTextColor="#555"
                                            value={previewCustomerEmail}
                                            onChangeText={setPreviewCustomerEmail}
                                            keyboardType="email-address"
                                            autoCapitalize="none"
                                        />

                                        <Text style={styles.viewSectionTitle}>Items</Text>
                                        {previewLineItems.map((item, idx) => (
                                            <View key={`preview-item-${idx}`} style={styles.lineItemCard}>
                                                <TextInput
                                                    style={styles.input}
                                                    placeholder="Description *"
                                                    placeholderTextColor="#555"
                                                    value={item.description}
                                                    onChangeText={(v) => updatePreviewLineItem(idx, "description", v)}
                                                />
                                                <View style={styles.lineItemRow}>
                                                    <TextInput
                                                        style={[styles.input, { flex: 1 }]}
                                                        placeholder="Qty"
                                                        placeholderTextColor="#555"
                                                        value={item.quantity}
                                                        onChangeText={(v) => updatePreviewLineItem(idx, "quantity", v)}
                                                        keyboardType="number-pad"
                                                    />
                                                    <TextInput
                                                        style={[styles.input, { flex: 2, marginLeft: 8 }]}
                                                        placeholder="Unit Price"
                                                        placeholderTextColor="#555"
                                                        value={item.unit_price}
                                                        onChangeText={(v) => updatePreviewLineItem(idx, "unit_price", v)}
                                                        keyboardType="decimal-pad"
                                                    />
                                                    {previewLineItems.length > 1 && (
                                                        <TouchableOpacity style={styles.removeBtn} onPress={() => removePreviewLineItem(idx)}>
                                                            <Text style={styles.removeBtnText}>✕</Text>
                                                        </TouchableOpacity>
                                                    )}
                                                </View>
                                                {!item.inventory_item_id && (
                                                    <TouchableOpacity
                                                        style={styles.linkInventoryBtn}
                                                        onPress={() => openPicker(idx, "preview")}
                                                    >
                                                        <Text style={styles.linkInventoryText}>📦 Link from inventory</Text>
                                                    </TouchableOpacity>
                                                )}
                                                {item.inventory_item_id && (
                                                    <View style={styles.linkedBadge}>
                                                        <Text style={styles.linkedBadgeText}>✓ From inventory</Text>
                                                    </View>
                                                )}
                                            </View>
                                        ))}
                                        <View style={styles.addItemRow}>
                                            <TouchableOpacity style={styles.addItemBtnHalf} onPress={addPreviewLineItem}>
                                                <Text style={styles.addItemText}>✏️ Custom Item</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity style={styles.addItemBtnHalf} onPress={() => openPicker(undefined, "preview")}>
                                                <Text style={styles.addItemText}>📦 From Inventory</Text>
                                            </TouchableOpacity>
                                        </View>

                                        <Text style={styles.viewSectionTitle}>Adjustments</Text>
                                        <View style={styles.adjustRow}>
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.adjustLabel}>Tax</Text>
                                                <TextInput
                                                    style={styles.input}
                                                    placeholder="0.00"
                                                    placeholderTextColor="#555"
                                                    value={previewTax}
                                                    onChangeText={setPreviewTax}
                                                    keyboardType="decimal-pad"
                                                />
                                            </View>
                                            <View style={{ flex: 1, marginLeft: 8 }}>
                                                <Text style={styles.adjustLabel}>Shipping</Text>
                                                <TextInput
                                                    style={styles.input}
                                                    placeholder="0.00"
                                                    placeholderTextColor="#555"
                                                    value={previewShipping}
                                                    onChangeText={setPreviewShipping}
                                                    keyboardType="decimal-pad"
                                                />
                                            </View>
                                            <View style={{ flex: 1, marginLeft: 8 }}>
                                                <Text style={styles.adjustLabel}>Discount</Text>
                                                <TextInput
                                                    style={styles.input}
                                                    placeholder="0.00"
                                                    placeholderTextColor="#555"
                                                    value={previewDiscount}
                                                    onChangeText={setPreviewDiscount}
                                                    keyboardType="decimal-pad"
                                                />
                                            </View>
                                        </View>

                                        <View style={styles.totalsCard}>
                                            <View style={styles.totalRow}>
                                                <Text style={styles.totalLabel}>Subtotal</Text>
                                                <Text style={styles.totalValue}>${calculatePreviewSubtotal().toFixed(2)}</Text>
                                            </View>
                                            <View style={styles.totalRow}>
                                                <Text style={styles.totalLabel}>Total</Text>
                                                <Text style={[styles.totalValue, { color: "#00B894" }]}>${calculatePreviewTotal().toFixed(2)}</Text>
                                            </View>
                                        </View>

                                        <TextInput
                                            style={[styles.input, { height: 60 }]}
                                            placeholder="Notes"
                                            placeholderTextColor="#555"
                                            value={previewNotes}
                                            onChangeText={setPreviewNotes}
                                            multiline
                                        />

                                        <TouchableOpacity
                                            style={[styles.submitButton, previewSaving && { opacity: 0.6 }]}
                                            onPress={savePreviewEdits}
                                            disabled={previewSaving}
                                        >
                                            {previewSaving ? (
                                                <ActivityIndicator color="#fff" />
                                            ) : (
                                                <Text style={styles.submitText}>💾 Save Invoice</Text>
                                            )}
                                        </TouchableOpacity>
                                    </>
                                ) : (
                                    <>
                                        {/* ── Invoice Fly-style branded document ── */}
                                        <View style={styles.invoiceDoc}>

                                            {/* ── Seller branding row ── */}
                                            <View style={styles.invoiceBrandRow}>
                                                {/* Logo / avatar left */}
                                                {sellerUser?.profile_picture ? (
                                                    <Image
                                                        source={{ uri: sellerUser.profile_picture }}
                                                        style={styles.invoiceBrandLogo}
                                                    />
                                                ) : (
                                                    <View style={styles.invoiceBrandLogoPlaceholder}>
                                                        <Text style={styles.invoiceBrandLogoInitial}>
                                                            {(sellerUser?.business_name ?? sellerUser?.email ?? "V")[0].toUpperCase()}
                                                        </Text>
                                                    </View>
                                                )}
                                                {/* Seller info right */}
                                                <View style={styles.invoiceBrandInfo}>
                                                    <Text style={styles.invoiceBrandName}>
                                                        {sellerUser?.business_name ?? sellerUser?.email ?? ""}
                                                    </Text>
                                                    {sellerUser?.email && sellerUser.business_name ? (
                                                        <Text style={styles.invoiceBrandEmail}>{sellerUser.email}</Text>
                                                    ) : null}
                                                </View>
                                            </View>

                                            <View style={styles.invoiceDocDivider} />

                                            {/* ── Two-column: CLIENT left, status badge right ── */}
                                            <View style={styles.invoiceMetaRow}>
                                                <View style={{ flex: 1 }}>
                                                    <Text style={styles.invoiceDocLabel}>CLIENT</Text>
                                                    <Text style={styles.invoiceDocCustomer}>{viewingInvoice.customer_name}</Text>
                                                    {viewingInvoice.customer_email ? (
                                                        <Text style={styles.invoiceDocEmail}>{viewingInvoice.customer_email}</Text>
                                                    ) : null}
                                                </View>
                                                <View style={styles.invoiceMetaRight}>
                                                    <View style={[styles.invoiceDocBadge, { backgroundColor: STATUS_COLORS[viewingInvoice.status] }]}>
                                                        <Text style={styles.invoiceDocBadgeText}>{viewingInvoice.status.toUpperCase()}</Text>
                                                    </View>
                                                </View>
                                            </View>

                                            <View style={styles.invoiceDocDivider} />

                                            {/* ── Line items table ── */}
                                            <View style={styles.invoiceTableHeader}>
                                                <Text style={[styles.invoiceTableHeaderCell, { flex: 3 }]}>DESCRIPTION</Text>
                                                <Text style={[styles.invoiceTableHeaderCell, { flex: 1, textAlign: "center" }]}>QTY</Text>
                                                <Text style={[styles.invoiceTableHeaderCell, { flex: 2, textAlign: "right" }]}>SUBTOTAL</Text>
                                            </View>
                                            {viewingInvoice.items.map((item) => (
                                                <View key={item.id} style={styles.invoiceTableRow}>
                                                    <View style={{ flex: 3 }}>
                                                        <Text style={styles.invoiceTableItemName}>{invoiceItemLabel(item)}</Text>
                                                        <Text style={styles.invoiceTableItemPrice}>${item.unit_price} each</Text>
                                                    </View>
                                                    <Text style={[styles.invoiceTableCell, { flex: 1, textAlign: "center" }]}>{item.quantity}</Text>
                                                    <Text style={[styles.invoiceTableCell, { flex: 2, textAlign: "right", fontWeight: "700" }]}>
                                                        ${item.line_total}
                                                    </Text>
                                                </View>
                                            ))}

                                            <View style={styles.invoiceDocDivider} />

                                            {/* ── Footer: invoice # / date / total (Invoice Fly style) ── */}
                                            <View style={styles.invoiceFooterRow}>
                                                <View style={styles.invoiceFooterCol}>
                                                    <Text style={styles.invoiceDocLabel}>INVOICE NO.</Text>
                                                    <Text style={styles.invoiceFooterVal}>{viewingInvoice.id.slice(0, 8).toUpperCase()}</Text>
                                                </View>
                                                <View style={styles.invoiceFooterCol}>
                                                    <Text style={styles.invoiceDocLabel}>DATE</Text>
                                                    <Text style={styles.invoiceFooterVal}>
                                                        {new Date(viewingInvoice.created_at).toLocaleDateString("en-US", {
                                                            month: "short", day: "numeric", year: "numeric",
                                                        })}
                                                    </Text>
                                                </View>
                                                <View style={[styles.invoiceFooterCol, { alignItems: "flex-end" }]}>
                                                    <Text style={styles.invoiceDocLabel}>TOTAL</Text>
                                                    <Text style={styles.invoiceFooterTotal}>${viewingInvoice.total}</Text>
                                                </View>
                                            </View>

                                            {/* Adjustments breakdown (hidden if all zero) */}
                                            {(parseFloat(viewingInvoice.tax ?? "0") > 0 ||
                                              parseFloat(viewingInvoice.shipping ?? "0") > 0 ||
                                              parseFloat(viewingInvoice.discount ?? "0") > 0) && (
                                                <View style={styles.invoiceAdjustBlock}>
                                                    {parseFloat(viewingInvoice.tax ?? "0") > 0 && (
                                                        <View style={styles.invoiceAdjustRow}>
                                                            <Text style={styles.invoiceAdjustLabel}>Subtotal</Text>
                                                            <Text style={styles.invoiceAdjustVal}>${viewingInvoice.subtotal}</Text>
                                                        </View>
                                                    )}
                                                    {parseFloat(viewingInvoice.tax ?? "0") > 0 && (
                                                        <View style={styles.invoiceAdjustRow}>
                                                            <Text style={styles.invoiceAdjustLabel}>Tax</Text>
                                                            <Text style={styles.invoiceAdjustVal}>${viewingInvoice.tax}</Text>
                                                        </View>
                                                    )}
                                                    {parseFloat(viewingInvoice.shipping ?? "0") > 0 && (
                                                        <View style={styles.invoiceAdjustRow}>
                                                            <Text style={styles.invoiceAdjustLabel}>Shipping</Text>
                                                            <Text style={styles.invoiceAdjustVal}>${viewingInvoice.shipping}</Text>
                                                        </View>
                                                    )}
                                                    {parseFloat(viewingInvoice.discount ?? "0") > 0 && (
                                                        <View style={styles.invoiceAdjustRow}>
                                                            <Text style={styles.invoiceAdjustLabel}>Discount</Text>
                                                            <Text style={styles.invoiceAdjustVal}>−${viewingInvoice.discount}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                            )}

                                            {viewingInvoice.notes ? (
                                                <>
                                                    <View style={styles.invoiceDocDivider} />
                                                    <Text style={[styles.invoiceDocLabel, { paddingHorizontal: 20 }]}>NOTES</Text>
                                                    <Text style={styles.invoiceDocNotes}>{viewingInvoice.notes}</Text>
                                                </>
                                            ) : null}

                                            {/* Bottom accent bar */}
                                            <View style={styles.invoiceDocBar} />
                                        </View>
                                    </>
                                )}
                            </ScrollView>
                        )}
                        {viewingInvoice && !isEditingPreview && (
                            <View style={styles.modalSendRow}>
                                <TouchableOpacity
                                    style={styles.modalSendBtn}
                                    onPress={() => handleSendInvoice(viewingInvoice)}
                                    disabled={sendingId === viewingInvoice.id}
                                >
                                    {sendingId === viewingInvoice.id ? (
                                        <ActivityIndicator color="#fff" size="small" />
                                    ) : (
                                        <Text style={styles.modalSendBtnText}>↑  Share Invoice</Text>
                                    )}
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                </View>
            </Modal>

            {/* ─── Shared Inventory Picker Modal (for preview edit) ─── */}
            <Modal
                visible={pickerOpen}
                transparent
                animationType="slide"
                onRequestClose={() => setPickerOpen(false)}
            >
                <KeyboardAvoidingView
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                    style={styles.modalOverlay}
                >
                    <View style={styles.modalSheet}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.modalTitle}>Add Item</Text>
                            <TouchableOpacity onPress={() => setPickerOpen(false)}>
                                <Text style={styles.modalClose}>✕</Text>
                            </TouchableOpacity>
                        </View>

                        <TextInput
                            style={styles.modalSearch}
                            placeholder="Search inventory..."
                            placeholderTextColor="#555"
                            value={pickerSearch}
                            onChangeText={setPickerSearch}
                            autoFocus
                        />

                        <TouchableOpacity style={styles.customItemRow} onPress={addCustomItem}>
                            <Text style={styles.customItemIcon}>✏️</Text>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.customItemTitle}>Custom Item</Text>
                                <Text style={styles.customItemSub}>Enter description & price manually</Text>
                            </View>
                            <Text style={styles.chevron}>›</Text>
                        </TouchableOpacity>

                        <View style={styles.divider} />

                        {inventoryLoading ? (
                            <ActivityIndicator color="#6C5CE7" style={{ marginTop: 20 }} />
                        ) : filteredInventory.length === 0 ? (
                            <Text style={styles.noResultsText}>
                                {pickerSearch ? "No items match your search" : "No inventory items yet"}
                            </Text>
                        ) : (
                            <FlatList
                                data={filteredInventory}
                                keyExtractor={(item) => item.id}
                                style={{ flex: 1 }}
                                keyboardShouldPersistTaps="handled"
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={styles.inventoryRow}
                                        onPress={() => selectInventoryItem(item)}
                                        activeOpacity={0.7}
                                    >
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.inventoryRowName}>{item.name}</Text>
                                            {item.sku && (
                                                <Text style={styles.inventoryRowSub}>SKU: {item.sku}</Text>
                                            )}
                                        </View>
                                        {item.expected_sell_price != null && (
                                            <Text style={styles.inventoryRowPrice}>
                                                ${parseFloat(item.expected_sell_price).toFixed(2)}
                                            </Text>
                                        )}
                                    </TouchableOpacity>
                                )}
                            />
                        )}
                    </View>
                </KeyboardAvoidingView>
            </Modal>
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
    backBtn: {
        marginBottom: 8,
        alignSelf: "flex-start",
    },
    backBtnText: {
        color: "#6C5CE7",
        fontSize: 16,
        fontWeight: "700",
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
    addItemRow: {
        flexDirection: "row",
        gap: 8,
    },
    addItemBtnHalf: {
        flex: 1,
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
    linkInventoryBtn: {
        marginTop: 4,
        alignSelf: "flex-start",
    },
    linkInventoryText: {
        color: "#6C5CE7",
        fontSize: 12,
        fontWeight: "600",
    },
    linkedBadge: {
        marginTop: 4,
        alignSelf: "flex-start",
        backgroundColor: "#00B89420",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
    },
    linkedBadgeText: {
        color: "#00B894",
        fontSize: 11,
        fontWeight: "700",
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
    actionRow: {
        flexDirection: "row",
        marginTop: 12,
        gap: 6,
    },
    actionBtn: {
        flex: 1,
        alignItems: "center",
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        backgroundColor: "#12122A",
    },
    actionBtnSend: {
        borderColor: "#6C5CE7",
    },
    actionBtnText: {
        color: "#CCC",
        fontWeight: "600",
        fontSize: 11,
    },
    viewModalSheet: {
        backgroundColor: "#12122A",
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: 24,
        maxHeight: "92%",
    },
    // ── Invoice Fly-style branded document ──
    invoiceDoc: {
        backgroundColor: "#FFFFFF",
        borderRadius: 12,
        overflow: "hidden",
        marginTop: 4,
        borderWidth: 1,
        borderColor: "#E8E8EE",
    },
    // Seller branding
    invoiceBrandRow: {
        flexDirection: "row",
        alignItems: "center",
        padding: 20,
        paddingBottom: 0,
        gap: 14,
    },
    invoiceBrandLogo: {
        width: 52,
        height: 52,
        borderRadius: 8,
        backgroundColor: "#1A1A2E",
    },
    invoiceBrandLogoPlaceholder: {
        width: 52,
        height: 52,
        borderRadius: 8,
        backgroundColor: "#1A1A2E",
        justifyContent: "center",
        alignItems: "center",
    },
    invoiceBrandLogoInitial: {
        color: "#FFF",
        fontSize: 22,
        fontWeight: "900",
    },
    invoiceBrandInfo: {
        flex: 1,
    },
    invoiceBrandName: {
        fontSize: 15,
        fontWeight: "700",
        color: "#1A1A2E",
    },
    invoiceBrandEmail: {
        fontSize: 12,
        color: "#777",
        marginTop: 2,
    },
    // Meta row
    invoiceMetaRow: {
        flexDirection: "row",
        paddingHorizontal: 20,
        alignItems: "flex-start",
    },
    invoiceMetaRight: {
        alignItems: "flex-end",
        paddingTop: 2,
    },
    invoiceDocDivider: {
        height: 1,
        backgroundColor: "#ECECF2",
        marginHorizontal: 20,
        marginVertical: 14,
    },
    invoiceDocLabel: {
        fontSize: 9,
        fontWeight: "800",
        color: "#AAA",
        letterSpacing: 1.5,
        marginBottom: 5,
        textTransform: "uppercase",
    },
    invoiceDocCustomer: {
        fontSize: 15,
        fontWeight: "700",
        color: "#1A1A2E",
        marginBottom: 2,
    },
    invoiceDocEmail: {
        fontSize: 12,
        color: "#555",
    },
    invoiceDocBadge: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
    },
    invoiceDocBadgeText: {
        color: "#FFF",
        fontSize: 10,
        fontWeight: "800",
        letterSpacing: 0.5,
    },
    // Table
    invoiceTableHeader: {
        flexDirection: "row",
        paddingHorizontal: 20,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#ECECF2",
        marginBottom: 4,
    },
    invoiceTableHeaderCell: {
        fontSize: 9,
        fontWeight: "800",
        color: "#AAA",
        letterSpacing: 1,
        textTransform: "uppercase",
    },
    invoiceTableRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderBottomWidth: 1,
        borderBottomColor: "#F4F4F8",
    },
    invoiceTableItemName: {
        fontSize: 13,
        fontWeight: "700",
        color: "#1A1A2E",
    },
    invoiceTableItemPrice: {
        fontSize: 11,
        color: "#999",
        marginTop: 1,
    },
    invoiceTableCell: {
        fontSize: 13,
        color: "#444",
    },
    // Footer row (Invoice No. / Date / Total)
    invoiceFooterRow: {
        flexDirection: "row",
        paddingHorizontal: 20,
        justifyContent: "space-between",
        alignItems: "flex-end",
    },
    invoiceFooterCol: {
        flex: 1,
    },
    invoiceFooterVal: {
        fontSize: 13,
        fontWeight: "600",
        color: "#333",
    },
    invoiceFooterTotal: {
        fontSize: 22,
        fontWeight: "900",
        color: "#6C5CE7",
        textAlign: "right",
    },
    // Adjustments
    invoiceAdjustBlock: {
        paddingHorizontal: 20,
        marginTop: 10,
        gap: 4,
    },
    invoiceAdjustRow: {
        flexDirection: "row",
        justifyContent: "space-between",
    },
    invoiceAdjustLabel: {
        fontSize: 12,
        color: "#888",
    },
    invoiceAdjustVal: {
        fontSize: 12,
        color: "#555",
        fontWeight: "600",
    },
    invoiceDocNotes: {
        fontSize: 12,
        color: "#666",
        lineHeight: 18,
        paddingHorizontal: 20,
    },
    // Bottom bar
    invoiceDocBar: {
        height: 8,
        backgroundColor: "#1A1A2E",
        marginTop: 20,
    },
    // ── Modal send footer ──
    modalSendRow: {
        paddingHorizontal: 20,
        paddingTop: 10,
        paddingBottom: 4,
        borderTopWidth: 1,
        borderTopColor: "#1E1E3A",
    },
    modalSendBtn: {
        backgroundColor: "#6C5CE7",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
    },
    modalSendBtnText: {
        color: "#FFF",
        fontSize: 15,
        fontWeight: "800",
        letterSpacing: 0.3,
    },
    viewSectionTitle: {
        fontSize: 13,
        fontWeight: "800",
        color: "#6C5CE7",
        marginTop: 12,
        marginBottom: 8,
        textTransform: "uppercase",
        letterSpacing: 0.5,
    },
    viewLineRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: "#1E1E3A",
    },
    // ─── Modal styles ───
    modalOverlay: {
        flex: 1,
        justifyContent: "flex-end",
        backgroundColor: "rgba(0,0,0,0.6)",
    },
    modalSheet: {
        backgroundColor: "#12122A",
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingBottom: 34,
        maxHeight: "80%",
    },
    modalHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: "800",
        color: "#FFFFFF",
    },
    modalClose: {
        fontSize: 18,
        color: "#888",
        paddingLeft: 16,
    },
    previewHeaderActions: {
        flexDirection: "row",
        alignItems: "center",
    },
    previewEditBtn: {
        borderWidth: 1,
        borderColor: "#6C5CE7",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 4,
        marginRight: 8,
        backgroundColor: "#1E1B3A",
    },
    previewEditBtnText: {
        color: "#A69BFF",
        fontSize: 12,
        fontWeight: "700",
    },
    previewCancelBtn: {
        borderWidth: 1,
        borderColor: "#2A2A4A",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 4,
        marginRight: 8,
        backgroundColor: "#1A1A2E",
    },
    previewCancelBtnText: {
        color: "#CCC",
        fontSize: 12,
        fontWeight: "700",
    },
    modalSearch: {
        backgroundColor: "#1A1A2E",
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: "#FFFFFF",
        fontSize: 15,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        marginHorizontal: 20,
        marginBottom: 12,
    },
    customItemRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 20,
        paddingVertical: 14,
    },
    customItemIcon: {
        fontSize: 22,
        marginRight: 12,
    },
    customItemTitle: {
        color: "#FFFFFF",
        fontSize: 15,
        fontWeight: "700",
    },
    customItemSub: {
        color: "#888",
        fontSize: 12,
        marginTop: 2,
    },
    chevron: {
        color: "#555",
        fontSize: 22,
        fontWeight: "300",
    },
    divider: {
        height: 1,
        backgroundColor: "#2A2A4A",
        marginHorizontal: 20,
        marginBottom: 8,
    },
    noResultsText: {
        color: "#888",
        textAlign: "center",
        marginTop: 24,
        fontSize: 14,
    },
    inventoryRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 20,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: "#1E1E3A",
    },
    inventoryRowName: {
        color: "#FFFFFF",
        fontSize: 15,
        fontWeight: "600",
    },
    inventoryRowSub: {
        color: "#888",
        fontSize: 12,
        marginTop: 2,
    },
    inventoryRowPrice: {
        color: "#00B894",
        fontSize: 16,
        fontWeight: "800",
        marginLeft: 12,
    },
});
