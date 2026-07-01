import { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import * as api from "../../../services/api";
import { ActionButton, Card, HeaderTitle, Pill, SectionLabel } from "../../../components/ui";
import { COLORS, SPACING } from "../../../theme/tokens";
import { formatCompactDate, formatCurrency, resolveQty, sizeBreakdown } from "../../../utils/inventory";
import { downloadPdfFile, previewPdfFile } from "../../../utils/fileActions";

interface DraftLineItem {
  description: string;
  quantity: string;
  unit_price: string;
  inventory_item_id?: string;
  size_label?: string;
  stock_label?: string;
}

function availableVariants(item: api.InventoryItem): api.SizeVariant[] {
  const variants = item.custom_attributes?.variants;
  if (!Array.isArray(variants)) return [];
  return variants
    .filter((variant: any) => variant?.size && Number(variant?.quantity || 0) > 0)
    .map((variant: any) => ({ size: String(variant.size), quantity: Number(variant.quantity || 0) }));
}

export default function InvoicesScreen() {
  const router = useRouter();
  const scrollRef = useRef<ScrollView | null>(null);
  const lineItemsAnchorY = useRef(0);
  const { width } = useWindowDimensions();

  const [view, setView] = useState<"create" | "history">("create");
  const [inventory, setInventory] = useState<api.InventoryItem[]>([]);
  const [invoices, setInvoices] = useState<api.InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [tax, setTax] = useState("0.00");
  const [shipping, setShipping] = useState("0.00");
  const [discount, setDiscount] = useState("0.00");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [openingInvoiceId, setOpeningInvoiceId] = useState<string | null>(null);
  const [recentlyAddedName, setRecentlyAddedName] = useState<string | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<api.InvoiceData | null>(null);
  const [lineItems, setLineItems] = useState<DraftLineItem[]>([
    { description: "", quantity: "1", unit_price: "" },
  ]);
  const [inventoryQuery, setInventoryQuery] = useState("");

  const compactLineItemLayout = width < 520;

  useEffect(() => {
    Promise.all([
      api.listInvoices({ perPage: 20 }),
      api.listItems({ perPage: 60, availableOnly: true }),
    ])
      .then(([invoicePage, inventoryPage]) => {
        setInvoices(invoicePage.items);
        setInventory(inventoryPage.items);
      })
      .catch(() => Alert.alert("Invoices unavailable", "Could not load invoices or inventory."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const trimmed = inventoryQuery.trim();
    if (!trimmed) return;

    const timer = globalThis.setTimeout(() => {
      setInventoryLoading(true);
      api.listItems({ perPage: 20, availableOnly: true, q: trimmed })
        .then((inventoryPage) => setInventory(inventoryPage.items))
        .catch(() => Alert.alert("Inventory search failed", "Could not search your inventory."))
        .finally(() => setInventoryLoading(false));
    }, 350);

    return () => globalThis.clearTimeout(timer);
  }, [inventoryQuery]);

  const filteredInventory = useMemo(() => {
    if (!inventoryQuery.trim()) return inventory;
    const q = inventoryQuery.toLowerCase();
    return inventory.filter((item) =>
      [item.name, item.sku || "", item.category || ""].some((value) =>
        value.toLowerCase().includes(q)
      )
    );
  }, [inventory, inventoryQuery]);

  const subtotal = lineItems.reduce((sum, item) => {
    return sum + (parseInt(item.quantity || "0", 10) || 0) * (parseFloat(item.unit_price || "0") || 0);
  }, 0);

  const total =
    subtotal +
    (parseFloat(tax || "0") || 0) +
    (parseFloat(shipping || "0") || 0) -
    (parseFloat(discount || "0") || 0);

  const updateLineItem = (index: number, field: keyof DraftLineItem, value: string) => {
    setLineItems((previous) => {
      const next = [...previous];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addFromInventory = (item: api.InventoryItem, variant?: api.SizeVariant) => {
    const selectedSize = variant?.size || item.size || undefined;
    const nextItem: DraftLineItem = {
      description: selectedSize ? `${item.name} - Size ${selectedSize}` : item.name,
      quantity: "1",
      unit_price: item.expected_sell_price || item.buy_price || "",
      inventory_item_id: item.id,
      size_label: selectedSize,
      stock_label: variant ? `Size stock ${variant.quantity}` : `Stock ${resolveQty(item)}`,
    };

    setLineItems((previous) => {
      const hasOnlyBlankDraft =
        previous.length === 1 &&
        !previous[0].description.trim() &&
        !previous[0].unit_price.trim() &&
        previous[0].quantity === "1";
      return hasOnlyBlankDraft ? [nextItem] : [...previous, nextItem];
    });

    setRecentlyAddedName(selectedSize ? `${item.name} size ${selectedSize}` : item.name);
    globalThis.setTimeout(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(lineItemsAnchorY.current - SPACING.md, 0),
        animated: true,
      });
    }, 50);
  };

  const handleClose = () => {
    router.replace("/dashboard" as any);
  };

  const handleOpenInvoice = async (invoiceId: string, mode: "preview" | "download" = "preview") => {
    setOpeningInvoiceId(invoiceId);
    try {
      const { pdf_base64, filename } = await api.exportInvoicePdf(invoiceId);
      if (mode === "download") {
        await downloadPdfFile(pdf_base64, filename);
      } else {
        await previewPdfFile(pdf_base64, filename);
      }
    } catch (err: any) {
      Alert.alert("Invoice unavailable", err?.message || "Could not open the invoice PDF.");
    } finally {
      setOpeningInvoiceId(null);
    }
  };

  const handleCreate = async () => {
    if (!customerName.trim()) {
      Alert.alert("Customer required", "Add a customer name before creating the invoice.");
      return;
    }
    if (lineItems.some((item) => !item.description.trim() || !item.unit_price.trim())) {
      Alert.alert("Line items required", "Each invoice row needs a description and a unit price.");
      return;
    }

    setSubmitting(true);
    try {
      const invoice = await api.createInvoice({
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim() || undefined,
        tax,
        shipping,
        discount,
        notes: notes.trim() || undefined,
        items: lineItems.map((item) => ({
          description: item.description.trim(),
          quantity: parseInt(item.quantity || "1", 10) || 1,
          unit_price: item.unit_price.trim(),
          inventory_item_id: item.inventory_item_id,
          size_label: item.size_label,
        })),
      });

      setInvoices((previous) => [invoice, ...previous.filter((existing) => existing.id !== invoice.id)]);
      setCustomerName("");
      setCustomerEmail("");
      setTax("0.00");
      setShipping("0.00");
      setDiscount("0.00");
      setNotes("");
      setRecentlyAddedName(null);
      setLineItems([{ description: "", quantity: "1", unit_price: "" }]);
      setSelectedInvoice(invoice);
      Alert.alert("Invoice created", `${invoice.customer_name} - ${formatCurrency(invoice.total)}`);
      setView("history");
    } catch (err: any) {
      Alert.alert("Invoice failed", err?.message || "Could not create the invoice.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.content}>
      <HeaderTitle
        title="Invoices"
        subtitle="Create inventory-backed invoices, open them as PDFs, and jump back to the dashboard when you're done."
        right={<ActionButton label="X" onPress={handleClose} tone="ghost" compact />}
      />

      <View style={styles.segmentRow}>
        <TouchableOpacity onPress={() => setView("create")}>
          <Pill label="Create Invoice" tone={view === "create" ? "primary" : "neutral"} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setView("history")}>
          <Pill label="Recent Invoices" tone={view === "history" ? "primary" : "neutral"} />
        </TouchableOpacity>
      </View>

      {view === "create" ? (
        <>
          <Card style={{ gap: SPACING.md }}>
            <SectionLabel>Customer</SectionLabel>
            <TextInput
              accessibilityLabel="Customer Name"
              style={styles.input}
              placeholder="Customer Name"
              placeholderTextColor={COLORS.textSoft}
              value={customerName}
              onChangeText={setCustomerName}
            />
            <TextInput
              accessibilityLabel="Customer Email"
              style={styles.input}
              placeholder="Email (optional)"
              placeholderTextColor={COLORS.textSoft}
              value={customerEmail}
              onChangeText={setCustomerEmail}
              autoCapitalize="none"
            />
          </Card>

          <Card style={{ gap: SPACING.md }}>
            <SectionLabel>From Inventory</SectionLabel>
            <TextInput
              accessibilityLabel="Search invoice inventory"
              style={styles.input}
              placeholder="Search by item name, SKU, or category"
              placeholderTextColor={COLORS.textSoft}
              value={inventoryQuery}
              onChangeText={setInventoryQuery}
            />
            <Text style={styles.helperText}>
              {recentlyAddedName
                ? `${recentlyAddedName} was added to the invoice below.`
                : "Search finds matching in-stock items from your inventory, then adds the selected item below."}
            </Text>
            {inventoryLoading ? <ActivityIndicator size="small" color={COLORS.primary} /> : null}
            <View style={{ gap: SPACING.sm }}>
              {filteredInventory.slice(0, 8).map((item) => {
                const variants = availableVariants(item);
                return (
                <View key={item.id} style={styles.inventoryOption}>
                    <View style={styles.inventoryTextWrap}>
                      <Text style={styles.optionTitle}>{item.name}</Text>
                      <Text style={styles.optionMeta}>
                        {sizeBreakdown(item)} - Stock {resolveQty(item)} - Ask {formatCurrency(item.expected_sell_price)}
                      </Text>
                      {variants.length > 0 ? (
                        <View style={styles.sizeChoiceRow}>
                          {variants.map((variant) => (
                            <TouchableOpacity
                              accessibilityLabel={`Add ${item.name} size ${variant.size}`}
                              accessibilityRole="button"
                              key={`${item.id}-${variant.size}`}
                              activeOpacity={0.84}
                              onPress={() => addFromInventory(item, variant)}
                            >
                              <View style={styles.sizeChoice}>
                                <Text style={styles.sizeChoiceText}>{variant.size}</Text>
                                <Text style={styles.sizeChoiceQty}>{variant.quantity}</Text>
                              </View>
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : null}
                    </View>
                    {variants.length === 0 ? (
                      <TouchableOpacity accessibilityLabel={`Add ${item.name}`} accessibilityRole="button" activeOpacity={0.84} onPress={() => addFromInventory(item)}>
                        <View style={styles.inlineAction}>
                          <Text style={styles.inlineActionText}>Add</Text>
                        </View>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                );
              })}
              {!inventoryLoading && filteredInventory.length === 0 ? (
                <Text style={styles.helperText}>No in-stock items matched that search.</Text>
              ) : null}
            </View>
          </Card>

          <View
            onLayout={(event) => {
              lineItemsAnchorY.current = event.nativeEvent.layout.y;
            }}
          >
            <Card style={{ gap: SPACING.md }}>
              <SectionLabel>Line Items</SectionLabel>
              <Text style={styles.helperText}>
                Add from inventory, review the price, then create and open the finished invoice.
              </Text>
              {lineItems.map((item, index) => (
                <View key={`${index}-${item.inventory_item_id || "custom"}`} style={styles.lineItemCard}>
                  {item.inventory_item_id ? (
                    <View style={styles.lineItemMetaRow}>
                      <Pill label="From Inventory" tone="success" />
                      <Text style={styles.lineItemHint}>
                        {item.size_label ? `Size ${item.size_label}` : "No size selected"} - {item.stock_label}
                      </Text>
                    </View>
                  ) : null}
                  <TextInput
                    accessibilityLabel={`Line item ${index + 1} description`}
                    style={styles.input}
                    placeholder="Description"
                    placeholderTextColor={COLORS.textSoft}
                    value={item.description}
                    onChangeText={(value) => updateLineItem(index, "description", value)}
                  />
                  <View style={[styles.dualRow, compactLineItemLayout && styles.dualRowStack]}>
                    <TextInput
                      accessibilityLabel={`Line item ${index + 1} quantity`}
                      style={[styles.input, styles.flexInput]}
                      placeholder="Qty"
                      placeholderTextColor={COLORS.textSoft}
                      value={item.quantity}
                      keyboardType="number-pad"
                      onChangeText={(value) => updateLineItem(index, "quantity", value)}
                    />
                    <TextInput
                      accessibilityLabel={`Line item ${index + 1} unit price`}
                      style={[styles.input, styles.flexInput]}
                      placeholder="Unit price"
                      placeholderTextColor={COLORS.textSoft}
                      value={item.unit_price}
                      keyboardType="decimal-pad"
                      onChangeText={(value) => updateLineItem(index, "unit_price", value)}
                    />
                  </View>
                </View>
              ))}
              <ActionButton
                label="Add Custom Item"
                onPress={() =>
                  setLineItems((previous) => [...previous, { description: "", quantity: "1", unit_price: "" }])
                }
                tone="secondary"
                compact
              />
            </Card>
          </View>

          <Card style={{ gap: SPACING.md }}>
            <SectionLabel>Totals</SectionLabel>
            <Text style={styles.helperText}>
              Add only the extra charges or credits the customer should see on this invoice.
            </Text>
            <View style={[styles.dualRow, compactLineItemLayout && styles.dualRowStack]}>
              <View style={styles.adjustmentField}>
                <Text style={styles.fieldLabel}>Sales tax</Text>
                <TextInput
                  accessibilityLabel="Sales tax"
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={COLORS.textSoft}
                  value={tax}
                  onChangeText={setTax}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.adjustmentField}>
                <Text style={styles.fieldLabel}>Shipping charged</Text>
                <TextInput
                  accessibilityLabel="Shipping charged"
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={COLORS.textSoft}
                  value={shipping}
                  onChangeText={setShipping}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>
            <View style={styles.adjustmentField}>
              <Text style={styles.fieldLabel}>Discount or credit</Text>
              <TextInput
                accessibilityLabel="Discount or credit"
                style={styles.input}
                placeholder="0.00"
                placeholderTextColor={COLORS.textSoft}
                value={discount}
                onChangeText={setDiscount}
                keyboardType="decimal-pad"
              />
            </View>
            <TextInput
              accessibilityLabel="Invoice notes"
              style={[styles.input, styles.notesInput]}
              placeholder="Notes"
              placeholderTextColor={COLORS.textSoft}
              value={notes}
              onChangeText={setNotes}
              multiline
            />
            <View style={styles.totalBlock}>
              <Text style={styles.totalLine}>Subtotal {formatCurrency(String(subtotal.toFixed(2)))}</Text>
              <Text style={styles.totalLine}>Total {formatCurrency(String(total.toFixed(2)))}</Text>
            </View>
            <ActionButton
              label={submitting ? "Creating..." : "Create Invoice"}
              onPress={handleCreate}
              disabled={submitting}
            />
          </Card>
        </>
      ) : (
        <Card style={{ gap: SPACING.sm }}>
          <SectionLabel>Recent Invoices</SectionLabel>
          {selectedInvoice ? (
            <Card style={styles.previewCard}>
              <View style={styles.previewHeader}>
                <View style={{ flex: 1 }}>
                  <SectionLabel>Open Invoice</SectionLabel>
                  <Text style={styles.previewTitle}>{selectedInvoice.customer_name}</Text>
                  <Text style={styles.helperText}>
                    {selectedInvoice.customer_email || "No customer email"} - {formatCompactDate(selectedInvoice.created_at)}
                  </Text>
                </View>
                <ActionButton
                  label="Close Preview"
                  onPress={() => setSelectedInvoice(null)}
                  tone="ghost"
                  compact
                />
              </View>

              <View style={styles.previewStatusRow}>
                <Pill
                  label={selectedInvoice.status.toUpperCase()}
                  tone={
                    selectedInvoice.status === "paid"
                      ? "success"
                      : selectedInvoice.status === "sent"
                        ? "info"
                        : "warning"
                  }
                />
                <Text style={styles.invoiceTotal}>{formatCurrency(selectedInvoice.total)}</Text>
              </View>

              <View style={styles.previewItemsWrap}>
                {selectedInvoice.items.map((item, index) => (
                  <View key={`${selectedInvoice.id}-${index}`} style={styles.previewItemRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.optionTitle}>{item.description}</Text>
                      <Text style={styles.optionMeta}>
                        Qty {item.quantity} - Unit {formatCurrency(item.unit_price)}
                        {item.size_label ? ` - Size ${item.size_label}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.previewLineTotal}>{formatCurrency(item.line_total)}</Text>
                  </View>
                ))}
              </View>

              {selectedInvoice.notes ? <Text style={styles.helperText}>{selectedInvoice.notes}</Text> : null}

              <ActionButton
                label="Preview"
                onPress={() =>
                  router.push({
                    pathname: "/inventory/invoice-preview" as any,
                    params: { id: selectedInvoice.id },
                  })
                }
                tone="primary"
                compact
              />
              <ActionButton
                label={openingInvoiceId === selectedInvoice.id ? "Preparing PDF..." : "Share PDF"}
                onPress={() => handleOpenInvoice(selectedInvoice.id, "download")}
                tone="secondary"
                compact
                disabled={openingInvoiceId === selectedInvoice.id}
              />
            </Card>
          ) : null}

          {invoices.length === 0 ? (
            <Text style={styles.helperText}>No invoices have been created yet.</Text>
          ) : (
            invoices.map((invoice) => (
              <View key={invoice.id} style={styles.invoiceRow}>
                <View style={styles.invoiceSummary}>
                  <Text style={styles.optionTitle}>{invoice.customer_name}</Text>
                  <Text style={styles.optionMeta}>
                    {invoice.items.length} item lines - {formatCompactDate(invoice.created_at)}
                  </Text>
                  {invoice.customer_email ? (
                    <Text style={styles.optionMeta}>{invoice.customer_email}</Text>
                  ) : null}
                </View>

                <View style={styles.invoiceAside}>
                  <Pill
                    label={invoice.status.toUpperCase()}
                    tone={
                      invoice.status === "paid"
                        ? "success"
                        : invoice.status === "sent"
                          ? "info"
                          : "warning"
                    }
                  />
                  <Text style={styles.invoiceTotal}>{formatCurrency(invoice.total)}</Text>
                </View>

                <View style={styles.invoiceActions}>
                  <ActionButton
                    label="Open Invoice"
                    onPress={() => setSelectedInvoice(invoice)}
                    tone="secondary"
                    compact
                  />
                </View>
              </View>
            ))
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: SPACING.lg, paddingBottom: 48, gap: SPACING.md },
  center: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentRow: { flexDirection: "row", gap: SPACING.sm, flexWrap: "wrap" },
  input: {
    backgroundColor: COLORS.bgElevated,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 14,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dualRow: { flexDirection: "row", gap: SPACING.sm, width: "100%" },
  dualRowStack: { flexDirection: "column" },
  flexInput: { flex: 1, minWidth: 0 },
  adjustmentField: { flex: 1, minWidth: 0, gap: 6 },
  fieldLabel: { color: COLORS.text, fontSize: 12, fontWeight: "800" },
  inventoryOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
  },
  inventoryTextWrap: { flex: 1, minWidth: 0 },
  optionTitle: { color: COLORS.text, fontSize: 14, fontWeight: "800" },
  optionMeta: { color: COLORS.textMuted, fontSize: 12, marginTop: 4 },
  inlineAction: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.info,
    backgroundColor: "#182744",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inlineActionText: { color: "#AFCEFF", fontSize: 12, fontWeight: "800" },
  sizeChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  sizeChoice: {
    minWidth: 58,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.primary,
    backgroundColor: COLORS.cardAlt,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center",
    gap: 2,
  },
  sizeChoiceText: { color: COLORS.text, fontSize: 12, fontWeight: "900" },
  sizeChoiceQty: { color: COLORS.textMuted, fontSize: 10, fontWeight: "700" },
  lineItemCard: {
    gap: SPACING.sm,
    backgroundColor: COLORS.bgElevated,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    overflow: "hidden",
  },
  lineItemMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    flexWrap: "wrap",
  },
  lineItemHint: { color: COLORS.textMuted, fontSize: 12 },
  notesInput: { minHeight: 84, textAlignVertical: "top" },
  totalBlock: {
    backgroundColor: COLORS.bgElevated,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.md,
    gap: 6,
  },
  totalLine: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  helperText: { color: COLORS.textMuted, fontSize: 13, lineHeight: 20 },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  previewCard: {
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
    backgroundColor: COLORS.bgElevated,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACING.sm,
  },
  previewTitle: { color: COLORS.text, fontSize: 18, fontWeight: "800" },
  previewStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.sm,
  },
  previewItemsWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },
  previewItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.cardAlt,
  },
  previewLineTotal: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  invoiceSummary: { flex: 1, minWidth: 220 },
  invoiceAside: { alignItems: "flex-end", gap: 6 },
  invoiceActions: { width: "100%", marginTop: SPACING.xs },
  invoiceTotal: { color: COLORS.success, fontSize: 14, fontWeight: "800" },
});
