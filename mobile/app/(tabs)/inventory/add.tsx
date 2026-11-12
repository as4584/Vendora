/**
 * Add Item Screen
 *
 * Form for creating a new inventory item with:
 *  â€¢ Front/back photo picker (expo-image-picker)
 *  â€¢ Barcode scanner modal (expo-camera)
 *  â€¢ Auto-SKU generator
 */
import { useEffect, useRef, useState } from "react";
import {
    Linking,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    ScrollView,
    Alert,
    Modal,
    Image,
    Dimensions,
    KeyboardAvoidingView,
    Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";
import { captureSession, isCurrentSession } from "../../../services/session";
import { isTempId } from "../../../services/offline";
import { ScannerOverlay } from "../../../components/ScannerOverlay";
import { StockxPriceHint } from "../../../components/Stockx";
import { Button, IconButton } from "../../../components/Button";
import { EbayCompsCard } from "../../../components/EbayCompsCard";
import { LiveBoxScanner, type LiveScanResult } from "../../../components/LiveBoxScanner";
import {
    isLabelReaderAvailable,
    isLiveScanAvailable,
    mergeFields,
    readLabel,
    rememberScan,
    resolveScan,
    syncScanMemory,
    backfillScanMemoryOnce,
    type ScanFields,
} from "../../../services/smartScan";

import { COLORS, FONT_SCALE } from "../../../theme/tokens";
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
    // Smart scan: barcode memory first, then the box label (read on device)
    const cameraRef = useRef<CameraView>(null);
    const [scanStep, setScanStep] = useState<"barcode" | "label">("barcode");
    const [readingLabel, setReadingLabel] = useState(false);
    const [scanNote, setScanNote] = useState<string | null>(null);
    const pendingBarcode = useRef<string>("");
    const styleCodeRef = useRef<string | undefined>(undefined);

    // Live scanner (VisionKit, A12+): barcode and label read together.
    const [liveSupported, setLiveSupported] = useState(false);
    const [liveOpen, setLiveOpen] = useState(false);

    const session = captureSession();
    // Bring this account's barcode memory onto the phone so scans work offline.
    useEffect(() => {
        // Learn barcodes from this account's inventory once on this device.
        syncScanMemory(session)
            .then(() => isCurrentSession(session) && backfillScanMemoryOnce(session))
            .catch(() => undefined);
        let alive = true;
        isLiveScanAvailable()
            .then((ok) => {
                if (alive) setLiveSupported(ok);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [session]);

    // ── Photo picker ─────────────────────────────────────────────────────────
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

    // ── Barcode scanner ──────────────────────────────────────────────────────
    const openScanner = async () => {
        if (!cameraPermission?.granted) {
            const { granted, canAskAgain } = await requestCameraPermission();
            if (!granted) {
                // Once denied, iOS won't ask again: send the seller to Settings instead.
                Alert.alert(
                    "Camera access needed",
                    "Allow camera access to scan barcodes and box labels.",
                    canAskAgain
                        ? [{ text: "OK" }]
                        : [
                              { text: "Not now", style: "cancel" },
                              { text: "Open Settings", onPress: () => void Linking.openSettings() },
                          ],
                );
                return;
            }
        }
        if (liveSupported) {
            setLiveOpen(true);
            return;
        }
        scanLock.current = false;
        setScanned(false);
        setScannerOpen(true);
    };

    /** Live scan finished: memory first, then what the camera read. */
    const onLiveFinish = async (result: LiveScanResult) => {
        if (!isCurrentSession(session)) return;
        setLiveOpen(false);
        const { barcode, ...read } = result;
        if (!barcode && Object.keys(read).length === 0) {
            setScanNote("Nothing was read. Try again with the label in good light, or type the details.");
            return;
        }
        let fields: ScanFields = read;
        let note = "Read live from the box on your phone. Check it, fix anything, and save. Resqlo will remember it.";
        if (barcode) {
            setUpc(barcode);
            try {
                const hit = await resolveScan(barcode, read.style_code, session);
                if (hit.match === "memory" || hit.match === "inventory") {
                    // Remembered beats read.
                    fields = mergeFields(hit.fields, read);
                    note =
                        hit.match === "memory"
                            ? "Filled from your scan memory. Check it and save."
                            : "Filled from an item you already have. Check it and save.";
                } else if (hit.match) {
                    // Same shoe, new size: the box's size wins.
                    fields = { ...read, ...hit.fields, size: read.size ?? hit.fields.size };
                }
            } catch {
                // Memory unavailable: use what was read.
            }
        }
        if (!isCurrentSession(session)) return;
        applyScanFields(fields);
        setScanNote(note);
    };

    const onLiveUnavailable = (message: string) => {
        // Fall back to the tap-to-read scanner for the rest of this session.
        setLiveOpen(false);
        setLiveSupported(false);
        setScanNote(message);
        scanLock.current = false;
        setScanned(false);
        setScannerOpen(true);
    };

    /** Fill empty fields only, so nothing the seller typed is overwritten. */
    const applyScanFields = (fields: ScanFields) => {
        const fill = (cur: string, set: (v: string) => void, val?: string) => {
            if (val && !cur.trim()) set(val);
        };
        fill(name, setName, fields.name);
        fill(category, setCategory, fields.category);
        fill(sku, setSku, fields.sku ?? fields.style_code);
        fill(color, setColor, fields.color);
        fill(condition, setCondition, fields.condition);
        fill(buyPrice, setBuyPrice, fields.buy_price);
        fill(expectedPrice, setExpectedPrice, fields.expected_sell_price);
        fill(platform, setPlatform, fields.platform);
        if (fields.style_code) styleCodeRef.current = fields.style_code;
        if (fields.size) {
            const finalCategory = category.trim() || fields.category || "";
            const boxSize = fields.size;
            if (isSizeCategory(finalCategory)) {
                setVariants((prev) => (prev.length ? prev : [{ size: boxSize, quantity: 1 }]));
            } else {
                fill(size, setSize, boxSize);
            }
        }
    };

    const closeScanner = () => {
        setScannerOpen(false);
        setScanStep("barcode");
        setReadingLabel(false);
    };

    const onBarcodeScanned = async ({ data }: { data: string }) => {
        if (scanLock.current || !isCurrentSession(session)) return;
        scanLock.current = true;
        setScanned(true);
        setUpc(data);
        pendingBarcode.current = data;
        try {
            const hit = await resolveScan(data, undefined, session);
            if (!isCurrentSession(session)) return;
            if (hit.match === "memory" || hit.match === "inventory") {
                applyScanFields(hit.fields);
                closeScanner();
                setScanNote(
                    hit.match === "memory"
                        ? `Filled from your scan memory${hit.times_seen > 1 ? ` (seen ${hit.times_seen} times)` : ""}. Check it and save.`
                        : "Filled from an item you already have. Check it and save.",
                );
                return;
            }
        } catch {
            // Memory unavailable: carry on to the label step.
        }
        if (!isCurrentSession(session)) return;
        if (isLabelReaderAvailable()) {
            setScanStep("label");
        } else {
            closeScanner();
            setScanNote("New barcode. Type the details once and Resqlo will remember it next time.");
        }
    };

    const captureLabel = async () => {
        if (!cameraRef.current || readingLabel || !isCurrentSession(session)) return;
        setReadingLabel(true);
        try {
            const photo = await cameraRef.current.takePictureAsync({ quality: 0.7 });
            let fields = await readLabel(photo.uri);
            if (!isCurrentSession(session)) return;
            if (fields.style_code) {
                // A different size of a shoe you already have fills in the rest.
                const family = await resolveScan(pendingBarcode.current, fields.style_code, session);
                if (!isCurrentSession(session)) return;
                if (family.match) fields = { ...fields, ...family.fields, size: fields.size ?? family.fields.size };
            }
            applyScanFields(fields);
            setScanNote(
                Object.keys(fields).length
                    ? "Read from the box label on your phone. Check it, fix anything, and save. Resqlo will remember it."
                    : "Couldn't read that label. Type the details once and Resqlo will remember this barcode.",
            );
        } catch {
            setScanNote("Couldn't read that label. Type the details once and Resqlo will remember this barcode.");
        } finally {
            closeScanner();
        }
    };

    const skipLabel = () => {
        closeScanner();
        setScanNote("New barcode. Type the details once and Resqlo will remember it next time.");
    };

    // ── Auto-SKU ─────────────────────────────────────────────────────────────
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

    // ── Submit ───────────────────────────────────────────────────────────────
    const handleSubmit = async () => {
        if (!isCurrentSession(session)) return;
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
            if (!isCurrentSession(session)) return;

            // Teach smart scan what this barcode is (phone first, then account).
            if (payload.upc) {
                rememberScan(payload.upc, {
                    name: payload.name,
                    category: payload.category,
                    sku: payload.sku,
                    style_code: styleCodeRef.current ?? payload.sku,
                    size: payload.size ?? (variants.length === 1 ? variants[0].size : undefined),
                    color: payload.color,
                    condition: payload.condition,
                    buy_price: payload.buy_price,
                    expected_sell_price: payload.expected_sell_price,
                    platform: payload.platform,
                }, session).catch(() => undefined);
            }
            const queuedOffline = isTempId(created.id);

            // Photos upload to a dedicated endpoint that needs a connection and a
            // real (server-assigned) item id. Offline, the item is queued now and
            // photos can be added after it syncs.
            if ((frontPhoto || backPhoto) && !queuedOffline) {
                try {
                    await api.uploadItemPhotos(created.id, frontPhoto, backPhoto);
                } catch {
                    console.warn("Photo save failed — item still created.");
                }
            }

            if (!isCurrentSession(session)) return;
            Alert.alert(
                queuedOffline ? "Saved offline" : "Added",
                queuedOffline
                    ? "Item saved on your device — it'll sync automatically when you're back online."
                    : "Item saved to inventory!",
                [{ text: "OK", onPress: () => router.replace("/(tabs)/inventory") }],
            );
        } catch (err: any) {
            if (!isCurrentSession(session)) return;
            if (err.detail?.error === "tier_limit_reached") {
                Alert.alert(
                    "You've hit the free limit",
                    err.detail.message || "Upgrade to Pro for unlimited inventory.",
                    [
                        { text: "Not now", style: "cancel" },
                        { text: "See Pro", onPress: () => router.push("/(tabs)/settings/subscription") },
                    ],
                );
            } else {
                Alert.alert("Error", err.message || "Failed to create item.");
            }
        } finally {
            setLoading(false);
        }
    };

    // ── Render ───────────────────────────────────────────────────────────────
    return (
        <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: "#0E0E11" }}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
        >
            <ScrollView
                style={styles.container}
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                {/* ── Photos ── */}
                {/* Smart scan: the fastest way to add a boxed item */}
                <Button
                    label="Scan a box"
                    leadingIcon="barcode-outline"
                    size="lg"
                    fullWidth
                    onPress={openScanner}
                    accessibilityLabel="Scan a box barcode and label"
                    testID="smart-scan-button"
                    style={styles.smartScanButton}
                />
                <Button
                    label="Scan many boxes"
                    leadingIcon="layers-outline"
                    variant="ghost"
                    fullWidth
                    onPress={() => router.push("/inventory/batch-scan")}
                    accessibilityLabel="Batch scan many boxes, then review and save them together"
                    testID="batch-scan-button"
                />
                {scanNote ? (
                    <View style={styles.scanNote} accessibilityLiveRegion="polite" testID="smart-scan-note">
                        <Text style={styles.scanNoteText}>{scanNote}</Text>
                    </View>
                ) : null}

                <Text style={styles.sectionTitle}>Photos</Text>
                <View style={styles.photoRow}>
                    <TouchableOpacity
                        accessibilityLabel="Add front photo"
                        accessibilityRole="button"
                        style={styles.photoSlot}
                        onPress={() => showPhotoOptions("front")}
                    >
                        {frontPhoto ? (
                            <Image source={{ uri: frontPhoto }} style={styles.photoThumb} resizeMode="cover" />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Ionicons name="camera-outline" size={26} color="#8C8C96" />
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
                            <Image source={{ uri: backPhoto }} style={styles.photoThumb} resizeMode="cover" />
                        ) : (
                            <View style={styles.photoPlaceholder}>
                                <Ionicons name="camera-outline" size={26} color="#8C8C96" />
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
                    placeholderTextColor="#8C8C96"
                    value={name}
                    onChangeText={setName}
                />

                {/* ── Details ── */}
                <Text style={styles.sectionTitle}>Details</Text>

                <View style={styles.row}>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>Category</Text>
                        <TextInput
                            accessibilityLabel="Category"
                            style={styles.input}
                            placeholder="sneakers"
                            placeholderTextColor="#8C8C96"
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
                                placeholder="SKU"
                                placeholderTextColor="#8C8C96"
                                value={sku}
                                onChangeText={setSku}
                                autoCapitalize="characters"
                            />
                            <IconButton icon="flash-outline" label="Generate SKU" onPress={handleAutoSKU} />
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
                        placeholderTextColor="#8C8C96"
                        value={upc}
                        onChangeText={setUpc}
                        keyboardType="numeric"
                    />
                    <IconButton icon="barcode-outline" label="Scan barcode" onPress={openScanner} />
                </View>

                <View style={styles.row}>
                    <View style={styles.halfField}>
                        <Text style={styles.label}>Size</Text>
                        <TextInput
                            accessibilityLabel="Size"
                            style={styles.input}
                            placeholder="10"
                            placeholderTextColor="#8C8C96"
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
                            placeholderTextColor="#8C8C96"
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
                    placeholderTextColor="#8C8C96"
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
                            placeholderTextColor="#8C8C96"
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
                            placeholderTextColor="#8C8C96"
                            value={expectedPrice}
                            onChangeText={setExpectedPrice}
                            keyboardType="decimal-pad"
                        />
                    </View>
                </View>
                <StockxPriceHint name={name} size={size} />

                <EbayCompsCard query={name} onUsePrice={setExpectedPrice} />

                <Text style={styles.label}>Platform</Text>
                <TextInput
                    accessibilityLabel="Platform"
                    style={styles.input}
                    placeholder="eBay, StockX, Mercari…"
                    placeholderTextColor="#8C8C96"
                    value={platform}
                    onChangeText={setPlatform}
                />

                <Text style={styles.label}>Vendor / Supplier</Text>
                <TextInput
                    accessibilityLabel="Vendor or Supplier"
                    style={styles.input}
                    placeholder="e.g. Nike, local thrift, auction"
                    placeholderTextColor="#8C8C96"
                    value={vendorName}
                    onChangeText={setVendorName}
                />

                <Text style={styles.label}>Notes</Text>
                <TextInput
                    accessibilityLabel="Notes"
                    style={[styles.input, { height: 90, textAlignVertical: "top" }]}
                    placeholder="Any extra details about this item…"
                    placeholderTextColor="#8C8C96"
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
                                    <IconButton icon="remove" label={`Decrease quantity for ${v.size}`} onPress={() => adjustVariantQty(idx, -1)} />
                                    <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.qtyValue}>{v.quantity}</Text>
                                    <IconButton icon="add" label={`Increase quantity for ${v.size}`} onPress={() => adjustVariantQty(idx, 1)} />
                                </View>
                                <IconButton icon="close" label={`Remove size ${v.size}`} onPress={() => removeVariant(idx)} />
                            </View>
                        ))}

                        <View style={styles.addSizeRow}>
                            <TextInput
                                accessibilityLabel="New Size"
                                style={styles.sizeInput}
                                placeholder="e.g. M, 32x32, 10.5"
                                placeholderTextColor="#8C8C96"
                                value={newVariantSize}
                                onChangeText={setNewVariantSize}
                                onSubmitEditing={addVariant}
                                returnKeyType="done"
                            />
                            <Button label="+ Add Size" variant="secondary" size="sm" onPress={addVariant} accessibilityLabel="Add Size" />
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
                            <IconButton icon="remove" label="Decrease quantity" onPress={() => setQuantity((q) => Math.max(1, q - 1))} />
                            <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.qtyValueLarge}>{quantity}</Text>
                            <IconButton icon="add" label="Increase quantity" onPress={() => setQuantity((q) => q + 1)} />
                        </View>
                    </>
                )}

                {/* ── Submit ── */}
                <Button
                    label="Add to Inventory"
                    size="lg"
                    fullWidth
                    haptic="success"
                    loading={loading}
                    disabled={loading}
                    onPress={handleSubmit}
                    style={styles.submitButton}
                />
            </ScrollView>

            {/* ── Barcode Scanner Modal ── */}
            <Modal visible={scannerOpen} animationType="slide" onRequestClose={closeScanner}>
                <View style={styles.scannerContainer}>
                    <CameraView
                        ref={cameraRef}
                        style={styles.camera}
                        facing="back"
                        barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "qr"] }}
                        onBarcodeScanned={scanned ? undefined : onBarcodeScanned}
                    />
                    {scanStep === "barcode" ? (
                        <ScannerOverlay hint="Point at the barcode on the box" onCancel={closeScanner} />
                    ) : (
                        <View style={styles.labelStep} testID="smart-scan-label-step">
                            <Text style={styles.labelStepTitle}>New barcode</Text>
                            <Text style={styles.labelStepHint}>
                                Fit the box label in view and tap Read label. It is read on your phone.
                            </Text>
                            <Button
                                label={readingLabel ? "Reading..." : "Read label"}
                                leadingIcon="scan-outline"
                                size="lg"
                                fullWidth
                                loading={readingLabel}
                                haptic="success"
                                onPress={captureLabel}
                            />
                            <Button label="Type it myself" variant="ghost" fullWidth onPress={skipLabel} style={styles.labelSkip} />
                        </View>
                    )}
                </View>
            </Modal>

            <Modal visible={liveOpen} animationType="slide" onRequestClose={() => setLiveOpen(false)}>
                {liveOpen ? (
                    <LiveBoxScanner
                        onFinish={onLiveFinish}
                        onCancel={() => setLiveOpen(false)}
                        onUnavailable={onLiveUnavailable}
                    />
                ) : null}
            </Modal>
        </KeyboardAvoidingView>
    );
}

const { width: SCREEN_W } = Dimensions.get("window");
const PHOTO_SIZE = (SCREEN_W - 60) / 2;

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: "#0E0E11" },
    content: { padding: 20, paddingBottom: 40 },

    sectionTitle: {
        fontSize: 17,
        fontWeight: "600",
        color: COLORS.text,
        marginTop: 24,
        marginBottom: 8,
    },
    label: {
        color: "#A6A6B0",
        fontSize: 11,
        fontWeight: "600",
        marginBottom: 6,
        marginTop: 8,
    },
    input: {
        backgroundColor: "#1C1C22",
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: "#FFFFFF",
        fontSize: 15,
        borderWidth: 1,
        borderColor: "#2C2C34",
    },
    row: { flexDirection: "row", gap: 12 },
    halfField: { flex: 1, minWidth: 0 },

    // Photos
    photoRow: { flexDirection: "row", gap: 12, marginBottom: 4 },
    photoSlot: {
        width: PHOTO_SIZE,
        height: PHOTO_SIZE,
        borderRadius: 12,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#2C2C34",
    },
    photoThumb: { width: "100%", height: "100%" },
    photoPlaceholder: {
        flex: 1,
        backgroundColor: "#141418",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
    },
    photoIcon: { fontSize: 32 },
    photoLabel: { color: "#8C8C96", fontSize: 12, fontWeight: "600" },

    // SKU row with auto-button
    skuRow: { flexDirection: "row", gap: 8, alignItems: "center" },
    skuInput: { flex: 1, minWidth: 0 },
    autoButton: {
        backgroundColor: "#2A1B4E",
        borderWidth: 1,
        borderColor: COLORS.primary,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    autoButtonText: { fontSize: 16 },

    // Scan button
    scanButton: {
        backgroundColor: "#1A2E1A",
        borderWidth: 1,
        borderColor: "#4CC38A",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    scanButtonText: { fontSize: 16 },

    // Submit
    button: {
        backgroundColor: COLORS.primary,
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: 28,
    },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },

    // Scanner modal
    submitButton: { marginTop: 24 },
    scannerContainer: { flex: 1, backgroundColor: "#000" },
    smartScanButton: { marginBottom: 12 },
    scanNote: {
        backgroundColor: COLORS.cardAlt,
        borderColor: COLORS.primary,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 16,
    },
    scanNoteText: { color: COLORS.text, fontSize: 14, lineHeight: 20 },
    labelStep: {
        position: "absolute",
        left: 16,
        right: 16,
        bottom: 40,
        backgroundColor: "rgba(10,10,26,0.92)",
        borderRadius: 16,
        padding: 16,
        gap: 8,
    },
    labelStepTitle: { color: COLORS.text, fontSize: 18, fontWeight: "600" },
    labelStepHint: { color: COLORS.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
    labelSkip: { marginTop: 4 },
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
        borderColor: "#4CC38A",
        borderRadius: 16,
        marginBottom: 20,
    },
    scannerHint: { color: "#CCC", fontSize: 14, marginBottom: 20 },
    cancelScan: {
        backgroundColor: "#E5584D",
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 12,
    },
    cancelScanText: { color: "#FFF", fontSize: 15, fontWeight: "600" },

    // Variants / Sizes section
    sizeHint: { color: "#8C8C96", fontSize: 12, marginBottom: 8, marginTop: 4 },
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
    qtyValue: { color: "#FFF", fontSize: 15, fontWeight: "600", minWidth: 26, textAlign: "center" },
    removeBtn: { marginLeft: 10, padding: 4 },
    removeBtnText: { color: "#E5584D", fontSize: 14, fontWeight: "600" },
    addSizeRow: {
        flexDirection: "row",
        gap: 8,
        marginTop: 4,
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

    // Quantity stepper (non-clothing)
    qtyRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        backgroundColor: "#1C1C22",
        borderRadius: 12,
        padding: 14,
        marginBottom: 6,
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
});
