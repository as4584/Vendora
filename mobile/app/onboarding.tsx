/**
 * Required setup for new sellers. Step 1: get inventory in (spreadsheet
 * import or scan/add). Step 2: show what they now have, then open the app.
 * No tab bar and no skip; "Sign out" is the only other way out.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as api from "../services/api";
import { useAuth } from "../context/auth";
import { markOnboarded } from "../services/onboarding";
import { track } from "../services/telemetry";
import { Button } from "../components/Button";
import { Icon, type IconName } from "../components/ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

type Summary = { items: number; units: number; value: number };

function money(n: number) {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [checking, setChecking] = useState(true);

  // Every time they come back here (after importing or adding), check what landed.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      api
        .listItems({ perPage: 100 })
        .then((page) => {
          if (!live) return;
          if (page.total > 0) {
            const units = page.items.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
            const value = page.items.reduce((n, i) => n + (Number(i.expected_sell_price ?? i.buy_price ?? 0) || 0) * (Number(i.quantity) || 0), 0);
            setSummary({ items: page.total, units, value });
            track("onboarding_step", { step: "inventory_added", items: page.total });
          } else {
            track("onboarding_step", { step: "choose" });
          }
        })
        .catch(() => undefined)
        .finally(() => live && setChecking(false));
      return () => {
        live = false;
      };
    }, []),
  );

  const finish = async () => {
    track("onboarding_step", { step: "finished" });
    if (user?.id) await markOnboarded(String(user.id));
    router.replace("/(tabs)/dashboard");
  };

  return (
    <ScrollView
      testID="onboarding"
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + SPACING.xl, paddingBottom: insets.bottom + SPACING.lg }]}
    >
      {checking ? (
        <ActivityIndicator color={COLORS.primary} style={styles.checking} />
      ) : summary ? (
        <View testID="onboarding-done">
          <View style={styles.badge}>
            <Icon name="checkmark" size={34} color={COLORS.success} />
          </View>
          <Text accessibilityRole="header" style={styles.title}>{"You're set up"}</Text>
          <Text style={styles.sub}>Your inventory is in. Here is what you are working with:</Text>
          <View style={styles.stats}>
            <Stat label="Items" value={String(summary.items)} />
            <Stat label="Units" value={String(summary.units)} />
            <Stat label="Value" value={money(summary.value)} />
          </View>
          <Text style={styles.next}>Next: sell from the Sales tab and Resqlo tracks profit after fees automatically.</Text>
          <Button testID="onboarding-finish" label="Open my dashboard" onPress={finish} fullWidth />
        </View>
      ) : (
        <View testID="onboarding-choose">
          <Text style={styles.step}>Step 1 of 2</Text>
          <Text accessibilityRole="header" style={styles.title}>{"Let's get your inventory in"}</Text>
          <Text style={styles.sub}>Takes about a minute. Pick whichever is faster for you.</Text>

          <Choice
            testID="onboarding-import"
            icon="document-text-outline"
            title="Import my spreadsheet"
            body="Excel or CSV. We match the columns for you and you review before anything saves."
            onPress={() => router.push("/inventory/import")}
          />
          <Choice
            testID="onboarding-scan"
            icon="barcode-outline"
            title="Scan or add my first item"
            body="Point the camera at a box label or card, or type it in."
            onPress={() => router.push("/inventory/add")}
          />
          <Choice
            testID="onboarding-batch"
            icon="layers-outline"
            title="Scan a stack of boxes"
            body="Scan many in a row, set the cost once, save them all."
            onPress={() => router.push("/inventory/batch-scan")}
          />
        </View>
      )}

      <TouchableOpacity accessibilityRole="button" onPress={() => void signOut()} style={styles.signOut} hitSlop={8}>
        <Text style={styles.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Choice({ testID, icon, title, body, onPress }: { testID: string; icon: IconName; title: string; body: string; onPress: () => void }) {
  return (
    <TouchableOpacity testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityHint={body} onPress={onPress} style={styles.choice}>
      <View style={styles.choiceIcon}>
        <Icon name={icon} size={24} color={COLORS.primaryBright} />
      </View>
      <View style={styles.choiceText}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceBody}>{body}</Text>
      </View>
      <Icon name="chevron-forward" size={18} color={COLORS.textSoft} />
    </TouchableOpacity>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: SPACING.md, flexGrow: 1, maxWidth: 560, width: "100%", alignSelf: "center" },
  checking: { marginTop: SPACING.xl },
  step: { ...TYPE.caption, color: COLORS.primaryBright, textTransform: "uppercase", letterSpacing: 0.6 },
  title: { ...TYPE.largeTitle, color: COLORS.text, marginTop: SPACING.xs },
  sub: { ...TYPE.body, color: COLORS.textMuted, marginTop: SPACING.xs, marginBottom: SPACING.lg },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    backgroundColor: COLORS.card,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    minHeight: 76,
  },
  choiceIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.primarySoft, alignItems: "center", justifyContent: "center" },
  choiceText: { flex: 1, gap: 2 },
  choiceTitle: { ...TYPE.headline, color: COLORS.text },
  choiceBody: { ...TYPE.footnote, color: COLORS.textMuted },
  badge: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.card, alignItems: "center", justifyContent: "center", marginBottom: SPACING.md },
  stats: { flexDirection: "row", gap: SPACING.sm, marginBottom: SPACING.lg },
  stat: { flex: 1, backgroundColor: COLORS.card, borderRadius: RADII.lg, padding: SPACING.md, alignItems: "center" },
  statValue: { ...TYPE.figure, color: COLORS.text },
  statLabel: { ...TYPE.caption, color: COLORS.textMuted, marginTop: 2 },
  next: { ...TYPE.subhead, color: COLORS.textMuted, marginBottom: SPACING.md },
  signOut: { alignSelf: "center", marginTop: "auto", paddingTop: SPACING.xl, minHeight: 44, justifyContent: "center" },
  signOutText: { ...TYPE.subhead, color: COLORS.textSoft },
});
