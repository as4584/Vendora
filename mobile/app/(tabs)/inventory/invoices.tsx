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
import { openPdfFile } from "../../../utils/fileActions";

interface DraftLineItem {
  description: string;
  quantity: string;
  unit_price: string;
  inventory_item_id?: string;
  size_label?: string;
  stock_label?: string;
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

  const addFromInventory = (item: api.InventoryItem) => {
    const nextItem: DraftLineItem = {
      description: item.name,
      quantity: "1",
      unit_price: item.expected_sell_price || item.buy_price || "",
      inventory_item_id: item.id,
      size_label: sizeBreakdown(item),
      stock_label: `Stock ${resolveQty(item)}`,
    };

    setLineItems((previous) => {
      const hasOnlyBlankDraft =
        previous.length === 1 &&
        !previous[0].description.trim() &&
        !previous[0].unit_price.trim() &&
        previous[0].quantity === "1";
      return hasOnlyBlankDraft ? [nextItem] : [...previous, nextItem];
    });

    setRecentlyAddedName(item.name);
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

  const handleOpenInvoice = async (invoiceId: string) => {
    setOpeningInvoiceId(invoiceId);
    try {
      const { pdf_base64, filename } = await api.exportInvoicePdf(invoiceId);
      await openPdfFile(pdf_base64, filename);
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
              style={styles.input}
              placeholder="Customer Name"
              placeholderTextColor={COLORS.textSoft}
              value={customerName}
              onChangeText={setCustomerName}
            />
            <TextInput
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
              style={styles.input}
              placeholder="Search inventory"
              placeholderTextColor={COLORS.textSoft}
              value={inventoryQuery}
              onChangeText={setInventoryQuery}
            />
            <Text style={styles.helperText}>
              {recentlyAddedName
                ? `${recentlyAddedName} was added to the invoice below.`
                : "Tap an item to add it straight into the invoice builder."}
            </Text>
            <View style={{ gap: SPACING.sm }}>
              {filteredInventory.slice(0, 6).map((item) => (
                <TouchableOpacity key={item.id} activeOpacity={0.84} onPress={() => addFromInventory(item)}>
                  <View style={styles.inventoryOption}>
                    <View style={styles.inventoryTextWrap}>
                      <Text style={styles.optionTitle}>{item.name}</Text>
                      <Text style={styles.optionMeta}>
                        {sizeBreakdown(item)} - Stock {resolveQty(item)} - Ask {formatCurrency(item.expected_sell_price)}
                      </Text>
                    </View>
                    <View style={styles.inlineAction}>
                      <Text style={styles.inlineActionText}>Add</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
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
                        {item.size_label} - {item.stock_label}
                      </Text>
                    </View>
                  ) : null}
                  <TextInput
                    style={styles.input}
                    placeholder="Description"
                    placeholderTextColor={COLORS.textSoft}
                    value={item.description}
                    onChangeText={(value) => updateLineItem(index, "description", value)}
                  />
                  <View style={[styles.dualRow, compactLineItemLayout && styles.dualRowStack]}>
                    <TextInput
                      style={[styles.input, styles.flexInput]}
                      placeholder="Qty"
                      placeholderTextColor={COLORS.textSoft}
                      value={item.quantity}
                      keyboardType="number-pad"
                      onChangeText={(value) => updateLineItem(index, "quantity", value)}
                    />
                    <TextInput
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
            <SectionLabel>Adjustments</SectionLabel>
            <View style={[styles.dualRow, compactLineItemLayout && styles.dualRowStack]}>
              <TextInput
                style={[styles.input, styles.flexInput]}
                placeholder="Tax"
                placeholderTextColor={COLORS.textSoft}
                value={tax}
                onChangeText={setTax}
                keyboardType="decimal-pad"
              />
              <TextInput
                style={[styles.input, styles.flexInput]}
                placeholder="Shipping"
                placeholderTextColor={COLORS.textSoft}
                value={shipping}
                onChangeText={setShipping}
                keyboardType="decimal-pad"
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="Discount"
              placeholderTextColor={COLORS.textSoft}
              value={discount}
              onChangeText={setDiscount}
              keyboardType="decimal-pad"
            />
            <TextInput
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
                      </Text>
                    </View>
                    <Text style={styles.previewLineTotal}>{formatCurrency(item.line_total)}</Text>
                  </View>
                ))}
              </View>

              {selectedInvoice.notes ? <Text style={styles.helperText}>{selectedInvoice.notes}</Text> : null}

              <ActionButton
                label={openingInvoiceId === selectedInvoice.id ? "Preparing PDF..." : "Download PDF"}
                onPress={() => handleOpenInvoice(selectedInvoice.id)}
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
