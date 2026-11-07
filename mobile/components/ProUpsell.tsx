/** Inline Pro upsell: explains what Pro adds here and links to Plans. */
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Button } from "./Button";
import { COLORS, SPACING } from "../theme/tokens";

export const SUBSCRIPTION_ROUTE = "/(tabs)/settings/subscription";

export function isProRequired(err: any): boolean {
  return err?.detail?.error === "pro_required" || err?.status === 403 && err?.detail?.feature != null;
}

export function ProUpsell({ message, testID = "pro-upsell" }: { message: string; testID?: string }) {
  const router = useRouter();
  return (
    <View testID={testID} style={styles.box}>
      <Text style={styles.text}>{message}</Text>
      <Button label="See Pro" size="sm" onPress={() => router.push(SUBSCRIPTION_ROUTE as any)} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: SPACING.sm, padding: SPACING.md, borderRadius: 12, borderWidth: 1, borderColor: COLORS.primary, backgroundColor: COLORS.bg },
  text: { color: COLORS.textSoft, fontSize: 14, lineHeight: 20 },
});
