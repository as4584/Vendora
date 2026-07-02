/**
 * Add Item Screen
 *
 * Form for creating a new inventory item with:
 *  â€¢ Front/back photo picker (expo-image-picker)
 *  â€¢ Barcode scanner modal (expo-camera)
 *  â€¢ Auto-SKU generator
 */
import { useRef, useState } from "react";
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
    Dimensions,
    KeyboardAvoidingView,
    Platform,
} from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";
import { ScannerOverlay } from "../../../components/ScannerOverlay";

const CATEGORY_PREFIXES: Record<string, string> = {
    sneakers: "SNK",
    clothing: "CLO",
    electronics: "ELC",
    accessories: "ACC",
    collectibles: "COL",
    books: "BKS",
    toys: "TOY",
    other: "OTH",
};

// Categories that unlock per-size variant entry
const CLOTHING_KEYWORDS = [
    "clothing", "apparel", "shirt", "pants", "jeans", "dress", "jacket",
    "hoodie", "sweater", "shorts", "shoes", "sneakers", "boots", "sandals",
    "coat", "blazer", "skirt", "leggings", "tracksuit",
];

function isSizeCategory(cat: string): boolean {
    const lower = cat.toLowerCase();
    return CLOTHING_KEYWORDS.some((kw) => lower.includes(kw));
}

function generateSKU(category: string): string {
    const prefix = CATEGORY_PREFIXES[category.toLowerCase()] ?? "VND";
    const ts = Date.now().toString(36).toUpperCase().slice(-5);
    const rand = Math.random().toString(36).substring(2, 4).toUpperCase();
    return `${prefix}-${ts}${rand}`;
}

type PhotoSide = "front" | "back";

export default function AddItemScreen() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);

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
    const [platform, setPlatform] = useState("");
    const [vendorName, setVendorName] = useState("");
    const [notes, setNotes] = useState("");

    // Quantity + variants
    const [quantity, setQuantity] = useState(1);
    const [variants, setVariants] = useState<api.SizeVariant[]>([]);
    const [newVariantSize, setNewVariantSize] = useState("");

    // Photo state
    const [frontPhoto, setFrontPhoto] = useState<string | null>(null);
    const [backPhoto, setBackPhoto] = useState<string | null>(null);

    // Barcode scanner
    const [scannerOpen, setScannerOpen] = useState(false);
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [scanned, setScanned] = useState(false);
    const scanLock = useRef(false);

    // â”€â”€ Photo picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            if (side === "front") setFrontPhoto(dataUrl);
            else setBackPhoto(dataUrl);
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
            if (side === "front") setFrontPhoto(dataUrl);
            else setBackPhoto(dataUrl);
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

    // â”€â”€ Barcode scanner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        Alert.alert("Barcode Scanned", `UPC: ${data}`);
    };

    // â”€â”€ Auto-SKU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleAutoSKU = () => {
        setSku(generateSKU(category || "other"));
    };

    // Variant helpers (clothing / size categories)
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

    // â”€â”€ Submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleSubmit = async () => {
        if (!name.trim()) {
            Alert.alert("Required", "Item name is required.");
            return;
        }
        setLoading(true);
        try {
            const clothingMode = isSizeCategory(category);
            const totalQty = clothingMode
                ? variants.reduce((acc, v) => acc + v.quantity, 0)
                : quantity;

            const payload: api.CreateItemPayload = {
                name: name.trim(),
                category: category.trim() || undefined,
                sku: sku.trim() || undefined,
                upc: upc.trim() || undefined,
                size: size.trim() || undefined,
                color: color.trim() || undefined,
                condition: condition.trim() || undefined,
                buy_price: buyPrice.trim() || undefined,
                expected_sell_price: expectedPrice.trim() || undefined,
                platform: platform.trim() || undefined,
                vendor_name: vendorName.trim() || undefined,
                notes: notes.trim() || undefined,
                quantity: totalQty,
                custom_attributes: clothingMode && variants.length > 0
                    ? { variants }
                    : undefined,
            };

            const created = await api.createItem(payload);

            // Save photos after item is created using the dedicated photo endpoint.
            if (frontPhoto || backPhoto) {
                try {
                    await api.uploadItemPhotos(created.id, frontPhoto, backPhoto);
                } catch {
                    console.warn("Photo save failed — item still created.");
                }
            }

            Alert.alert("✅ Added", "Item saved to inventory!", [
                { text: "OK", onPress: () => router.replace("/(tabs)/inventory") },
            ]);
        } catch (err: any) {
            if (err.detail?.error === "tier_limit_reached") {
                Alert.alert("Tier Limit", err.detail.message || "Upgrade to Pro for unlimited inventory.");
            } else {
                Alert.alert("Error", err.message || "Failed to create item.");
            }
        } finally {
            setLoading(false);
        }
    };

    // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                {/* â”€â”€ Photos â”€â”€ */}
                <Text style={styles.sectionTitle}>Photos</Text>
                <View style={styles.photoRow}>
                    <TouchableOpacity
                        accessibilityLabel="Add front photo"
                        accessibilityRole="button"
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("front")}
                    >
                        {frontPhoto ? (
                            <Image source={{ uri: frontPhoto }} style={styles.photoThumb} />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>📸</Text>
                                <Text style={styles.photoLabel}>Front</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                        accessibilityLabel="Add back photo"
                        accessibilityRole="button"
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("back")}
                    >
                        {backPhoto ? (
                            <Image source={{ uri: backPhoto }} style={styles.photoThumb} />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>📸</Text>
                                <Text style={styles.photoLabel}>Back</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>

                {/* â”€â”€ Required â”€â”€ */}
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

                {/* â”€â”€ Details â”€â”€ */}
                <Text style={styles.sectionTitle}>Details</Text>

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
                        <View style={styles.skuRow}>
                            <TextInput
                                accessibilityLabel="SKU"
                                style={[styles.input, styles.skuInput]}
                                placeholder="SKU-001"
                                placeholderTextColor="#555"
                                value={sku}
                                onChangeText={setSku}
                                autoCapitalize="characters"
                            />
                            <TouchableOpacity
                                accessibilityLabel="Generate SKU"
                                accessibilityRole="button"
                                style={styles.autoButton}
                                onPress={handleAutoSKU}
                            >
                                <Text style={styles.autoButtonText}>⚡</Text>
                            </TouchableOpacity>
                        </View>
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

                {/* â”€â”€ Pricing â”€â”€ */}
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

                <Text style={styles.label}>Platform</Text>
                <TextInput
                    accessibilityLabel="Platform"
                    style={styles.input}
                    placeholder="eBay, StockX, Mercari…"
                    placeholderTextColor="#555"
                    value={platform}
                    onChangeText={setPlatform}
                />

                <Text style={styles.label}>Vendor / Supplier</Text>
                <TextInput
                    accessibilityLabel="Vendor or Supplier"
                    style={styles.input}
                    placeholder="e.g. Nike, local thrift, auction"
                    placeholderTextColor="#555"
                    value={vendorName}
                    onChangeText={setVendorName}
                />

                <Text style={styles.label}>Notes</Text>
                <TextInput
                    accessibilityLabel="Notes"
                    style={[styles.input, { height: 90, textAlignVertical: "top" }]}
                    placeholder="Any extra details about this item…"
                    placeholderTextColor="#555"
                    value={notes}
                    onChangeText={setNotes}
                    multiline
                    numberOfLines={4}
                />

                {/* ── Sizes (clothing / footwear) ── */}
                {isSizeCategory(category) && (
                    <>
                        <Text style={styles.sectionTitle}>Sizes &amp; Quantities</Text>
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
                                onPress={() => setQuantity((q) => Math.max(1, q - 1))}
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

                {/* ── Submit ── */}
                <TouchableOpacity
                    accessibilityRole="button"
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

            {/* â”€â”€ Barcode Scanner Modal â”€â”€ */}
            <Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
                <View style={styles.scannerContainer}>
                    <CameraView
                        style={styles.camera}
                        facing="back"
                        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "qr"] }}
                        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
                    />
                    <ScannerOverlay hint="Point at a barcode to scan" onCancel={() => setScannerOpen(false)} />
                </View>
            </Modal>
        </KeyboardAvoidingView>
    );
}

const { width: SCREEN_W } = Dimensions.get("window");
const PHOTO_SIZE = (SCREEN_W - 60) / 2;

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0A0A1A" },
    content: { padding: 20, paddingBottom: 40 },

    sectionTitle: {
        fontSize: 13,
        fontWeight: "800",
        color: "#6C5CE7",
        marginTop: 22,
        marginBottom: 8,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    label: {
        color: "#999",
        fontSize: 11,
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
    row: { flexDirection: "row", gap: 12 },
    halfField: { flex: 1 },

    // Photos
    photoRow: { flexDirection: "row", gap: 12, marginBottom: 4 },
    photoSlot: {
        width: PHOTO_SIZE,
        height: PHOTO_SIZE,
        borderRadius: 12,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    photoThumb: { width: "100%", height: "100%" },
    photoPlaceholder: {
        flex: 1,
        backgroundColor: "#16213E",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
    },
    photoIcon: { fontSize: 32 },
    photoLabel: { color: "#555", fontSize: 12, fontWeight: "600" },

    // SKU row with auto-button
    skuRow: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
    skuInput: { flex: 1 },
    autoButton: {
        backgroundColor: "#2A1B4E",
        borderWidth: 1,
        borderColor: "#6C5CE7",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    autoButtonText: { fontSize: 16 },

    // Scan button
    scanButton: {
        backgroundColor: "#1A2E1A",
        borderWidth: 1,
        borderColor: "#00B894",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    scanButtonText: { fontSize: 16 },

    // Submit
    button: {
        backgroundColor: "#6C5CE7",
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 28,
    },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },

    // Scanner modal
    scannerContainer: { flex: 1, backgroundColor: "#000" },
    camera: { flex: 1 },
    scannerOverlay: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        alignItems: "center",
        paddingBottom: 50,
        backgroundColor: "rgba(0,0,0,0.4)",
        paddingTop: 20,
    },
    scannerFrame: {
        width: 240,
        height: 240,
        borderWidth: 2,
        borderColor: "#00B894",
        borderRadius: 16,
        marginBottom: 20,
    },
    scannerHint: { color: "#CCC", fontSize: 14, marginBottom: 20 },
    cancelScan: {
        backgroundColor: "#E17055",
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 12,
    },
    cancelScanText: { color: "#FFF", fontSize: 15, fontWeight: "700" },

    // Variants / Sizes section
    sizeHint: { color: "#666", fontSize: 12, marginBottom: 8, marginTop: 4 },
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
    qtyValue: { color: "#FFF", fontSize: 15, fontWeight: "700", minWidth: 26, textAlign: "center" },
    removeBtn: { marginLeft: 10, padding: 4 },
    removeBtnText: { color: "#E17055", fontSize: 14, fontWeight: "700" },
    addSizeRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 4,
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

    // Quantity stepper (non-clothing)
    qtyRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        backgroundColor: "#1A1A2E",
        borderRadius: 12,
        padding: 14,
        marginBottom: 6,
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
});
