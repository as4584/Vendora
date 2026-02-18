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

---
📄 For state machine definitions, see: `STATE_MACHINES.md`
📄 For data security and compliance rules, see: `DATA_SECURITY_AND_COMPLIANCE.md`