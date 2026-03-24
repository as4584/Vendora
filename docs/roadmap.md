🔵 VENDORA BUILD ROADMAP — Last Updated: 2026-02-24 (Post-Sprint 6 Hotfix Session)

Production URL: https://vendora.lexmakesit.com
Git Branch: sprint-5-lightspeed-deploy (latest: b8e2deb)
Expo SDK: 54 | React Native: 0.81.5 | FastAPI backend on Ubuntu VPS
EAS Project: @lexmakesit/vendora
EAS Update URL: exp://u.expo.dev/85f51ce2-35b8-4ba2-b3fe-a4f182a412f9?channel-name=production&runtime-version=1.0.0

---

⚠️ DEPLOYMENT NOTE — DATABASE VOLUMES
When running `docker compose up --build -d`, if a new volume is created
(log shows "Volume vendora_xxx Creating"), ALL user data is wiped.
After any volume-recreating deploy, run:
  ssh vendora "cd /opt/vendora && docker compose -f docker-compose.prod.yml exec -T backend python create_user.py"
  ssh vendora "cd /opt/vendora && docker compose -f docker-compose.prod.yml exec -T backend alembic upgrade head"
Test account: thegamermasterninja@gmail.com / Alexander1221 (Pro + Partner tier)

⚠️ DEPLOYMENT NOTE — ENV VARS
`docker compose restart backend` does NOT reload .env.prod changes.
Must use: `docker compose -f docker-compose.prod.yml up -d backend` to recreate container.

---

🟢 Sprint 1 — Core Engine Stabilization — COMPLETE
✅ PostgreSQL schema (users, inventory_items, migrations 001)
✅ Auth system (JWT + bcrypt), CRUD, state machine, pagination, indexing
✅ pytest suite, 80%+ coverage
✅ Mobile: Login, inventory list, add/edit, navigation, API integration

🟢 Sprint 2 — Revenue Engine — COMPLETE
✅ Transactions table (migration 002)
✅ Profit calculation engine (isolated service)
✅ Refund logic, dashboard API
✅ Mobile: Quick Sale, manual payment logging, Dashboard v1

🟢 Sprint 3 — Automated Money Layer — COMPLETE
✅ Invoice system + state machine (draft→sent→paid→cancelled)
✅ Stripe Connect, PaymentIntent, webhook handler (idempotent)
✅ Subscription billing logic, tier enforcement middleware
✅ Invoice items table (migration 003)
✅ Mobile: Invoice creation screen, Stripe pay link, subscription flow

🟢 Sprint 4 — Modular Expansion + Hardening — COMPLETE
✅ Barcode scanning (expo-camera CameraView)
✅ Feature flags service
✅ CSV export (Pro tier)
✅ Public seller page
✅ Full regression test suite

🟢 Sprint 5 — Lightspeed POS Integration — COMPLETE
✅ Lightspeed OAuth token storage (migration 004)
✅ Background sync every 15 min (expo-background-fetch + expo-task-manager)
✅ Lightspeed sync endpoints: /integrations/lightspeed/status|connect|sync
✅ source + external_id dedup columns (migration 005)
✅ Mobile: Settings → Lightspeed card, Connect/Sync/Disconnect

🟢 Sprint 6 — Market Intelligence + Invoice PDF — COMPLETE (2026-02-24)
✅ Market price endpoint: GET /inventory/market-price
✅ Pricing suggestion endpoint: GET /inventory/{id}/pricing-suggestion
✅ PDF invoice export: GET /invoices/{id}/pdf (fpdf2, styled A4)
✅ profile_picture column on users (migration 006)
✅ PATCH /auth/profile (business_name + profile_picture base64)
✅ Mobile: 3-column photo grid inventory view
✅ Mobile: Add item with front/back photos, barcode scanner, auto-SKU
✅ Mobile: Item detail — market price panel, smart pricing suggestion + Apply
✅ Mobile: Invoice PDF export button (expo-file-system/legacy + expo-sharing)
✅ Mobile: Profile picture upload in Settings (circular, shown on PDF invoices)
✅ Mobile: Show/hide password toggle on login screen

🟢 Sprint 6 Hotfix Session — Bug Fixes & Distribution (2026-02-24)

Bug fixes:
✅ Fixed all garbled UTF-8 mojibake emoji in settings.tsx (✅ 🔗 🚀 🔄 —)
✅ Fixed all garbled emoji in inventory/add.tsx (📸 ⚡ 🔍 ✅)
✅ Fixed PDF export crash: "cannot read property 'base64' of undefined"
   — Root cause: FileSystem.EncodingType.Base64 undefined in Expo Go
   — Fix: switched to expo-file-system/legacy import + null guard on pdf_base64
✅ Fixed PDF layout: NUMBER/DATE/DUE DATE values overflowing off right page edge
   — Root cause: rx + lbl_w + val_w exceeded 190mm A4 usable width
   — Fix: repositioned metadata block, left-aligned values within margins
✅ Fixed Lightspeed "Connect" crash: "Cannot cast Optional(nil) to URL"
   — Root cause: API returns authorization_url key, frontend expected url key
   — Fix: updated getLightspeedConnectUrl() to return { authorization_url }
✅ Fixed Lightspeed "not configured" showing as cryptic error
   — Now shows human-readable "Coming Soon" alert when 503 returned
✅ Lightspeed OAuth credentials configured on production server
   — CLIENT_ID + CLIENT_SECRET + REDIRECT_URI set in /opt/vendora/.env.prod
   — Verified: GET /integrations/lightspeed/connect returns valid OAuth URL

UX improvements:
✅ Invoice "+ Add Item" button now opens inventory search modal (bottom sheet)
   — Search bar filters live against full inventory list
   — Tap inventory item → auto-fills description, price, links inventory_item_id
   — "✏️ Custom Item" fallback for manual entry
✅ Renamed "Add Line Item" → "+ Add Item" (clearer CTA)

Distribution:
✅ EAS CLI installed + logged in as @lexmakesit
✅ EAS project created: @lexmakesit/vendora (ID: 85f51ce2-35b8-4ba2-b3fe-a4f182a412f9)
✅ expo-updates installed
✅ eas.json created
✅ First EAS Update published to production channel (iOS)
   — Permanent shareable link: exp://u.expo.dev/85f51ce2-35b8-4ba2-b3fe-a4f182a412f9?channel-name=production&runtime-version=1.0.0
   — Anyone with Expo Go can open this link without needing your computer on

---

🔵 Sprint 7 — UX Polish + App Store Prep (NEXT)
🎯 Goal: Make Vendora App Store submittable and distribute via TestFlight.

Deliverables:
- Onboarding flow (first-time user walkthrough)
- Empty states with illustrations
- Error boundary components (replace raw Alert calls)
- Password reset flow (forgot password email)
- Push notifications (expo-notifications) for invoice paid events
- App icon + splash screen final assets (replace default Expo assets)
- App Store metadata (screenshots, description, keywords)
- EAS Build configuration → production iOS build → TestFlight
- Privacy policy + Terms of service screens
- Android APK build (EAS Build --platform android)

Success Criteria:
- No crashes in any happy-path flow
- App Store review guidelines checklist passes
- TestFlight build installable by external testers

---

🔐 Documentation Rule (STRICT)

Every feature must update:
- ARCHITECTURE.md if schema/endpoint changes
- STATE_MACHINES.md if transitions change
- RISK_REGISTER.md if new exposure
- FEATURE_REGISTRY.md if feature status changes
- ROADMAP.md sprint status + deployment notes
- Vendora_source_of_truth.md if core product definition changes

Docs are not optional. Outdated docs = context hallucination.


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