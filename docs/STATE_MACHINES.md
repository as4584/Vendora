Vendora — State Machine Definitions
📦 Inventory State Machine

States:

in_stock
listed
sold
shipped
paid
archived

Transitions:

in_stock → listed

in_stock → sold

listed → sold

sold → shipped

shipped → paid

sold → paid (digital / instant)

paid → archived

Rules:

Cannot revert from paid → in_stock

Refund creates new transaction record

Sold requires payment method attached

🧾 Invoice State Machine

States:

draft
sent
paid
cancelled

Transitions:

draft → sent

sent → paid

sent → cancelled

draft / sent → partially_paid (a payment smaller than the balance)

draft / sent / partially_paid → paid (the payment that clears the balance, or a manual "mark paid", which records the remaining balance as one payment)

partially_paid → (no cancel, no edit: money has been taken)

paid → (locked)

Rules:

Payments: POST /invoices/{id}/payments with amount, method (cash, card, zelle, venmo, cashapp, paypal, stripe, other) and an optional note. Overpayment is rejected; amount_paid and balance_due are on every invoice response.

Each payment books one transaction per line, splitting pre-tax revenue and collected tax by line value. Tax and frozen line cost use cumulative rounding across payments so the total balances exactly when fully paid. The first payment moves stock, records the payment and updates invoice status together. If stock (including the selected size) cannot be deducted, none of those changes commit. The generic sale-refund endpoint does not refund an invoice payment.

Offline-created invoices carry a client_request_id; a replay returns the invoice the first request made. The number (INV0001) is only ever assigned by the server.

Paid invoices cannot be edited

Cancelled invoices cannot be paid

Stripe webhook triggers paid transition

💳 Transaction State Logic

Manual:

Created → Completed

Stripe:

Pending → Succeeded → Recorded

Failed → No state change

Refund:

Creates negative transaction entry

Adjusts profit

---
📄 For data security and compliance rules, see: `DATA_SECURITY_AND_COMPLIANCE.md`
