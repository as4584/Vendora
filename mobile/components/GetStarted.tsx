/** First-run checklist on the Dashboard: add an item, record a sale, connect a marketplace. */
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as api from "../services/api";
import { Icon } from "./ui";
import { COLORS, SPACING } from "../theme/tokens";

const dismissKey = (userId: string) => `vendora.getStarted.dismissed.${userId}`;

export interface GetStartedProps {
  userId: string;
  totalItems: number;
  itemsSold: number;
}

export function GetStarted({ userId, totalItems, itemsSold }: GetStartedProps) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(dismissKey(userId))
      .then((v) => { if (live) setDismissed(v === "1"); })
      .catch(() => { if (live) setDismissed(false); });
    Promise.allSettled([api.getEbayStatus(), api.getStockxStatus()]).then((r) => {
      if (live) setConnected(r.some((x) => x.status === "fulfilled" && (x.value as { connected?: boolean } | undefined)?.connected));
    });
    return () => { live = false; };
  }, [userId]);

  const steps = [
    { key: "item", label: "Add your first item", done: totalItems > 0, route: "/inventory/add" },
    { key: "sale", label: "Record your first sale", done: itemsSold > 0, route: "/inventory/sale" },
    { key: "connect", label: "Connect eBay or StockX", done: connected, route: "/settings" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (dismissed !== false || doneCount === steps.length) return null;

  const dismiss = () => {
    setDismissed(true);
    AsyncStorage.setItem(dismissKey(userId), "1").catch(() => {});
  };

  return (
    <View testID="get-started" style={styles.box}>
      <View style={styles.head}>
        <Text accessibilityRole="header" style={styles.title}>{`Get started · ${doneCount} of ${steps.length}`}</Text>
        <TouchableOpacity testID="get-started-dismiss" accessibilityRole="button" accessibilityLabel="Hide get started" onPress={dismiss} hitSlop={12}>
          <Icon name="close" size={18} color={COLORS.textMuted} />
        </TouchableOpacity>
      </View>
      {steps.map((s) => (
        <TouchableOpacity
          key={s.key}
          testID={`get-started-${s.key}`}
          accessibilityRole="button"
          accessibilityState={{ checked: s.done }}
          disabled={s.done}
          onPress={() => router.push(s.route as never)}
          style={styles.row}
        >
          <Icon name={s.done ? "checkmark-circle" : "ellipse-outline"} size={20} color={s.done ? COLORS.primaryBright : COLORS.textMuted} />
          <Text style={[styles.label, s.done && styles.labelDone]}>{s.label}</Text>
          {!s.done ? <Icon name="chevron-forward" size={16} color={COLORS.textMuted} /> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: SPACING.xs, padding: SPACING.md, borderRadius: 12, borderWidth: 1, borderColor: COLORS.primary, backgroundColor: COLORS.bg, marginBottom: SPACING.md },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SPACING.xs },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, paddingVertical: 10, minHeight: 44 },
  label: { flex: 1, color: COLORS.text, fontSize: 15 },
  labelDone: { color: COLORS.textMuted, textDecorationLine: "line-through" },
});
