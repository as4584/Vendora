Vendora — Feature Registry
🎯 Purpose

This registry tracks all features across Vendora.

It ensures:

No feature drift

Clear status tracking

Risk awareness

Testing discipline

Modular growth

Agents must update this file whenever:

A feature is added

A feature status changes

Risk increases

Test coverage changes

🟢 Core Engine Features (Immutable Layer)

These are foundational systems.
They must remain stable and highly tested.

Feature: User Authentication

Status: Stable

Layer: Core Engine

Dependencies: Database, JWT

Risk Level: Medium

Test Coverage: 100% required

Notes: Never store plaintext passwords.

Feature: Inventory Engine

Status: Stable

Layer: Core Engine

Dependencies: Database schema

Risk Level: High

Test Coverage: 100% (60+ tests)

Notes: State machine enforced. Soft-delete. Tier limits. Row-level ownership.

Feature: Payment Engine (Stripe + Manual)

Status: Stable

Layer: Core Engine

Dependencies: Stripe Connect

Risk Level: Critical

Test Coverage: 100% (5 webhook tests + deduplication)

Notes: Webhook idempotent via event_id dedup. Payment Intent creation Pro-gated. Subscription lifecycle handled.

Feature: Invoice System

Status: Stable

Layer: Core Engine

Dependencies: Payment engine, Inventory Engine

Risk Level: High

Test Coverage: 100% (17 tests)

Notes: Invoice state machine enforced (draft→sent→paid/cancelled). Paid creates transactions + transitions inventory. Locked after payment.

Feature: Profit Calculation Engine

Status: Stable

Layer: Core Engine

Dependencies: Transactions

Risk Level: Critical

Test Coverage: 100% (11 unit tests + 4 Golden Frames)

Notes: Isolated service. Deterministic Decimal math.

Feature: Transaction Engine

Status: Stable

Layer: Core Engine

Dependencies: Inventory Engine, Profit Calculation Engine

Risk Level: High

Test Coverage: 100% (12 tests)

Notes: Quick Sale, manual log, refund with negative entry + item revert.

Feature: Dashboard API

Status: Stable

Layer: Core Engine

Dependencies: Profit Calculation Engine, Transaction Engine

Risk Level: Medium

Test Coverage: 100% (5 tests)

Notes: Revenue/profit/inventory aggregation across time windows.

Feature: Subscription Billing

Status: Stable

Layer: Core Engine

Dependencies: Stripe Connect, User model

Risk Level: Critical

Test Coverage: 100% (subscription create/delete tests)

Notes: Webhook-driven tier changes. Past due handling.

🟣 Module Features (Expandable Layer)

These attach to the core.

Feature: Barcode Scanning

Status: Planned

Layer: Module

Dependencies: Inventory engine

Risk Level: Medium

Test Coverage: 70% acceptable

Notes: Must allow fallback manual entry.

Feature: Trust Score System

Status: Experimental

Layer: Module

Dependencies: Transactions

Risk Level: Medium

Test Coverage: 60% acceptable

Notes: No guarantee language.

Feature: Public Seller Page

Status: Experimental

Layer: Module

Dependencies: Payment methods

Risk Level: Medium

Test Coverage: 70% acceptable

Notes: Must not imply financial guarantee.

Feature: Smart Pricing Suggestions

Status: Planned

Layer: Module

Dependencies: Historical sales data

Risk Level: Low

Test Coverage: 60% acceptable

Notes: Non-blocking to core flow.

Feature: POS Mode (In-Person Sales)

Status: Planned

Layer: Module

Dependencies: Inventory engine, Payment engine

Risk Level: Medium

Test Coverage: 70% acceptable

Notes: Designed for sneaker events / pop-ups. Post-MVP.

Feature: CSV Import (Cash App / PayPal)

Status: Planned

Layer: Module

Dependencies: Transactions, Inventory engine

Risk Level: Low

Test Coverage: 60% acceptable

Notes: Upload CSV, parse transactions, match to inventory.

Feature: Google Sheets Sync

Status: Planned

Layer: Module

Dependencies: Inventory engine

Risk Level: Low

Test Coverage: 60% acceptable

Notes: Optional sync for spreadsheet-heavy sellers. Post-MVP.

🟡 Feature Status Definitions

Planned → Not built yet

In-Progress → Being developed

Stable → Production-ready, fully tested

Experimental → Can change, isolated from core

Deprecated → Scheduled for removal

🧠 Agent Rules Regarding Feature Registry

Agents must:

Never modify core engine features without updating registry

Never mark feature stable without tests

Never change risk level silently

Always update coverage percentage

Always document dependency changes