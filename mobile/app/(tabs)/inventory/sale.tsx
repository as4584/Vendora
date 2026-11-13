import { useCallback, useEffect, useRef, useState } from "react";
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

// Cash and card first: that is how almost every show sale is paid.
const PRIMARY_METHODS = ["cash", "card"];
const OTHER_METHODS = ["venmo", "cashapp", "paypal", "zelle", "other"];
const PART_METHODS = [...PRIMARY_METHODS, ...OTHER_METHODS];
const CATALOG_PAGE_SIZE = 12;

// price: the agreed per-unit price as typed (defaults to the list price, editable to haggle).
type CartLine = { item: api.InventoryItem; qty: number; price: string; size?: string };
type PaymentRow = { key: string; method: string; amount: string };

const listPrice = (item: api.InventoryItem) => centsToString(toCents(item.expected_sell_price || "0"));
const cartKey = (itemId: string, size?: string) => size ? `${itemId}:${size.trim().toLowerCase()}` : itemId;
const lineMax = (line: CartLine, cart: Record<string, CartLine>, key: string) => {
  const sizes = sizeOptions(line.item);
  const otherQty = Object.entries(cart).reduce(
    (sum, [id, other]) => id !== key && other.item.id === line.item.id ? sum + other.qty : sum,
    0,
  );
  const available = Math.max(0, resolveQty(line.item) - otherQty);
  if (!sizes.length) return available;
  if (!line.size) return Math.min(1, available);
  return Math.min(available, sizes.find((s) => s.size === line.size)?.quantity ?? 0);
};
const unselectedSizes = (item: api.InventoryItem, cart: Record<string, CartLine>) =>
  sizeOptions(item).filter((s) => s.quantity > 0 && !cart[cartKey(item.id, s.size)]);
let rowSeq = 0;
const newRow = (method: string, amount = ""): PaymentRow => ({ key: `p${++rowSeq}`, method, amount });
const newCheckoutId = () => `checkout_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

export default function QuickSaleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ add?: string }>();
  const [items, setItems] = useState<api.InventoryItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [itemsError, setItemsError] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(0);
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
  const catalogRequest = useRef(0);
  const submissionInFlight = useRef(false);
  const checkoutAttempt = useRef<{ fingerprint: string; id: string } | null>(null);

  const addToCart = useCallback((item: api.InventoryItem) => {
    setCart((prev) => {
      const variants = sizeOptions(item);
      const sizes = variants.filter((s) => s.quantity > 0);
      if (variants.length && !sizes.length) return prev;
      const options = unselectedSizes(item, prev);
      if (sizes.length > 1 && (!options.length || prev[item.id])) return prev;
      const size = options.length === 1 ? options[0].size : sizes.length === 1 ? sizes[0].size : undefined;
      const key = cartKey(item.id, size);
      const existing = prev[key];
      const line = existing ? { ...existing, qty: existing.qty + 1 } : { item, qty: 1, price: listPrice(item), size };
      const qty = Math.min(lineMax(line, prev, key), line.qty);
      if (!qty) return prev;
      return { ...prev, [key]: { ...line, qty } };
    });
  }, []);

  const loadItems = useCallback(async (term: string, nextPage = 1) => {
    const request = ++catalogRequest.current;
    setLoadingItems(true);
    setItemsError(false);
    try {
      const result = await api.listItems({
        perPage: CATALOG_PAGE_SIZE,
        availableOnly: true,
        ...(nextPage > 1 ? { page: nextPage } : {}),
        ...(term ? { q: term } : {}),
      });
      if (request !== catalogRequest.current) return;
      if (nextPage === 1) setItems(result.items);
      else {
        setItems((prev) => Array.from(new Map([...prev, ...result.items].map((item) => [item.id, item])).values()));
      }
      setPage(nextPage);
      setPages(result.pages);
    } catch {
      if (request === catalogRequest.current) setItemsError(true);
    } finally {
      if (request === catalogRequest.current) setLoadingItems(false);
    }
  }, []);

  const term = query.trim();
  useEffect(() => {
    const timer = setTimeout(() => { void loadItems(term); }, term ? 200 : 0);
    return () => {
      clearTimeout(timer);
      catalogRequest.current += 1;
    };
  }, [loadItems, term]);

  useEffect(() => {
    const add = params.add;
    if (!add) return;
    let active = true;
    // "Sell this" must work even when the item isn't on the first page.
    api.getItem(add).then((item) => {
      if (active && resolveQty(item) > 0 && (item.status === "in_stock" || item.status === "listed")) addToCart(item);
    }).catch(() => {
      if (active) Alert.alert("Item unavailable", "Search your inventory to add an item to this sale.");
    });
    return () => { active = false; };
  }, [addToCart, params.add]);

  useEffect(() => {
    let active = true;
    api
      .getMe()
      .then((me) => {
        if (!active) return;
        setBusinessName(me.business_name);
        const rate = me.sales_tax_rate ? String(Number(me.sales_tax_rate)) : "";
        if (rate && Number(rate) > 0) {
          setDefaultTax(rate);
          setTaxRate(rate);
          setTaxOn(true);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const changeSearch = (value: string) => {
    if (value.trim() !== term) {
      catalogRequest.current += 1;
      setItems([]);
      setPage(0);
      setPages(0);
      setLoadingItems(true);
      setItemsError(false);
    }
    setQuery(value);
  };

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

  const removeCartLine = (id: string) => {
    setCart((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const changeQty = (id: string, delta: number) => {
    setCart((prev) => {
      const line = prev[id];
      if (!line) return prev;
      const qty = Math.max(1, Math.min(lineMax(line, prev, id), line.qty + delta));
      return { ...prev, [id]: { ...line, qty } };
    });
  };

  const changePrice = (id: string, price: string) => {
    setCart((prev) => ({ ...prev, [id]: { ...prev[id], price } }));
  };

  const pickSize = (id: string, size: string) => {
    setCart((prev) => {
      if (!prev[id]) return prev;
      const line = { ...prev[id], size };
      const key = cartKey(line.item.id, size);
      if (key !== id && prev[key]) return prev;
      const qty = Math.min(line.qty, lineMax(line, prev, id));
      if (!qty) return prev;
      // Retain cart order when replacing a placeholder with a sized line.
      return Object.fromEntries(Object.entries(prev).map(([k, v]) =>
        k === id ? [key, { ...line, qty }] : [k, v],
      ));
    });
  };

  const startSplit = () => {
    const half = Math.floor(totals.total / 2);
    setSplit([newRow("cash", centsToString(totals.total - half)), newRow("card", centsToString(half))]);
  };

  const updateRow = (key: string, patch: Partial<PaymentRow>) =>
    setSplit((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

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
    setScannerOpen(true);
  };

  const onBarcodeScanned = async ({ data }: { data: string }) => {
    if (scanLock.current) return;
    scanLock.current = true;
    setScannerOpen(false);
    let hit = items.find((item) => sameBarcode(item.upc, data));
    if (!hit) {
      try {
        const res = await api.listItems({ upc: data, perPage: 5, availableOnly: true });
        hit = res.items[0];
      } catch {
        hit = undefined;
      }
    }
    if (hit) {
      triggerHaptic("success");
      addToCart(hit);
    } else {
      triggerHaptic("warning");
      Alert.alert(
        "Not in your inventory",
        `Nothing in stock has barcode ${data}. Add it in Add Stock first, or search for it by name.`,
        [
          { text: "OK" },
          { text: "Add item", onPress: () => router.push("/inventory/add") },
        ]
      );
    }
  };

  const resetSale = () => {
    checkoutAttempt.current = null;
    setCart({});
    setMethod("cash");
    setSplit([]);
    setFeeAmount("");
    setDiscountMode("amount");
    setDiscountValue("");
    setTaxRate(defaultTax);
    setTaxOn(Number(defaultTax) > 0);
    setNotes("");
    setCustomer(null);
    setReceipt(null);
    if (term) changeSearch("");
    else {
      setItems([]);
      setPage(0);
      void loadItems("");
    }
  };

  const handleSubmit = async () => {
    if (submissionInFlight.current) return;
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
    submissionInFlight.current = true;
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
      const fingerprint = JSON.stringify(payload);
      // A retry after an ambiguous failure may be the same sale on the server.
      // Keep its key until the sale resets or the operator changes the order.
      if (checkoutAttempt.current?.fingerprint !== fingerprint) {
        checkoutAttempt.current = {
          fingerprint,
          id: newCheckoutId(),
        };
      }
      payload.client_request_id = checkoutAttempt.current.id;
      const order = await api.createSaleOrder(payload);
      const offline = !!order.pending || !isOnline();
      triggerHaptic("success");
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
      submissionInFlight.current = false;
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
              maxLength={200}
              value={query}
              onChangeText={changeSearch}
            />
            <IconButton icon="barcode-outline" label="Scan barcode to add" variant="primary" onPress={openScanner} />
          </View>
          {loadingItems && items.length === 0 ? (
            <View accessibilityRole="progressbar" accessibilityLabel="Loading sellable inventory" style={{ gap: SPACING.xs }}>
              <ActivityIndicator color={COLORS.primary} />
              <Text style={styles.helperText}>Getting your stock ready…</Text>
            </View>
          ) : itemsError && items.length === 0 ? (
            <View style={{ gap: SPACING.sm }}>
              <Text accessibilityRole="alert" style={styles.helperText}>{"Couldn't load your stock. Try again."}</Text>
              <Button label="Try loading stock again" variant="secondary" onPress={() => { void loadItems(term); }} />
            </View>
          ) : (
            <View style={{ gap: SPACING.sm }}>
              {items.map((item) => {
                const sized = sizeOptions(item).length > 0;
                const added = cartLines.some((line) => line.item.id === item.id);
                const anotherSize = sized && added && !cart[item.id] && unselectedSizes(item, cart).length > 0
                  && lineMax({ item, qty: 1, price: "" }, cart, item.id) > 0;
                const action = added ? sized ? (anotherSize ? "Add size" : "Added") : "Remove" : "Add";
                return (
                  <TouchableOpacity
                    key={item.id}
                    activeOpacity={0.84}
                    onPress={() => added && !sized ? removeCartLine(item.id) : addToCart(item)}
                    disabled={action === "Added"}
                    accessibilityRole="button"
                    accessibilityLabel={`${action} ${item.name}`}
                  >
                    <View style={[styles.itemOption, added && styles.itemOptionActive]}>
                      <View style={[styles.check, added && styles.checkOn]}>
                        {added ? <Icon name="checkmark" size={15} color={BRAND.onPrimary} /> : null}
                      </View>
                      <View style={styles.flex}>
                        <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                        <Text style={styles.itemMeta}>Stock {resolveQty(item)} · {formatCurrency(item.expected_sell_price)}</Text>
                      </View>
                      <Pill label={added && !sized ? "Added" : action} tone={added ? "primary" : "neutral"} />
                    </View>
                  </TouchableOpacity>
                );
              })}
              {items.length === 0 ? (
                <View style={{ gap: SPACING.sm }}>
                  <Text style={styles.helperText}>{term ? "No sellable items match that search." : "Table's empty — add stock to start a sale."}</Text>
                  {!term ? (
                    <Button testID="sale-empty-add-stock" label="Add stock" variant="secondary" leadingIcon="add" onPress={() => router.push("/inventory/add")} />
                  ) : (
                    <Button label="Clear search" variant="secondary" onPress={() => changeSearch("")} />
                  )}
                </View>
              ) : null}
              {items.length > 0 && itemsError ? (
                <Text accessibilityRole="alert" style={styles.helperText}>{"Couldn't load more stock. Try again."}</Text>
              ) : null}
              {page < pages ? (
                <Button
                  label={itemsError ? "Retry loading more stock" : "Show more stock"}
                  variant="secondary"
                  loading={loadingItems}
                  onPress={() => { void loadItems(term, page + 1); }}
                />
              ) : null}
            </View>
          )}
        </Card>

        {cartLines.length > 0 ? (
          <Card style={{ gap: SPACING.sm }}>
            <SectionLabel>Cart · {cartLines.length} item{cartLines.length === 1 ? "" : "s"}</SectionLabel>
            {Object.entries(cart).map(([key, line]) => {
              const sizes = sizeOptions(line.item);
              const sameItem = cartLines.filter((other) => other.item.id === line.item.id);
              const lineLabel = sameItem.length > 1 ? `${line.item.name}, ${line.size ? `size ${line.size}` : "choose size"}` : line.item.name;
              return (
                <View key={key} style={styles.cartLine}>
                  <View style={styles.cartTop}>
                    <View style={styles.flex}>
                      <Text style={styles.itemName} numberOfLines={2}>{line.item.name}</Text>
                      <Text style={styles.itemMeta}>{line.size ? `Size ${line.size} · ` : ""}List {formatCurrency(line.item.expected_sell_price)}</Text>
                    </View>
                    <Text style={styles.lineTotal}>{formatCents(toCents(line.price) * line.qty)}</Text>
                    <IconButton icon="close" label={`Remove ${lineLabel} from cart`} onPress={() => removeCartLine(key)} />
                  </View>
                  {sizes.length > 0 ? (
                    <View style={styles.chipWrap} accessibilityRole="radiogroup" accessibilityLabel={`Size for ${lineLabel}`}>
                      {sizes.map((s) => {
                        const active = line.size === s.size;
                        const out = s.quantity <= 0 || (!active && !!cart[cartKey(line.item.id, s.size)]);
                        return (
                          <Chip
                            key={s.size}
                            label={`${s.size} · ${s.quantity}`}
                            accessibilityLabel={`Size ${s.size}, ${s.quantity} in stock${sameItem.length > 1 ? `, for ${lineLabel}` : ""}`}
                            active={active}
                            disabled={out}
                            onPress={() => pickSize(key, s.size)}
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
                        accessibilityLabel={`${label} on ${lineLabel}`}
                        onPress={() => changePrice(key, haggle(line.price, listPrice(line.item), step))}
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
                        accessibilityLabel={`Sale price for ${lineLabel}`}
                        style={styles.priceInput}
                        value={line.price}
                        onChangeText={(value) => changePrice(key, value)}
                        keyboardType="decimal-pad"
                        selectTextOnFocus
                      />
                    </View>
                    <View style={styles.qtyStepper}>
                      <IconButton icon="remove" label={`Decrease ${lineLabel}`} onPress={() => changeQty(key, -1)} />
                      <Text maxFontSizeMultiplier={FONT_SCALE.chrome} style={styles.qtyValue}>{line.qty}</Text>
                      <IconButton icon="add" label={`Increase ${lineLabel}`} onPress={() => changeQty(key, 1)} />
                    </View>
                  </View>
                  {line.size && sameItem[0] === line && !cart[line.item.id]
                    && unselectedSizes(line.item, cart).length > 0
                    && lineMax({ ...line, size: undefined }, cart, line.item.id) > 0 ? (
                    <Button label="Add another size" variant="secondary" onPress={() => addToCart(line.item)} />
                  ) : null}
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
                <Chip label="Split" accessibilityLabel="Split payment" icon="layers-outline" active={false} onPress={startSplit} />
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
          <ScannerOverlay hint="Scan an item to add it to the sale" onCancel={() => setScannerOpen(false)} />
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
  scanner: { flex: 1, backgroundColor: COLORS.bg },
});
