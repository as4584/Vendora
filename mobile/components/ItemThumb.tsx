/** Small product photo for list rows (cart, pickers); an icon when there's no photo. */
import { Image, StyleSheet, View } from "react-native";
import type { InventoryItem } from "../services/api";
import { resolvedPhoto } from "../utils/inventory";
import { COLORS, RADII } from "../theme/tokens";
import { Icon } from "./ui";

export function ItemThumb({ item, size = 44 }: { item: InventoryItem; size?: number }) {
  const uri = resolvedPhoto(item, "front") || resolvedPhoto(item, "back");
  const box = { width: size, height: size, borderRadius: Math.min(RADII.md, size / 4) };
  return uri ? (
    <Image testID="item-thumb" source={{ uri }} style={[styles.base, box]} resizeMode="cover" accessibilityIgnoresInvertColors />
  ) : (
    <View testID="item-thumb-empty" style={[styles.base, styles.empty, box]}>
      <Icon name="image-outline" size={Math.round(size * 0.42)} color={COLORS.textSoft} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: COLORS.cardAlt, overflow: "hidden" },
  empty: { alignItems: "center", justifyContent: "center" },
});
