/**
 * Import review: every previewed spreadsheet row rendered as the inventory
 * card it will become. Rows can be edited (validated like the importer) or
 * removed (with undo); rows that need a fix are flagged and left out until
 * fixed. Edits and removals are saved on the import job server-side, so the
 * commit applies exactly what the seller sees.
 */
import { useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import InventoryCard from "./InventoryCard";
import { Card, Pill } from "./ui";
import { COLORS, FONT_SCALE, RADII, SPACING } from "../theme/tokens";
import {
  commitLabel,
  draftFromRow,
  draftToPayload,
  EDIT_FIELDS,
  EditDraft,
  reviewCounts,
  reviewSummary,
  rowToItem,
  validateDraft,
} from "../utils/importReview";
import { errorMessage } from "../services/errors";

const BADGES: Record<string, { label: string; tone: "success" | "info" | "danger" }> = {
  create: { label: "New item", tone: "success" },
  update: { label: "Updates existing", tone: "info" },
  error: { label: "Needs a fix", tone: "danger" },
};

export interface ImportReviewProps {
  preview: api.InventoryImportPreview;
  committing: boolean;
  onCommit: () => void;
  onRowsChange?: (rows: api.ImportPreviewRow[]) => void;
}

export default function ImportReview({ preview, committing, onCommit, onRowsChange }: ImportReviewProps) {
  const [rows, setRowsState] = useState<api.ImportPreviewRow[]>(preview.rows);
  const [editing, setEditing] = useState<api.ImportPreviewRow | null>(null);
  const [draft, setDraft] = useState<EditDraft>({});
  const [errors, setErrors] = useState<ReturnType<typeof validateDraft>>({});
  const [saving, setSaving] = useState(false);
  const [lastRemoved, setLastRemoved] = useState<{ row: api.ImportPreviewRow; previousAction: string | null } | null>(null);

  const counts = useMemo(() => reviewCounts(rows), [rows]);
  const visible = rows.filter((r) => r.action !== "skip");

  const setRows = (updater: (prev: api.ImportPreviewRow[]) => api.ImportPreviewRow[]) => {
    setRowsState((prev) => {
      const next = updater(prev);
      onRowsChange?.(next);
      return next;
    });
  };
  const replaceRow = (next: api.ImportPreviewRow) =>
    setRows((prev) => prev.map((r) => (r.row_number === next.row_number ? next : r)));

  const openEdit = (row: api.ImportPreviewRow) => {
    setEditing(row);
    setDraft(draftFromRow(row));
    setErrors({});
  };

  const saveEdit = async () => {
    if (!editing) return;
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (!editing.id) return;
    setSaving(true);
    try {
      const updated = await api.updateInventoryImportRow(preview.job_id, editing.id, { data: draftToPayload(draft) });
      replaceRow(updated);
      if (updated.action === "error") {
        setErrors({ name: updated.error_message || "This row still can't be imported." });
      } else {
        setEditing(null);
      }
    } catch (err) {
      Alert.alert("Couldn't save the row", errorMessage(err, "Try again."));
    } finally {
      setSaving(false);
    }
  };

  const removeRow = async (row: api.ImportPreviewRow) => {
    if (!row.id) return;
    const previousAction = row.action;
    replaceRow({ ...row, action: "skip" });
    setLastRemoved({ row, previousAction });
    try {
      await api.updateInventoryImportRow(preview.job_id, row.id, { skip: true });
    } catch (err) {
      replaceRow(row);
      setLastRemoved(null);
      Alert.alert("Couldn't remove the row", errorMessage(err, "Try again."));
    }
  };

  const undoRemove = async () => {
    if (!lastRemoved?.row.id) return;
    const { row } = lastRemoved;
    setLastRemoved(null);
    replaceRow(row);
    try {
      const restored = await api.updateInventoryImportRow(preview.job_id, row.id!, { skip: false });
      replaceRow(restored);
    } catch (err) {
      replaceRow({ ...row, action: "skip" });
      Alert.alert("Couldn't restore the row", errorMessage(err, "Try again."));
    }
  };

  return (
    <View style={styles.wrap} testID="import-review">
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>Review import</Text>
        <Text style={styles.summary} testID="import-review-summary">{reviewSummary(counts)}</Text>
        <Text style={styles.helper}>
          {preview.filename || "Spreadsheet"} · Tap an item to edit it before it goes into your inventory.
        </Text>
      </View>

      {lastRemoved ? (
        <Card style={styles.undoBar}>
          <Text style={styles.undoText} numberOfLines={2}>Removed {rowToItem(lastRemoved.row).name}</Text>
          <Button label="Undo" onPress={undoRemove} variant="secondary" size="sm" />
        </Card>
      ) : null}

      {visible.map((row) => {
        const badge = BADGES[row.action || ""] || null;
        const item = rowToItem(row);
        const isError = row.action === "error";
        return (
          <InventoryCard
            key={row.row_number}
            item={item}
            onPress={() => openEdit(row)}
            accessibilityLabel={`Review ${item.name}`}
            flagged={isError}
            testID={`import-row-${row.row_number}`}
            badge={badge ? <Pill label={badge.label} tone={badge.tone} /> : null}
            footer={
              <>
                {isError ? (
                  <Text style={styles.errorText}>Row {row.row_number}: {`${row.error_message || "This row can't be imported yet."} It won't be added until it's fixed.`}</Text>
                ) : null}
                <View style={styles.rowActions}>
                  <Button label={isError ? "Fix" : "Edit"} leadingIcon="create-outline" onPress={() => openEdit(row)} variant="secondary" size="sm" accessibilityLabel={`${isError ? "Fix" : "Edit"} ${item.name}`} />
                  <Button label="Remove" leadingIcon="trash-outline" onPress={() => removeRow(row)} variant="ghost" size="sm" accessibilityLabel={`Remove ${item.name}`} />
                </View>
              </>
            }
          />
        );
      })}

      {visible.length === 0 ? (
        <Card><Text style={styles.helper}>Every row was removed. Undo a removal or choose another file.</Text></Card>
      ) : null}

      <Button
        label={committing ? "Adding..." : commitLabel(counts)}
        onPress={onCommit}
        loading={committing}
        disabled={committing || counts.importable === 0}
        fullWidth
        size="lg"
        haptic="success"
        testID="import-commit"
      />
      {counts.needsFix ? (
        <Text style={styles.helper}>Rows that need a fix are left out. Fix them first to include them.</Text>
      ) : null}

      <Modal visible={!!editing} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.sheetTitle}>
                Edit row {editing?.row_number}
              </Text>
            </View>
            <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
              {EDIT_FIELDS.map((f) => (
                <View key={f.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput
                    accessibilityLabel={f.label}
                    value={draft[f.key] ?? ""}
                    onChangeText={(text) => setDraft((d) => ({ ...d, [f.key]: text }))}
                    keyboardType={f.numeric === "int" ? "number-pad" : f.numeric === "money" ? "decimal-pad" : "default"}
                    multiline={f.multiline}
                    autoCapitalize={f.key === "sku" || f.key === "upc" ? "characters" : "sentences"}
                    placeholderTextColor={COLORS.textSoft}
                    style={[styles.input, f.multiline && styles.inputMultiline, errors[f.key] ? styles.inputError : null]}
                  />
                  {errors[f.key] ? <Text style={styles.errorText}>{errors[f.key]}</Text> : null}
                </View>
              ))}
            </ScrollView>
            <View style={styles.sheetActions}>
              <Button label="Cancel" onPress={() => setEditing(null)} variant="ghost" style={styles.flex} />
              <Button label="Save" onPress={saveEdit} loading={saving} disabled={saving} style={styles.flex} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: SPACING.sm },
  head: { gap: SPACING.xxs, marginTop: SPACING.xs },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "600" },
  summary: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  helper: { color: COLORS.textMuted, fontSize: 13, lineHeight: 19 },
  errorText: { color: COLORS.danger, fontSize: 13, lineHeight: 18 },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs, justifyContent: "flex-end" },
  undoBar: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, padding: SPACING.sm },
  undoText: { flex: 1, color: COLORS.text, fontSize: 14 },
  backdrop: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    maxHeight: "90%",
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  sheetHead: { padding: SPACING.lg, paddingBottom: SPACING.xs },
  sheetTitle: { color: COLORS.text, fontSize: 18, fontWeight: "600" },
  sheetBody: { paddingHorizontal: SPACING.lg, paddingBottom: SPACING.md, gap: SPACING.sm },
  field: { gap: SPACING.xxs },
  fieldLabel: { color: COLORS.textMuted, fontSize: 13, fontWeight: "600" },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.sm,
    paddingHorizontal: SPACING.sm,
    color: COLORS.text,
    backgroundColor: COLORS.cardAlt,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 80, paddingTop: SPACING.xs, textAlignVertical: "top" },
  inputError: { borderColor: COLORS.danger },
  sheetActions: { flexDirection: "row", gap: SPACING.sm, padding: SPACING.lg, paddingTop: SPACING.sm },
  flex: { flex: 1 },
});
