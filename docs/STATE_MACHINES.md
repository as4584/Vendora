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

paid → (locked)

Rules:

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