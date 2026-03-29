/**
 * ItemQuickSheet
 *
 * A bottom-sheet modal that slides up when the user taps any inventory card.
 * — All items:   photo, name, status, pricing, margin %, quantity stepper
 * — Clothing :  per-size variant breakdown with +/– controls and "Add Size"
 *
 * Clothing is detected by matching the item's category against CLOTHING_KEYWORDS.
 * Size inputs are free-text, supporting "S / M / L / XL", "32x32", "10.5", etc.
 */
import { useEffect, useRef, useState } from "react";
import {
    View,
    Text,
    Modal,
    TouchableOpacity,
    TouchableWithoutFeedback,
    StyleSheet,
    Image,
    ScrollView,
    TextInput,
    Animated,
    Alert,
    ActivityIndicator,
    Dimensions,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../../services/api";

// ─── Clothing / Size-variant detection ──────────────────────────────────────
const CLOTHING_KEYWORDS = [
    "clothing", "apparel", "shirt", "pants", "jeans", "dress", "jacket",
    "hoodie", "sweater", "shorts", "shoes", "sneakers", "boots", "sandals",
    "coat", "blazer", "skirt", "leggings", "tracksuit",
];

function isClothingItem(category: string | null): boolean {
    if (!category) return false;
    const lower = category.toLowerCase();
    return CLOTHING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── Margin helpers ──────────────────────────────────────────────────────────
function computeMargin(buy: string | null, sell: string | null): number | null {
    const b = parseFloat(buy ?? "");
    const s = parseFloat(sell ?? "");
    if (isNaN(b) || isNaN(s) || b === 0) return null;
    return ((s - b) / b) * 100;
}

function marginColor(pct: number): string {
    if (pct >= 30) return "#00B894";
    if (pct >= 15) return "#FDCB6E";
    return "#E17055";
}

// ─── Variant helpers ─────────────────────────────────────────────────────────
function getVariants(item: api.InventoryItem): api.SizeVariant[] {
    const v = item.custom_attributes?.variants;
    if (Array.isArray(v)) return v as api.SizeVariant[];
    return [];
}

function totalVariantQty(variants: api.SizeVariant[]): number {
    return variants.reduce((acc, v) => acc + (v.quantity || 0), 0);
}

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

const SCREEN_H = Dimensions.get("window").height;

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
    item: api.InventoryItem | null;
    visible: boolean;
    existingBrands: string[];
    onClose: () => void;
    onItemUpdated: (updated: api.InventoryItem) => void;
    onItemDeleted: (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ItemQuickSheet({
    item,
    visible,
    existingBrands,
    onClose,
    onItemUpdated,
    onItemDeleted,
}: Props) {
    const router = useRouter();
    const slideAnim = useRef(new Animated.Value(SCREEN_H)).current;

    // Local editable state
    const [variants, setVariants] = useState<api.SizeVariant[]>([]);
    const [quantity, setQuantity] = useState(1);
    const [newSize, setNewSize] = useState("");
    const [nameDraft, setNameDraft] = useState("");
    const [editingName, setEditingName] = useState(false);
    const [brandDraft, setBrandDraft] = useState("");
    const [editingBrand, setEditingBrand] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Sync state when item changes
    useEffect(() => {
        if (item) {
            setVariants(getVariants(item));
            setQuantity(item.quantity ?? 1);
            setNewSize("");
            setNameDraft(item.name);
            setEditingName(false);
            setBrandDraft(typeof item.custom_attributes?.brand === "string" ? item.custom_attributes.brand : "");
            setEditingBrand(false);
        }
    }, [item?.id]);

    // Slide animation
    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue: visible ? 0 : SCREEN_H,
            useNativeDriver: true,
            tension: 68,
            friction: 12,
        }).start();
    }, [visible]);

    if (!item) return null;

    const clothing = isClothingItem(item.category);
    const margin = computeMargin(item.buy_price, item.expected_sell_price);
    const dotColor = STATUS_COLORS[item.status] ?? "#636E72";
    const normalizedBrand = brandDraft.trim().toLowerCase();

    // ── Variant helpers ──────────────────────────────────────────────────────
    const adjustVariantQty = (idx: number, delta: number) => {
        setVariants((prev) =>
            prev.map((v, i) =>
                i === idx ? { ...v, quantity: Math.max(0, v.quantity + delta) } : v
            )
        );
    };

    const addVariant = () => {
        const s = newSize.trim();
        if (!s) return;
        if (variants.some((v) => v.size.toLowerCase() === s.toLowerCase())) {
            Alert.alert("Duplicate", "That size already exists.");
            return;
        }
        setVariants((prev) => [...prev, { size: s, quantity: 1 }]);
        setNewSize("");
    };

    const removeVariant = (idx: number) => {
        setVariants((prev) => prev.filter((_, i) => i !== idx));
    };

    // ── Save changes ─────────────────────────────────────────────────────────
    const saveChanges = async () => {
        if (!item) return;
        const trimmedName = nameDraft.trim();
        const trimmedBrand = brandDraft.trim();
        if (!trimmedName) {
            Alert.alert("Required", "Item name cannot be empty.");
            return;
        }
        setSaving(true);
        try {
            const existing = item.custom_attributes ?? {};
            const customAttributes: Record<string, any> = { ...existing };
            if (trimmedBrand) {
                customAttributes.brand = trimmedBrand;
            } else {
                delete customAttributes.brand;
            }

            let updated: api.InventoryItem;
            if (clothing) {
                updated = await api.updateItem(item.id, {
                    name: trimmedName,
                    custom_attributes: { ...customAttributes, variants },
                });
            } else {
                updated = await api.updateItem(item.id, {
                    name: trimmedName,
                    quantity,
                    custom_attributes: customAttributes,
                });
            }
            onItemUpdated(updated);
            onClose();
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to save changes.");
        } finally {
            setSaving(false);
        }
    };

    // ── Delete ───────────────────────────────────────────────────────────────
    const handleDelete = () => {
        Alert.alert(
            "Delete Item",
            `Remove "${item.name}" from inventory?`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                        setDeleting(true);
                        try {
                            await api.deleteItem(item.id);
                            onItemDeleted(item.id);
                            onClose();
                        } catch (err: any) {
                            Alert.alert("Error", err.message || "Failed to delete.");
                        } finally {
                            setDeleting(false);
                        }
                    },
                },
            ]
        );
    };

    const displayQty = clothing ? totalVariantQty(variants) : quantity;

    return (
        <Modal
            visible={visible}
            transparent
            animationType="none"
            onRequestClose={onClose}
        >
            {/* Backdrop */}
            <TouchableWithoutFeedback onPress={onClose}>
                <View style={styles.backdrop} />
            </TouchableWithoutFeedback>

            {/* Sheet */}
            <Animated.View
                style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
            >
                {/* Handle bar */}
                <View style={styles.handle} />

                <ScrollView
                    contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {/* ── Photo + Title ── */}
                    <View style={styles.topRow}>
                        {(item.custom_attributes?.photo_front ?? item.photo_front_url) ? (
                            <Image
                                source={{ uri: (item.custom_attributes?.photo_front ?? item.photo_front_url) as string }}
                                style={styles.photo}
                                resizeMode="cover"
                            />
                        ) : (
                            <View style={[styles.photo, styles.photoPlaceholder]}>
                                <Text style={styles.photoIcon}>📦</Text>
                            </View>
                        )}

                        <View style={styles.titleBlock}>
                            {editingName ? (
                                <TextInput
                                    style={styles.itemNameInput}
                                    value={nameDraft}
                                    onChangeText={setNameDraft}
                                    autoFocus
                                    maxLength={120}
                                    returnKeyType="done"
                                    onSubmitEditing={() => setEditingName(false)}
                                    onBlur={() => setEditingName(false)}
                                    placeholder="Item name"
                                    placeholderTextColor="#666"
                                />
                            ) : (
                                <TouchableOpacity onPress={() => setEditingName(true)} activeOpacity={0.7}>
                                    <Text style={styles.itemName} numberOfLines={3}>
                                        {nameDraft || item.name}
                                    </Text>
                                    <Text style={styles.itemNameHint}>Tap name to rename</Text>
                                </TouchableOpacity>
                            )}
                            {item.category && (
                                <Text style={styles.category}>{item.category}</Text>
                            )}
                            {editingBrand ? (
                                <TextInput
                                    style={styles.brandInput}
                                    value={brandDraft}
                                    onChangeText={setBrandDraft}
                                    autoFocus
                                    maxLength={80}
                                    returnKeyType="done"
                                    onSubmitEditing={() => setEditingBrand(false)}
                                    onBlur={() => setEditingBrand(false)}
                                    placeholder="Brand"
                                    placeholderTextColor="#666"
                                />
                            ) : (
                                <TouchableOpacity onPress={() => setEditingBrand(true)} activeOpacity={0.7}>
                                    <Text style={styles.brandText}>
                                        {brandDraft ? `Brand: ${brandDraft}` : "Brand: Unbranded"}
                                    </Text>
                                    <Text style={styles.brandHint}>Tap to edit brand</Text>
                                </TouchableOpacity>
                            )}
                            <View style={styles.brandChipRow}>
                                <TouchableOpacity
                                    style={[
                                        styles.brandChip,
                                        normalizedBrand === "" && styles.brandChipActive,
                                    ]}
                                    onPress={() => {
                                        setBrandDraft("");
                                        setEditingBrand(false);
                                    }}
                                    activeOpacity={0.8}
                                >
                                    <Text
                                        style={[
                                            styles.brandChipText,
                                            normalizedBrand === "" && styles.brandChipTextActive,
                                        ]}
                                    >
                                        Unbranded
                                    </Text>
                                </TouchableOpacity>

                                {existingBrands.map((brand) => {
                                    const isActive = normalizedBrand === brand.trim().toLowerCase();
                                    return (
                                        <TouchableOpacity
                                            key={brand}
                                            style={[styles.brandChip, isActive && styles.brandChipActive]}
                                            onPress={() => {
                                                setBrandDraft(brand);
                                                setEditingBrand(false);
                                            }}
                                            activeOpacity={0.8}
                                        >
                                            <Text
                                                style={[styles.brandChipText, isActive && styles.brandChipTextActive]}
                                            >
                                                {brand}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                            <View style={styles.statusRow}>
                                <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
                                <Text style={[styles.statusLabel, { color: dotColor }]}>
                                    {item.status.replace("_", " ")}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* ── Pricing ── */}
                    <View style={styles.pricingRow}>
                        <View style={styles.pricingCell}>
                            <Text style={styles.pricingLabel}>Buy Price</Text>
                            <Text style={styles.pricingValue}>
                                {item.buy_price
                                    ? `$${parseFloat(item.buy_price).toFixed(2)}`
                                    : "—"}
                            </Text>
                        </View>
                        <View style={styles.pricingCell}>
                            <Text style={styles.pricingLabel}>Expected</Text>
                            <Text style={[styles.pricingValue, { color: "#00B894" }]}>
                                {item.expected_sell_price
                                    ? `$${parseFloat(item.expected_sell_price).toFixed(2)}`
                                    : "—"}
                            </Text>
                        </View>
                        <View style={styles.pricingCell}>
                            <Text style={styles.pricingLabel}>Margin</Text>
                            {margin !== null ? (
                                <Text
                                    style={[
                                        styles.pricingValue,
                                        { color: marginColor(margin) },
                                    ]}
                                >
                                    {margin >= 0 ? "+" : ""}
                                    {margin.toFixed(1)}%
                                </Text>
                            ) : (
                                <Text style={styles.pricingValue}>—</Text>
                            )}
                        </View>
                    </View>

                    {/* ── Sizes (clothing only) ── */}
                    {clothing ? (
                        <View style={styles.section}>
                            <View style={styles.sectionHeader}>
                                <Text style={styles.sectionTitle}>Sizes</Text>
                                <Text style={styles.sectionSub}>
                                    Total qty: {displayQty}
                                </Text>
                            </View>

                            {variants.length === 0 && (
                                <Text style={styles.emptyVariants}>
                                    No sizes added yet. Add sizes below.
                                </Text>
                            )}

                            {variants.map((v, idx) => (
                                <View key={idx} style={styles.variantRow}>
                                    <Text style={styles.variantSize}>{v.size}</Text>
                                    <View style={styles.qtyControls}>
                                        <TouchableOpacity
                                            style={styles.qtyBtn}
                                            onPress={() => adjustVariantQty(idx, -1)}
                                        >
                                            <Text style={styles.qtyBtnText}>−</Text>
                                        </TouchableOpacity>
                                        <Text style={styles.qtyValue}>{v.quantity}</Text>
                                        <TouchableOpacity
                                            style={styles.qtyBtn}
                                            onPress={() => adjustVariantQty(idx, 1)}
                                        >
                                            <Text style={styles.qtyBtnText}>+</Text>
                                        </TouchableOpacity>
                                    </View>
                                    <TouchableOpacity
                                        style={styles.removeBtn}
                                        onPress={() => removeVariant(idx)}
                                    >
                                        <Text style={styles.removeBtnText}>✕</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}

                            {/* Add new size row */}
                            <View style={styles.addSizeRow}>
                                <TextInput
                                    style={styles.sizeInput}
                                    placeholder='e.g. M, 32x32, 10.5'
                                    placeholderTextColor="#555"
                                    value={newSize}
                                    onChangeText={setNewSize}
                                    onSubmitEditing={addVariant}
                                    returnKeyType="done"
                                />
                                <TouchableOpacity
                                    style={styles.addSizeBtn}
                                    onPress={addVariant}
                                >
                                    <Text style={styles.addSizeBtnText}>+ Add Size</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : (
                        /* ── Quantity (non-clothing) ── */
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>Quantity</Text>
                            <View style={styles.qtyRow}>
                                <TouchableOpacity
                                    style={styles.qtyBtnLarge}
                                    onPress={() => setQuantity((q) => Math.max(0, q - 1))}
                                >
                                    <Text style={styles.qtyBtnLargeText}>−</Text>
                                </TouchableOpacity>
                                <Text style={styles.qtyValueLarge}>{quantity}</Text>
                                <TouchableOpacity
                                    style={styles.qtyBtnLarge}
                                    onPress={() => setQuantity((q) => q + 1)}
                                >
                                    <Text style={styles.qtyBtnLargeText}>+</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {/* ── Action Buttons ── */}
                    <View style={styles.actions}>
                        <TouchableOpacity
                            style={styles.saveBtn}
                            onPress={saveChanges}
                            disabled={saving}
                        >
                            {saving ? (
                                <ActivityIndicator color="#fff" />
                            ) : (
                                <Text style={styles.saveBtnText}>Save Changes</Text>
                            )}
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.editBtn}
                            onPress={() => {
                                onClose();
                                router.push(`/(tabs)/inventory/edit?id=${item.id}`);
                            }}
                        >
                            <Text style={styles.editBtnText}>✏️ Full Edit</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.deleteBtn}
                            onPress={handleDelete}
                            disabled={deleting}
                        >
                            {deleting ? (
                                <ActivityIndicator color="#fff" />
                            ) : (
                                <Text style={styles.deleteBtnText}>Delete</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </ScrollView>
            </Animated.View>
        </Modal>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: "rgba(0,0,0,0.55)",
    },
    sheet: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: "#12122A",
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: SCREEN_H * 0.88,
        paddingBottom: 36,
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: "#3A3A5A",
        borderRadius: 2,
        alignSelf: "center",
        marginTop: 10,
        marginBottom: 4,
    },
    content: {
        padding: 20,
        paddingBottom: 8,
    },

    // Top row
    topRow: {
        flexDirection: "row",
        gap: 14,
        marginBottom: 16,
    },
    photo: {
        width: 90,
        height: 90,
        borderRadius: 12,
        backgroundColor: "#1A1A2E",
    },
    photoPlaceholder: {
        justifyContent: "center",
        alignItems: "center",
    },
    photoIcon: { fontSize: 32 },
    titleBlock: { flex: 1, justifyContent: "center", gap: 4 },
    itemName: { color: "#FFF", fontSize: 16, fontWeight: "800", lineHeight: 20 },
    itemNameInput: {
        color: "#FFF",
        fontSize: 16,
        fontWeight: "800",
        lineHeight: 20,
        backgroundColor: "#1A1A2E",
        borderWidth: 1,
        borderColor: "#2A2A4A",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    itemNameHint: {
        color: "#777",
        fontSize: 10,
        marginTop: 2,
    },
    brandText: {
        color: "#B7B7C7",
        fontSize: 11,
        fontWeight: "700",
        marginTop: 2,
    },
    brandHint: {
        color: "#777",
        fontSize: 10,
        marginTop: 1,
    },
    brandInput: {
        color: "#FFF",
        fontSize: 12,
        fontWeight: "700",
        backgroundColor: "#1A1A2E",
        borderWidth: 1,
        borderColor: "#2A2A4A",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        marginTop: 2,
    },
    brandChipRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 6,
        marginTop: 6,
    },
    brandChip: {
        backgroundColor: "#1A1A2E",
        borderWidth: 1,
        borderColor: "#2A2A4A",
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    brandChipActive: {
        borderColor: "#6C5CE7",
        backgroundColor: "#1E1B3A",
    },
    brandChipText: {
        color: "#B7B7C7",
        fontSize: 11,
        fontWeight: "700",
    },
    brandChipTextActive: {
        color: "#6C5CE7",
    },
    category: { color: "#6C5CE7", fontSize: 11, fontWeight: "600", textTransform: "uppercase" },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusLabel: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },

    // Pricing
    pricingRow: {
        flexDirection: "row",
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 12,
        marginBottom: 16,
        gap: 4,
    },
    pricingCell: { flex: 1, alignItems: "center" },
    pricingLabel: { color: "#777", fontSize: 10, fontWeight: "600", marginBottom: 4, textTransform: "uppercase" },
    pricingValue: { color: "#FFF", fontSize: 15, fontWeight: "700" },

    // Section
    section: {
        marginBottom: 16,
    },
    sectionHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 10,
    },
    sectionTitle: {
        color: "#6C5CE7",
        fontSize: 12,
        fontWeight: "800",
        textTransform: "uppercase",
        letterSpacing: 0.8,
    },
    sectionSub: { color: "#888", fontSize: 11 },
    emptyVariants: { color: "#666", fontSize: 13, textAlign: "center", paddingVertical: 8 },

    // Variant row
    variantRow: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1A1A2E",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginBottom: 6,
    },
    variantSize: { flex: 1, color: "#FFF", fontSize: 14, fontWeight: "700" },
    qtyControls: { flexDirection: "row", alignItems: "center", gap: 10 },
    qtyBtn: {
        width: 30,
        height: 30,
        borderRadius: 8,
        backgroundColor: "#2A2A4A",
        justifyContent: "center",
        alignItems: "center",
    },
    qtyBtnText: { color: "#FFF", fontSize: 18, fontWeight: "700", lineHeight: 22 },
    qtyValue: { color: "#FFF", fontSize: 16, fontWeight: "700", minWidth: 28, textAlign: "center" },
    removeBtn: { marginLeft: 10, padding: 4 },
    removeBtnText: { color: "#E17055", fontSize: 14, fontWeight: "700" },

    // Add size row
    addSizeRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 6,
        alignItems: "center",
    },
    sizeInput: {
        flex: 1,
        backgroundColor: "#1A1A2E",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: "#FFF",
        fontSize: 14,
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    addSizeBtn: {
        backgroundColor: "#6C5CE7",
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    addSizeBtnText: { color: "#FFF", fontSize: 13, fontWeight: "700" },

    // Non-clothing qty stepper
    qtyRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 12,
    },
    qtyBtnLarge: {
        width: 42,
        height: 42,
        borderRadius: 12,
        backgroundColor: "#2A2A4A",
        justifyContent: "center",
        alignItems: "center",
    },
    qtyBtnLargeText: { color: "#FFF", fontSize: 22, fontWeight: "700" },
    qtyValueLarge: { color: "#FFF", fontSize: 28, fontWeight: "800", minWidth: 50, textAlign: "center" },

    // Actions
    actions: { gap: 10, marginTop: 4 },
    saveBtn: {
        backgroundColor: "#6C5CE7",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
    },
    saveBtnText: { color: "#FFF", fontSize: 15, fontWeight: "700" },
    editBtn: {
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    editBtnText: { color: "#CCC", fontSize: 15, fontWeight: "600" },
    deleteBtn: {
        backgroundColor: "#2A1218",
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#E17055",
    },
    deleteBtnText: { color: "#E17055", fontSize: 15, fontWeight: "700" },
});
