/**
 * Add Item Screen
 *
 * Form for creating a new inventory item with:
 *  â€¢ Front/back photo picker (expo-image-picker)
 *  â€¢ Barcode scanner modal (expo-camera)
 *  â€¢ Auto-SKU generator
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
    Modal,
    Image,
    Dimensions,
} from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";

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

    // Photo state
    const [frontPhoto, setFrontPhoto] = useState<string | null>(null);
    const [backPhoto, setBackPhoto] = useState<string | null>(null);

    // Barcode scanner
    const [scannerOpen, setScannerOpen] = useState(false);
    const [cameraPermission, requestCameraPermission] = useCameraPermissions();
    const [scanned, setScanned] = useState(false);

    // â”€â”€ Photo picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const pickPhoto = async (side: PhotoSide) => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== "granted") {
            Alert.alert("Permission Required", "Allow photo access to attach item photos.");
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
            if (side === "front") setFrontPhoto(result.assets[0].uri);
            else setBackPhoto(result.assets[0].uri);
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
        });
        if (!result.canceled && result.assets[0]) {
            if (side === "front") setFrontPhoto(result.assets[0].uri);
            else setBackPhoto(result.assets[0].uri);
        }
    };

    const showPhotoOptions = (side: PhotoSide) => {
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
        setScanned(false);
        setScannerOpen(true);
    };

    const onBarcodeScanned = ({ data }: { data: string }) => {
        if (scanned) return;
        setScanned(true);
        setScannerOpen(false);
        setUpc(data);
        Alert.alert("Barcode Scanned", `UPC: ${data}`);
    };

    // â”€â”€ Auto-SKU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleAutoSKU = () => {
        setSku(generateSKU(category || "other"));
    };

    // â”€â”€ Submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                upc: upc.trim() || undefined,
                size: size.trim() || undefined,
                color: color.trim() || undefined,
                condition: condition.trim() || undefined,
                buy_price: buyPrice.trim() || undefined,
                expected_sell_price: expectedPrice.trim() || undefined,
                platform: platform.trim() || undefined,
            };
            await api.createItem(payload);
            Alert.alert("âœ… Added", "Item saved to inventory!", [
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
        <>
            <ScrollView
                style={styles.container}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
            >
                {/* â”€â”€ Photos â”€â”€ */}
                <Text style={styles.sectionTitle}>Photos</Text>
                <View style={styles.photoRow}>
                    <TouchableOpacity
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("front")}
                    >
                        {frontPhoto ? (
                            <Image source={{ uri: frontPhoto }} style={styles.photoThumb} />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>ðŸ“¸</Text>
                                <Text style={styles.photoLabel}>Front</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("back")}
                    >
                        {backPhoto ? (
                            <Image source={{ uri: backPhoto }} style={styles.photoThumb} />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Text style={styles.photoIcon}>ðŸ“¸</Text>
                                <Text style={styles.photoLabel}>Back</Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>

                {/* â”€â”€ Required â”€â”€ */}
                <Text style={styles.sectionTitle}>Required</Text>
                <Text style={styles.label}>Item Name</Text>
                <TextInput
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
                                style={[styles.input, styles.skuInput]}
                                placeholder="SKU-001"
                                placeholderTextColor="#555"
                                value={sku}
                                onChangeText={setSku}
                                autoCapitalize="characters"
                            />
                            <TouchableOpacity
                                style={styles.autoButton}
                                onPress={handleAutoSKU}
                            >
                                <Text style={styles.autoButtonText}>âš¡</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>

                {/* UPC with barcode scan */}
                <Text style={styles.label}>UPC / Barcode</Text>
                <View style={styles.skuRow}>
                    <TextInput
                        style={[styles.input, styles.skuInput]}
                        placeholder="Scan or type barcode"
                        placeholderTextColor="#555"
                        value={upc}
                        onChangeText={setUpc}
                        keyboardType="numeric"
                    />
                    <TouchableOpacity style={styles.scanButton} onPress={openScanner}>
                        <Text style={styles.scanButtonText}>ðŸ”</Text>
                    </TouchableOpacity>
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

                {/* â”€â”€ Pricing â”€â”€ */}
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
                    placeholder="eBay, StockX, Mercariâ€¦"
                    placeholderTextColor="#555"
                    value={platform}
                    onChangeText={setPlatform}
                />

                {/* â”€â”€ Submit â”€â”€ */}
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

            {/* â”€â”€ Barcode Scanner Modal â”€â”€ */}
            <Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
                <View style={styles.scannerContainer}>
                    <CameraView
                        style={styles.camera}
                        facing="back"
                        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "qr"] }}
                        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
                    />
                    <View style={styles.scannerOverlay}>
                        <View style={styles.scannerFrame} />
                        <Text style={styles.scannerHint}>Point at a barcode to scan</Text>
                        <TouchableOpacity
                            style={styles.cancelScan}
                            onPress={() => setScannerOpen(false)}
                        >
                            <Text style={styles.cancelScanText}>Cancel</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </>
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
        flex: 1,
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
});
