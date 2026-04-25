import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Alert,
  ScrollView,
  TouchableOpacity,
  Platform,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel, Stepper } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";

export default function InventoryImportScreen() {
  const [preview, setPreview] = useState<api.InventoryImportPreview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);

  const handlePickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "text/csv",
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
      setPreview(nextPreview);
    } catch (err: any) {
      Alert.alert("Import preview failed", err?.message || "Could not read this CSV file.");
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview) return;
    setCommitting(true);
    try {
      const result = await api.commitInventoryImport(preview.job_id);
      Alert.alert(
        "Import committed",
        `${result.rows_created} created, ${result.rows_updated} updated, ${result.rows_skipped} skipped.`
      );
    } catch (err: any) {
      Alert.alert("Import failed", err?.message || "Could not commit the import.");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle
        title="Import Inventory"
        subtitle="Upload a CSV, preview the matches, then commit the changes into your local seeded account."
      />

      <Card style={{ gap: SPACING.md }}>
        <SectionLabel>Flow</SectionLabel>
        <Stepper steps={["Upload", "Preview", "Commit"]} active={preview ? 1 : 0} />
        <Text style={styles.helperText}>
          Spreadsheet import now understands the exported raw photo URLs and the seeded account round-trip columns.
        </Text>
        <ActionButton label={loading ? "Preparing Preview..." : "Choose CSV File"} onPress={handlePickFile} disabled={loading} />
        {fileName ? <Text style={styles.fileName}>Selected: {fileName}</Text> : null}
      </Card>

      {preview ? (
        <Card style={{ gap: SPACING.md }}>
          <SectionLabel>Preview Summary</SectionLabel>
          <View style={styles.summaryRow}>
            <Pill label={`Create ${preview.rows_to_create}`} tone="success" />
            <Pill label={`Update ${preview.rows_to_update}`} tone="info" />
            <Pill label={`Errors ${preview.rows_errored}`} tone={preview.rows_errored > 0 ? "danger" : "neutral"} />
          </View>
          <Text style={styles.helperText}>
            {preview.filename || "CSV file"} • {preview.total_rows} row{preview.total_rows === 1 ? "" : "s"}
          </Text>
          <View style={styles.previewList}>
            {preview.rows.slice(0, 8).map((row) => (
              <View key={`${row.row_number}-${row.action}`} style={styles.previewRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.previewTitle}>Row {row.row_number}</Text>
                  <Text style={styles.previewBody}>
                    {row.error_message ||
                      row.mapped_data?.name ||
                      row.match_value ||
                      "Spreadsheet row"}
                  </Text>
                </View>
                <Pill
                  label={(row.action || "skip").toUpperCase()}
                  tone={
                    row.action === "create"
                      ? "success"
                      : row.action === "update"
                        ? "info"
                        : row.action === "error"
                          ? "danger"
                          : "neutral"
                  }
                />
              </View>
            ))}
          </View>
          <ActionButton label={committing ? "Committing..." : "Commit Import"} onPress={handleCommit} disabled={committing} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  fileName: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
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
  previewTitle: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  previewBody: { color: COLORS.textMuted, fontSize: 12, marginTop: 3 },
});
