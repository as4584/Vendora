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
import { useEffect, useState } from "react";
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
    Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as api from "../../../../services/api";

import { COLORS } from "../../../../theme/tokens";
import { Button, IconButton } from "../../../../components/Button";
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
    if (pct >= 30) return "#4CC38A";
    if (pct >= 15) return "#E5B04A";
    return "#E5584D";
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
    in_stock: "#4CC38A",
    listed: "#0984E3",
    sold: "#E5584D",
    shipped: "#E5B04A",
    paid: COLORS.primary,
    archived: "#8C8C96",
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
export default function ItemQuickSheet(props: Props) {
    return <ItemQuickSheetContent key={props.item?.id ?? "empty"} {...props} />;
}

function ItemQuickSheetContent({
    item,
    visible,
    existingBrands,
    onClose,
    onItemUpdated,
    onItemDeleted,
}: Props) {
    const router = useRouter();
    const [slideAnim] = useState(() => new Animated.Value(SCREEN_H));

    // Local editable state
    const [variants, setVariants] = useState<api.SizeVariant[]>(() => item ? getVariants(item) : []);
    const [quantity, setQuantity] = useState(item?.quantity ?? 1);
    const [newSize, setNewSize] = useState("");
    const [nameDraft, setNameDraft] = useState(item?.name ?? "");
    const [editingName, setEditingName] = useState(false);
    const [brandDraft, setBrandDraft] = useState(
        typeof item?.custom_attributes?.brand === "string" ? item.custom_attributes.brand : ""
    );
    const [editingBrand, setEditingBrand] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Slide animation
    useEffect(() => {
        Animated.spring(slideAnim, {
            toValue: visible ? 0 : SCREEN_H,
            useNativeDriver: true,
            tension: 68,
            friction: 12,
        }).start();
    }, [slideAnim, visible]);

    if (!item) return null;

    const clothing = isClothingItem(item.category);
    const margin = computeMargin(item.buy_price, item.expected_sell_price);
    const dotColor = STATUS_COLORS[item.status] ?? "#8C8C96";
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
                    expected_quantity: item.quantity ?? undefined,
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
                                <Ionicons name="image-outline" size={26} color="#8C8C96" />
                            </View>
                        )}

                        <View style={styles.titleBlock}>
                            {editingName ? (
                                <TextInput
                                    accessibilityLabel="Item Name"
                                    style={styles.itemNameInput}
                                    value={nameDraft}
                                    onChangeText={setNameDraft}
                                    autoFocus
                                    maxLength={120}
                                    returnKeyType="done"
                                    onSubmitEditing={() => setEditingName(false)}
                                    onBlur={() => setEditingName(false)}
                                    placeholder="Item name"
                                    placeholderTextColor="#8C8C96"
                                />
                            ) : (
                                <TouchableOpacity
                                    accessibilityLabel="Edit item name"
                                    accessibilityRole="button"
                                    onPress={() => setEditingName(true)}
                                    activeOpacity={0.7}
                                >
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
                                    accessibilityLabel="Brand"
                                    style={styles.brandInput}
                                    value={brandDraft}
                                    onChangeText={setBrandDraft}
                                    autoFocus
                                    maxLength={80}
                                    returnKeyType="done"
                                    onSubmitEditing={() => setEditingBrand(false)}
                                    onBlur={() => setEditingBrand(false)}
                                    placeholder="Brand"
                                    placeholderTextColor="#8C8C96"
                                />
                            ) : (
                                <TouchableOpacity
                                    accessibilityLabel="Edit brand"
                                    accessibilityRole="button"
                                    onPress={() => setEditingBrand(true)}
                                    activeOpacity={0.7}
                                >
                                    <Text style={styles.brandText}>
                                        {brandDraft ? `Brand: ${brandDraft}` : "Brand: Unbranded"}
                                    </Text>
                                    <Text style={styles.brandHint}>Tap to edit brand</Text>
                                </TouchableOpacity>
                            )}
                            <View style={styles.brandChipRow}>
                                <TouchableOpacity
                                    accessibilityLabel="Set brand to unbranded"
                                    accessibilityRole="button"
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
                                            accessibilityLabel={`Set brand to ${brand}`}
                                            accessibilityRole="button"
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
                            <Text style={[styles.pricingValue, { color: "#4CC38A" }]}>
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
                                        <IconButton icon="remove" label={`Decrease quantity for ${v.size}`} onPress={() => adjustVariantQty(idx, -1)} />
                                        <Text style={styles.qtyValue}>{v.quantity}</Text>
                                        <IconButton icon="add" label={`Increase quantity for ${v.size}`} onPress={() => adjustVariantQty(idx, 1)} />
                                    </View>
                                    <IconButton icon="close" label={`Remove size ${v.size}`} onPress={() => removeVariant(idx)} />
                                </View>
                            ))}

                            {/* Add new size row */}
                            <View style={styles.addSizeRow}>
                                <TextInput
                                    accessibilityLabel="New Size"
                                    style={styles.sizeInput}
                                    placeholder='e.g. M, 32x32, 10.5'
                                    placeholderTextColor="#8C8C96"
                                    value={newSize}
                                    onChangeText={setNewSize}
                                    onSubmitEditing={addVariant}
                                    returnKeyType="done"
                                />
                                <Button label="+ Add Size" variant="secondary" size="sm" onPress={addVariant} accessibilityLabel="Add Size" />
                            </View>
                        </View>
                    ) : (
                        /* ── Quantity (non-clothing) ── */
                        <View style={styles.section}>
                            <Text style={styles.sectionTitle}>Quantity</Text>
                            <View style={styles.qtyRow}>
                                <IconButton icon="remove" label="Decrease quantity" onPress={() => setQuantity((q) => Math.max(0, q - 1))} />
                                <Text style={styles.qtyValueLarge}>{quantity}</Text>
                                <IconButton icon="add" label="Increase quantity" onPress={() => setQuantity((q) => q + 1)} />
                            </View>
                        </View>
                    )}

                    {/* ── Action Buttons ── */}
                    <View style={styles.actions}>
                        <Button label="Save Changes" variant="primary" size="lg" fullWidth onPress={saveChanges} disabled={saving} loading={saving} />

                        <Button
                            label="Full Edit"
                            variant="secondary"
                            size="lg"
                            fullWidth
                            leadingIcon="create-outline"
                            onPress={() => {
                                onClose();
                                router.push(`/(tabs)/inventory/edit?id=${item.id}`);
                            }}
                        />

                        <Button label="Delete" variant="destructive" size="lg" fullWidth onPress={handleDelete} disabled={deleting} loading={deleting} />
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
        backgroundColor: "#141418",
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        maxHeight: SCREEN_H * 0.88,
        paddingBottom: 36,
    },
    handle: {
        width: 40,
        height: 4,
        backgroundColor: "#2C2C34",
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
        backgroundColor: "#1C1C22",
    },
    photoPlaceholder: {
        justifyContent: "center",
        alignItems: "center",
    },
    photoIcon: { fontSize: 32 },
    titleBlock: { flex: 1, justifyContent: "center", gap: 4 },
    itemName: { color: "#FFF", fontSize: 16, fontWeight: "600", lineHeight: 20 },
    itemNameInput: {
        color: "#FFF",
        fontSize: 16,
        fontWeight: "600",
        lineHeight: 20,
        backgroundColor: "#1C1C22",
        borderWidth: 1,
        borderColor: "#2C2C34",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    itemNameHint: {
        color: "#8C8C96",
        fontSize: 10,
        marginTop: 2,
    },
    brandText: {
        color: "#A6A6B0",
        fontSize: 11,
        fontWeight: "600",
        marginTop: 2,
    },
    brandHint: {
        color: "#8C8C96",
        fontSize: 10,
        marginTop: 1,
    },
    brandInput: {
        color: "#FFF",
        fontSize: 12,
        fontWeight: "600",
        backgroundColor: "#1C1C22",
        borderWidth: 1,
        borderColor: "#2C2C34",
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
        backgroundColor: "#1C1C22",
        borderWidth: 1,
        borderColor: "#2C2C34",
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    brandChipActive: {
        borderColor: COLORS.primary,
        backgroundColor: "#24203A",
    },
    brandChipText: {
        color: "#A6A6B0",
        fontSize: 11,
        fontWeight: "600",
    },
    brandChipTextActive: {
        color: COLORS.primary,
    },
    category: { color: COLORS.primary, fontSize: 11, fontWeight: "600" },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusLabel: { fontSize: 11, fontWeight: "600" },

    // Pricing
    pricingRow: {
        flexDirection: "row",
        backgroundColor: "#1C1C22",
        borderRadius: 12,
        padding: 12,
        marginBottom: 16,
        gap: 4,
    },
    pricingCell: { flex: 1, alignItems: "center" },
    pricingLabel: { color: "#8C8C96", fontSize: 10, fontWeight: "600", marginBottom: 4 },
    pricingValue: { color: "#FFF", fontSize: 15, fontWeight: "600" },

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
        color: COLORS.text,
        fontSize: 17,
        fontWeight: "600",
    },
    sectionSub: { color: "#A6A6B0", fontSize: 11 },
    emptyVariants: { color: "#8C8C96", fontSize: 13, textAlign: "center", paddingVertical: 8 },

    // Variant row
    variantRow: {
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1C1C22",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginBottom: 6,
    },
    variantSize: { flex: 1, color: "#FFF", fontSize: 14, fontWeight: "600" },
    qtyControls: { flexDirection: "row", alignItems: "center", gap: 10 },
    qtyBtn: {
        width: 30,
        height: 30,
        borderRadius: 8,
        backgroundColor: "#2C2C34",
        justifyContent: "center",
        alignItems: "center",
    },
    qtyBtnText: { color: "#FFF", fontSize: 18, fontWeight: "600", lineHeight: 22 },
    qtyValue: { color: "#FFF", fontSize: 16, fontWeight: "600", minWidth: 28, textAlign: "center" },
    removeBtn: { marginLeft: 10, padding: 4 },
    removeBtnText: { color: "#E5584D", fontSize: 14, fontWeight: "600" },

    // Add size row
    addSizeRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 6,
        alignItems: "center",
    },
    sizeInput: {
        flex: 1,
        backgroundColor: "#1C1C22",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: "#FFF",
        fontSize: 14,
        borderWidth: 1,
        borderColor: "#2C2C34",
    },
    addSizeBtn: {
        backgroundColor: COLORS.primary,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    addSizeBtnText: { color: "#FFF", fontSize: 13, fontWeight: "600" },

    // Non-clothing qty stepper
    qtyRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        backgroundColor: "#1C1C22",
        borderRadius: 12,
        padding: 12,
    },
    qtyBtnLarge: {
        width: 42,
        height: 42,
        borderRadius: 12,
        backgroundColor: "#2C2C34",
        justifyContent: "center",
        alignItems: "center",
    },
    qtyBtnLargeText: { color: "#FFF", fontSize: 22, fontWeight: "600" },
    qtyValueLarge: { color: "#FFF", fontSize: 28, fontWeight: "600", minWidth: 50, textAlign: "center" },

    // Actions
    actions: { gap: 10, marginTop: 4 },
    saveBtn: {
        backgroundColor: COLORS.primary,
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
    },
    saveBtnText: { color: "#FFF", fontSize: 15, fontWeight: "600" },
    editBtn: {
        backgroundColor: "#1C1C22",
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#2C2C34",
    },
    editBtnText: { color: "#CCC", fontSize: 15, fontWeight: "600" },
    deleteBtn: {
        backgroundColor: "#33191A",
        borderRadius: 12,
        paddingVertical: 13,
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#E5584D",
    },
    deleteBtnText: { color: "#E5584D", fontSize: 15, fontWeight: "600" },
});
