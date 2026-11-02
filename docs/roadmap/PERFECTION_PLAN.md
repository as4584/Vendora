# Vendora — "perfect before launch" plan

Source: four independent reviews of the code on 2026-11-02:
- a sneaker reseller who works conventions (grade **C-**, would not pay $19.99 yet)
- a card/collectibles vendor who invoices wholesale buyers (grade **C-**)
- an iOS product designer
- a staff-engineer readiness audit

Rule: no App Store submission until every P0 and P1 item is done and the
reviewers re-grade at least **B+**. Each item gets its own branch and PR, and
merges only with CI green.

## P0: trust and safety (data can be wrong or unsafe today)

| # | Item | Evidence |
|---|------|----------|
| 0.1 | Protect `main`: require a PR, required checks, linear history, no force-push. Confirm the `production` environment has a required reviewer, because a push to main publishes an OTA update | mobile-tests.yml OTA jobs |
| 0.2 | CI: add lint (mobile `expo lint`, backend ruff), gitleaks secret scan, expo-doctor, alembic upgrade→downgrade→upgrade round trip and a single-head check | ci.yml, mobile-tests.yml |
| 0.3 | Export/import round trip loses data. The `source` column overwrites the vendor on re-import, `id` is ignored so manual items duplicate, sizes (`size_breakdown`) aren't re-parsed, and dates are dropped | csv_export.py:24,141; spreadsheet_import.py:45,889; routers/inventory.py:242-269 |
| 0.4 | CSV formula injection: escape cells starting with `= + - @` on export. Add a UTF-8 BOM so Excel shows accents correctly | export.py:324 |
| 0.5 | Import parsing silently corrupts values. European decimals ("1.234,56"), negatives, quantities ("1,200"→1, blank→1), Windows-1252 files, unknown statuses→in_stock, Name+Description alias clash. All must warn per row, not guess | spreadsheet_import.py:32,179,187,196,209,852 |
| 0.6 | Multi-item sale is sent as N separate requests with no order id, so a dropped connection leaves a half-recorded sale. The order fee is attached to the first line only | sale.tsx:81-94 |
| 0.7 | Invoice numbers are computed on each request, not stored, so they can change. That's an audit/tax problem | routers/invoices.py:325-335 |

## P1: the "pocket POS" core (why people would pay)

| # | Item |
|---|------|
| 1.1 | **Scan → autofill.** Barcode scan looks up the product and fills name/brand/model/colorway/size/photo. Replace the upcitemdb trial endpoint with a keyed provider. Use the same barcode types on add and edit |
| 1.2 | **Scan → sell.** Scan a box from the inventory/sale screen to add it to the cart |
| 1.3 | **Haggle price per line**, plus discounts (% or $), tax rate, and split payments (cash + Venmo) at checkout |
| 1.4 | **Sizes at checkout:** sell a specific variant so per-size stock stays correct |
| 1.5 | **Receipts:** native share sheet / text / email after a sale. Share invoices too |
| 1.6 | **Invoices work offline** (queued in the outbox like sales) |
| 1.7 | **Customers:** a customer record (name, email, phone, address, tax-exempt) picked from invoices; purchase history |
| 1.8 | **Invoice payments:** due date/terms, partial payments and deposits, balance due, overdue status, void/credit |
| 1.9 | **Show close-out:** a per-event report of totals by payment method, cost basis, fees and profit; exportable |
| 1.10 | Remove demo copy ("seeded account") from the import screen |

## P1: design system (the "funky buttons")

| # | Item |
|---|------|
| D.1 | One `Button` (primary/secondary/ghost/destructive × sm/md/lg; loading, disabled, pressed, haptics, 44pt minimum) + `IconButton`, `EmptyState`, `ErrorState`, `Skeleton`, `Screen` |
| D.2 | Tokens: one brand purple (remove `#6C5CE7`, use `COLORS.primary`), a type scale, control heights, radii 14/18 only |
| D.3 | Migrate screens in this order: auth → add/edit → ItemQuickSheet → inventory list (swipe actions, context menu) → detail/sale/invoices → settings → the rest |
| D.4 | Lint rule: no raw `TouchableOpacity` or hex colors outside `components/` and `theme/` |
| D.5 | Devices: iPhone XR (iOS 16.4+ is the SDK 57 floor, and XR runs 18) through 17 Pro Max, plus iPad (max content width, `useWindowDimensions`, Dynamic Type cap) |
| D.6 | Fix the app icon fold artifact and the profit card's stray line |

## P2: native iOS extras (after P0/P1)

Haptics (part of D.1), Tap to Pay on iPhone (Stripe Terminal; needs Apple
entitlement), App Shortcuts ("log a sale"), Spotlight for inventory, a
home-screen widget for today's sales, a CSV share extension, and collectibles
fields (grading company/grade/cert/set number).

## P2: test hardening

- Mutation testing nightly: mutmut on revenuecat_service, webhooks and
  spreadsheet_import; Stryker on the offline outbox and api.ts.
- Property-based (hypothesis) tests for import parsing.
- The 15 import/export cases in the collectibles review.

## Release blockers outside the code

- Provisioning profile needs the Associated Domains capability (for
  reset-password Universal Links). Regenerate once with an interactive
  `eas build`, where Alex logs in with his Apple ID one time.
- Paid Apps agreement, tax and bank (Alex).
- App Privacy questionnaire (Alex, with the answers supplied).
