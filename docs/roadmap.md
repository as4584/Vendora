🔵 UPDATED 4-SPRINT BUILD ROADMAP (Core-First, Revenue-Stable)

We are no longer thinking “MVP.”

We are thinking:

Core Engine Stabilization → Revenue Engine → Expansion-Ready Architecture

Each sprint = 1–2 weeks.

🟢 Sprint 1 — Core Engine Stabilization
🎯 Goal:

Build the immutable foundation correctly with test discipline.

Deliverables:
Backend

Project structure

PostgreSQL schema (users, inventory_items, migrations)

Auth system (JWT + bcrypt)

Inventory CRUD

State machine enforcement (inventory states)

Pagination for inventory

Proper DB indexing

Testing

pytest setup

Inventory CRUD tests

Auth tests

State transition tests

Test DB environment

80%+ coverage for inventory + auth

Mobile

Login screen

Inventory list screen

Add/edit item screen

Basic navigation

API integration

Error states

DevOps

Docker compose

Test DB

GitHub Actions CI (backend tests required)

EAS preview build manual

Success Criteria:

User can create account

Add/edit/delete item

Inventory states enforced

All tests passing

Preview build installable

Architecture docs updated

Core must feel solid.

No payments yet.

🟢 Sprint 2 — Revenue Engine (Profit + Transactions)
🎯 Goal:

Make inventory financially meaningful.

Deliverables:
Backend

Transactions table

Manual payment logging

Profit calculation engine (isolated service)

Refund logic

Dashboard API endpoints

Golden Frame scenarios for:

Add item → sell → profit calc

Refund → profit adjust

Testing

Profit engine 100% coverage

Transaction tests

Refund tests

Regression test suite begins

Mobile

Quick Sale flow

Manual payment logging UI

Dashboard v1:

Revenue today

Net profit

Inventory value

Success Criteria:

Log sale in <5 seconds

Profit updates instantly

Refund updates profit correctly

Golden Frames pass

Now Vendora becomes usable even without Stripe.

🟢 Sprint 3 — Automated Money Layer (Stripe + Invoices)
🎯 Goal:

Automate revenue without breaking core.

Deliverables:
Backend

Invoice system

Invoice state machine

Stripe Connect

Payment Intent creation

Webhook handler (idempotent)

Subscription billing logic

Tier enforcement middleware

Event ID deduplication

Testing

Stripe webhook integration test

Invoice lifecycle test

Subscription enforcement test

Full Golden Frame:

Create invoice

Stripe payment

Webhook

Inventory update

Dashboard update

Mobile

Invoice creation screen

Stripe pay link flow

Subscription upgrade flow

Success Criteria:

Customer pays invoice

Item auto marked sold

Profit accurate

Subscription tiers enforced

Webhook cannot double-process

Now you have a revenue-stable core.

🟢 Sprint 4 — Modular Expansion + Hardening
🎯 Goal:

Prepare for continuous evolution safely.

Deliverables:
Modules

Barcode scanning

Feature flags

CSV export

Public seller page (basic)

Pro tier gating for barcode

Stability

Full regression test suite

Performance query optimization

Backup automation

Logging improvements

Risk register review

UX

Onboarding polish

Error handling improvement

Empty states

App Store compliance review

Success Criteria:

Stable preview builds

Golden Frames green

Risk register updated

Feature registry accurate

App Store submission-ready

Now the system is expansion-ready.

🔐 Updated Documentation Rule

Replace your old rule with this stricter version:

Every feature must:

Update ARCHITECTURE.md if schema changes

Update STATE_MACHINES.md if transitions change

Update RISK_REGISTER.md if exposure changes

Update FEATURE_REGISTRY.md if status changes

Update SYSTEM_EVOLUTION_PROTOCOL.md if expansion logic changes

Docs are not optional.