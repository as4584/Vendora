/**
 * eBay listing insights on item detail: traffic line ("48 views · 3 watchers
 * · 0 sales"), a gentle price hint, and "Send offer to watchers".
 */
import { useCallback, useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "../services/api";
import { Button } from "./Button";
import { normalizePrice } from "./EbayListingCard";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

type Mode = "percent" | "price";

export const OFFER_PERCENTS = [5, 10, 15, 20];

function errorMessage(err: any, fallback: string): string {
  return err?.detail?.message || err?.message || fallback;
}

export function EbayInsights({ itemId, listPrice }: { itemId: string; listPrice: string | null }) {
  const [traffic, setTraffic] = useState<api.EbayTraffic | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("percent");
  const [percent, setPercent] = useState(10);
  const [price, setPrice] = useState("");
  const [days, setDays] = useState("2");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [ineligible, setIneligible] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      setTraffic(await api.getEbayTraffic(itemId, refresh));
    } catch {
      setTraffic(null);
    }
  }, [itemId]);

  useEffect(() => {
    // Fetch-on-mount: load's state updates are the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const openSheet = async () => {
    setError(null);
    setIneligible(null);
    setOpen(true);
    try {
      const check = await api.getEbayOfferEligibility(itemId);
      if (!check.eligible) setIneligible(check.message || "eBay says this listing can't get offers right now.");
    } catch {
      // The send call reports the real reason; don't block on the pre-check.
    }
  };

  const submit = async () => {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 30) return setError("Offer length must be 1 to 30 days.");
    const input: api.EbayOfferInput = { duration_days: d, message: message.trim() || undefined };
    if (mode === "price") {
      const p = normalizePrice(price);
      if (!p) return setError("Enter an offer price above $0.");
      if (listPrice && Number(p) >= Number(listPrice)) return setError("The offer must be below the listing price.");
      input.price = p;
    } else {
      input.discount_percent = percent;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendEbayOffer(itemId, input);
      setSent(result.offers_sent === 1 ? "Offer sent to 1 buyer." : `Offer sent to ${result.offers_sent} buyers.`);
      setOpen(false);
    } catch (err: any) {
      setError(errorMessage(err, "Could not send the offer."));
    } finally {
      setBusy(false);
    }
  };

  const watchers = traffic?.watchers ?? 0;

  return (
    <View testID="ebay-insights" style={styles.stack}>
      {traffic?.summary ? <Text style={styles.traffic}>{traffic.summary}</Text> : null}
      {traffic?.price_hint ? <Text testID="ebay-price-hint" style={styles.hint}>{traffic.price_hint}</Text> : null}
      {sent ? <Text style={styles.success}>{sent}</Text> : null}
      <View style={styles.row}>
        <Button
          testID="ebay-offer-button"
          label="Send offer to watchers"
          size="sm"
          variant="secondary"
          leadingIcon="mail-outline"
          onPress={() => void openSheet()}
          disabled={traffic?.watchers === 0}
        />
        <Button label="Refresh stats" size="sm" variant="ghost" onPress={() => void load(true)} />
      </View>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View testID="ebay-offer-sheet" style={styles.sheet} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <Text accessibilityRole="header" style={styles.title}>Send offer to watchers</Text>
              <Text style={styles.muted}>
                {traffic?.watchers != null ? `${watchers} watching. ` : ""}eBay sends the offer to buyers who watched this item.
              </Text>
              <View style={styles.row}>
                <Button label="Percent off" size="sm" variant={mode === "percent" ? "primary" : "secondary"} onPress={() => setMode("percent")} />
                <Button label="Set price" size="sm" variant={mode === "price" ? "primary" : "secondary"} onPress={() => setMode("price")} />
              </View>
              {mode === "percent" ? (
                <View style={styles.row}>
                  {OFFER_PERCENTS.map((p) => (
                    <Button
                      key={p}
                      label={`${p}% off`}
                      size="sm"
                      variant={percent === p ? "primary" : "secondary"}
                      onPress={() => setPercent(p)}
                    />
                  ))}
                </View>
              ) : (
                <TextInput
                  testID="ebay-offer-price"
                  accessibilityLabel="Offer price"
                  value={price}
                  onChangeText={setPrice}
                  keyboardType="decimal-pad"
                  placeholder={listPrice ? `Below $${listPrice}` : "0.00"}
                  placeholderTextColor={COLORS.textSoft}
                  style={styles.input}
                />
              )}
              <Text style={styles.label}>Offer length (days)</Text>
              <TextInput
                testID="ebay-offer-days"
                accessibilityLabel="Offer length in days"
                value={days}
                onChangeText={setDays}
                keyboardType="number-pad"
                style={styles.input}
              />
              <Text style={styles.label}>Message (optional)</Text>
              <TextInput
                testID="ebay-offer-message"
                accessibilityLabel="Offer message"
                value={message}
                onChangeText={(t) => setMessage(t.slice(0, 1000))}
                multiline
                style={[styles.input, styles.multiline]}
                placeholderTextColor={COLORS.textSoft}
              />
              {ineligible ? <Text testID="ebay-offer-ineligible" style={styles.error}>{ineligible}</Text> : null}
              {error ? <Text testID="ebay-offer-error" style={styles.error}>{error}</Text> : null}
              <Button testID="ebay-offer-submit" label="Send offer" onPress={submit} loading={busy} disabled={!!ineligible} fullWidth />
              <Button label="Cancel" variant="ghost" onPress={() => setOpen(false)} fullWidth />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACING.xs, marginTop: SPACING.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  traffic: { ...TYPE.callout, color: COLORS.text },
  hint: { ...TYPE.footnote, color: COLORS.warning },
  success: { ...TYPE.footnote, color: COLORS.success },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: COLORS.overlay },
  sheet: {
    maxHeight: "92%",
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADII.xl,
    borderTopRightRadius: RADII.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  sheetContent: { padding: SPACING.lg, gap: SPACING.sm, paddingBottom: SPACING.xl },
  title: { ...TYPE.headline, color: COLORS.text },
  label: { ...TYPE.footnote, color: COLORS.textMuted },
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
  multiline: { minHeight: 80, paddingTop: SPACING.xs, textAlignVertical: "top" },
  error: { ...TYPE.footnote, color: COLORS.danger },
});
