Vendora — UX Flow Map
🟢 First-Time User Flow

Open app

Sign up

Enter business name

Choose subscription tier

Connect Stripe (optional skip)

Land on empty Dashboard

Prompt: “Add Your First Item”

📦 Inventory Flow

Add Item:

Manual entry OR

Scan barcode

If UPC found:
→ Auto-fill
Else:
→ Create new

Save item
Return to Inventory List

💰 Quick Sale Flow (In-Person)

Tap item

Tap “Quick Sale”

Select payment method

Enter amount

Confirm

Item status → sold

Profit auto-calculated

🧾 Invoice Flow

Create invoice

Select item OR custom line

Add tax/shipping/discount

Send link

Customer pays via Stripe

Webhook updates:

Invoice → paid

Inventory → sold

Dashboard updated

📊 Dashboard Flow

User sees:

Revenue today

Net profit

Inventory value

Pending payouts

Top selling items

Must be readable in < 5 seconds.

📘 /docs/STATE_MACHINES.md
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

📘 /docs/DATA_SECURITY_AND_COMPLIANCE.md
Vendora — Data Security & Compliance Plan
🔐 Authentication

Passwords hashed with bcrypt

JWT-based session auth

HTTPS only

No plaintext passwords

💳 Stripe Security

Webhook signature validation required

Stripe secret keys stored in environment variables

Never stored in database

Test and production keys separated

📁 Data Handling

Sensitive data stored:

Email

Business name

Stripe account ID

Not stored:

Card numbers

Bank credentials

Stripe handles PCI compliance.

🗑 Data Deletion Policy

User must be able to:

Delete account

Delete all associated inventory

Delete invoices

Delete transactions

Future endpoint:
DELETE /user/account

🗄 Backups

Daily automated DB backups

7-day retention minimum

Restore testing quarterly

🧾 Logging

Log errors

Log failed webhooks

Log failed payments

Never log secrets