# Resqlo 1.1 — App Store release checklist (owner)

Work through these in order. Anything marked **TODO** needs a decision or value from you.

## 1. Before building
1. Merge the `release/appstore-prep` PR into main.
2. In the EAS production env, confirm `EXPO_PUBLIC_REVENUECAT_IOS_KEY` is set (the `appl_...` key). Without it, iOS shows "Plans are unavailable". It never falls back to Stripe.
3. On the backend env (Doppler), confirm `REVENUECAT_WEBHOOK_AUTH` is set. Optionally set `REVENUECAT_SECRET_KEY` (`sk_...`) so that deleting an account also deletes the RevenueCat customer.
4. In RevenueCat, the offering `vendora_default` contains packages for `com.vendora.pro.monthly`, `com.vendora.pro.yearly` and `com.vendora.partner.monthly`.

## 2. Review demo account
1. Pick a dedicated email and a strong password. Store both in Doppler as `REVIEW_ACCOUNT_EMAIL` and `REVIEW_ACCOUNT_PASSWORD`.
2. From `backend/`, against prod:
   `python -m scripts.seed_review_account --dry-run`, then run it again without `--dry-run`.
   This gives Pro + Partner, 15 items, 3 customers, 3 sales (one split cash + card), and an invoice with a partial payment, all inside a show started 3 hours ago.
   Re-run it right before you submit so the "show" is fresh. Each run wipes and reseeds that account only.
3. Optional: add the email to `TESTER_EMAIL_ALLOWLIST` so the account stays Pro even if a sandbox purchase expires.

## 3. Build
1. `cd mobile && eas build -p ios --profile production`. Sign in with your Apple ID when asked.
2. `eas submit -p ios --latest`. Alternatively, upload through Transporter.

## 4. App Store Connect — app listing
- **Name:** Resqlo
- **Subtitle (≤30):** Inventory & sales for resellers
- **Promotional text (≤170):** Scan it, price it, sell it. Resqlo tracks every pair, every size, and every sale at your next show, with receipts, invoices and an end-of-show summary.
- **Description:**
  Resqlo is the inventory and point-of-sale app for sneaker, streetwear, vintage and card resellers.
  • Scan barcodes and labels to add items in seconds, with per-size stock
  • Ring up sales fast: cart, haggle prices, discounts, tax, and split payments
  • Share receipts and send invoices, with partial payments tracked
  • Know your numbers: profit today, inventory value, and an end-of-show summary
  • Keep customers on file with their purchase history
  • Connect eBay, StockX, Google Sheets, Square, Clover and Lightspeed
  • Works offline at the show and syncs when you're back online
  Resqlo Pro unlocks unlimited inventory, exports and advanced analytics.
- **Keywords (≤100):** `reseller,inventory,sneakers,pos,point of sale,invoice,barcode,ebay,stockx,vintage,card show` (99 chars)
- **Support URL:** https://vendora.lexmakesit.com/support
- **Marketing URL:** optional
- **Privacy Policy URL:** https://vendora.lexmakesit.com/privacy
- **Category:** Business (primary), Productivity (secondary)
- **Age rating:** answer "None" to every question → 4+
- **Copyright:** **TODO** (for example "2026 LexMakesIt")
- **Screenshots:** upload `mobile/appstore/screenshots/6.9in/*` and `6.5in/*`. To regenerate them, run `npm run build:web && node scripts/appstore-screenshots.ts` in `mobile/`.
- **App Privacy:** use `docs/release/APP_PRIVACY_ANSWERS.md`.

## 5. Subscriptions (ASC → Subscriptions), one group "Resqlo Pro"
For each product, verify the reference name, product ID, duration, price, display name, description (≤45), availability, and review notes in App Store Connect. Follow the [native subscription screenshot guide](SUBSCRIPTION_REVIEW_SCREENSHOTS.md) to capture and check one App Review screenshot per product. These are separate from the public listing screenshots in section 4.

| Product id | Duration | Display name | Description |
|---|---|---|---|
| com.vendora.pro.monthly | 1 month | Resqlo Pro (Monthly) | Unlimited inventory, exports, analytics |
| com.vendora.pro.yearly | 1 year | Resqlo Pro (Yearly) | Pro for a full year |
| com.vendora.partner.monthly | 1 month | Resqlo Pro + Partner | Pro plus storefront and priority support |

Also: set the group localization (display name "Resqlo Pro"), attach the subscriptions to version 1.1, and check that the paid-apps agreement and banking are active.

## 6. Review notes (paste and fill in)
```
Demo account: <REVIEW_ACCOUNT_EMAIL> / <REVIEW_ACCOUNT_PASSWORD>
The account is already on Pro with sample data (inventory with sizes, sales including a split
payment, an invoice with a partial payment, customers, and a live show summary under More > Show Summary).
Subscriptions are sold only through Apple in-app purchase: More > Plans & Billing (Restore Purchases is there too).
Account deletion: Settings > Delete Account (password + type DELETE). This deletes all data and revokes connected eBay/StockX/Google access.
Camera is used for barcode/label scanning and item photos; recognition runs on the device.
eBay/StockX/Square/Clover/Lightspeed/Google connections are optional and need the reviewer's own accounts; they aren't needed to review core features.
```

## 7. After approval
Release manually. Then run `C:\Users\AlexS\Automations\checks\cloudflare-status.ps1` and spot-check https://vendora.lexmakesit.com.
