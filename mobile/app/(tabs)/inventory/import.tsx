import { useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Alert,
  ScrollView,
  Platform,
  TextInput,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel, Stepper } from "../../../components/ui";
import { GoogleSheetsPrompt } from "../../../components/GoogleSheets";
import { COLORS, SPACING } from "../../../theme/tokens";
import ImportReview from "../../../components/ImportReview";

export default function InventoryImportScreen() {
  const [preview, setPreview] = useState<api.InventoryImportPreview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [link, setLink] = useState("");
  const [linkResult, setLinkResult] = useState<api.InventoryImportResult | null>(null);
  const [linkLoading, setLinkLoading] = useState<"preview" | "import" | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Bring a freshly loaded review into view once it has laid out.
  const scrollToReview = useRef(false);

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        "text/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    setFileName(asset.name);
    setLoading(true);
    try {
      const formData = new FormData();
      if (Platform.OS === "web") {
        const blob = await fetch(asset.uri).then((response) => response.blob());
        formData.append("file", blob, asset.name);
      } else {
        formData.append("file", {
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType || "text/csv",
        } as any);
      }
      const nextPreview = await api.previewInventoryImport(formData);
      scrollToReview.current = true;
      setPreview(nextPreview);
    } catch (err: any) {
      Alert.alert("Import preview failed", err?.message || "Could not read this CSV file.");
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    setCommitting(true);
    try {
      const result = await api.commitInventoryImport(preview!.job_id);
      const added = result.rows_created + result.rows_updated;
      Alert.alert(
        added === 1 ? "1 item added" : `${added} items added`,
        `${result.rows_created} new, ${result.rows_updated} updated${result.rows_skipped ? `, ${result.rows_skipped} left out` : ""}.`
      );
      setPreview(null);
      setFileName(null);
    } catch (err: any) {
      Alert.alert("Import failed", err?.message || "Could not commit the import.");
    } finally {
      setCommitting(false);
    }
  };

  const handleLinkImport = async (dryRun: boolean) => {
    const trimmedLink = link.trim();
    if (!trimmedLink) {
      Alert.alert("Spreadsheet link required", "Paste a read-only Google Sheets, CSV, or XLSX link first.");
      return;
    }

    setLinkLoading(dryRun ? "preview" : "import");
    setLinkResult(null);
    try {
      const result = await api.importInventoryFromLink(trimmedLink, dryRun);
      setLinkResult(result);
      const importedCount = result.created + result.updated;
      const photoSampleCount = result.sample_items.filter(
        (item) => typeof item.photo_front_url === "string" && item.photo_front_url.startsWith("data:image/")
      ).length;
      const missingPriceCount = result.warnings.filter((issue) => issue.message.includes("Price missing")).length;
      const missingSizeCount = result.warnings.filter((issue) => issue.message.includes("Size missing")).length;
      const missingPhotoCount = result.warnings.filter((issue) => issue.message.includes("Photo missing")).length;
      const reviewMessage =
        missingPriceCount || missingSizeCount || missingPhotoCount
          ? ` Needs review: ${[
              missingPriceCount ? `${missingPriceCount} missing price` : null,
              missingSizeCount ? `${missingSizeCount} missing size` : null,
              missingPhotoCount ? `${missingPhotoCount} missing photo` : null,
            ].filter(Boolean).join(", ")}.`
          : "";
      if (dryRun) {
        Alert.alert(
          result.rows_importable > 0 ? "Preview ready" : "No importable items found",
          `${result.rows_importable} item${result.rows_importable === 1 ? "" : "s"} found. ` +
            `${result.created} would be created, ${result.updated} would be updated, ${result.skipped} skipped.` +
            (photoSampleCount > 0 ? ` Photos detected in ${photoSampleCount} preview item${photoSampleCount === 1 ? "" : "s"}.` : "") +
            reviewMessage
        );
      } else {
        Alert.alert(
          importedCount > 0 ? "Spreadsheet imported" : "No items imported",
          `${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`
        );
      }
    } catch (err: any) {
      Alert.alert("Link import failed", err?.message || "Could not import from this spreadsheet link.");
    } finally {
      setLinkLoading(null);
    }
  };

  return (
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle
        title="Import Inventory"
        subtitle="Upload a CSV, review each item, then add them to your inventory."
      />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Flow</SectionLabel>
        <Stepper steps={["Upload", "Review", "Add"]} active={preview ? 1 : 0} />
        <Text style={styles.helperText}>
          Re-importing a Resqlo export updates the same items. Nothing is duplicated, and rows we can’t read are flagged so you can fix them.
        </Text>
        <ActionButton label={loading ? "Preparing Preview..." : "Choose CSV File"} onPress={handlePickFile} disabled={loading} />
        {fileName ? <Text style={styles.fileName}>Selected: {fileName}</Text> : null}
      </Card>

      <GoogleSheetsPrompt title="Keep a Google Sheet in sync instead" cta="Set up Google Sheets sync" />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Read-Only Link</SectionLabel>
        <TextInput
          accessibilityLabel="Spreadsheet link"
          value={link}
          onChangeText={setLink}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://docs.google.com/spreadsheets/d/..."
          placeholderTextColor={COLORS.textMuted}
          style={styles.input}
        />
        <View style={styles.actionRow}>
          <ActionButton
            label={linkLoading === "preview" ? "Checking..." : "Preview Link"}
            onPress={() => handleLinkImport(true)}
            disabled={Boolean(linkLoading)}
            tone="secondary"
            compact
          />
          <ActionButton
            label={linkLoading === "import" ? "Importing..." : "Import Link"}
            onPress={() => handleLinkImport(false)}
            disabled={Boolean(linkLoading)}
            compact
          />
        </View>
        {linkResult ? (
          <View style={styles.previewList}>
            <View style={styles.summaryRow}>
              <Pill label={`Importable ${linkResult.rows_importable}`} tone="info" />
              <Pill label={`Create ${linkResult.created}`} tone="success" />
              <Pill label={`Update ${linkResult.updated}`} tone="info" />
              <Pill label={`Skipped ${linkResult.skipped}`} tone="neutral" />
              <Pill label={`Errors ${linkResult.errors.length}`} tone={linkResult.errors.length ? "danger" : "neutral"} />
              <Pill
                label={`Review ${linkResult.warnings.length}`}
                tone={linkResult.warnings.length ? "warning" : "neutral"}
              />
            </View>
            {linkResult.sample_items.slice(0, 3).map((item, index) => (
              <View key={`${item.name || "item"}-${index}`} style={styles.previewRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.previewTitle}>{item.name || "Imported item"}</Text>
                  <Text style={styles.previewBody}>
                    {[item.sku, item.category, item.expected_sell_price ? `$${item.expected_sell_price}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </View>
            ))}
            {linkResult.errors.slice(0, 3).map((issue) => (
              <Text key={`${issue.row}-${issue.message}`} style={styles.errorText}>
                Row {issue.row}: {issue.message}
              </Text>
            ))}
            {linkResult.warnings.slice(0, 3).map((issue) => (
              <Text key={`warning-${issue.row}-${issue.message}`} style={styles.warningText}>
                Row {issue.row}: {issue.message}
              </Text>
            ))}
          </View>
        ) : null}
      </Card>

      {preview ? (
        <View
          onLayout={(event) => {
            if (!scrollToReview.current) return;
            scrollToReview.current = false;
            scrollRef.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y - SPACING.md), animated: true });
          }}
        >
          <ImportReview key={preview.job_id} preview={preview} committing={committing} onCommit={handleCommit} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  fileName: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: SPACING.md,
    color: COLORS.text,
    backgroundColor: COLORS.cardAlt,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm },
  summaryRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  previewList: { gap: SPACING.sm },
  previewRow: {
    flexDirection: "row",
    gap: SPACING.sm,
    alignItems: "center",
    paddingBottom: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  previewTitle: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  previewBody: { color: COLORS.textMuted, fontSize: 12, marginTop: 3 },
  errorText: { color: COLORS.danger, fontSize: 12, lineHeight: 18 },
  warningText: { color: COLORS.warning, fontSize: 12, lineHeight: 18 },
});
