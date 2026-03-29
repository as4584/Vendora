📘 VENDORA — SOURCE OF TRUTH v2.2
Last Updated: 2026-02-25 (Sprint 7 — Inventory UX + Dashboard Margins)

## ✅ LIVE DEPLOYMENT STATE

| Component | Status | Detail |
|-----------|--------|--------|
| Production URL | ✅ Live | https://vendora.lexmakesit.com |
| Backend | ✅ Running | FastAPI + Uvicorn on Ubuntu VPS via Docker |
| Database | ✅ PostgreSQL | 7 migrations applied (001–007) |
| Git Branch | sprint-5-lightspeed-deploy | latest commit: pending push |
| Expo SDK | 54 | React Native 0.81.5 |
| Dev Tunnel | exp://fsl2bsc-anonymous-8085.exp.direct | port 8085 |
| EAS Project | @lexmakesit/vendora | ID: 85f51ce2-35b8-4ba2-b3fe-a4f182a412f9 |
| EAS Update | ✅ Published | Production channel, iOS, Group: 7b2814b4-a34a-46c0-a84e-e26a86d207ac |
| Lightspeed OAuth | ✅ Configured | Credentials in /opt/vendora/.env.prod |

## ✅ EAS DISTRIBUTION

**Expo Account:** `lexmakesit`
**EAS Project:** `@lexmakesit/vendora`
**Project ID:** `85f51ce2-35b8-4ba2-b3fe-a4f182a412f9`
**updates.url:** `https://u.expo.dev/85f51ce2-35b8-4ba2-b3fe-a4f182a412f9`
**Runtime Version Policy:** `appVersion` (tied to app.json version field)

**Shareable App Link (Expo Go):**
```
exp://u.expo.dev/85f51ce2-35b8-4ba2-b3fe-a4f182a412f9?channel-name=production&runtime-version=1.0.0
```

**Publishing a new update:**
```bash
cd mobile
npx eas-cli update --channel production --platform ios
```
Anyone with Expo Go can scan the QR or open the link above — no build required.

**Build profiles (eas.json):**
- `development` — internal distribution, development client
- `preview` — internal distribution, no store
- `production` — App Store build (requires Apple account)

## ✅ SPRINT 7 CHANGES (2026-02-25)

### Problem → Solution
| Field Tester Bug | Fix Applied |
|---|---|
| Same item added 3 times = 3 cards | Cards now show qty badge; use ItemQuickSheet to adjust quantity |
| Box icon instead of photo | `photo_front_url` now stored in DB and uploaded after item create |
| Clicking item shows black screen | Tapping a card opens QuickSheet (no route navigation) — crash eliminated |
| Clothing needs size variants | QuickSheet + Add screen detect clothing category and show per-size breakdown |
| Inventory logs → Quick Sale redirect | Tapping card no longer navigates; QuickSheet opens inline |
| Dashboard needs margin % | Gross Margin % and Markup % cards added (client-computed) |

### New DB Columns (migration 007)
```
inventory_items.photo_front_url  TEXT       nullable
inventory_items.photo_back_url   TEXT       nullable
inventory_items.quantity         INTEGER    default 1, not null
```

### Clothing Detection
The `category` field is matched against a keyword list:
```
clothing, apparel, shirt, pants, jeans, dress, jacket, hoodie,
sweater, shorts, shoes, sneakers, boots, sandals, coat, blazer,
skirt, leggings, tracksuit
```
When matched → ItemQuickSheet and Add screen show the **Sizes & Quantities** section.
Size inputs are free-text: `S`, `M`, `XL`, `32x32`, `10.5` — no preset enum.

### Size Variants Storage
Variants live in the existing `custom_attributes` JSON column:
```json
{ "variants": [{ "size": "M", "quantity": 2 }, { "size": "32x32", "quantity": 1 }] }
```
No new table required.

### Margin % Formula
```
Gross Margin % = (potential_profit / total_expected_value) * 100
Markup %       = (potential_profit / total_inventory_value) * 100
```
Both computed client-side from the existing `/dashboard` response.

### Auto-Migration
`backend/app/main.py` now runs `alembic upgrade head` inside a lifespan context
on every container startup. After deploying, just restart the backend container —
no manual `alembic upgrade head` SSH step needed.

---


## ✅ DATABASE SCHEMA (migration sequence)
- 001: users, inventory_items
- 002: transactions
- 003: invoices, invoice_items, subscriptions, webhook_events
- 004: lightspeed_tokens
- 005: source + external_id on inventory_items + transactions
- 006: profile_picture on users
- 007: photo_front_url, photo_back_url, quantity on inventory_items

> **Auto-migration:** `app/main.py` lifespan hook runs `alembic upgrade head`
> automatically on every backend container start. No manual step needed after deploy.

## ✅ DEPLOYED ENDPOINTS

**Auth:** POST /auth/register, POST /auth/login, GET /auth/me, PATCH /auth/profile

**Inventory:** GET/POST /inventory, GET/PUT/DELETE /inventory/{id},
PATCH /inventory/{id}/status, PATCH /inventory/{id}/photos,
GET /inventory/market-price, GET /inventory/{id}/pricing-suggestion

**Invoices:** GET/POST /invoices, GET /invoices/{id}, PATCH /invoices/{id}/status,
POST /invoices/{id}/pay, GET /invoices/{id}/pdf

**Transactions:** GET/POST /transactions, GET /transactions/{id}

**Dashboard:** GET /dashboard/summary

**Sellers:** GET /sellers/{user_id}

**Export (Pro):** GET /export/inventory, GET /export/transactions

**Lightspeed:** GET /integrations/lightspeed/status,
GET /integrations/lightspeed/connect,
POST /integrations/lightspeed/sync

**Webhooks:** POST /webhooks/stripe

## ✅ MOBILE SCREENS (Expo Router)

- `/(auth)/login` — JWT login with show/hide password toggle
- `/(auth)/register` — Account creation
- `/(tabs)/dashboard` — Revenue/profit summary + **Gross Margin % & Markup % cards**
- `/(tabs)/inventory/index` — 3-column photo grid; **qty badge top-left; tap opens ItemQuickSheet (no navigation)**
- `/(tabs)/inventory/add` — Add item (photos → uploaded as base64 after create, barcode scanner, auto-SKU, **quantity stepper**, **clothing/footwear: per-size variant entry with free-text size input**)
- `/(tabs)/inventory/[id]` — Item detail (market price panel, pricing suggestion) — now only reached via "Full Edit" in QuickSheet
- `/(tabs)/inventory/components/ItemQuickSheet` — **NEW** bottom-sheet modal on card tap. Shows photo, name, status, margin %. Clothing items show size variant manager (free-text: S / 32x32 / 10.5 etc.). All items show qty stepper. Save / Full Edit / Delete actions.
- `/(tabs)/inventory/invoices` — Invoice list + create + 📄 Export PDF
- `/(tabs)/settings` — Profile picture, Lightspeed integration, tier info, sign out

## ✅ INSTALLED MOBILE PACKAGES
- expo ~54.0.33, expo-router ~6.0.23
- react-native-reanimated 4.1.6, react-native-worklets 0.5.1
- expo-camera ~17.0.10, expo-image-picker ~17.0.10
- expo-background-fetch ~14.0.9, expo-task-manager ~14.0.9
- expo-web-browser ~15.0.10
- expo-file-system 19.0.21 (import via `expo-file-system/legacy`), expo-sharing 14.0.8
- expo-updates ~0.32.0 (OTA updates via EAS Update)

## ⚠️ KNOWN OPERATIONAL RISKS

**DB Volume Wipe:** `docker compose up --build -d` may recreate the Postgres
volume, wiping all data. After any deploy that shows "Volume ... Creating", re-run:
```bash
docker compose -f docker-compose.prod.yml exec -T backend python create_user.py
docker compose -f docker-compose.prod.yml exec -T backend alembic upgrade head
```
Test account: thegamermasterninja@gmail.com / Alexander1221 (Pro + Partner tier)

**Env Var Reload:** `docker compose restart backend` does NOT reload .env.prod.
Must recreate container: `docker compose -f docker-compose.prod.yml up -d backend`

**Migration Missing After Redeploy:** If a container is recreated without a volume
wipe, the DB persists but alembic_version may still need a head run if the
migration was added after the last deploy. Always run `alembic upgrade head`
after any backend container recreate as a safety step.

**Expo Go Limitations:** expo-background-fetch and expo-task-manager are
no-ops in Expo Go (wrapped in try/catch). Full background sync only works
in a development build (EAS Build).

**expo-file-system Import:** Use `expo-file-system/legacy` (not the default
`expo-file-system`) when calling `writeAsStringAsync` — the default export in
Expo 54/SDK 52+ renames `EncodingType`, causing a crash in Expo Go.

**QR Code in Windows Terminal:** Renders rectangular — use manual URL entry
in Expo Go or open http://localhost:8085 in browser for proper QR.

**EAS Update Runtime Version:** The `appVersion` policy means the Expo Go
shareable link only works when the runtime version (from app.json `version`)
exactly matches. If app.json version changes, republish the update and share
the new link.

---



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