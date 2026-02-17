Vendora — Testing & Preview Automation Protocol
🎯 Purpose

This document defines how Vendora:

Runs automated tests

Builds preview app versions

Deploys internal builds via Expo EAS

Maintains documentation integrity

This protocol must be followed for all feature additions.

🧱 Testing Philosophy

Vendora must never rely on manual-only testing.

Every feature must:

Have backend test coverage

Pass automated CI checks

Be validated in a preview build before merge

Update documentation if architecture changes

No feature is complete without tests.

🧪 Testing Layers

Vendora uses 3 layers of validation:

1️⃣ Backend Tests (Required)

Framework:

pytest

Location:

/backend/tests/

Must cover:

Inventory CRUD

Profit calculation logic

Invoice total calculations

Transaction creation

Stripe webhook handler

Subscription enforcement logic

Minimum requirement before merge:

No failing tests

All Stripe webhook flows simulated

2️⃣ Mobile Tests (Lightweight for MVP)

Framework:

Jest

React Native Testing Library

Location:

/mobile/__tests__/

Must cover:

Rendering of main screens

Invoice creation logic

Dashboard calculations

Deep E2E mobile automation (Detox) is optional until post-MVP.

3️⃣ Integration Tests (Critical)

Must simulate:

Create user

Add inventory item

Create invoice

Simulate Stripe payment

Trigger webhook

Assert:

Invoice = paid

Inventory = sold

Transaction created

Dashboard updated

These tests ensure real-world reliability.

🔄 Stripe Webhook Testing

Use Stripe CLI locally:

stripe listen --forward-to localhost:8000/stripe/webhook

Webhook handler must:

Validate Stripe signature

Mark invoice as paid

Update inventory status

Create transaction record

Recalculate profit

Webhook logic must be tested in automated tests before merging.

📦 Preview Build System (Expo EAS)

Vendora uses Expo EAS preview builds for internal testing.

We do NOT use Vercel or public hosting at this stage.

Preview Build Rules

All preview builds:

Use Stripe test keys only

Use preview environment variables

Must be installable via QR

Must not use production database

EAS Build Profiles

Located in:

/eas.json

Preview profile:

{
  "build": {
    "preview": {
      "distribution": "internal",
      "channel": "preview"
    }
  }
}
🤖 Automated Preview Build (CI)

GitHub Actions must:

Run backend tests

Run mobile tests

If tests pass:

Trigger EAS preview build

Preview builds are triggered on:

dev branch push

Never auto-build from main.

🌿 Branching Strategy
main → stable only
dev → integration branch
feature/* → feature branches

Workflow:

Create feature branch

Add code + tests

Update docs if needed

Merge into dev

CI runs

Preview build created

Manual testing

Merge dev → main only when stable

📁 Required Folder Structure
/backend
/mobile
/docs
/.github/workflows

Required docs:

/docs/ARCHITECTURE.md
/docs/ROADMAP.md
/docs/TESTING_AND_PREVIEW_AUTOMATION.md
🧠 Documentation Enforcement Rule

Every feature addition must check:

If schema changed:

Update /docs/ARCHITECTURE.md

If feature scope changed:

Update /docs/ROADMAP.md

If testing strategy changed:

Update /docs/TESTING_AND_PREVIEW_AUTOMATION.md

Agents must never modify core functionality without updating documentation.

🔐 Environment Separation

Must maintain:

.env.preview
.env.production

Preview builds:

Use Stripe test mode

Use preview backend URL

Use test database

Production builds:

Use production Stripe keys

Use production backend

Environment variables must never be hardcoded.

📊 Definition of “Feature Complete”

A feature is considered complete when:

Backend tests pass

No CI failures

Preview build installs successfully

Manual mobile test completed

Documentation updated

🚨 Failure Protocol

If preview build fails:

Fix immediately

Do not merge to main

Do not begin new features

Stability > speed.

🧭 Long-Term Plan

After MVP:

Add E2E automation (Playwright or Detox)

Add regression test suite

Add Golden Frame scenario testing

Add coverage threshold enforcement

🎯 Final Principle

Vendora must always be:

Testable

Previewable

Documented

Stable

No feature without validation.
No validation without automation.
No automation without documentation