Vendora — Risk Register
🎯 Purpose

This document identifies, categorizes, and mitigates risks that could impact:

Product stability

User trust

Revenue

Compliance

Scalability

App Store approval

Long-term viability

Vendora must proactively manage risks instead of reacting to failures.

📊 Risk Scoring System

Each risk is evaluated by:

Impact: Low / Medium / High / Critical

Likelihood: Low / Medium / High

Priority Level = Impact × Likelihood

🟥 1. PAYMENT & STRIPE RISKS
1.1 Stripe Webhook Failure

Description:
Stripe sends payment event but backend fails to process it.

Impact: Critical
Likelihood: Medium
Priority: High

Failure Scenario:

Invoice paid

Inventory not updated

Dashboard incorrect

User distrust

Mitigation:

Validate Stripe webhook signature

Make webhook handler idempotent

Log all failed webhook events

Retry failed events

Add integration tests simulating webhook flow

Use Stripe CLI in dev

1.2 Duplicate Webhook Events

Description:
Stripe may send the same event multiple times.

Impact: High
Likelihood: High
Priority: High

Mitigation:

Store Stripe event IDs

Prevent duplicate processing

Use database transaction locking

1.3 Subscription Billing Failures

Description:
User subscription fails but access not revoked.

Impact: High
Likelihood: Medium
Priority: Medium

Mitigation:

Listen for subscription.updated events

Enforce tier checks on each request

Periodic subscription validation job

1.4 Refund Logic Errors

Description:
Refund issued but profit not recalculated.

Impact: High
Likelihood: Medium
Priority: Medium

Mitigation:

Store refund transactions as negative entries

Recalculate profit on refund

Test refund webhook path

🟧 2. MOBILE & BARCODE RISKS
2.1 Barcode Misreads

Description:
UPC scans incorrectly due to lighting or camera quality.

Impact: Medium
Likelihood: Medium
Priority: Medium

Mitigation:

Show scanned UPC for confirmation

Allow manual correction before saving

Always allow fallback manual entry

2.2 No UPC / Tag Removed

Description:
Clothing or handmade item has no barcode.

Impact: Low
Likelihood: High
Priority: Medium

Mitigation:

Support manual SKU

Support QR generation

Never depend on marketplace lookup

2.3 Camera Permission Denial

Description:
User denies camera access.

Impact: Low
Likelihood: Medium
Priority: Low

Mitigation:

Clear permission explanation

Fallback to manual entry

🟧 3. APP STORE RISKS
3.1 Apple Review Rejection (Financial Confusion)

Description:
Apple misinterprets app as financial service.

Impact: High
Likelihood: Medium
Priority: High

Mitigation:

Clearly state: “Payments processed by Stripe.”

No wallet storage

No escrow in MVP

Transparent subscription terms

3.2 Subscription Policy Violations

Description:
Improper subscription disclosure.

Impact: High
Likelihood: Medium
Priority: High

Mitigation:

Clear pricing page

Clear cancellation policy

Follow Apple subscription UI guidelines

🟧 4. PAYMENT COMPLIANCE RISKS
4.1 Storing Sensitive Financial Data

Description:
Accidentally storing card data or bank credentials.

Impact: Critical
Likelihood: Low
Priority: High

Mitigation:

Stripe handles PCI

Never store card data

Strict environment variable handling

Regular code review

4.2 Misleading “Verified” Badge

Description:
Users assume guaranteed transactions.

Impact: High
Likelihood: Medium
Priority: Medium

Mitigation:

Clear badge definition

Disclaimer in profile

Avoid language implying guarantees

🟨 5. SCALING & DATABASE RISKS
5.1 Slow Inventory Queries

Description:
Large inventory causes slow dashboard load.

Impact: Medium
Likelihood: Medium
Priority: Medium

Mitigation:

Proper indexing

Pagination

Avoid N+1 queries

Query profiling early

5.2 Large JSON Fields

Description:
Unstructured custom attributes degrade performance.

Impact: Medium
Likelihood: Medium
Priority: Medium

Mitigation:

Index frequently queried fields

Avoid heavy JSON filtering

Normalize schema if needed

5.3 Cost Explosion

Description:
High DB or Stripe costs at scale.

Impact: Medium
Likelihood: Low
Priority: Low

Mitigation:

Monitor usage

Optimize queries

Introduce pricing tiers strategically

🟨 6. BUSINESS RISKS
6.1 Overbuilding Before Validation

Description:
Adding Phase 2 features before validating MVP.

Impact: High
Likelihood: High
Priority: Critical

Mitigation:

Strict MVP boundary

Sprint discipline

No new features until first real users

6.2 Competing With Marketplaces

Description:
Scope drifts toward building a marketplace.

Impact: High
Likelihood: Medium
Priority: High

Mitigation:

Stay inventory + payment focused

No public product listing marketplace in MVP

🟨 7. DATA LOSS RISKS
7.1 Database Corruption

Impact: Critical
Likelihood: Low
Priority: High

Mitigation:

Daily automated backups

Backup verification tests

Staging environment separation

7.2 Accidental Account Deletion

Impact: High
Likelihood: Low
Priority: Medium

Mitigation:

Soft delete system

Confirmation prompts

Delayed permanent deletion

🟨 8. USER TRUST RISKS
8.1 Incorrect Profit Calculations

Impact: Critical
Likelihood: Medium
Priority: Critical

Mitigation:

100% test coverage for profit engine

Unit tests for fee edge cases

Regression testing before releases

8.2 UI Complexity

Impact: High
Likelihood: High
Priority: High

Mitigation:

Enforce “3-minute onboarding” rule

Reduce clutter

Continuous UX review

🧭 Review Policy

This Risk Register must be:

Reviewed before each major sprint

Updated when new features added

Updated when new integrations added

Referenced during architecture changes\r\n\r\n📋 Sprint 4 Review (Updated)\r\n\r\n✅ 1.1 Stripe Webhook Failure — MITIGATED: Signature verification + idempotent handler + event dedup table + 5 integration tests\r\n✅ 1.2 Duplicate Webhook Events — MITIGATED: webhook_events table with unique event_id index\r\n✅ 1.3 Subscription Billing — MITIGATED: Webhook handlers for create/delete + tier enforcement\r\n✅ 1.4 Refund Logic — MITIGATED: Negative transaction entries + item revert + 4 tests\r\n✅ 2.1 Barcode Misreads — MITIGATED: Manual entry fallback always available\r\n✅ 4.1 Sensitive Data — MITIGATED: Only Stripe IDs stored, no card data\r\n✅ 5.1 Slow Queries — MITIGATED: Composite partial indexes, pagination, count queries\r\n✅ 6.1 Overbuilding — MITIGATED: 4-sprint discipline, feature flags\r\n✅ 8.1 Incorrect Profit — MITIGATED: 100% coverage, 4 Golden Frames, Decimal math\r\n✅ 8.2 UI Complexity — MITIGATED: Tab navigation, empty states, progressive disclosure

## Warm-light checkout preview risk review — 2026-11-07

UI-only changes on the combined preview branch. The pinned checkout calls the existing order handler; money calculations, validation, payment providers, authorization, schema, and state transitions are unchanged. Dashboard fallback labels distinguish UTC calendar-month totals from rolling analytics; matching amounts can be legitimate.

Primary regression risks: obscured checkout on short screens, expanded text wrapping, low-contrast selected/offline states, and hidden secondary item information. Mitigation: viewport-pinned checkout E2E assertions, responsive and large-text layout gates, color-contrast and offline-notice unit tests, disclosure state tests, plus localhost visual inspection. Physical iPhone keyboard, VoiceOver, haptics, and native launch appearance still require owner QA. This is not a production-readiness sign-off.

🧠 Final Principle

Vendora’s long-term advantage is:

Reliability + clarity + discipline.

Risk management ensures:

No silent failures

No trust erosion

No chaotic scaling

We build stable systems.
We prevent surprises.
We scale responsibly.
