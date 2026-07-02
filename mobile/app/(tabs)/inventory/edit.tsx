/**
 * Edit Item Screen
 *
 * Full edit form for an existing inventory item. Pre-populates all fields
 * from the current item data and saves changes via updateItem.
 */
import { useEffect, useRef, useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    Alert,
    ActivityIndicator,
    Modal,
    Image,
    KeyboardAvoidingView,
    Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";
import { ScannerOverlay } from "../../../components/ScannerOverlay";

const CLOTHING_KEYWORDS = [
    "clothing", "apparel", "shirt", "pants", "jeans", "dress", "jacket",
    "hoodie", "sweater", "shorts", "shoes", "sneakers", "boots", "sandals",
    "coat", "blazer", "skirt", "leggings", "tracksuit",
];

function isSizeCategory(cat: string): boolean {
    const lower = cat.toLowerCase();
    return CLOTHING_KEYWORDS.some((kw) => lower.includes(kw));
}

type PhotoSide = "front" | "back";

export default function EditItemScreen() {
    const { back } = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const [loadingItem, setLoadingItem] = useState(Boolean(id));
    const [saving, setSaving] = useState(false);

    // Form state
    const [name, setName] = useState("");
    const [category, setCategory] = useState("");
    const [sku, setSku] = useState("");
    const [upc, setUpc] = useState("");
    const [size, setSize] = useState("");
    const [color, setColor] = useState("");
    const [condition, setCondition] = useState("");
    const [buyPrice, setBuyPrice] = useState("");
    const [expectedPrice, setExpectedPrice] = useState("");
    const [actualPrice, setActualPrice] = useState("");
    const [platform, setPlatform] = useState("");
    const [brand, setBrand] = useState("");

    // Quantity + variants
    const [quantity, setQuantity] = useState(1);
    const [variants, setVariants] = useState<api.SizeVariant[]>([]);
    const [newVariantSize, setNewVariantSize] = useState("");

    // Photo state — URI for display (could be base64 data url or file uri)
    const [frontPhoto, setFrontPhoto] = useState<string | null>(null);
    const [backPhoto, setBackPhoto] = useState<string | null>(null);
    const [frontChanged, setFrontChanged] = useState(false);
    const [backChanged, setBackChanged] = useState(false);

    // Barcode scanner
    const [scannerOpen, setScannerOpen] = useState(false);
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [scanned, setScanned] = useState(false);
    const scanLock = useRef(false);

    // ── Load existing item ──
    useEffect(() => {
        if (!id) {
            Alert.alert("Error", "This item link is missing an inventory ID.");
            back();
            return;
        }
        (async () => {
            try {
                const item = await api.getItem(id);
                setName(item.name ?? "");
                setCategory(item.category ?? "");
                setSku(item.sku ?? "");
                setUpc(item.upc ?? "");
                setSize(item.size ?? "");
                setColor(item.color ?? "");
                setCondition(item.condition ?? "");
                setBuyPrice(item.buy_price ?? "");
                setExpectedPrice(item.expected_sell_price ?? "");
                setActualPrice(item.actual_sell_price ?? "");
                setPlatform(item.platform ?? "");
                setBrand(
                    typeof item.custom_attributes?.brand === "string"
                        ? item.custom_attributes.brand
                        : ""
                );
                setQuantity(item.quantity ?? 1);

                const v = item.custom_attributes?.variants;
                if (Array.isArray(v)) setVariants(v as api.SizeVariant[]);

                // Photos: prefer custom_attributes photos, fallback to url fields
                const photoF = item.photo_front_url;
                const photoB = item.photo_back_url;
                if (photoF) setFrontPhoto(photoF);
                if (photoB) setBackPhoto(photoB);
            } catch (err: any) {
                Alert.alert("Error", err.message || "Failed to load item.");
                back();
            } finally {
                setLoadingItem(false);
            }
        })();
    }, [back, id]);

    // ── Photo picker ──
    const pickPhoto = async (side: PhotoSide) => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== "granted") {
            Alert.alert("Permission Required", "Allow photo access to attach item photos.");
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: Platform.OS !== "web",
            aspect: [1, 1],
            quality: 0.8,
            base64: true,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const dataUrl = asset.base64
                ? `data:image/jpeg;base64,${asset.base64}`
                : asset.uri;
            if (side === "front") { setFrontPhoto(dataUrl); setFrontChanged(true); }
            else { setBackPhoto(dataUrl); setBackChanged(true); }
        }
    };

    const takePhoto = async (side: PhotoSide) => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== "granted") {
            Alert.alert("Permission Required", "Allow camera access to take item photos.");
            return;
        }
        const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
            base64: true,
        });
        if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            const dataUrl = asset.base64
                ? `data:image/jpeg;base64,${asset.base64}`
                : asset.uri;
            if (side === "front") { setFrontPhoto(dataUrl); setFrontChanged(true); }
            else { setBackPhoto(dataUrl); setBackChanged(true); }
        }
    };

    const showPhotoOptions = (side: PhotoSide) => {
        // On web, Alert action sheets don't render multiple buttons — go straight to library picker.
        if (Platform.OS === "web") {
            pickPhoto(side);
            return;
        }
        Alert.alert(
            `${side === "front" ? "Front" : "Back"} Photo`,
            "Choose a source",
            [
                { text: "Camera", onPress: () => takePhoto(side) },
                { text: "Photo Library", onPress: () => pickPhoto(side) },
                { text: "Cancel", style: "cancel" },
            ]
        );
    };

    // ── Barcode scanner ──
    const openScanner = async () => {
        if (!cameraPermission?.granted) {
            const { granted } = await requestCameraPermission();
            if (!granted) {
                Alert.alert("Permission Required", "Allow camera access to scan barcodes.");
                return;
            }
        }
        scanLock.current = false;
        setScanned(false);
        setScannerOpen(true);
    };

    const onBarcodeScanned = ({ data }: { data: string }) => {
        if (scanLock.current) return;
        scanLock.current = true;
        setScanned(true);
        setScannerOpen(false);
        setUpc(data);
    };

    // Variant helpers
    const addVariant = () => {
        const s = newVariantSize.trim();
        if (!s) return;
        if (variants.some((v) => v.size.toLowerCase() === s.toLowerCase())) {
            Alert.alert("Duplicate", "That size is already listed.");
            return;
        }
        setVariants((prev) => [...prev, { size: s, quantity: 1 }]);
        setNewVariantSize("");
    };

    const adjustVariantQty = (idx: number, delta: number) => {
        setVariants((prev) =>
            prev.map((v, i) =>
                i === idx ? { ...v, quantity: Math.max(0, v.quantity + delta) } : v
            )
        );
    };

    const removeVariant = (idx: number) => {
        setVariants((prev) => prev.filter((_, i) => i !== idx));
    };

    // ── Save ──
    const handleSave = async () => {
        if (!id) return;
        if (!name.trim()) {
            Alert.alert("Required", "Item name is required.");
            return;
        }
        setSaving(true);
        try {
            const clothingMode = isSizeCategory(category);
            const totalQty = clothingMode
                ? variants.reduce((acc, v) => acc + v.quantity, 0)
                : quantity;

            const existingAttrs: Record<string, any> = {};

            // Preserve/update brand
            if (brand.trim()) {
                existingAttrs.brand = brand.trim();
            }

            // Preserve/update variants
            if (clothingMode && variants.length > 0) {
                existingAttrs.variants = variants;
            }

            const payload: Partial<api.CreateItemPayload> = {
                name: name.trim(),
                category: category.trim() || undefined,
                sku: sku.trim() || undefined,
                upc: upc.trim() || undefined,
                size: size.trim() || undefined,
                color: color.trim() || undefined,
                condition: condition.trim() || undefined,
                buy_price: buyPrice.trim() || undefined,
                expected_sell_price: expectedPrice.trim() || undefined,
                actual_sell_price: actualPrice.trim() || undefined,
                platform: platform.trim() || undefined,
                quantity: totalQty,
                custom_attributes: existingAttrs,
            };

            const updated = await api.updateItem(id, payload);
            if (frontChanged || backChanged) {
                await api.uploadItemPhotos(
                    updated.id,
                    frontChanged ? frontPhoto : undefined,
                    backChanged ? backPhoto : undefined,
                );
            }

            Alert.alert("✅ Updated", "Item changes saved!", [
                { text: "OK", onPress: back },
            ]);
        } catch (err: any) {
            Alert.alert("Error", err.message || "Failed to update item.");
        } finally {
            setSaving(false);
        }
    };

    if (loadingItem) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: "#0A0A1A" }}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        >
            <ScrollView
                style={styles.container}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                {/* Back button */}
                <TouchableOpacity accessibilityRole="button" style={styles.backBtn} onPress={back}>
                    <Text style={styles.backBtnText}>← Back</Text>
                </TouchableOpacity>

                <Text style={styles.screenTitle}>Edit Item</Text>

                {/* ── Photos ── */}
                <Text style={styles.sectionTitle}>Photos</Text>
                <View style={styles.photoRow}>
                    <TouchableOpacity
                        accessibilityLabel="Edit front photo"
                        accessibilityRole="button"
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("front")}
                    >
                        {frontPhoto ? (
                            <Image source={{ uri: frontPhoto }} style={styles.photoThumb} resizeMode="cover" />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>📸</Text>
                                <Text style={styles.photoLabel}>Front</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                        accessibilityLabel="Edit back photo"
                        accessibilityRole="button"
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("back")}
                    >
                        {backPhoto ? (
                            <Image source={{ uri: backPhoto }} style={styles.photoThumb} resizeMode="cover" />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>📸</Text>
                                <Text style={styles.photoLabel}>Back</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>

                {/* ── Required ── */}
                <Text style={styles.sectionTitle}>Required</Text>
                <Text style={styles.label}>Item Name</Text>
                <TextInput
                    accessibilityLabel="Item Name"
                    style={styles.input}
                    placeholder="e.g. Jordan 1 Retro High OG"
                    placeholderTextColor="#555"
                    value={name}
                    onChangeText={setName}
                />

                {/* ── Details ── */}
                <Text style={styles.sectionTitle}>Details</Text>

                <Text style={styles.label}>Brand</Text>
                <TextInput
                    accessibilityLabel="Brand"
                    style={styles.input}
                    placeholder="Nike, Adidas, etc."
                    placeholderTextColor="#555"
                    value={brand}
                    onChangeText={setBrand}
                />

                <View style={styles.row}>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>Category</Text>
                        <TextInput
                            accessibilityLabel="Category"
                            style={styles.input}
                            placeholder="sneakers"
                            placeholderTextColor="#555"
                            value={category}
                            onChangeText={setCategory}
                            autoCapitalize="none"
                        />
                    </View>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>SKU</Text>
                        <TextInput
                            accessibilityLabel="SKU"
                            style={styles.input}
                            placeholder="SKU-001"
                            placeholderTextColor="#555"
                            value={sku}
                            onChangeText={setSku}
                            autoCapitalize="characters"
                        />
                    </View>
                </View>

                {/* UPC with barcode scan */}
                <Text style={styles.label}>UPC / Barcode</Text>
                <View style={styles.skuRow}>
                    <TextInput
                        accessibilityLabel="UPC or Barcode"
                        style={[styles.input, styles.skuInput]}
                        placeholder="Scan or type barcode"
                        placeholderTextColor="#555"
                        value={upc}
                        onChangeText={setUpc}
                        keyboardType="numeric"
                    />
                    <TouchableOpacity
                        accessibilityLabel="Scan barcode"
                        accessibilityRole="button"
                        style={styles.scanButton}
                        onPress={openScanner}
                    >
                        <Text style={styles.scanButtonText}>🔍</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.row}>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>Size</Text>
                        <TextInput
                            accessibilityLabel="Size"
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
                            accessibilityLabel="Color"
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
                    accessibilityLabel="Condition"
                    style={styles.input}
                    placeholder="new, used, refurbished"
                    placeholderTextColor="#555"
                    value={condition}
                    onChangeText={setCondition}
                />

                {/* ── Pricing ── */}
                <Text style={styles.sectionTitle}>Pricing</Text>
                <View style={styles.row}>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>Buy Price ($)</Text>
                        <TextInput
                            accessibilityLabel="Buy Price"
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
                            accessibilityLabel="Expected Sell Price"
                            style={styles.input}
                            placeholder="0.00"
                            placeholderTextColor="#555"
                            value={expectedPrice}
                            onChangeText={setExpectedPrice}
                            keyboardType="decimal-pad"
                        />
                    </View>
                </View>

                <Text style={styles.label}>Actual Sell Price ($)</Text>
                <TextInput
                    accessibilityLabel="Actual Sell Price"
                    style={styles.input}
                    placeholder="0.00"
                    placeholderTextColor="#555"
                    value={actualPrice}
                    onChangeText={setActualPrice}
                    keyboardType="decimal-pad"
                />

                <Text style={styles.label}>Platform</Text>
                <TextInput
                    accessibilityLabel="Platform"
                    style={styles.input}
                    placeholder="eBay, StockX, Mercari…"
                    placeholderTextColor="#555"
                    value={platform}
                    onChangeText={setPlatform}
                />

                {/* ── Sizes (clothing / footwear) ── */}
                {isSizeCategory(category) && (
                    <>
                        <Text style={styles.sectionTitle}>Sizes & Quantities</Text>
                        <Text style={styles.sizeHint}>
                            Add each size you stock. Any format: S, M, L, XL, 32x32, 10.5…
                        </Text>

                        {variants.map((v, idx) => (
                            <View key={idx} style={styles.variantRow}>
                                <Text style={styles.variantSize}>{v.size}</Text>
                                <View style={styles.qtyControls}>
                                    <TouchableOpacity
                                        accessibilityLabel={`Decrease quantity for ${v.size}`}
                                        accessibilityRole="button"
                                        style={styles.qtyBtn}
                                        onPress={() => adjustVariantQty(idx, -1)}
                                    >
                                        <Text style={styles.qtyBtnText}>−</Text>
                                    </TouchableOpacity>
                                    <Text style={styles.qtyValue}>{v.quantity}</Text>
                                    <TouchableOpacity
                                        accessibilityLabel={`Increase quantity for ${v.size}`}
                                        accessibilityRole="button"
                                        style={styles.qtyBtn}
                                        onPress={() => adjustVariantQty(idx, 1)}
                                    >
                                        <Text style={styles.qtyBtnText}>+</Text>
                                    </TouchableOpacity>
                                </View>
                                <TouchableOpacity
                                    accessibilityLabel={`Remove size ${v.size}`}
                                    accessibilityRole="button"
                                    style={styles.removeBtn}
                                    onPress={() => removeVariant(idx)}
                                >
                                    <Text style={styles.removeBtnText}>✕</Text>
                                </TouchableOpacity>
                            </View>
                        ))}

                        <View style={styles.addSizeRow}>
                            <TextInput
                                accessibilityLabel="New Size"
                                style={styles.sizeInput}
                                placeholder="e.g. M, 32x32, 10.5"
                                placeholderTextColor="#555"
                                value={newVariantSize}
                                onChangeText={setNewVariantSize}
                                onSubmitEditing={addVariant}
                                returnKeyType="done"
                            />
                            <TouchableOpacity
                                accessibilityLabel="Add Size"
                                accessibilityRole="button"
                                style={styles.addSizeBtn}
                                onPress={addVariant}
                            >
                                <Text style={styles.addSizeBtnText}>+ Add Size</Text>
                            </TouchableOpacity>
                        </View>
                        <Text style={styles.sizeHint}>
                            Total units: {variants.reduce((a, v) => a + v.quantity, 0)}
                        </Text>
                    </>
                )}

                {/* ── Quantity (non-size categories) ── */}
                {!isSizeCategory(category) && (
                    <>
                        <Text style={styles.sectionTitle}>Quantity</Text>
                        <View style={styles.qtyRow}>
                            <TouchableOpacity
                                accessibilityLabel="Decrease quantity"
                                accessibilityRole="button"
                                style={styles.qtyBtnLarge}
                                onPress={() => setQuantity((q) => Math.max(0, q - 1))}
                            >
                                <Text style={styles.qtyBtnLargeText}>−</Text>
                            </TouchableOpacity>
                            <Text style={styles.qtyValueLarge}>{quantity}</Text>
                            <TouchableOpacity
                                accessibilityLabel="Increase quantity"
                                accessibilityRole="button"
                                style={styles.qtyBtnLarge}
                                onPress={() => setQuantity((q) => q + 1)}
                            >
                                <Text style={styles.qtyBtnLargeText}>+</Text>
                            </TouchableOpacity>
                        </View>
                    </>
                )}

                {/* ── Save Button ── */}
                <TouchableOpacity
                    accessibilityRole="button"
                    style={[styles.saveButton, saving && { opacity: 0.6 }]}
                    onPress={handleSave}
                    disabled={saving}
                >
                    {saving ? (
                        <ActivityIndicator color="#fff" />
                    ) : (
                        <Text style={styles.saveText}>💾 Save Changes</Text>
                    )}
                </TouchableOpacity>
            </ScrollView>

            {/* ── Barcode Scanner Modal ── */}
            <Modal
                visible={scannerOpen}
                animationType="slide"
                onRequestClose={() => setScannerOpen(false)}
            >
                <View style={styles.scannerContainer}>
                    <CameraView
                        style={StyleSheet.absoluteFill}
                        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
                        barcodeScannerSettings={{
                            barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39"],
                        }}
                    />
                    <ScannerOverlay hint="Point at a barcode to scan" onCancel={() => setScannerOpen(false)} />
                </View>
            </Modal>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0A0A1A" },
    content: { padding: 20, paddingBottom: 50 },
    backBtn: { marginBottom: 8, alignSelf: "flex-start" },
    backBtnText: { color: "#6C5CE7", fontSize: 16, fontWeight: "700" },
    screenTitle: {
        color: "#FFFFFF",
        fontSize: 22,
        fontWeight: "800",
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: "800",
        color: "#6C5CE7",
        marginTop: 22,
        marginBottom: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
    },
    label: { color: "#B7B7C7", fontSize: 12, fontWeight: "600", marginBottom: 4, marginTop: 6 },
    input: {
        backgroundColor: "#1A1A2E",
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: "#FFFFFF",
        fontSize: 15,
        borderWidth: 1,
        borderColor: "#2A2A4A",
        marginBottom: 6,
    },
    row: { flexDirection: "row", gap: 10 },
    halfField: { flex: 1 },
    skuRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    skuInput: { flex: 1 },
    scanButton: {
        backgroundColor: "#6C5CE7",
        borderRadius: 10,
        width: 44,
        height: 44,
        justifyContent: "center",
        alignItems: "center",
        marginBottom: 6,
    },
    scanButtonText: { fontSize: 20 },
    photoRow: { flexDirection: "row", gap: 12, marginBottom: 6 },
    photoSlot: {
        width: 100,
        height: 100,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: "#2A2A4A",
        overflow: "hidden",
        backgroundColor: "#1A1A2E",
    },
    photoThumb: { width: "100%", height: "100%" },
    photoPlaceholder: { flex: 1, justifyContent: "center", alignItems: "center" },
    photoIcon: { fontSize: 28 },
    photoLabel: { color: "#555", fontSize: 11, marginTop: 4 },
    sizeHint: { color: "#888", fontSize: 12, marginBottom: 4 },
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
    addSizeRow: { flexDirection: "row", gap: 8, marginTop: 6, alignItems: "center" },
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
    saveButton: {
        backgroundColor: "#6C5CE7",
        borderRadius: 14,
        paddingVertical: 18,
        alignItems: "center",
        marginTop: 24,
    },
    saveText: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
    scannerContainer: { flex: 1, backgroundColor: "#000" },
    scannerClose: {
        position: "absolute",
        bottom: 60,
        alignSelf: "center",
        backgroundColor: "rgba(0,0,0,0.7)",
        borderRadius: 20,
        paddingHorizontal: 24,
        paddingVertical: 14,
    },
    scannerCloseText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
});
