/**
 * StockX surfaces: settings card, item-detail card (match sheet, market data,
 * asks) and Add-stock price hint. Outbox errors live in Sync Center (shared list).
 *
 * Every piece degrades quietly: when StockX is not configured or not
 * connected it says so instead of erroring. Labels never call an ask a sale.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { openProviderConnect } from "../utils/oauthConnect";
import * as api from "../services/api";
import { Button } from "./Button";
import { Card, Pill, SectionLabel } from "./ui";
import { COLORS, RADII, SPACING, TYPE } from "../theme/tokens";

export const FEE_DISCLAIMER =
  "StockX deducts its seller fees and payment processing from your payout. The ask price is what buyers see, not what you receive.";

function money(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

/** "StockX: last sale $X · lowest ask $Y" — only the parts StockX returned. */
export function marketLine(market: Pick<api.StockxMarket, "last_sale" | "lowest_ask" | "highest_bid"> | null): string {
  if (!market) return "StockX: no market data";
  const parts: string[] = [];
  const sale = money(market.last_sale);
  const ask = money(market.lowest_ask);
  const bid = money(market.highest_bid);
  if (sale) parts.push(`last sale ${sale}`);
  if (ask) parts.push(`lowest ask ${ask}`);
  if (bid) parts.push(`highest bid ${bid}`);
  return parts.length ? `StockX: ${parts.join(" · ")}` : "StockX: no market data";
}

function errorText(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message || fallback;
}

type Availability = "loading" | "unconfigured" | "disconnected" | "ready" | "error";

function availability(status: api.StockxStatus | null, failed: boolean): Availability {
  if (failed) return "error";
  if (!status) return "loading";
  if (!status.configured) return "unconfigured";
  if (!status.connected) return "disconnected";
  return "ready";
}

function useStockxStatus() {
  const [status, setStatus] = useState<api.StockxStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setStatus(await api.getStockxStatus());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);
  return { status, state: availability(status, failed), reload };
}

// ── Settings → Integrations ──────────────────────────────────────────────────

export function StockxSettingsCard() {
  const { status, state, reload } = useStockxStatus();

  const connect = async () => {
    try {
      const { authorization_url } = await api.getStockxConnectUrl();
      await openProviderConnect(authorization_url);
      await reload();
    } catch (err) {
      Alert.alert("StockX unavailable", errorText(err, "Could not open the StockX connect flow."));
    }
  };

  const disconnect = () =>
    Alert.alert("Disconnect StockX?", "Matches are kept so you can reconnect later.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          try { await api.disconnectStockx(); await reload(); }
          catch (err) { Alert.alert("Disconnect failed", errorText(err, "Could not disconnect StockX.")); }
        },
      },
    ]);

  return (
    <Card style={{ gap: SPACING.sm }}>
      <View style={styles.rowBetween}>
        <Text style={styles.title}>StockX</Text>
        {state === "loading" ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
        {state === "ready" ? <Pill label="Connected" tone="success" /> : null}
        {state === "disconnected" ? <Pill label="StockX not connected" tone="neutral" /> : null}
        {state === "unconfigured" ? <Pill label="StockX not configured" tone="warning" /> : null}
      </View>
      <Text style={styles.muted}>Match items to StockX, see market prices, place asks and import StockX sales.</Text>
      {state === "error" ? <Text style={styles.muted}>StockX status is unavailable right now.</Text> : null}
      {state === "ready" && status ? (
        <Text style={styles.muted}>
          {status.matched_items} matched item(s), {status.open_listings} open ask(s)
          {status.outbox_errors ? `, ${status.outbox_errors} sync error(s)` : ""}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {state === "disconnected" ? <Button label="Connect StockX" onPress={connect} size="sm" /> : null}
        {state === "ready" ? <Button label="Disconnect" onPress={disconnect} variant="ghost" size="sm" /> : null}
      </View>
    </Card>
  );
}

// ── Add stock price hint ─────────────────────────────────────────────────────

export function StockxPriceHint({ name, size }: { name: string; size?: string | null }) {
  const [line, setLine] = useState<string | null>(null);
  const query = name.trim();

  useEffect(() => {
    if (query.length < 3) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const status = await api.getStockxStatus();
        if (!status.configured || !status.connected) return;
        const quote = await api.getStockxQuote(query, size);
        if (!cancelled) setLine(quote.product ? marketLine(quote.market) : null);
      } catch {
        if (!cancelled) setLine(null);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, size]);

  if (!line || query.length < 3) return null;
  return <Text style={styles.hint} testID="stockx-price-hint">{line}</Text>;
}

// ── Item detail ──────────────────────────────────────────────────────────────

export function StockxItemCard({ itemId }: { itemId: string }) {
  const { state } = useStockxStatus();
  const [data, setData] = useState<api.StockxItem | null>(null);
  const [market, setMarket] = useState<api.StockxMarket[]>([]);
  const [sheet, setSheet] = useState(false);
  const [askFor, setAskFor] = useState<api.StockxLink | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getStockxItem(itemId);
      setData(next);
      setMarket(next.links.length ? await api.getStockxMarket(itemId) : []);
    } catch {
      setMarket([]);
    }
  }, [itemId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state === "ready") void load();
  }, [state, load]);

  if (state === "loading" || state === "error") return null;

  const openAsk = (link: api.StockxLink) =>
    data?.listings.find((l) => l.variant_id === link.variant_id && (l.status === "active" || l.status === "pending"));

  const remove = (listing: api.StockxListing) =>
    Alert.alert("Remove ask?", "This takes the ask off StockX.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try { await api.removeStockxAsk(listing.id); await load(); }
          catch (err) { Alert.alert("Could not remove ask", errorText(err, "Try again.")); }
        },
      },
    ]);

  return (
    <Card style={{ gap: SPACING.sm }}>
      <SectionLabel>StockX</SectionLabel>
      {state === "unconfigured" ? <Text style={styles.muted}>StockX not configured</Text> : null}
      {state === "disconnected" ? <Text style={styles.muted}>StockX not connected. Connect it in Settings.</Text> : null}
      {state === "ready" && data ? (
        <>
          {data.links.length === 0 ? <Text style={styles.muted}>Not matched to a StockX product yet.</Text> : null}
          {data.links.map((link) => {
            const m = market.find((row) => row.variant_id === link.variant_id) ?? null;
            const ask = openAsk(link);
            return (
              <View key={link.variant_id ?? link.size ?? "link"} style={styles.linkRow}>
                <Text style={styles.body}>Size {link.size || "-"}</Text>
                <Text style={styles.muted}>{marketLine(m)}{m?.stale ? " (cached)" : ""}</Text>
                {ask ? (
                  <Text style={styles.muted}>
                    Your ask {money(ask.amount)} {ask.status === "pending" ? "(pending)" : ""}
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  <Button label={ask ? "Update" : "Place ask"} onPress={() => setAskFor(link)} size="sm" variant="secondary" />
                  {ask ? <Button label="Remove" onPress={() => remove(ask)} size="sm" variant="ghost" /> : null}
                </View>
              </View>
            );
          })}
          <Button label={data.links.length ? "Re-match on StockX" : "Match on StockX"} onPress={() => setSheet(true)} size="sm" variant="secondary" />
        </>
      ) : null}
      {sheet ? <MatchSheet itemId={itemId} onClose={() => setSheet(false)} onDone={async () => { setSheet(false); await load(); }} /> : null}
      {askFor ? (
        <AskSheet
          itemId={itemId}
          link={askFor}
          existing={openAsk(askFor) ?? null}
          onClose={() => setAskFor(null)}
          onDone={async () => { setAskFor(null); await load(); }}
        />
      ) : null}
    </Card>
  );
}

function MatchSheet({ itemId, onClose, onDone }: { itemId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [result, setResult] = useState<{ best: api.StockxCandidate | null; shortlist: api.StockxCandidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    api.getStockxMatch(itemId).then(setResult).catch((err) => setError(errorText(err, "StockX search failed.")));
  }, [itemId]);

  const choose = async (candidate: api.StockxCandidate) => {
    setSaving(candidate.product_id);
    try {
      const saved = await api.confirmStockxMatch(itemId, candidate.product_id);
      if (saved.links.length === 0) Alert.alert("No size match", "None of this item's sizes exist on that StockX product.");
      await onDone();
    } catch (err) {
      Alert.alert("Could not save match", errorText(err, "Try again."));
      setSaving(null);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Match on StockX</Text>
          {!result && !error ? <ActivityIndicator color={COLORS.primary} /> : null}
          {error ? <Text style={styles.muted}>{error}</Text> : null}
          {result && result.shortlist.length === 0 ? <Text style={styles.muted}>No StockX products found.</Text> : null}
          <ScrollView style={{ maxHeight: 360 }}>
            {result?.shortlist.map((c) => (
              <View key={c.product_id} style={styles.linkRow}>
                <Text style={styles.body}>{c.title}</Text>
                <Text style={styles.muted}>
                  {[c.style_id, c.colorway].filter(Boolean).join(" · ")}
                  {result.best?.product_id === c.product_id ? "  Best match" : ""}
                </Text>
                <Button label="Use this" onPress={() => choose(c)} size="sm" variant={result.best?.product_id === c.product_id ? "primary" : "secondary"} loading={saving === c.product_id} />
              </View>
            ))}
          </ScrollView>
          <Text style={styles.muted}>Each of your sizes is mapped to the matching StockX size.</Text>
          <Button label="Cancel" onPress={onClose} variant="ghost" />
        </View>
      </View>
    </Modal>
  );
}

function AskSheet({
  itemId, link, existing, onClose, onDone,
}: {
  itemId: string;
  link: api.StockxLink;
  existing: api.StockxListing | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(existing ? String(Number(existing.amount)) : "");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      Alert.alert("Enter a price", "Ask price must be more than $0.");
      return;
    }
    setSaving(true);
    try {
      if (existing) await api.updateStockxAsk(existing.id, value.toFixed(2));
      else await api.placeStockxAsk(itemId, link.variant_id ?? "", value.toFixed(2));
      await onDone();
    } catch (err) {
      Alert.alert("StockX ask failed", errorText(err, "Try again."));
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{existing ? "Update ask" : "Place ask"} - size {link.size || "-"}</Text>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="Ask price (USD)"
            placeholderTextColor={COLORS.textSoft}
            style={styles.input}
            accessibilityLabel="Ask price"
          />
          <Text style={styles.muted}>{FEE_DISCLAIMER}</Text>
          <Button label={existing ? "Update ask" : "Place ask"} onPress={submit} loading={saving} fullWidth />
          <Button label="Cancel" onPress={onClose} variant="ghost" fullWidth />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { ...TYPE.headline, color: COLORS.text },
  body: { ...TYPE.callout, color: COLORS.text },
  muted: { ...TYPE.footnote, color: COLORS.textMuted },
  hint: { ...TYPE.footnote, color: COLORS.textMuted, marginTop: SPACING.xxs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  linkRow: { gap: SPACING.xxs, paddingVertical: SPACING.xs, borderTopWidth: 1, borderTopColor: COLORS.border },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: COLORS.canvas },
  sheet: { backgroundColor: COLORS.card, padding: SPACING.md, gap: SPACING.sm, borderTopLeftRadius: RADII.xl, borderTopRightRadius: RADII.xl },
  input: {
    ...TYPE.body, color: COLORS.text, backgroundColor: COLORS.cardAlt, borderRadius: RADII.md,
    borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: SPACING.sm, minHeight: 48,
  },
});
