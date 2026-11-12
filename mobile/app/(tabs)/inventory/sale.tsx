import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Modal,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as api from "../../../services/api";
import { CustomerPicker } from "../../../components/CustomerPicker";
import { isOnline } from "../../../services/offline";
import { Card, Icon, Pill, SectionLabel } from "../../../components/ui";
import { Button, IconButton, triggerHaptic } from "../../../components/Button";
import { ScannerOverlay } from "../../../components/ScannerOverlay";
import { ReceiptSheet } from "../../../components/ReceiptSheet";
import { maybeAskForRating, recordSale } from "../../../services/rating";
import { BRAND, COLORS, FONT_SCALE, RADII, SPACING, TYPE } from "../../../theme/tokens";
import { formatCurrency, resolveQty } from "../../../utils/inventory";
import {
  autoBalance,
  centsToString,
  computeCheckout,
  formatCents,
  haggle,
  HAGGLE_STEPS,
  paymentLabel,
  sameBarcode,
  sizeOptions,
  toCents,
  type DiscountMode,
  type ReceiptData,
} from "../../../utils/checkout";
import { errorMessage } from "../../../services/errors";
import { playSound } from "../../../services/sounds";
import { REPEAT_COOLDOWN_MS } from "../../../services/batchScan";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Cash and card first: that is how almost every show sale is paid.
const PRIMARY_METHODS = ["cash", "card"];
const OTHER_METHODS = ["venmo", "cashapp", "paypal", "zelle", "other"];
const PART_METHODS = [...PRIMARY_METHODS, ...OTHER_METHODS];

// price: the agreed per-unit price as typed (defaults to the list price, editable to haggle).
type CartLine = { item: api.InventoryItem; qty: number; price: string; size?: string };
type PaymentRow = { key: string; method: string; amount: string };

const listPrice = (item: api.InventoryItem) => centsToString(toCents(item.expected_sell_price || "0"));
const lineMax = (line: CartLine) => {
  const sizes = sizeOptions(line.item);
  if (line.size) return Math.max(1, sizes.find((s) => s.size === line.size)?.quantity ?? 1);
  return Math.max(1, resolveQty(line.item));
};
let rowSeq = 0;
const newRow = (method: string, amount = ""): PaymentRow => ({ key: `p${++rowSeq}`, method, amount });

export default function QuickSaleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ add?: string }>();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [itemsError, setItemsError] = useState(false);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [method, setMethod] = useState("cash");
  const [split, setSplit] = useState<PaymentRow[]>([]);
  const [feeAmount, setFeeAmount] = useState("");
  const [discountMode, setDiscountMode] = useState<DiscountMode>("amount");
  const [discountValue, setDiscountValue] = useState("");
  const [taxOn, setTaxOn] = useState(false);
  const [taxRate, setTaxRate] = useState("");
  const [defaultTax, setDefaultTax] = useState("");
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [customer, setCustomer] = useState<api.Customer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLock = useRef(false);
  // Scan-to-cart stays open: remember the last code so one box isn't added twice.
  const lastScan = useRef<{ code: string; at: number } | null>(null);
  const [scanNote, setScanNote] = useState<{ text: string; ok: boolean } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefilled = useRef(false);

  const addToCart = useCallback((item: api.InventoryItem) => {
    setCart((prev) => {
      const existing = prev[item.id];
      if (existing) {
        return { ...prev, [item.id]: { ...existing, qty: Math.min(lineMax(existing), existing.qty + 1) } };
      }
      const sizes = sizeOptions(item).filter((s) => s.quantity > 0);
      return {
        ...prev,
        [item.id]: { item, qty: 1, price: listPrice(item), size: sizes.length === 1 ? sizes[0].size : undefined },
      };
    });
  }, []);

  const addParam = params.add;
  const loadItems = useCallback(() => {
    return api
      .listItems({ perPage: 100, availableOnly: true })
      .then((result) => {
        setItemsError(false);
        setItems(result.items);
        // Deep link from an item ("Sell this"): /inventory/sale?add=<item id>.
        const hit = addParam && !prefilled.current ? result.items.find((i) => i.id === addParam) : undefined;
        if (hit) {
          prefilled.current = true;
          addToCart(hit);
        }
      })
      .catch(() => setItemsError(true))
      .finally(() => setLoadingItems(false));
  }, [addParam, addToCart]);

  useEffect(() => {
    loadItems();
    api
      .getMe()
      .then((me) => {
        setBusinessName(me.business_name);
        const rate = me.sales_tax_rate ? String(Number(me.sales_tax_rate)) : "";
        if (rate && Number(rate) > 0) {
          setDefaultTax(rate);
          setTaxRate(rate);
          setTaxOn(true);
        }
      })
      .catch(() => undefined);
  }, [loadItems]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) =>
      [item.name, item.sku || "", item.category || "", item.upc || ""].some((value) => value.toLowerCase().includes(q))
    );
  }, [items, query]);

  const cartLines = Object.values(cart);
  const totals = computeCheckout({
    lines: cartLines.map((l) => ({ priceCents: toCents(l.price), qty: l.qty })),
    discountMode,
    discountValue,
    taxRate: taxOn ? taxRate : "",
  });
  const fee = toCents(feeAmount);
  const splitting = split.length > 0;
  const splitPaid = split.reduce((sum, row) => sum + toCents(row.amount), 0);
  const splitLeft = totals.total - splitPaid;

  const toggleItem = (item: api.InventoryItem) => {
    if (cart[item.id]) {
      setCart((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    } else {
      addToCart(item);
    }
  };

  const changeQty = (id: string, delta: number) => {
    setCart((prev) => {
      const line = prev[id];
      const qty = Math.min(lineMax(line), Math.max(1, line.qty + delta));
      return { ...prev, [id]: { ...line, qty } };
    });
  };

  const changePrice = (id: string, price: string) => {
    setCart((prev) => ({ ...prev, [id]: { ...prev[id], price } }));
  };

  const pickSize = (id: string, size: string) => {
    setCart((prev) => {
      const line = { ...prev[id], size };
      return { ...prev, [id]: { ...line, qty: Math.min(line.qty, lineMax(line)) } };
    });
  };

  // Cash + card: type the cash you were handed; the card covers the rest.
  const startSplit = () => {
    setSplit([newRow("cash", ""), newRow("card", centsToString(totals.total))]);
  };

  const updateRow = (key: string, patch: Partial<PaymentRow>) =>
    setSplit((rows) => {
      const next = rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
      return patch.amount !== undefined ? autoBalance(next, key, totals.total) : next;
    });

  const removeRow = (key: string) =>
    setSplit((rows) => (rows.length <= 2 ? [] : rows.filter((row) => row.key !== key)));

  const fillRemaining = (key: string) => {
    const row = split.find((r) => r.key === key);
    if (!row) return;
    updateRow(key, { amount: centsToString(Math.max(0, toCents(row.amount) + splitLeft)) });
  };

  const saveDefaultTax = async () => {
    try {
      await api.updateProfile({ sales_tax_rate: taxRate.trim() || "0" });
      setDefaultTax(taxRate.trim());
      triggerHaptic("success");
    } catch (err) {
      Alert.alert("Couldn't save", errorMessage(err, "Try again when you're online."));
    }
  };

  const openScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result?.granted) {
        Alert.alert("Camera needed", "Allow camera access in Settings to scan barcodes.");
        return;
      }
    }
    scanLock.current = false;
    lastScan.current = null;
    setScanNote(null);
    setScannerOpen(true);
  };

  const showScanNote = (text: string, ok: boolean) => {
    setScanNote({ text, ok });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setScanNote(null), 2500);
  };

  const onBarcodeScanned = async ({ data }: { data: string }) => {
    const now = Date.now();
    if (scanLock.current) return;
    if (lastScan.current && lastScan.current.code === data && now - lastScan.current.at < REPEAT_COOLDOWN_MS) return;
    scanLock.current = true;
    lastScan.current = { code: data, at: now };
    let hit = items.find((item) => sameBarcode(item.upc, data));
    if (!hit) {
      try {
        const res = await api.listItems({ upc: data, perPage: 5, availableOnly: true });
        hit = res.items[0];
        if (hit) setItems((prev) => (prev.some((i) => i.id === hit!.id) ? prev : [hit!, ...prev]));
      } catch {
        hit = undefined;
      }
    }
    if (hit) {
      const found = hit;
      triggerHaptic("success");
      playSound("scan");
      addToCart(found);
      const inCart = (cart[found.id]?.qty ?? 0) + 1;
      showScanNote(`Added ${found.name}${inCart > 1 ? ` · ${inCart} in cart` : ""}`, true);
    } else {
      triggerHaptic("warning");
      showScanNote(`Not in stock: ${data}. Add it in Add Stock first.`, false);
    }
    scanLock.current = false;
  };

  const resetSale = () => {
    setCart({});
    setSplit([]);
    setFeeAmount("");
    setDiscountValue("");
    setNotes("");
    setReceipt(null);
    setLoadingItems(true);
    loadItems();
  };

  const handleSubmit = async () => {
    if (cartLines.length === 0) {
      Alert.alert("No items selected", "Tap items above to add them to this sale.");
      return;
    }
    const needsSize = cartLines.find((l) => sizeOptions(l.item).length > 0 && !l.size);
    if (needsSize) {
      Alert.alert("Pick a size", `Choose which size of ${needsSize.item.name} you sold.`);
      return;
    }
    if (totals.error) {
      Alert.alert("Check the discount", totals.error);
      return;
    }
    if (fee > totals.gross) {
      Alert.alert("Check the fee", "The fee can't be more than the sale total.");
      return;
    }
    if (splitting && splitLeft !== 0) {
      Alert.alert(
        "Payments don't add up",
        splitLeft > 0
          ? `${formatCents(splitLeft)} is still unpaid. Payments must add up to ${formatCents(totals.total)}.`
          : `Payments are ${formatCents(-splitLeft)} over the ${formatCents(totals.total)} total.`
      );
      return;
    }
    setSubmitting(true);
    try {
      // One request for the whole checkout: the server records every line or
      // none, and splits discount, tax and fee across lines by value.
      const payload: api.CreateSaleOrderPayload = {
        lines: cartLines.map((line) => ({
          item_id: line.item.id,
          quantity: line.qty,
          unit_price: centsToString(toCents(line.price)),
          ...(line.size ? { size: line.size } : {}),
        })),
        ...(splitting
          ? {
              payments: split
                .filter((row) => toCents(row.amount) > 0)
                .map((row) => ({ method: row.method, amount: centsToString(toCents(row.amount)) })),
            }
          : { method }),
        fee_amount: centsToString(fee),
        notes: notes.trim() || undefined,
        ...(customer ? { customer_id: customer.id } : {}),
      };
      if (totals.discount > 0) {
        if (discountMode === "percent") payload.discount_percent = discountValue.trim();
        else payload.discount_amount = centsToString(totals.discount);
      }
      if (totals.tax > 0) payload.tax_rate = taxRate.trim();
      const order = await api.createSaleOrder(payload);
      const offline = !!order.pending || !isOnline();
      triggerHaptic("success");
      playSound("sale");
      if (!offline) void recordSale();
      setReceipt({
        businessName,
        date: new Date(),
        lines: cartLines.map((l) => ({ name: l.item.name, size: l.size, qty: l.qty, unitCents: toCents(l.price) })),
        subtotal: totals.subtotal,
        discount: totals.discount,
        tax: totals.tax,
        taxRate: totals.tax > 0 ? taxRate.trim() : undefined,
        total: totals.total,
        payments: (payload.payments ?? [{ method, amount: centsToString(totals.total) }]).map((p) => ({
          method: p.method,
          cents: toCents(p.amount),
        })),
        pending: offline,
        orderId: offline ? undefined : order.order_id,
        transactionIds: offline ? undefined : (order.transactions ?? []).map((t) => t.id),
      });
    } catch (err) {
      Alert.alert("Sale failed", errorMessage(err, "Could not log this sale."));
    } finally {
      setSubmitting(false);
    }
  };

  const undoSale = async () => {
    const ids = receipt?.transactionIds ?? [];
    try {
      for (const id of ids) await api.refundTransaction(id, "Undone at checkout");
      triggerHaptic("success");
      resetSale();
      Alert.alert("Sale undone", "Items are back in stock.");
    } catch (err) {
      Alert.alert("Couldn't undo", (err as Error)?.message || "Try again, or refund it from the item.");
    }
  };

  const step = cartLines.length === 0 ? "Add items" : `${cartLines.length} item${cartLines.length === 1 ? "" : "s"} in cart`;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: SPACING.md }}>
          <View style={styles.sectionHead}>
            <SectionLabel>Items</SectionLabel>
            <Text style={styles.stepText}>{step}</Text>
          </View>
          <View style={styles.searchRow}>
            <TextInput
              accessibilityLabel="Search sale inventory"
              style={[styles.input, styles.flex]}
              placeholder="Search name, SKU or barcode"
              placeholderTextColor={COLORS.textSoft}
              value={query}
              onChangeText={setQuery}
            />
            <IconButton icon="barcode-outline" label="Scan barcode to add" variant="primary" onPress={openScanner} />
          </View>
          {loadingItems ? (
            <View accessibilityRole="progressbar" accessibilityLabel="Loading sellable inventory" style={{ gap: SPACING.xs }}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.helperText}>Getting your stock ready…</Text>
            </View>
          ) : itemsError ? (
            <View style={{ gap: SPACING.sm }}>
              <Text accessibilityRole="alert" style={styles.helperText}>{"Couldn't load your stock. Try again."}</Text>
              <Button label="Try loading stock again" variant="secondary" onPress={() => { setLoadingItems(true); void loadItems(); }} />
            </View>
          ) : (
            <View style={{ gap: SPACING.sm }}>
              {filtered.slice(0, 12).map((item) => {
                const added = !!cart[item.id];
                return (
                  <TouchableOpacity
                    key={item.id}
                    activeOpacity={0.84}
                    onPress={() => toggleItem(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`${added ? "Remove" : "Add"} ${item.name}`}
                  >
                    <View style={[styles.itemOption, added && styles.itemOptionActive]}>
                      <View style={[styles.check, added && styles.checkOn]}>
                        {added ? <Icon name="checkmark" size={15} color={BRAND.onPrimary} /> : null}
                      </View>
                      <View style={styles.flex}>
                        <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                        <Text style={styles.itemMeta}>Stock {resolveQty(item)} · {formatCurrency(item.expected_sell_price)}</Text>
                      </View>
                      <Pill label={added ? "Added" : "Add"} tone={added ? "primary" : "neutral"} />
                    </View>
                  </TouchableOpacity>
                );
              })}
              {filtered.length === 0 ? (
                <View style={{ gap: SPACING.sm }}>
                  <Text style={styles.helperText}>{items.length === 0 ? "Table's empty — add stock to start a sale." : "No sellable items match that search."}</Text>
                  {items.length === 0 ? (
                    <Button testID="sale-empty-add-stock" label="Add stock" variant="secondary" leadingIcon="add" onPress={() => router.push("/inventory/add")} />
                  ) : (
                    <Button label="Clear search" variant="secondary" onPress={() => setQuery("")} />
                  )}
                </View>
              ) : null}
            </View>
          )}
        </Card>

        {cartLines.length > 0 ? (
          <Card style={{ gap: SPACING.sm }}>
            <SectionLabel>Cart · {cartLines.length} item{cartLines.length === 1 ? "" : "s"}</SectionLabel>
            {cartLines.map((line) => {
              const sizes = sizeOptions(line.item);
              return (
                <View key={line.item.id} style={styles.cartLine}>
                  <View style={styles.cartTop}>
                    <View style={styles.flex}>
                      <Text style={styles.itemName} numberOfLines={2}>{line.item.name}</Text>
                      <Text style={styles.itemMeta}>List {formatCurrency(line.item.expected_sell_price)}</Text>
                    </View>
                    <Text style={styles.lineTotal}>{formatCents(toCents(line.price) * line.qty)}</Text>
                  </View>
                  {sizes.length > 0 ? (
                    <View style={styles.chipWrap} accessibilityRole="radiogroup" accessibilityLabel={`Size for ${line.item.name}`}>
                      {sizes.map((s) => {
                        const active = line.size === s.size;
                        const out = s.quantity <= 0;
                        return (
                          <Chip
                            key={s.size}
                            label={`${s.size} · ${s.quantity}`}
                            accessibilityLabel={`Size ${s.size}, ${s.quantity} in stock`}
                            active={active}
                            disabled={out}
                            onPress={() => pickSize(line.item.id, s.size)}
                          />
                        );
                      })}
                    </View>
                  ) : null}
                  <View style={styles.haggleRow}>
                    {HAGGLE_STEPS.map(({ step, label }) => (
                      <TouchableOpacity
                        key={step}
                        accessibilityRole="button"
                        accessibilityLabel={`${label} on ${line.item.name}`}
                        onPress={() => changePrice(line.item.id, haggle(line.price, listPrice(line.item), step))}
                        style={styles.haggleChip}
                        hitSlop={4}
                      >
                        <Text style={styles.haggleText}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.cartControls}>
                    <View style={styles.priceField}>
                      <Text style={styles.currency}>$</Text>
                      <TextInput
                        accessibilityLabel={`Sale price for ${line.item.name}`}
                        style={styles.priceInput}
                        value={line.price}
                        onChangeText={(value) => changePrice(line.item.id, value)}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                    <View style={styles.qtyStepper}>
                      <IconButton icon="remove" label={`Decrease ${line.item.name}`} onPress={() => changeQty(line.item.id, -1)} />
                      <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.qtyValue}>{line.qty}</Text>
                      <IconButton icon="add" label={`Increase ${line.item.name}`} onPress={() => changeQty(line.item.id, 1)} />
                    </View>
                  </View>
                </View>
              );
            })}

            <View style={styles.divider} />
            <TotalRow label="Subtotal" value={formatCents(totals.subtotal)} />

            <View style={styles.adjustRow}>
              <Text style={styles.adjustLabel}>Discount</Text>
              <View style={styles.segment}>
                <Chip label="$" accessibilityLabel="Discount in dollars" active={discountMode === "amount"} onPress={() => setDiscountMode("amount")} compact />
                <Chip label="%" accessibilityLabel="Discount in percent" active={discountMode === "percent"} onPress={() => setDiscountMode("percent")} compact />
              </View>
              <TextInput
                accessibilityLabel="Discount"
                style={styles.smallInput}
                placeholder="0"
                placeholderTextColor={COLORS.textSoft}
                value={discountValue}
                onChangeText={setDiscountValue}
                keyboardType="decimal-pad"
              />
            </View>
            {totals.discount > 0 ? <TotalRow label="Discount" value={`-${formatCents(totals.discount)}`} tone="success" /> : null}
            {totals.error ? <Text style={styles.errorText}>{totals.error}</Text> : null}

            <View style={styles.adjustRow}>
              <Text style={styles.adjustLabel}>Sales tax</Text>
              <Chip
                label={taxOn ? "On" : "Off"}
                accessibilityLabel="Charge sales tax"
                active={taxOn}
                onPress={() => setTaxOn((v) => !v)}
                compact
              />
              {taxOn ? (
                <View style={styles.rateField}>
                  <TextInput
                    accessibilityLabel="Sales tax rate"
                    style={styles.smallInput}
                    placeholder="6.625"
                    placeholderTextColor={COLORS.textSoft}
                    value={taxRate}
                    onChangeText={setTaxRate}
                    keyboardType="decimal-pad"
                  />
                  <Text style={styles.currency}>%</Text>
                </View>
              ) : null}
            </View>
            {taxOn && taxRate.trim() && taxRate.trim() !== defaultTax ? (
              <TouchableOpacity accessibilityRole="button" onPress={saveDefaultTax} style={styles.linkButton}>
                <Text style={styles.linkText}>Use {taxRate.trim()}% for every sale</Text>
              </TouchableOpacity>
            ) : null}
            {totals.tax > 0 ? <TotalRow label={`Tax (${taxRate.trim()}%)`} value={formatCents(totals.tax)} /> : null}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text maxFontSizeMultiplier={FONT_SCALE.display} style={styles.totalValue}>{formatCents(totals.total)}</Text>
            </View>
          </Card>
        ) : null}

        <Card style={{ gap: SPACING.sm }}>
          <SectionLabel>Customer (optional)</SectionLabel>
          <CustomerPicker
            selected={customer}
            onChange={(next) => {
              setCustomer(next);
              // A tax-exempt buyer pays no sales tax.
              if (next?.tax_exempt) setTaxOn(false);
            }}
          />
        </Card>

        <Card style={{ gap: SPACING.md }}>
          <SectionLabel>Payment</SectionLabel>
          {!splitting ? (
            <>
              <View style={styles.primaryMethods}>
                {PRIMARY_METHODS.map((entry) => (
                  <Button
                    key={entry}
                    label={paymentLabel(entry)}
                    leadingIcon={entry === "cash" ? "cash-outline" : "card-outline"}
                    variant={method === entry ? "primary" : "secondary"}
                    onPress={() => setMethod(entry)}
                    style={styles.flex}
                    accessibilityLabel={`Pay with ${paymentLabel(entry)}`}
                  />
                ))}
              </View>
              <View style={styles.chipWrap}>
                {OTHER_METHODS.map((entry) => (
                  <Chip key={entry} label={paymentLabel(entry)} active={method === entry} onPress={() => setMethod(entry)} />
                ))}
                <Chip label="Cash + card" accessibilityLabel="Split payment" icon="layers-outline" active={false} onPress={startSplit} />
              </View>
            </>
          ) : (
            <View style={{ gap: SPACING.sm }}>
              {split.map((row, index) => (
                <View key={row.key} style={styles.splitRow}>
                  <View style={styles.splitHead}>
                    <Text style={styles.adjustLabel}>Payment {index + 1}</Text>
                    <View style={styles.priceField}>
                      <Text style={styles.currency}>$</Text>
                      <TextInput
                        accessibilityLabel={`Payment ${index + 1} amount`}
                        style={styles.priceInput}
                        value={row.amount}
                        onChangeText={(amount) => updateRow(row.key, { amount })}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                    <IconButton icon="close" label={`Remove payment ${index + 1}`} variant="ghost" onPress={() => removeRow(row.key)} />
                  </View>
                  <View style={styles.chipWrap}>
                    {PART_METHODS.map((entry) => (
                      <Chip
                        key={entry}
                        label={paymentLabel(entry)}
                        accessibilityLabel={`Payment ${index + 1} ${paymentLabel(entry)}`}
                        active={row.method === entry}
                        onPress={() => updateRow(row.key, { method: entry })}
                        compact
                      />
                    ))}
                  </View>
                  {splitLeft !== 0 && index === split.length - 1 ? (
                    <TouchableOpacity accessibilityRole="button" onPress={() => fillRemaining(row.key)} style={styles.linkButton}>
                      <Text style={styles.linkText}>Make this {formatCents(Math.max(0, toCents(row.amount) + splitLeft))}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
              <View style={styles.splitFooter}>
                <Text style={[styles.helperText, splitLeft !== 0 && styles.errorText]}>
                  {splitLeft === 0
                    ? `Paid in full · ${formatCents(totals.total)}`
                    : splitLeft > 0
                      ? `${formatCents(splitLeft)} left to pay`
                      : `${formatCents(-splitLeft)} over the total`}
                </Text>
                <View style={styles.splitActions}>
                  <Button label="Add" size="sm" variant="secondary" leadingIcon="add" onPress={() => setSplit((rows) => [...rows, newRow("cash", splitLeft > 0 ? centsToString(splitLeft) : "")])} accessibilityLabel="Add payment" />
                  <Button label="One payment" size="sm" variant="ghost" onPress={() => setSplit([])} />
                </View>
              </View>
            </View>
          )}
          <TextInput
            accessibilityLabel="Fee amount"
            style={styles.input}
            placeholder="Processing fee (optional)"
            placeholderTextColor={COLORS.textSoft}
            value={feeAmount}
            onChangeText={setFeeAmount}
            keyboardType="decimal-pad"
          />
          <TextInput
            accessibilityLabel="Sale notes"
            style={[styles.input, styles.notesInput]}
            placeholder="Notes"
            placeholderTextColor={COLORS.textSoft}
            value={notes}
            onChangeText={setNotes}
            multiline
          />
          <Text style={styles.helperText}>
            You keep {formatCents(totals.gross - fee)} after fees{totals.tax > 0 ? `; ${formatCents(totals.tax)} is tax` : ""}.
          </Text>
          <Button
            label={submitting ? "Logging Sale..." : `Log Sale · ${formatCents(totals.total)}`}
            onPress={handleSubmit}
            disabled={submitting}
            loading={submitting}
            size="lg"
            fullWidth
            haptic="none"
          />
          <Button
            label="End-of-show summary"
            variant="ghost"
            leadingIcon="stats-chart-outline"
            onPress={() => router.push("/settings/show-summary")}
            fullWidth
          />
        </Card>
      </ScrollView>

      <Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scanner}>
          <CameraView
            style={styles.flex}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "qr"] }}
            onBarcodeScanned={onBarcodeScanned}
          />
          <ScannerOverlay
            hint={cartLines.length ? `${cartLines.reduce((n, l) => n + l.qty, 0)} in cart · keep scanning` : "Scan items to add them to the sale"}
            onCancel={() => setScannerOpen(false)}
            cancelLabel="Done"
          />
          {scanNote ? (
            <View
              testID="scan-note"
              accessibilityLiveRegion="polite"
              style={[styles.scanNote, { top: insets.top + SPACING.md }, !scanNote.ok && styles.scanNoteWarn]}
            >
              <Icon name={scanNote.ok ? "checkmark-circle" : "alert-circle"} size={18} color={scanNote.ok ? COLORS.success : COLORS.warning} />
              <Text numberOfLines={2} style={styles.scanNoteText}>{scanNote.text}</Text>
            </View>
          ) : null}
        </View>
      </Modal>

      <ReceiptSheet
        receipt={receipt}
        onUndo={undoSale}
        onNewSale={() => {
          resetSale();
          void maybeAskForRating();
        }}
        onDone={() => {
          resetSale();
          router.replace("/(tabs)/dashboard");
          void maybeAskForRating();
        }}
      />
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  disabled = false,
  compact = false,
  icon,
  accessibilityLabel,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  icon?: React.ComponentProps<typeof Icon>["name"];
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={() => {
        triggerHaptic("light");
        onPress();
      }}
      hitSlop={compact ? { top: 4, bottom: 4, left: 2, right: 2 } : undefined}
      style={[styles.chip, compact && styles.chipCompact, active && styles.chipActive, disabled && styles.chipDisabled]}
    >
      {icon ? <Icon name={icon} size={15} color={active ? BRAND.onPrimary : COLORS.textMuted} /> : null}
      <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function TotalRow({ label, value, tone }: { label: string; value: string; tone?: "success" }) {
  return (
    <View style={styles.subRow}>
      <Text style={styles.subLabel}>{label}</Text>
      <Text style={[styles.subValue, tone === "success" && { color: COLORS.success }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.md, paddingBottom: 48, gap: SPACING.md, width: "100%", maxWidth: 720, alignSelf: "center" },
  flex: { flex: 1 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm },
  stepText: { ...TYPE.footnote, color: COLORS.textMuted },
  searchRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  input: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADII.md,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
    minWidth: 0,
  },
  itemOption: {
    flexDirection: "row",
    gap: SPACING.sm,
    alignItems: "center",
    backgroundColor: COLORS.bgElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  itemOptionActive: { borderColor: COLORS.primary },
  check: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
  },
  checkOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  itemName: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  itemMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  errorText: { color: COLORS.danger, fontSize: 13, lineHeight: 18 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
  },
  chipCompact: { minHeight: 36, paddingHorizontal: 12 },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipDisabled: { opacity: 0.4 },
  chipText: { ...TYPE.footnote, color: COLORS.textMuted, fontWeight: "600" },
  chipTextActive: { color: BRAND.onPrimary },
  cartLine: {
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cartTop: { flexDirection: "row", alignItems: "flex-start", gap: SPACING.sm },
  haggleRow: { flexDirection: "row", gap: SPACING.xs, flexWrap: "wrap" },
  haggleChip: { minHeight: 32, paddingHorizontal: SPACING.sm, justifyContent: "center", borderRadius: 16, borderWidth: 1, borderColor: COLORS.border },
  haggleText: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
  cartControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING.sm },
  qtyStepper: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  qtyValue: { color: COLORS.text, fontSize: 16, fontWeight: "600", minWidth: 24, textAlign: "center" },
  lineTotal: { color: COLORS.text, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  priceField: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADII.sm,
    paddingLeft: 10,
    minHeight: 44,
    flexShrink: 1,
  },
  currency: { color: COLORS.textMuted, fontSize: 15, fontWeight: "600" },
  priceInput: {
    color: COLORS.text,
    fontWeight: "600",
    fontSize: 15,
    width: 96,
    minHeight: 44,
    paddingHorizontal: 8,
    textAlign: "right",
  },
  divider: { height: 1, backgroundColor: COLORS.border, marginVertical: SPACING.xs },
  subRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  subLabel: { color: COLORS.textMuted, fontSize: 14, fontWeight: "600" },
  subValue: { color: COLORS.text, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  adjustRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm, flexWrap: "wrap" },
  adjustLabel: { color: COLORS.text, fontSize: 14, fontWeight: "600", flexGrow: 1 },
  segment: { flexDirection: "row", gap: 4 },
  smallInput: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: RADII.sm,
    color: COLORS.text,
    fontWeight: "600",
    width: 84,
    minHeight: 44,
    paddingHorizontal: 10,
    textAlign: "right",
  },
  rateField: { flexDirection: "row", alignItems: "center", gap: 6 },
  linkButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { color: COLORS.primaryBright, fontSize: 14, fontWeight: "600" },
  totalRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: SPACING.sm, marginTop: SPACING.xs,
  },
  totalLabel: { color: COLORS.textMuted, fontSize: 15, fontWeight: "600" },
  totalValue: { color: COLORS.text, fontSize: 24, fontWeight: "600", fontVariant: ["tabular-nums"] },
  primaryMethods: { flexDirection: "row", gap: SPACING.sm },
  splitRow: {
    gap: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: RADII.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgElevated,
  },
  splitHead: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  splitFooter: { gap: SPACING.sm },
  splitActions: { flexDirection: "row", gap: SPACING.sm },
  notesInput: { minHeight: 72, textAlignVertical: "top" },
  scanner: { flex: 1, backgroundColor: COLORS.canvas },
  // Always over the camera, so a fixed dark pill reads in both modes.
  scanNote: {
    position: "absolute",
    left: SPACING.md,
    right: SPACING.md,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADII.pill,
    backgroundColor: "rgba(14,14,17,0.82)",
    borderWidth: 1,
    borderColor: "rgba(95,214,156,0.5)",
  },
  scanNoteWarn: { borderColor: "rgba(237,191,98,0.6)" },
  scanNoteText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600", flex: 1 },
});
