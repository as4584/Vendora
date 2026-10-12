/**
 * Thin status strip shown under the status bar:
 *  - offline  → amber "Offline — changes will sync when you're back"
 *  - online with a backlog → blue "Syncing N change(s)…"
 *  - offline changes the server rejected → red, dismissible notice
 *  - online & empty → nothing
 */
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNetwork } from "../context/network";
import { COLORS } from "../theme/tokens";

export function OfflineBanner() {
  const { online, pending, failed, dismissFailed } = useNetwork();
  const insets = useSafeAreaInsets();

  if (failed > 0 && online && pending === 0) {
    return (
      <View style={[styles.bar, { paddingTop: insets.top + 6, backgroundColor: COLORS.danger }]}>
        <Text style={styles.text}>
          {failed} offline change{failed === 1 ? "" : "s"} couldn&apos;t be saved. Please check and re-enter.
        </Text>
        <TouchableOpacity accessibilityRole="button" onPress={dismissFailed} hitSlop={10}>
          <Text style={[styles.text, styles.dismiss]}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (online && pending === 0) return null;

  const offline = !online;
  const label = offline
    ? pending > 0
      ? `Offline · ${pending} change${pending === 1 ? "" : "s"} queued`
      : "Offline · changes will sync when you're back"
    : `Syncing ${pending} change${pending === 1 ? "" : "s"}…`;

  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top + 6, backgroundColor: offline ? COLORS.warning : COLORS.info },
      ]}
    >
      <View style={styles.dot} />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 7,
    paddingHorizontal: 14,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#0A0E1A",
    opacity: 0.55,
  },
  dismiss: { textDecorationLine: "underline" },
  text: {
    color: "#0A0E1A",
    fontSize: 12.5,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});
