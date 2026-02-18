📘 1️⃣ TECHNICAL ARCHITECTURE SPEC

Vendora v1 — Backend + Mobile

🏗 System Overview

Client: Expo (React Native)
Backend: FastAPI (or Node if preferred)
Database: PostgreSQL
Payments: Stripe Connect
Auth: JWT (or Supabase Auth if desired)
Hosting: DigitalOcean / Render
Storage: S3-compatible (for QR images)

Architecture style:

REST API

Stateless backend

Stripe webhooks

Mobile-first design

Marketplace-independent

🧠 Core Data Models (DB Schema)
users
id (uuid, pk)
email (unique)
password_hash
business_name
subscription_tier (free | pro)
is_partner (boolean, default false)
stripe_account_id
created_at
updated_at
inventory_items
id (uuid, pk)
user_id (fk → users)
name
category
sku
upc
size
color
condition
serial_number
custom_attributes (jsonb)
buy_price
expected_sell_price
actual_sell_price
platform
status (in_stock, listed, sold, shipped, paid, archived)
created_at
updated_at
transactions
id (uuid, pk)
user_id (fk)
item_id (fk)
method (stripe, cashapp, paypal, zelle, venmo)
gross_amount
fee_amount
net_amount
external_reference_id
created_at
invoices
id (uuid, pk)
user_id (fk)
customer_name
customer_email
status (draft, sent, paid, cancelled)
subtotal
tax
shipping
discount
total
stripe_payment_intent_id
created_at
invoice_items
id (uuid, pk)
invoice_id (fk)
inventory_item_id (nullable)
description
quantity
unit_price
line_total
payment_methods
id (uuid, pk)
user_id (fk)
type (stripe, paypal, cashapp, zelle, venmo)
identifier
qr_image_url
created_at
subscriptions
id (uuid, pk)
user_id (fk)
stripe_subscription_id
tier (free | pro)
is_partner (boolean, default false)
status
current_period_end
🔌 Core API Routes
Auth
POST   /auth/register
POST   /auth/login
GET    /auth/me
Inventory
POST   /inventory
GET    /inventory
GET    /inventory/:id
PUT    /inventory/:id
DELETE /inventory/:id
POST   /inventory/scan
Transactions
POST   /transactions
GET    /transactions
Invoices
POST   /invoices
GET    /invoices
GET    /invoices/:id
POST   /invoices/:id/send
Stripe
POST   /stripe/connect
POST   /stripe/webhook
POST   /stripe/create-payment-intent

Webhook Responsibilities:

Mark invoice paid

Create transaction

Update inventory status

Update profit dashboard

Profit Calculation Service

Backend service function:

net_profit = gross_amount 
            - fee_amount 
            - shipping 
            - tax 
            - buy_price

Must run:

On transaction creation

On webhook

On manual entry

Barcode Flow

Mobile scans UPC

Calls:

POST /inventory/scan

Backend:

If UPC exists for user → return item

Else → return “not_found”

Mobile handles UI logic for creation.

📱 Mobile App Structure (Expo)

Screens:

Login

Dashboard

Inventory List

Item Detail

Scan Screen

Quick Sale Screen

Invoice Creator

Settings

State Management:

React Query for API sync

Local draft cache for offline mode

🔐 Security

JWT auth

Stripe webhook signature validation

Rate limiting

Row-level ownership enforcement

📈 Future Architecture Hooks (Not MVP)

Plaid integration

Trust score table

Public seller page route

Pricing suggestion service

Insights analytics service