/**
 * Item Detail Screen — /inventory/[id]
 *
 * Displays item details with:
 *  • Front / back photo carousel
 *  • Market price panel (UPCItemDB + internal history)
 *  • Smart pricing suggestion banner with one-tap Apply
 *  • Status transitions and soft-delete
 */
import { useEffect, useState } from "react";
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Alert,
    Image,
    Dimensions,
    Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as api from "../../../services/api";

const STATUS_COLORS: Record<string, string> = {
    in_stock: "#00B894",
    listed: "#0984E3",
    sold: "#E17055",
    shipped: "#FDCB6E",
    paid: "#6C5CE7",
    archived: "#636E72",
};

const VALID_TRANSITIONS: Record<string, string[]> = {
    in_stock: ["listed", "sold"],
    listed: ["sold", "in_stock"],
    sold: ["shipped", "paid"],
    shipped: ["paid"],
    paid: ["archived"],
    archived: [],
};

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
        <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{label}</Text>
            <Text style={styles.detailValue}>{value}</Text>
        </View>
    );
}

export default function ItemDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [item, setItem] = useState<api.InventoryItem | null>(null);
    const [loading, setLoading] = useState(true);
    const [activePhoto, setActivePhoto] = useState<"front" | "back">("front");
    const [photoUploading, setPhotoUploading] = useState(false);

    // Market price
    const [marketPrice, setMarketPrice] = useState<api.MarketPriceResult | null>(null);
    const [marketLoading, setMarketLoading] = useState(false);

    // Pricing suggestion
    const [suggestion, setSuggestion] = useState<api.PricingSuggestion | null>(null);
    const [suggestLoading, setSuggestLoading] = useState(false);
    const [applyingPrice, setApplyingPrice] = useState(false);

    const fetchItem = async () => {
        try {
            const data = await api.getItem(id!);
            setItem(data);
        } catch (err: any) {
            Alert.alert("Error", err.message || "Item not found.", [
                { text: "OK", onPress: () => router.back() },
            ]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchItem();
    }, [id]);

    // Load market price + suggestion after item loads
    useEffect(() => {
        if (!item) return;
        // Market price
        setMarketLoading(true);
        api.getMarketPrice(item.name, item.upc ?? undefined)
            .then(setMarketPrice)
            .catch(() => {})
            .finally(() => setMarketLoading(false));
        // Pricing suggestion
        setSuggestLoading(true);
        api.getPricingSuggestion(item.id)
            .then(setSuggestion)
            .catch(() => {})
            .finally(() => setSuggestLoading(false));
    }, [item?.id]);

    const handleTransition = async (newStatus: string) => {
        try {
            const updated = await api.updateItemStatus(item!.id, newStatus);
            setItem(updated);
        } catch (err: any) {
            Alert.alert("Transition Failed", err.message || "Cannot change status.");
        }
    };

    const handleDelete = () => {
        Alert.alert(
            "Delete Item",
            "This item will be recoverable for 30 days. Continue?",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                        try {
                            await api.deleteItem(item!.id);
                            Alert.alert("Deleted", "Item has been removed.", [
                                { text: "OK", onPress: () => router.replace("/(tabs)/inventory") },
                            ]);
                        } catch (err: any) {
                            Alert.alert("Error", err.message);
                        }
                    },
                },
            ]
        );
    };

    // ── Photo editing ──
    const changePhoto = async (side: "front" | "back", uri: string) => {
        setPhotoUploading(true);
        try {
            const b64 = await FileSystem.readAsStringAsync(uri, {
                encoding: FileSystem.EncodingType.Base64,
            });
            const dataUrl = `data:image/jpeg;base64,${b64}`;
            const updated = await api.uploadItemPhotos(
                item!.id,
                side === "front" ? dataUrl : undefined,
                side === "back" ? dataUrl : undefined,
            );
            setItem(updated);
        } catch (err: any) {
            Alert.alert("Upload Failed", err.message || "Could not save photo.");
        } finally {
            setPhotoUploading(false);
        }
    };

    const pickPhotoForSide = async (side: "front" | "back") => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== "granted") {
            Alert.alert("Permission Required", "Allow photo access to change item photos.");
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
            await changePhoto(side, result.assets[0].uri);
        }
    };

    const takePhotoForSide = async (side: "front" | "back") => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== "granted") {
            Alert.alert("Permission Required", "Allow camera access to take a photo.");
            return;
        }
        const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.8,
        });
        if (!result.canceled && result.assets[0]) {
            await changePhoto(side, result.assets[0].uri);
        }
    };

    const showPhotoOptions = (side: "front" | "back") => {
        Alert.alert(
            `Change ${side === "front" ? "Front" : "Back"} Photo`,
            "Choose a source",
            [
                { text: "Take Photo", onPress: () => takePhotoForSide(side) },
                { text: "Choose from Library", onPress: () => pickPhotoForSide(side) },
                { text: "Cancel", style: "cancel" },
            ]
        );
    };

    const handleApplyPrice = async () => {
        if (!suggestion || !item) return;
        setApplyingPrice(true);
        try {
            const updated = await api.updateItem(item.id, {
                expected_sell_price: suggestion.suggested_price.toFixed(2),
            });
            setItem(updated);
            setSuggestion(null);
            Alert.alert("✅ Applied", `Expected price set to $${suggestion.suggested_price.toFixed(2)}`);
        } catch (err: any) {
            Alert.alert("Error", err.message);
        } finally {
            setApplyingPrice(false);
        }
    };

    if (loading || !item) {
        return (
            <View style={styles.center}>
                <ActivityIndicator size="large" color="#6C5CE7" />
            </View>
        );
    }

    const transitions = VALID_TRANSITIONS[item.status] || [];
    const frontUri = (item as any).photo_front_url as string | null;
    const backUri = (item as any).photo_back_url as string | null;
    const activeUri = activePhoto === "front" ? frontUri : backUri;

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* ── Photo Carousel ── */}
            <View style={styles.photoSection}>
                <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() =>
                        Platform.OS === "web"
                            ? pickPhotoForSide(activePhoto)
                            : showPhotoOptions(activePhoto)
                    }
                    disabled={photoUploading}
                >
                    {activeUri ? (
                        <Image
                            source={{ uri: activeUri }}
                            style={styles.photoMain}
                            resizeMode="cover"
                        />
                    ) : (
                        <View style={[styles.photoMain, styles.photoPlaceholder]}>
                            <Text style={styles.photoPlaceholderIcon}>📷</Text>
                            <Text style={styles.photoPlaceholderText}>Tap to add photo</Text>
                        </View>
                    )}
                    {photoUploading ? (
                        <View style={styles.photoUploadOverlay}>
                            <ActivityIndicator size="large" color="#FFF" />
                        </View>
                    ) : (
                        <View style={styles.photoEditOverlay}>
                            <Text style={styles.photoEditOverlayText}>📷  Change</Text>
                        </View>
                    )}
                </TouchableOpacity>
                <View style={styles.photoTabs}>
                    {(["front", "back"] as const).map((side) => (
                        <TouchableOpacity
                            key={side}
                            style={[styles.photoTab, activePhoto === side && styles.photoTabActive]}
                            onPress={() => setActivePhoto(side)}
                        >
                            <Text style={[styles.photoTabText, activePhoto === side && styles.photoTabTextActive]}>
                                {side.toUpperCase()}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>

            {/* ── Header ── */}
            <Text style={styles.itemName}>{item.name}</Text>
            <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[item.status] }]}>
                <Text style={styles.statusText}>{item.status.replace("_", " ").toUpperCase()}</Text>
            </View>

            {/* ── Smart Pricing Suggestion ── */}
            {suggestLoading && (
                <View style={styles.suggestBox}>
                    <ActivityIndicator size="small" color="#6C5CE7" />
                    <Text style={styles.suggestLoading}>Analysing market data…</Text>
                </View>
            )}
            {suggestion && (
                <View style={styles.suggestBox}>
                    <View style={styles.suggestHeader}>
                        <Text style={styles.suggestTitle}>💡 Smart Pricing</Text>
                        <View style={[
                            styles.confidenceBadge,
                            { backgroundColor: suggestion.confidence === "high" ? "#00B894" : suggestion.confidence === "medium" ? "#FDCB6E" : "#E17055" }
                        ]}>
                            <Text style={styles.confidenceText}>{suggestion.confidence.toUpperCase()}</Text>
                        </View>
                    </View>
                    <Text style={styles.suggestPrice}>${suggestion.suggested_price.toFixed(2)}</Text>
                    <Text style={styles.suggestReason}>{suggestion.reason}</Text>
                    <Text style={styles.suggestBasis}>{suggestion.basis}</Text>
                    <TouchableOpacity
                        style={[styles.applyButton, applyingPrice && styles.applyButtonDisabled]}
                        onPress={handleApplyPrice}
                        disabled={applyingPrice}
                    >
                        {applyingPrice
                            ? <ActivityIndicator size="small" color="#FFF" />
                            : <Text style={styles.applyButtonText}>Apply Price</Text>
                        }
                    </TouchableOpacity>
                </View>
            )}

            {/* ── Details ── */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Details</Text>
                <DetailRow label="Category" value={item.category} />
                <DetailRow label="SKU" value={item.sku} />
                <DetailRow label="UPC" value={item.upc} />
                <DetailRow label="Size" value={item.size} />
                <DetailRow label="Color" value={item.color} />
                <DetailRow label="Condition" value={item.condition} />
                <DetailRow label="Serial Number" value={item.serial_number} />
                <DetailRow label="Platform" value={item.platform} />
                <DetailRow label="Vendor" value={(item as any).vendor_name} />
                {(item as any).notes ? (
                    <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Notes</Text>
                        <Text style={[styles.detailValue, { flex: 1 }]}>{(item as any).notes}</Text>
                    </View>
                ) : null}
            </View>

            {/* ── Pricing ── */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Pricing</Text>
                <DetailRow label="Buy Price" value={item.buy_price ? `$${item.buy_price}` : null} />
                <DetailRow label="Expected Sell" value={item.expected_sell_price ? `$${item.expected_sell_price}` : null} />
                <DetailRow label="Actual Sell" value={item.actual_sell_price ? `$${item.actual_sell_price}` : null} />
                {item.buy_price && item.expected_sell_price && (
                    <DetailRow
                        label="Expected Profit"
                        value={`$${(parseFloat(item.expected_sell_price) - parseFloat(item.buy_price)).toFixed(2)}`}
                    />
                )}
            </View>

            {/* ── Market Price Panel ── */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Market Price</Text>
                {marketLoading && <ActivityIndicator size="small" color="#6C5CE7" style={{ marginVertical: 8 }} />}
                {!marketLoading && marketPrice && (
                    <>
                        {marketPrice.product_info && (
                            <View style={styles.marketProduct}>
                                {marketPrice.product_info.image_url && (
                                    <Image
                                        source={{ uri: marketPrice.product_info.image_url }}
                                        style={styles.marketProductImage}
                                        resizeMode="contain"
                                    />
                                )}
                                <View style={styles.marketProductInfo}>
                                    <Text style={styles.marketProductTitle} numberOfLines={2}>
                                        {marketPrice.product_info.title}
                                    </Text>
                                    {marketPrice.product_info.brand && (
                                        <Text style={styles.marketProductBrand}>{marketPrice.product_info.brand}</Text>
                                    )}
                                    {marketPrice.product_info.lowest_price != null && (
                                        <Text style={styles.marketPriceRange}>
                                            ${marketPrice.product_info.lowest_price.toFixed(2)}
                                            {marketPrice.product_info.highest_price != null
                                                ? ` – $${marketPrice.product_info.highest_price.toFixed(2)}`
                                                : ""}
                                        </Text>
                                    )}
                                </View>
                            </View>
                        )}
                        {marketPrice.internal_history.avg_sold_price != null && (
                            <View style={styles.historyRow}>
                                <Text style={styles.historyLabel}>
                                    Your avg sold price ({marketPrice.internal_history.sample_count} sales)
                                </Text>
                                <Text style={styles.historyValue}>
                                    ${marketPrice.internal_history.avg_sold_price.toFixed(2)}
                                </Text>
                            </View>
                        )}
                        {marketPrice.sources.map((src) =>
                            src.price != null ? (
                                <View key={src.source} style={styles.sourceRow}>
                                    <Text style={styles.sourceLabel}>{src.label}</Text>
                                    <Text style={styles.sourceValue}>${src.price.toFixed(2)}</Text>
                                </View>
                            ) : null
                        )}
                        {!marketPrice.product_info && marketPrice.internal_history.avg_sold_price == null && (
                            <Text style={styles.noMarket}>No market data found for this item.</Text>
                        )}
                    </>
                )}
                {!marketLoading && !marketPrice && (
                    <Text style={styles.noMarket}>Market data unavailable.</Text>
                )}
            </View>

            {/* ── Status Transitions ── */}
            {transitions.length > 0 && (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Actions</Text>
                    <View style={styles.actionsRow}>
                        {transitions.map((status) => (
                            <TouchableOpacity
                                key={status}
                                style={[styles.transitionButton, { borderColor: STATUS_COLORS[status] }]}
                                onPress={() => handleTransition(status)}
                            >
                                <Text style={[styles.transitionText, { color: STATUS_COLORS[status] }]}>
                                    → {status.replace("_", " ").toUpperCase()}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            )}

            {/* ── Timestamps ── */}
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>Timestamps</Text>
                <DetailRow label="Created" value={new Date(item.created_at).toLocaleDateString()} />
                <DetailRow label="Updated" value={new Date(item.updated_at).toLocaleDateString()} />
            </View>

            {/* ── Delete ── */}
            <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                <Text style={styles.deleteText}>🗑 Delete Item</Text>
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
    center: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#0A0A1A",
    },
    itemName: {
        fontSize: 24,
        fontWeight: "800",
        color: "#FFFFFF",
        marginBottom: 12,
    },
    statusBadge: {
        alignSelf: "flex-start",
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginBottom: 24,
    },
    statusText: {
        color: "#FFFFFF",
        fontSize: 12,
        fontWeight: "800",
        letterSpacing: 0.5,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: "800",
        color: "#6C5CE7",
        marginBottom: 12,
        textTransform: "uppercase",
        letterSpacing: 1,
    },
    detailRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A2E",
    },
    detailLabel: {
        color: "#888",
        fontSize: 14,
        fontWeight: "500",
    },
    detailValue: {
        color: "#FFFFFF",
        fontSize: 14,
        fontWeight: "600",
        maxWidth: "60%",
        textAlign: "right",
    },
    actionsRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 10,
    },
    transitionButton: {
        borderWidth: 1.5,
        borderRadius: 10,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    transitionText: {
        fontSize: 13,
        fontWeight: "700",
    },
    deleteButton: {
        backgroundColor: "#2D1F1F",
        borderWidth: 1,
        borderColor: "#E17055",
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: 8,
    },
    deleteText: {
        color: "#E17055",
        fontSize: 15,
        fontWeight: "700",
    },

    // Photos
    photoSection: { marginBottom: 20 },
    photoMain: {
        width: "100%",
        height: Dimensions.get("window").width * 0.7,
        borderRadius: 14,
        backgroundColor: "#16213E",
    },
    photoPlaceholder: {
        justifyContent: "center",
        alignItems: "center",
        borderWidth: 2,
        borderColor: "#2A2A4A",
        borderStyle: "dashed",
    },
    photoPlaceholderIcon: { fontSize: 36, marginBottom: 8 },
    photoPlaceholderText: { color: "#555", fontSize: 14, fontWeight: "600" },
    photoUploadOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: "rgba(0,0,0,0.55)",
        borderRadius: 14,
        justifyContent: "center",
        alignItems: "center",
    },
    photoEditOverlay: {
        position: "absolute",
        bottom: 10,
        right: 10,
        backgroundColor: "rgba(0,0,0,0.55)",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    photoEditOverlayText: {
        color: "#FFF",
        fontSize: 12,
        fontWeight: "700",
    },
    photoTabs: { flexDirection: "row", gap: 8, marginTop: 10 },
    photoTab: {
        flex: 1,
        paddingVertical: 8,
        alignItems: "center",
        borderRadius: 8,
        backgroundColor: "#1A1A2E",
        borderWidth: 1,
        borderColor: "#2A2A4A",
    },
    photoTabActive: { backgroundColor: "#6C5CE7", borderColor: "#6C5CE7" },
    photoTabText: { color: "#888", fontSize: 12, fontWeight: "700" },
    photoTabTextActive: { color: "#FFF" },

    // Smart pricing
    suggestBox: {
        backgroundColor: "#1A1A3E",
        borderRadius: 14,
        padding: 16,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: "#6C5CE7",
    },
    suggestLoading: { color: "#888", marginLeft: 10 },
    suggestHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
    suggestTitle: { color: "#B8A9E8", fontSize: 14, fontWeight: "800" },
    confidenceBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
    confidenceText: { color: "#FFF", fontSize: 10, fontWeight: "800" },
    suggestPrice: { color: "#FFFFFF", fontSize: 28, fontWeight: "900", marginBottom: 4 },
    suggestReason: { color: "#CCC", fontSize: 13, marginBottom: 2 },
    suggestBasis: { color: "#888", fontSize: 11, marginBottom: 12 },
    applyButton: {
        backgroundColor: "#6C5CE7",
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: "center",
    },
    applyButtonDisabled: { opacity: 0.6 },
    applyButtonText: { color: "#FFF", fontSize: 14, fontWeight: "700" },

    // Market price
    marketProduct: { flexDirection: "row", gap: 12, marginBottom: 12 },
    marketProductImage: {
        width: 70,
        height: 70,
        borderRadius: 8,
        backgroundColor: "#16213E",
    },
    marketProductInfo: { flex: 1 },
    marketProductTitle: { color: "#FFF", fontSize: 13, fontWeight: "600", marginBottom: 4 },
    marketProductBrand: { color: "#888", fontSize: 11, marginBottom: 4 },
    marketPriceRange: { color: "#00B894", fontSize: 15, fontWeight: "700" },
    historyRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A2E",
    },
    historyLabel: { color: "#888", fontSize: 13 },
    historyValue: { color: "#6C5CE7", fontSize: 14, fontWeight: "700" },
    sourceRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A2E",
    },
    sourceLabel: { color: "#999", fontSize: 13 },
    sourceValue: { color: "#FFF", fontSize: 13, fontWeight: "600" },
    noMarket: { color: "#555", fontSize: 13, fontStyle: "italic" },
});
