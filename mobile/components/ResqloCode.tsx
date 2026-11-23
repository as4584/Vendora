import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import * as api from "../services/api";
import { Card, SectionLabel } from "./ui";
import { COLORS, SPACING, TYPE } from "../theme/tokens";

/** The item's universal Resqlo code: every pair of this shoe in this size, in every store. */
export function ResqloCode({ itemId }: { itemId: string }) {
  const [product, setProduct] = useState<api.CatalogProduct | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getResqloCode(itemId)
      .then((p) => {
        if (!cancelled) setProduct(p);
      })
      .catch((err) => {
        // 422: the item has no style code yet. Offline or other errors: stay hidden.
        if (!cancelled && (err as { status?: number })?.status === 422) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (!product && !missing) return null;
  return (
    <Card>
      <SectionLabel>Resqlo code</SectionLabel>
      {product ? (
        <>
          <Text style={styles.code} selectable testID="resqlo-code">{product.rq_code}</Text>
          <Text style={styles.helper}>
            Every {product.name}
            {product.size ? ` in size ${product.size}` : ""} has this code in every store on Resqlo. Scan it anywhere and it fills in.
          </Text>
        </>
      ) : (
        <Text style={styles.helper}>Add a style code (or SKU) to give this item its Resqlo code.</Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  code: { ...TYPE.title, color: COLORS.text, letterSpacing: 2, marginVertical: SPACING.xs },
  helper: { ...TYPE.caption, color: COLORS.textMuted },
});
