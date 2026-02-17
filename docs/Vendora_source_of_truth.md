📘 VENDORA — SOURCE OF TRUTH v1.0

Product Type: Mobile-First Reseller Operating System
Positioning: Inventory + Payments + Profit + Trust — Unified
Primary Users: Resellers (sneakers, clothing, watches, pet gear, handmade, Instagram brands)

🧱 CORE SYSTEM
1️⃣ User Accounts & Authentication

Purpose: Secure identity & subscription control.

Must Do:

Email/password login

OAuth (Google/Apple optional)

Secure session management (JWT)

Store user profile (name, business name, contact)

Track subscription tier

Connect external services (Stripe now, Plaid future)

Role-based access (future multi-staff accounts)

📦 INVENTORY MANAGEMENT
2️⃣ Inventory Item System

Purpose: Universal item tracking across categories.

Must Support Categories:

Sneakers

Watches

Clothes

Dogs / Pet Gear

Custom categories (future)

Item States:

In Stock

Listed

Sold

Shipped

Paid

Archived

Flexible Attributes (Dynamic Schema):

Size

Color

Condition

Serial number

SKU

Breed fit

UPC

Custom metadata JSON

Financial Tracking Per Item:

Buy price

Expected sell price

Actual sell price

Platform listed on

Profit potential

3️⃣ Bulk Add / Quick Add Mode

Purpose: On-the-go inventory logging.

Must Do:

Add item in <10 seconds

Minimal required fields

“Quick Sale” toggle

Attach payment instantly

Barcode auto-fill if scanned

4️⃣ Barcode Scanning (Mobile)

Purpose: Fast sneaker & tagged inventory lookup.

For UPC Items (Shoes):

Scan barcode (Expo)

Search internal DB

If match → load item

If no match → create new entry prefilled with UPC

For Non-UPC Items:

Manual SKU

Custom SKU

QR code generation

Print QR option (future)

Design Rule:
Never depend on StockX/GOAT to function.

💰 PROFIT & FINANCIAL TRACKING
5️⃣ Automatic Profit Calculation Engine

Must Calculate:

Gross amount

Platform fees

Stripe fees

Shipping cost

Tax (optional)

Net profit

Must Display:

Profit per item

Profit per platform

Profit per payment method

Auto-updates dashboard instantly.

6️⃣ Financial Dashboard

Must Show:

Today’s revenue

Total revenue

Net profit

Pending payouts

Inventory value

Sales by payment method

Fastest moving items

Slowest moving items

Design Constraint:
No clutter. 1-glance clarity.

📲 PAYMENT HUB
7️⃣ Payment Methods Profile

User Can Add:

Stripe (OAuth connect)

PayPal email

Cash App $handle

Cash App QR upload

Zelle email

Venmo username

Must Do:

Store payment identifiers

Attach method to transactions

Display on seller profile page (Phase 2)

Use for invoice options

8️⃣ Stripe Integration (Core)

Must Do:

Stripe Connect OAuth

Pull transaction data

Pull fee data

Track refunds

Trigger webhook on payment success

Auto-mark invoice paid

Auto-mark item sold

Update dashboard

9️⃣ Manual Payment Logging

Must Do:

Log Cash App, PayPal, Zelle, Venmo manually

Enter gross + fee

Auto-calc net

Attach to item

Timestamp transaction

🔟 CSV Import (Cash App / PayPal)

Must Do:

Upload CSV

Parse transactions

Match to inventory

Update profits

Flag unmatched payments

1️⃣1️⃣ Future: Bank Sync (Plaid)

Phase 2

Connect bank

Detect deposits

Auto-categorize source

Reconcile transactions

🧾 INVOICE SYSTEM
1️⃣2️⃣ Invoice Creation

Must Do:

Create from inventory item

OR create custom invoice

Add:

Tax

Shipping

Discount

Notes

Auto-calc totals

Save draft

1️⃣3️⃣ Invoice Delivery

Must Do:

Generate shareable link

Generate PDF

Copy link for SMS

Email invoice

Track status:

Draft

Sent

Paid

Cancelled

1️⃣4️⃣ Stripe Pay Button on Invoice

Must Do:

“Pay Now” button

Process payment

Webhook

Mark invoice paid

Mark inventory sold

Update dashboard

🏅 TRUST & VERIFICATION
1️⃣5️⃣ Identity Verification (Phase 2)

Using Stripe Identity

Government ID verification

Bank confirmation

Email + phone confirmation

Badge:
✔ ID Verified

1️⃣6️⃣ Trust Score System

Must Track:

Completed sales

Dispute rate

Refund rate

Calculate trust score.

Unlock badge eligibility.

Badge:
⭐ Trusted Seller

1️⃣7️⃣ Paid Partner Verification ($3–4/mo)

Must Provide:

Verified badge

Profile highlight

Priority support

Profile customization

Search boost

Eligibility requires trust threshold.

Badge:
🔥 Vendora Partner

📈 SMART FEATURES (PHASE 2+)
1️⃣8️⃣ Inventory Insights Engine

Must Show:

Items sitting too long

High-margin items

Restock suggestions

Category trends

1️⃣9️⃣ Smart Pricing Suggestions

Must Base On:

User historical sales

Turnover rate

Demand trends

(Optional) Marketplace data if available

Crowdsourced pricing (future)

Must work even if item not on StockX.

🌐 SELLER PROFILE PAGE
2️⃣0️⃣ Public Seller Page

Example:
vendora.app/username

Must Show:

Seller name

Verified badges

Payment QR codes

PayPal link

Stripe checkout link

Acts as payment identity hub.

📊 GOOGLE SHEETS SYNC
2️⃣1️⃣ Sheets Export / Sync

Must Do:

Export inventory to CSV

Optional Google Sheets API sync

Real-time or scheduled push

For spreadsheet-heavy sellers migrating.

🛍 POS MODE (In-Person Sales)
2️⃣2️⃣ Simple POS Mode

Must Do:

Select item

Accept payment

Attach method

Print/send receipt

Update inventory

Instant profit calc

Designed for sneaker events / pop-ups.

💳 SUBSCRIPTION MODEL
2️⃣3️⃣ Subscription System

Must Include:

Free tier (limited items)

Pro tier

Partner tier

Stripe subscription billing

Usage enforcement

Upgrade prompts

📱 APP STORE READY
2️⃣4️⃣ Mobile-First App (Expo)

Must Support:

Barcode scanning

Offline draft entries

Fast navigation

Native performance

Push notifications (future)

🎯 DESIGN PHILOSOPHY (Non-Negotiable)

3-minute onboarding

30-second invoice

5-second sale logging

Profit visible instantly

No enterprise clutter

Works without marketplace data

Works for niche sellers

🚀 MVP CUT LINE

MVP includes:

Auth

Inventory

Barcode

Manual payments

Stripe integration

Invoices

Profit engine

Basic dashboard

Subscription

Everything else staged.

🧠 WHAT VENDORA IS

Not accounting software.
Not just comps.
Not dependent on StockX.

It is:

A reseller control center.
Inventory + Payment + Profit + Trust — unified.
Marketplace-independent.