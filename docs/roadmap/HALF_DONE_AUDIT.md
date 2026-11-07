# Half-done audit (2026-11)

Scope: `mobile/` and `backend/`. I searched for TODO/FIXME, "coming soon", NotImplementedError, empty handlers,
unused feature flags, `services/api.ts` exports with no app caller, backend endpoints with no mobile caller,
screens you can't reach, settings rows that do nothing, integration UI and sync paths, offline gaps, and
planned items in FEATURE_REGISTRY / PRODUCT_REQUIREMENTS / PERFECTION_PLAN.

The marker search found nothing: there are no TODO/FIXME/"coming soon"/NotImplementedError markers and no
empty `onPress` handlers. Every half-done feature turned up as one of these instead: an API function or
endpoint that nothing in the app calls, or a feature listed in a plan that doesn't exist yet.

Classes: **(a)** finish now, **(b)** remove or hide, **(c)** needs the owner.

| # | Finding | Evidence | Class | Outcome |
|---|---------|----------|-------|---------|
| 1 | No customer records (PERFECTION_PLAN 1.7) | invoices stored only free-text name/email | a | Built Customers: `customers` table (migration 032, backfilled from existing invoices), `/customers` list/detail/create/patch, linked from invoices and checkouts, list and detail screens (purchase history, total spent, last purchase), a quick-pick at checkout and on invoices, phone on invoices, tax-exempt turns sales tax off at checkout. The list falls back to the last cached copy when offline |
| 2 | Refunds had no UI | `refundTransaction` unused; dashboard shows a refund count | a | Refund button on item detail Sales History (checkout sales only; it restores stock) |
| 3 | You couldn't void an invoice (PERFECTION_PLAN 1.8) | `updateInvoiceStatus` unused; draft could not move to cancelled | a | "Mark as sent" and "Void invoice" on invoice detail; state machine now allows draft to cancelled; label shows VOID |
| 4 | Sync Center: failed runs can't be retried | `retrySyncRun` unused | a | Retry button on failed or partial runs |
| 5 | Sync Center: reconciliation issues are read-only | `updateReconciliationIssue` unused | a | Resolved / Dismiss actions |
| 6 | Square/Clover can connect but not disconnect | no DELETE endpoints; Lightspeed and eBay had one | a | `DELETE /integrations/square` and `/clover` (keeps item links); Disconnect buttons in Settings |
| 7 | eBay "send offer" ignored the eligibility check | `getEbayOfferEligibility` unused | a | Checked when the offer sheet opens; Send is disabled with eBay's reason |
| 8 | Raw hex in invoices and the eBay sheet | `#182744`, `#AFCEFF`, rgba backdrop | a | Replaced with tokens (new `COLORS.overlay`) |
| 9 | Dead client functions | `getTransaction`, `updateInvoice` (+ `UpdateInvoicePayload`), `getFeatureFlags`, `getTiers`, `exportInventoryCSV` | b | Removed. Invoice editing isn't part of the product (void and recreate instead). Tiers and flags come from `/subscriptions/me`. Inventory export uses the warehouse/xlsx variants. The server endpoints stay for API clients |
| 10 | `createTransaction`, `updateItemVariants`, `importInventoryFile`, `healthCheck` | no screen calls them | b (kept) | The offline outbox still replays queued legacy quick sales through the `createTransaction` types. The other three are thin wrappers covered by endpoint tests. Kept on purpose, no UI |
| 11 | `exportTransactionsCSV` | no UI | c | Needs a call on where a sales CSV export belongs (Show Summary already exports) |
| 12 | Smart Pricing / POS Mode / CSV import of Cash App/PayPal / Google Sheets sync, still marked "Planned" in FEATURE_REGISTRY | registry is stale | c | Pricing suggestions and in-person checkout exist now, so the registry needs the owner's update. Cash App/PayPal CSV and Sheets sync are post-MVP product calls |
| 13 | Live integrations (Stripe, RevenueCat, eBay/StockX production keys, Lightspeed app approval, Tap to Pay entitlement) | env/keys | c | Need the owner's accounts and keys; all tests mock them |
| 14 | Invoice customer address and tax-exempt on PDFs | customers now store them | c | Decide whether the invoice PDF should print address and tax-exempt status |
