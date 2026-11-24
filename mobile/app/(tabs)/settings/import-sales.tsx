/**
 * Import sales from another platform's sales report (Poshmark, Mercari,
 * Whatnot, Depop, or any CSV with a price column). Preview first, then
 * import; re-importing the same file adds nothing.
 */
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as api from "../../../services/api";
import { ActionButton, Card } from "../../../components/ui";
import { errorMessage } from "../../../services/errors";
import { COLORS, SPACING } from "../../../theme/tokens";

const PLATFORMS: { key: api.SalesPlatform; label: string }[] = [
  { key: "poshmark", label: "Poshmark" },
  { key: "mercari", label: "Mercari" },
  { key: "whatnot", label: "Whatnot" },
  { key: "depop", label: "Depop" },
  { key: "other_csv", label: "Other" },
];

type PickedFile = { uri: string; name: string; mimeType?: string };

export default function ImportSalesScreen() {
  const [platform, setPlatform] = useState<api.SalesPlatform>("poshmark");
  const [file, setFile] = useState<PickedFile | null>(null);
  const [preview, setPreview] = useState<api.SalesImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (picked: PickedFile, target: api.SalesPlatform, dryRun: boolean) => {
    setBusy(true);
    try {
      const result = await api.importSalesCsv(picked, target, dryRun);
      if (dryRun) {
        setPreview(result);
      } else {
        setPreview(null);
        setFile(null);
        Alert.alert("Sales imported", `${result.imported} sale${result.imported === 1 ? "" : "s"} added to your profit and tax totals.`);
      }
    } catch (err) {
      Alert.alert(dryRun ? "Couldn't read that file" : "Import failed", errorMessage(err, "Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["text/csv", "text/comma-separated-values", "application/vnd.ms-excel", "*/*"],
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const picked = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? undefined };
    setFile(picked);
    await run(picked, platform, true);
  };

  const pickPlatform = (key: api.SalesPlatform) => {
    setPlatform(key);
    if (file) void run(file, key, true);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }}>
      <Text accessibilityRole="header" style={styles.title}>Import sales</Text>
      <Text style={styles.muted}>
        Sold somewhere Resqlo doesn&apos;t connect to yet? Download your sales report as a CSV from that site,
        then pick it here. Your fees and profit come with it.
      </Text>
      <View style={styles.chips}>
        {PLATFORMS.map((p) => (
          <TouchableOpacity key={p.key} accessibilityRole="button" accessibilityState={{ selected: platform === p.key }}
            onPress={() => pickPlatform(p.key)} style={[styles.chip, platform === p.key && styles.chipActive]}>
            <Text style={[styles.chipText, platform === p.key && styles.chipTextActive]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ActionButton label={busy && !preview ? "Reading..." : file ? "Choose a different file" : "Choose CSV file"}
        tone={file ? "secondary" : "primary"} onPress={() => void choose()} disabled={busy} />

      {preview ? (
        <Card>
          <Text style={styles.section}>{file?.name}</Text>
          {preview.new_sales > 0 ? (
            <>
              <Text style={styles.big}>{preview.new_sales} new sale{preview.new_sales === 1 ? "" : "s"}</Text>
              <Text style={styles.line}>{`$${Number(preview.gross_total).toFixed(2)} sold · $${Number(preview.fee_total).toFixed(2)} in fees`}</Text>
            </>
          ) : (
            <Text style={styles.big}>No new sales to import</Text>
          )}
          {preview.duplicates > 0 ? <Text style={styles.muted}>{preview.duplicates} already imported, skipped.</Text> : null}
          {preview.missing_dates > 0 ? <Text style={styles.muted}>{preview.missing_dates} without a date will use today.</Text> : null}
          {preview.errors.slice(0, 3).map((e) => (
            <Text key={`${e.row}-${e.reason}`} style={styles.warn}>{e.row > 1 ? `Row ${e.row}: ` : ""}{e.reason}</Text>
          ))}
          {preview.new_sales > 0 && file ? (
            <View style={{ marginTop: SPACING.sm }}>
              <ActionButton label={busy ? "Importing..." : `Import ${preview.new_sales} sale${preview.new_sales === 1 ? "" : "s"}`}
                onPress={() => void run(file, platform, false)} disabled={busy} />
            </View>
          ) : null}
        </Card>
      ) : null}
      <Text style={styles.muted}>
        Imported sales count toward profit, the tax pack and your dashboard. They aren&apos;t matched to inventory items, so stock counts don&apos;t change.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "700" },
  section: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600", marginBottom: 4 },
  big: { color: COLORS.text, fontSize: 18, fontWeight: "700" },
  line: { color: COLORS.text, fontSize: 14, marginTop: 2 },
  muted: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  warn: { color: COLORS.warning, fontSize: 13, lineHeight: 19, marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
});
