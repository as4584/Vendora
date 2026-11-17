/**
 * eBay listing controls for an inventory item: status badge + link,
 * "List on eBay" sheet (price, title, condition, quantity, preview),
 * "Update price" and "End listing".
 *
 * Quantity is never above the item's stock; after any in-person sale the
 * backend pushes the new quantity to eBay (or ends the listing at zero).
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { EbayInsights } from "./EbayInsights";
import { EbayPolicySetup, isMissingPoliciesError } from "./EbayPolicySetup";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

export const EBAY_CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW", label: "New with box" },
  { value: "NEW_OTHER", label: "New, no box" },
  { value: "USED_EXCELLENT", label: "Pre-owned" },
];

const STATUS_TONE: Record<api.EbayListingStatus, "success" | "neutral" | "warning" | "danger" | "info"> = {
  active: "success",
  draft: "info",
  ended: "neutral",
  sold: "neutral",
  error: "danger",
};

const STATUS_LABEL: Record<api.EbayListingStatus, string> = {
  active: "Live on eBay",
  draft: "Draft",
  ended: "Ended",
  sold: "Sold on eBay",
  error: "Needs attention",
};

export function defaultEbayTitle(item: api.InventoryItem): string {
  const brand = String(item.custom_attributes?.brand ?? "").trim();
  const parts: string[] = [];
  if (brand && !item.name.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
  parts.push(item.name.trim());
  if (item.size) parts.push(`Size ${item.size}`);
  return parts.join(" ").slice(0, 80);
}

export function defaultEbayCondition(condition?: string | null): string {
  const c = (condition || "").toLowerCase();
  if (!c) return "NEW";
  if (c.includes("used") || c.includes("pre")) return "USED_EXCELLENT";
  if (c.includes("no box") || c.includes("vnds") || c.includes("open")) return "NEW_OTHER";
  return "NEW";
}

/** Two-decimal money string, or null when not a positive amount. */
export function normalizePrice(raw: string): string | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!(value > 0)) return null;
  return value.toFixed(2);
}

function errorMessage(err: any, fallback: string): string {
  return err?.detail?.message || err?.message || fallback;
}

type Props = { item: api.InventoryItem; available: number; onChanged?: () => void };

export function EbayListingCard({ item, available, onChanged }: Props) {
  const [listing, setListing] = useState<api.EbayListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<"list" | "price" | null>(null);
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState("");
  const [title, setTitle] = useState("");
  const [condition, setCondition] = useState("NEW");
  const [quantity, setQuantity] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);
  const [needsPolicies, setNeedsPolicies] = useState(false);

  const load = useCallback(async () => {
    try {
      setListing(await api.getEbayListing(item.id));
    } catch {
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => {
    // Fetch-on-mount: load's state updates are the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const openList = () => {
    const ask = item.expected_sell_price != null ? Number(item.expected_sell_price) : NaN;
    setPrice(Number.isFinite(ask) && ask > 0 ? ask.toFixed(2) : "");
    setTitle(defaultEbayTitle(item));
    setCondition(defaultEbayCondition(item.condition));
    setQuantity(String(Math.max(1, Math.min(available, 1))));
    setFormError(null);
    setNeedsPolicies(false);
    setSheet("list");
  };

  const openPrice = () => {
    setPrice(listing?.price ?? "");
    setFormError(null);
    setSheet("price");
  };

  const submitList = async () => {
    const p = normalizePrice(price);
    const q = Number(quantity);
    if (!p) return setFormError("Enter a price above $0.");
    if (!title.trim()) return setFormError("Add a title.");
    if (!Number.isInteger(q) || q < 1 || q > available) return setFormError(`Quantity must be 1 to ${available}.`);
    setBusy(true);
    setFormError(null);
    setNeedsPolicies(false);
    try {
      const result = await api.createEbayListing({ item_id: item.id, price: p, quantity: q, title: title.trim(), condition });
      setListing(result);
      setSheet(null);
      onChanged?.();
    } catch (err: any) {
      if (isMissingPoliciesError(err)) {
        setNeedsPolicies(true);
        setFormError("Your eBay account needs selling policies before you can list.");
      } else {
        setFormError(errorMessage(err, "Could not list on eBay."));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitPrice = async () => {
    const p = normalizePrice(price);
    if (!p) return setFormError("Enter a price above $0.");
    setBusy(true);
    setFormError(null);
    try {
      setListing(await api.updateEbayListing(item.id, { price: p }));
      setSheet(null);
    } catch (err: any) {
      setFormError(errorMessage(err, "Could not update the price."));
    } finally {
      setBusy(false);
    }
  };

  const endListing = () => {
    Alert.alert("End eBay listing", "Buyers will no longer see this listing. You can list it again later.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "End listing",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            setListing(await api.endEbayListing(item.id));
            onChanged?.();
          } catch (err: any) {
            Alert.alert("Could not end listing", errorMessage(err, "Try again in a moment."));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const live = listing?.status === "active";
  const preview = normalizePrice(price);

  return (
    <Card>
      <View style={styles.header}>
        <SectionLabel>eBay listing</SectionLabel>
        {listing?.status ? (
          <Pill label={STATUS_LABEL[listing.status]} tone={STATUS_TONE[listing.status]} />
        ) : null}
      </View>

      {loading ? (
        <Text style={styles.muted}>Checking eBay listing…</Text>
      ) : live && listing ? (
        <View testID="ebay-listing-live" style={styles.stack}>
          <Text style={styles.price}>{`$${listing.price}`}</Text>
          <Text style={styles.muted}>{`${listing.quantity ?? 0} listed · stock syncs after every sale`}</Text>
          <View style={styles.row}>
            {listing.url ? (
              <Button label="View on eBay" size="sm" variant="secondary" trailingIcon="open-outline" onPress={() => void Linking.openURL(listing.url!)} />
            ) : null}
            <Button label="Update price" size="sm" variant="secondary" onPress={openPrice} disabled={busy} />
            <Button label="End listing" size="sm" variant="ghost" onPress={endListing} loading={busy} />
          </View>
          <EbayInsights itemId={item.id} listPrice={listing.price} />
        </View>
      ) : (
        <View style={styles.stack}>
          <Text style={styles.muted}>
            {listing?.status === "error"
              ? "The last attempt did not publish. Fix the issue and list again."
              : "List this item on eBay. When it sells here first, eBay is updated so it can't sell twice."}
          </Text>
          <Button
            testID="ebay-list-button"
            label="List on eBay"
            leadingIcon="pricetag-outline"
            onPress={openList}
            disabled={available < 1}
          />
          {available < 1 ? <Text style={styles.muted}>Out of stock.</Text> : null}
        </View>
      )}

      <Modal visible={sheet !== null} animationType="slide" transparent onRequestClose={() => setSheet(null)}>
        <View style={styles.backdrop}>
          <View testID="ebay-list-sheet" style={styles.sheet} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <Text accessibilityRole="header" style={styles.sheetTitle}>
                {sheet === "price" ? "Update eBay price" : "List on eBay"}
              </Text>

              <Text style={styles.label}>Price (USD)</Text>
              <TextInput
                testID="ebay-price-input"
                accessibilityLabel="eBay price"
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={COLORS.textSoft}
                style={styles.input}
              />

              {sheet === "list" ? (
                <>
                  <Text style={styles.label}>Title</Text>
                  <TextInput
                    testID="ebay-title-input"
                    accessibilityLabel="eBay title"
                    value={title}
                    onChangeText={(t) => setTitle(t.slice(0, 80))}
                    style={styles.input}
                    placeholderTextColor={COLORS.textSoft}
                  />
                  <Text style={styles.hint}>{`${title.length}/80`}</Text>

                  <Text style={styles.label}>Condition</Text>
                  <View style={styles.row}>
                    {EBAY_CONDITIONS.map((c) => (
                      <Button
                        key={c.value}
                        label={c.label}
                        size="sm"
                        variant={condition === c.value ? "primary" : "secondary"}
                        onPress={() => setCondition(c.value)}
                        accessibilityLabel={`Condition ${c.label}`}
                      />
                    ))}
                  </View>

                  <Text style={styles.label}>{`Quantity (max ${available})`}</Text>
                  <TextInput
                    testID="ebay-qty-input"
                    accessibilityLabel="eBay quantity"
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="number-pad"
                    style={styles.input}
                  />

                  <View testID="ebay-preview" style={styles.preview}>
                    <Text style={styles.previewLabel}>Preview</Text>
                    <Text style={styles.previewTitle} numberOfLines={2}>{title || "Untitled"}</Text>
                    <Text style={styles.previewMeta}>
                      {`${preview ? `$${preview}` : "No price"} · ${EBAY_CONDITIONS.find((c) => c.value === condition)?.label} · Buy It Now`}
                    </Text>
                  </View>
                </>
              ) : null}

              {formError ? <Text testID="ebay-form-error" style={styles.error}>{formError}</Text> : null}

              {sheet === "list" && needsPolicies ? (
                <EbayPolicySetup
                  onDone={() => {
                    setNeedsPolicies(false);
                    void submitList();
                  }}
                />
              ) : null}

              <View style={styles.stack}>
                <Button
                  testID="ebay-submit"
                  label={sheet === "price" ? "Save price" : "Publish listing"}
                  onPress={sheet === "price" ? submitPrice : submitList}
                  loading={busy}
                  fullWidth
                />
                <Button label="Cancel" variant="ghost" onPress={() => setSheet(null)} fullWidth />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SPACING.xs },
  stack: { gap: SPACING.sm },
  row: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
  price: { ...TYPE.title, color: COLORS.text },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    maxHeight: "92%",
    backgroundColor: COLORS.bgElevated,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  sheetContent: { padding: SPACING.lg, gap: SPACING.xs, paddingBottom: SPACING.xl },
  sheetTitle: { ...TYPE.headline, color: COLORS.text, marginBottom: SPACING.xs },
  label: { ...TYPE.footnote, color: COLORS.textMuted, marginTop: SPACING.xs },
  hint: { ...TYPE.footnote, color: COLORS.textSoft, textAlign: "right" },
  input: {
    ...TYPE.body,
    color: COLORS.text,
    backgroundColor: COLORS.bgElevated,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADII.md,
    paddingHorizontal: SPACING.sm,
    minHeight: 48,
  },
  preview: {
    marginTop: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
    gap: SPACING.xxs,
  },
  previewLabel: { ...TYPE.footnote, color: COLORS.textSoft },
  previewTitle: { ...TYPE.callout, color: COLORS.text },
  previewMeta: { ...TYPE.footnote, color: COLORS.textMuted },
  error: { ...TYPE.footnote, color: COLORS.danger, marginVertical: SPACING.xs },
});
