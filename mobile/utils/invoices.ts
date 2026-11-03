import type { InvoiceData } from "../services/api";

/** What to call an invoice in the UI. Offline ones have no number yet and
 * must never show a guessed INV number. */
export function invoiceLabel(invoice: Pick<InvoiceData, "invoice_number" | "_pending">): string {
  if (invoice._pending) return "Pending sync";
  return invoice.invoice_number || "Invoice";
}

/** Balance still owed, falling back for responses from older servers. */
export function invoiceBalance(invoice: Pick<InvoiceData, "balance_due" | "status" | "total">): number {
  if (invoice.balance_due != null) return Number(invoice.balance_due);
  return invoice.status === "paid" ? 0 : Number(invoice.total);
}

/** Amount paid so far, falling back for responses from older servers. */
export function invoicePaid(invoice: Pick<InvoiceData, "amount_paid" | "status" | "total">): number {
  if (invoice.amount_paid != null) return Number(invoice.amount_paid);
  return invoice.status === "paid" ? Number(invoice.total) : 0;
}
