import { useState } from "react";
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "../theme/tokens";

/** Square product photography, including a deliberate fallback for broken URLs. */
export function ProductImage({ uri, label, fallbackLabel, style }: {
  uri?: string | null;
  label: string;
  fallbackLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return (
    <View style={[styles.frame, style]}>
      {uri && failedUri !== uri ? (
        <Image accessibilityLabel={label} source={{ uri }} resizeMode="cover"
          style={StyleSheet.absoluteFill} onError={() => setFailedUri(uri)} />
      ) : (
        <View accessibilityRole="image" accessibilityLabel={`No photo: ${label}`} style={styles.fallback}>
          <Ionicons name="cube-outline" size={24} color={COLORS.textSoft} />
          {fallbackLabel ? <Text style={styles.caption}>{fallbackLabel}</Text> : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { aspectRatio: 1, overflow: "hidden", borderRadius: 10, backgroundColor: COLORS.cardAlt },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 8 },
  caption: { color: COLORS.textMuted, fontSize: 14, textAlign: "center" },
});
