📅 2️⃣ 4-SPRINT BUILD ROADMAP

Each sprint = 1–2 weeks.

🟢 Sprint 1 — Foundation

Goal: Working backend + basic inventory

Deliverables:

Project setup

Database schema

Auth system

Inventory CRUD

Basic mobile UI for inventory

Deploy staging backend

Success Criteria:

User can create account

Add item

Edit item

Delete item

No payments yet.

🟢 Sprint 2 — Profit & Barcode

Goal: Make it usable in real world

Deliverables:

Barcode scanning (Expo)

Manual payment logging

Profit calculation engine

Transaction table

Dashboard v1 (revenue + profit)

Success Criteria:

Scan → create item

Log sale → see profit instantly

🟢 Sprint 3 — Invoices + Stripe

Goal: Money automation

Deliverables:

Invoice system

Stripe Connect

Payment Intent creation

Stripe webhooks

Auto-update inventory on payment

Subscription billing setup

Success Criteria:

Send invoice

Customer pays

Item marked sold automatically

Dashboard updates

🟢 Sprint 4 — Polish + App Store

Goal: Production-ready

Deliverables:

Subscription tier enforcement

UX polish

Error handling

CSV export

App Store prep

Landing page

Success Criteria:

Stable

Clean UI

Stripe working

Can onboard new user start-to-finish

🧠 Documentation Rule (Important)

You said:

I want my AI to always keep documentation in /docs

Good.

Here’s your permanent project rule:

Every feature addition must:

Update /docs/ARCHITECTURE.md if schema or routes change

Update /docs/ROADMAP.md if scope shifts

Update /docs/FEATURES.md if functionality expands

Never modify README without updating docs

You enforce this in your AI prompts:

“After generating code, update relevant docs in /docs to reflect architectural changes.”

That prevents drift.