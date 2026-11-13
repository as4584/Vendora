/**
 * Required setup for new sellers, in the glass style. Step 1: get inventory
 * in (spreadsheet import, scan/add, or batch scan). Step 2: a payoff panel
 * with a ring gauge showing what they now have, then the app opens.
 * No tab bar and no skip; "Sign out" is the only other way out.
 */
import { useCallback, useState } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle } from "react-native-svg";
import * as api from "../services/api";
import { useAuth } from "../context/auth";
import { markOnboarded } from "../services/onboarding";
import { track } from "../services/telemetry";
import { Button } from "../components/Button";
import { Icon, type IconName } from "../components/ui";
import { COLORS, FONT_SCALE, GRADIENTS, RADII, SPACING, TONES, TYPE } from "../theme/tokens";

type Summary = { items: number; units: number; value: number; inStockPct: number };

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
            const qty = (i: api.InventoryItem) => Number(i.quantity) || 0;
            const units = page.items.reduce((n, i) => n + qty(i), 0);
            const value = page.items.reduce((n, i) => n + (Number(i.expected_sell_price ?? i.buy_price ?? 0) || 0) * qty(i), 0);
            const priced = page.items.filter((i) => i.expected_sell_price != null).length;
            setSummary({ items: page.total, units, value, inStockPct: page.items.length ? priced / page.items.length : 0 });
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

  const step = summary ? 2 : 1;

  return (
    <ScrollView
      testID="onboarding"
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + SPACING.md }]}
    >
      <View style={styles.topBar}>
        <View style={styles.brand}>
          <Image source={require("../assets/brand/resqlo-logo.png")} style={styles.logo} accessibilityIgnoresInvertColors />
          <Text style={styles.brandName}>Resqlo</Text>
        </View>
        <View style={styles.progress} accessible accessibilityLabel={`Step ${step} of 2`}>
          {[1, 2].map((n) => (
            <View key={n} style={[styles.progressDot, n <= step && styles.progressDotOn]} />
          ))}
        </View>
      </View>

      {checking ? (
        <ActivityIndicator color={COLORS.primaryBright} style={styles.checking} />
      ) : summary ? (
        <View testID="onboarding-done">
          <LinearGradient colors={GRADIENTS.hero} style={[styles.glass, styles.hero]}>
            <Text style={styles.kicker}>{"You're set up"}</Text>
            <Text accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.display} style={styles.heroTitle}>
              Your inventory is in
            </Text>
            <View style={styles.ringRow}>
              <Ring progress={Math.max(0.08, summary.inStockPct)} label={money(summary.value)} sub="Inventory value" />
            </View>
          </LinearGradient>

          <View style={styles.statRow}>
            <Stat icon="cube-outline" label="Items" value={String(summary.items)} />
            <Stat icon="layers-outline" label="Units" value={String(summary.units)} />
          </View>

          <View style={[styles.glass, styles.nextCard]}>
            <View style={styles.nextIcon}>
              <Icon name="flash-outline" size={18} color={TONES.primary.text} />
            </View>
            <Text style={styles.nextText}>Next: sell from the Sales tab. Resqlo works out your profit after fees for you.</Text>
          </View>

          <Button testID="onboarding-finish" label="Open my dashboard" onPress={finish} fullWidth />
        </View>
      ) : (
        <View testID="onboarding-choose">
          <LinearGradient colors={GRADIENTS.hero} style={[styles.glass, styles.hero]}>
            <Text style={styles.kicker}>Step 1 of 2 · about a minute</Text>
            <Text accessibilityRole="header" maxFontSizeMultiplier={FONT_SCALE.display} style={styles.heroTitle}>
              {"Let's get your inventory in"}
            </Text>
            <Text style={styles.heroSub}>Pick whichever is fastest for you. You can add more any time.</Text>
          </LinearGradient>

          <Choice
            testID="onboarding-import"
            icon="document-text-outline"
            title="Import my spreadsheet"
            body="Excel or CSV. We match the columns and you review before anything saves."
            badge="Fastest"
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

/** Ring gauge (as in the glass dashboard reference): value in the middle. */
function Ring({ progress, label, sub }: { progress: number; label: string; sub: string }) {
  const size = 188;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityLabel={`${sub} ${label}`}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={COLORS.cardAlt} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={COLORS.primaryBright}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * Math.min(1, progress)} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.ringCenter}>
        <Text maxFontSizeMultiplier={FONT_SCALE.display} adjustsFontSizeToFit numberOfLines={1} style={styles.ringValue}>
          {label}
        </Text>
        <Text style={styles.ringSub}>{sub}</Text>
      </View>
    </View>
  );
}

function Choice({
  testID,
  icon,
  title,
  body,
  badge,
  onPress,
}: {
  testID: string;
  icon: IconName;
  title: string;
  body: string;
  badge?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={body}
      onPress={onPress}
      activeOpacity={0.75}
      style={[styles.glass, styles.choice]}
    >
      <View style={styles.choiceIcon}>
        <Icon name={icon} size={24} color={COLORS.text} />
      </View>
      <View style={styles.choiceText}>
        <View style={styles.choiceHead}>
          <Text style={styles.choiceTitle}>{title}</Text>
          {badge ? (
            <View style={styles.badge}>
              <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.choiceBody}>{body}</Text>
      </View>
      <View style={styles.chevron}>
        <Icon name="arrow-forward" size={16} color={COLORS.text} />
      </View>
    </TouchableOpacity>
  );
}

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <View style={[styles.glass, styles.stat]}>
      <Icon name={icon} size={18} color={COLORS.textMuted} />
      <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { paddingHorizontal: SPACING.md, flexGrow: 1, maxWidth: 560, width: "100%", alignSelf: "center", gap: SPACING.sm },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: SPACING.sm },
  brand: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  logo: { width: 30, height: 30, borderRadius: 9 },
  brandName: { ...TYPE.headline, color: COLORS.text },
  progress: { flexDirection: "row", gap: 6, padding: 6, borderRadius: RADII.pill, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.border },
  progressDot: { width: 22, height: 6, borderRadius: 3, backgroundColor: COLORS.cardAlt },
  progressDotOn: { backgroundColor: COLORS.primaryBright },
  checking: { marginTop: SPACING.xl },
  glass: { borderRadius: RADII.xl, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.card },
  hero: { padding: SPACING.lg, marginBottom: SPACING.sm, overflow: "hidden" },
  kicker: { ...TYPE.caption, color: COLORS.primaryBright, textTransform: "uppercase", letterSpacing: 0.8 },
  heroTitle: { fontSize: 34, lineHeight: 40, fontWeight: "700", color: COLORS.text, marginTop: SPACING.xs, letterSpacing: -0.5 },
  heroSub: { ...TYPE.body, color: COLORS.textMuted, marginTop: SPACING.xs },
  ringRow: { alignItems: "center", marginTop: SPACING.lg },
  ringCenter: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  ringValue: { fontSize: 32, fontWeight: "700", color: COLORS.text, fontVariant: ["tabular-nums"] },
  ringSub: { ...TYPE.caption, color: COLORS.textMuted, marginTop: 2 },
  choice: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, padding: SPACING.md, minHeight: 88 },
  choiceIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.cardAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceText: { flex: 1, gap: 4 },
  choiceHead: { flexDirection: "row", alignItems: "center", gap: SPACING.xs, flexWrap: "wrap" },
  choiceTitle: { ...TYPE.headline, color: COLORS.text },
  choiceBody: { ...TYPE.footnote, color: COLORS.textMuted },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: RADII.pill, backgroundColor: TONES.primary.bg },
  badgeText: { ...TYPE.caption, color: TONES.primary.text },
  chevron: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.cardAlt, alignItems: "center", justifyContent: "center" },
  statRow: { flexDirection: "row", gap: SPACING.sm, marginBottom: SPACING.sm },
  stat: { flex: 1, padding: SPACING.md, gap: 4 },
  statValue: { ...TYPE.figure, color: COLORS.text },
  statLabel: { ...TYPE.caption, color: COLORS.textMuted },
  nextCard: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, padding: SPACING.md, marginBottom: SPACING.md },
  nextIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: TONES.primary.bg, alignItems: "center", justifyContent: "center" },
  nextText: { ...TYPE.subhead, color: COLORS.text, flex: 1 },
  signOut: { alignSelf: "center", marginTop: "auto", paddingTop: SPACING.lg, minHeight: 44, justifyContent: "center" },
  signOutText: { ...TYPE.subhead, color: COLORS.textSoft },
});
