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

Status: In-Progress

Layer: Core Engine

Dependencies: Database schema

Risk Level: High

Test Coverage: 90% minimum

Notes: Must respect state machine definitions.

Feature: Payment Engine (Stripe + Manual)

Status: Planned

Layer: Core Engine

Dependencies: Stripe Connect

Risk Level: Critical

Test Coverage: 100% required

Notes: Webhook must be idempotent.

Feature: Invoice System

Status: Planned

Layer: Core Engine

Dependencies: Payment engine

Risk Level: High

Test Coverage: 90% required

Notes: Invoice state machine enforced.

Feature: Profit Calculation Engine

Status: Planned

Layer: Core Engine

Dependencies: Transactions

Risk Level: Critical

Test Coverage: 100% required

Notes: Any bug destroys user trust.

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