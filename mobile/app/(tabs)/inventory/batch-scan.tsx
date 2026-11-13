/**
 * Batch Smart Scan: scan box after box without leaving the camera, then review and
 * save them all at once. Known barcodes fill themselves in; boxes you already stock
 * add to the existing item instead of creating a duplicate.
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";
import { rememberScan, resolveScan } from "../../../services/smartScan";
import { captureSession, isCurrentSession } from "../../../services/session";
import {
  addScan,
  applyCostToAll,
  missingNames,
  planSave,
  setQty,
  totalUnits,
  updateEntry,
  type TrayEntry,
} from "../../../services/batchScan";
import { Button, triggerHaptic } from "../../../components/Button";
import { Icon } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";

const BARCODE_TYPES = ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39"] as const;

export default function BatchScanScreen() {
  const session = captureSession();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [tray, setTray] = useState<TrayEntry[]>([]);
  const [mode, setMode] = useState<"scan" | "review">("scan");
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const trayRef = useRef<TrayEntry[]>([]);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    trayRef.current = tray;
  }, [tray]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const onScanned = async ({ data }: { data: string }) => {
    const code = data.trim();
    if (!code || inFlight.current.has(code) || !isCurrentSession(session)) return;
    const now = Date.now();
    // A box already in the tray: count it without another lookup.
    if (trayRef.current.some((e) => e.barcode === code)) {
      const { tray: next, added } = addScan(trayRef.current, code, trayRef.current.find((e) => e.barcode === code)!.fields, true, now);
      if (added) {
        triggerHaptic("success");
        trayRef.current = next;
        setTray(next);
      }
      return;
    }
    inFlight.current.add(code);
    try {
      const [hit, existing] = await Promise.all([
        resolveScan(code, undefined, session).catch(() => null),
        api.listItems({ upc: code, perPage: 1 }).then((r) => r.items[0] ?? null).catch(() => null),
      ]);
      if (!isCurrentSession(session)) return;
      const known = !!hit?.match;
      const { tray: next, added } = addScan(trayRef.current, code, hit?.fields ?? {}, known, Date.now(), existing);
      if (added) {
        triggerHaptic(known ? "success" : "light");
        trayRef.current = next;
        setTray(next);
      }
    } finally {
      inFlight.current.delete(code);
    }
  };

  const saveAll = async () => {
    if (!isCurrentSession(session)) return;
    const unnamed = missingNames(tray);
    if (unnamed.length) {
      Alert.alert("Name every new item", unnamed.length === 1 ? "1 box still needs a name." : `${unnamed.length} boxes still need a name.`);
      return;
    }
    setSaving(true);
    let created = 0;
    let added = 0;
    const failed: TrayEntry[] = [];
    for (const action of planSave(tray)) {
      if (!isCurrentSession(session)) return;
      try {
        if (action.kind === "create") {
          await api.createItem(action.payload);
          created += 1;
          rememberScan(action.entry.barcode, action.entry.fields, session).catch(() => undefined);
        } else {
          await api.updateItem(action.itemId, {
            quantity: action.quantity,
            expected_quantity: action.expected,
            ...(action.variants ? { custom_attributes: { ...(action.entry.existing?.custom_attributes ?? {}), variants: action.variants } } : {}),
          });
          added += 1;
        }
      } catch {
        failed.push(action.entry);
      }
    }
    if (!isCurrentSession(session)) return;
    setSaving(false);
    if (failed.length) {
      setTray(failed);
      Alert.alert("Some boxes didn't save", `${failed.length} left in the list. Check them and try again.`);
      return;
    }
    triggerHaptic("success");
    const parts = [created && `${created} new item${created === 1 ? "" : "s"}`, added && `${added} restocked`].filter(Boolean);
    Alert.alert("Saved", `${parts.join(", ")}.`);
    router.replace("/inventory");
  };

  if (permission && !permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.muted}>Allow the camera to scan boxes.</Text>
        <Button
          label={permission.canAskAgain ? "Allow camera" : "Open Settings"}
          onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings())}
        />
      </View>
    );
  }

  const units = totalUnits(tray);

  return (
    <View style={styles.container} testID="batch-scan">
      {mode === "scan" ? (
        <View style={styles.cameraWrap}>
          <CameraView
            testID="batch-camera"
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={saving ? undefined : onScanned}
          />
          <View style={styles.cameraHint} pointerEvents="none">
            <Text style={styles.hintText}>
              {units ? `${units} scanned · keep going` : "Point at a box barcode. Keep scanning."}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.costRow}>
          <TextInput
            accessibilityLabel="Cost for every box"
            style={styles.costInput}
            placeholder="Cost each, e.g. 110"
            placeholderTextColor={COLORS.textSoft}
            keyboardType="decimal-pad"
            value={cost}
            onChangeText={setCost}
          />
          <Button label="Apply to all" size="sm" variant="secondary" onPress={() => setTray((t) => applyCostToAll(t, cost))} />
        </View>
      )}

      <FlatList
        data={tray}
        keyExtractor={(e) => e.key}
        style={styles.list}
        contentContainerStyle={{ gap: SPACING.xs, padding: SPACING.md }}
        ListEmptyComponent={<Text style={styles.muted}>Scanned boxes show up here.</Text>}
        renderItem={({ item: e }) => (
          <View style={styles.row} testID={`tray-${e.barcode}`}>
            <View style={{ flex: 1, gap: 4 }}>
              {mode === "review" && !(e.addToExisting && e.existing) ? (
                <TextInput
                  accessibilityLabel={`Name for ${e.barcode}`}
                  style={[styles.nameInput, !e.fields.name && styles.needsName]}
                  placeholder="Item name"
                  placeholderTextColor={COLORS.textSoft}
                  value={e.fields.name ?? ""}
                  onChangeText={(name) => setTray((t) => updateEntry(t, e.key, { fields: { name } }))}
                />
              ) : (
                <Text style={styles.title} numberOfLines={1}>
                  {e.existing && e.addToExisting ? e.existing.name : e.fields.name || "New item · name it in review"}
                </Text>
              )}
              <Text style={styles.muted} numberOfLines={1}>
                {[e.fields.size && `Size ${e.fields.size}`, e.fields.buy_price && `Cost $${e.fields.buy_price}`, e.barcode]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {e.existing ? (
                <View style={styles.dupRow}>
                  <Text style={styles.dupText}>{`Already in stock (${e.existing.quantity}). Add to it`}</Text>
                  <Switch
                    accessibilityLabel={`Add ${e.barcode} to existing item`}
                    value={e.addToExisting}
                    onValueChange={(v) => setTray((t) => updateEntry(t, e.key, { addToExisting: v }))}
                  />
                </View>
              ) : null}
            </View>
            <View style={styles.qty}>
              <TouchableOpacity accessibilityLabel={`Fewer ${e.barcode}`} onPress={() => setTray((t) => setQty(t, e.key, e.qty - 1))} hitSlop={8}>
                <Icon name={e.qty === 1 ? "trash-outline" : "remove-circle-outline"} size={24} color={COLORS.textMuted} />
              </TouchableOpacity>
              <Text style={styles.qtyText}>{e.qty}</Text>
              <TouchableOpacity accessibilityLabel={`More ${e.barcode}`} onPress={() => setTray((t) => setQty(t, e.key, e.qty + 1))} hitSlop={8}>
                <Icon name="add-circle-outline" size={24} color={COLORS.primaryBright} />
              </TouchableOpacity>
            </View>
          </View>
        )}
      />

      <View style={styles.footer}>
        {mode === "scan" ? (
          <Button
            testID="batch-review"
            label={units ? `Review ${units} box${units === 1 ? "" : "es"}` : "Scan a box to start"}
            disabled={!units}
            fullWidth
            size="lg"
            onPress={() => setMode("review")}
          />
        ) : (
          <View style={{ gap: SPACING.xs }}>
            <Button testID="batch-save" label={`Save ${units}`} loading={saving} fullWidth size="lg" onPress={saveAll} />
            <Button label="Keep scanning" variant="ghost" fullWidth onPress={() => setMode("scan")} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: SPACING.sm, padding: SPACING.lg, backgroundColor: COLORS.bg },
  cameraWrap: { height: "38%", overflow: "hidden", backgroundColor: "#000" },
  cameraHint: { position: "absolute", bottom: SPACING.sm, left: 0, right: 0, alignItems: "center" },
  hintText: { color: "#fff", fontSize: 14, fontWeight: "600", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: SPACING.sm, paddingVertical: 6, borderRadius: 8, overflow: "hidden" },
  costRow: { flexDirection: "row", gap: SPACING.sm, alignItems: "center", padding: SPACING.md, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  costInput: { flex: 1, minHeight: 44, color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: SPACING.sm },
  list: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, padding: SPACING.sm, borderRadius: 12, backgroundColor: COLORS.bgElevated },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  muted: { color: COLORS.textMuted, fontSize: 13, textAlign: "left" },
  nameInput: { color: COLORS.text, fontSize: 15, minHeight: 40, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  needsName: { borderBottomColor: COLORS.primary },
  dupRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.xs },
  dupText: { color: COLORS.textSoft, fontSize: 13, flex: 1 },
  qty: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  qtyText: { color: COLORS.text, fontSize: 17, fontWeight: "700", minWidth: 22, textAlign: "center" },
  footer: { padding: SPACING.md, borderTopWidth: 1, borderTopColor: COLORS.border },
});
