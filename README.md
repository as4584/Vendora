# Vendora — Reseller Operating System

[![Backend CI](https://github.com/as4584/Vendora/actions/workflows/ci.yml/badge.svg)](https://github.com/as4584/Vendora/actions/workflows/ci.yml)
[![Mobile Tests](https://github.com/as4584/Vendora/actions/workflows/mobile-tests.yml/badge.svg)](https://github.com/as4584/Vendora/actions/workflows/mobile-tests.yml)

A full-stack mobile application built for resellers to manage inventory, track profit, generate invoices, and accept payments — all from their phone.

---

## What It Does

Resellers (sneakers, electronics, clothing, etc.) use Vendora to run their business end-to-end:

- **Inventory tracking** — add items with photos, barcode scanning, condition, buy/sell price, platform
- **Profit engine** — real-time P&L per item and across the portfolio
- **Invoice generation** — create and send PDF invoices to buyers
- **Payment processing** — Stripe-powered checkout, subscription billing
- **Lightspeed integration** — sync inventory with Lightspeed X-Series POS
- **Multi-tier access** — Free and Pro tiers with enforced feature gates

---

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | React Native (Expo 54, Expo Router v6) |
| Backend | FastAPI (Python 3.12) |
| Database | PostgreSQL + Alembic migrations |
| Auth | JWT (access tokens) |
| Payments | Stripe Connect + webhooks |
| POS Integration | Lightspeed X-Series OAuth |
| OTA Updates | EAS Update (Expo) |
| CI/CD | GitHub Actions |
| Containerization | Docker + docker-compose |

---

## Architecture

```
┌─────────────────────────────────────┐
│         React Native App            │
│      (Expo Router, iOS/Android)     │
│                                     │
│  (auth)  login / register           │
│  (tabs)  dashboard / inventory /    │
│          invoices / settings        │
└───────────────┬─────────────────────┘
                │ REST + JWT
                ▼
┌─────────────────────────────────────┐
│         FastAPI Backend             │
│                                     │
│  /auth      JWT login + register    │
│  /inventory CRUD + state machine    │
│  /invoices  PDF generation          │
│  /webhooks  Stripe event handling   │
│  /integrations  Lightspeed OAuth    │
└───────────────┬─────────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
   PostgreSQL        Stripe API
   (Alembic          (payments +
    migrations)       webhooks)
```

### Inventory State Machine

Items flow through a strict state machine — no invalid transitions allowed:

```
in_stock → listed → sold → shipped → paid
              ↓
           archived
```

---

## CI/CD Pipeline

```
Push to feature branch
        │
        ▼
   Pull Request → main
        │
        ├── Backend tests (pytest, 80% coverage gate, real PostgreSQL)
        └── Mobile smoke tests (Playwright, iPhone 12 + SE viewport)
        │
        ▼ (merge to main)
   Both test suites pass
        │
        ▼
   EAS Update → preview channel
        │
        ▼
   Expo Go (testers) gets update automatically on next open
```

All deployments are gated — broken code never reaches testers.

---

## Project Structure

```
vendora/
├── backend/
│   ├── app/
│   │   ├── models/          # SQLAlchemy ORM models
│   │   ├── routers/         # FastAPI route handlers
│   │   ├── schemas/         # Pydantic request/response schemas
│   │   └── services/        # Business logic (profit, invoices, Stripe)
│   ├── alembic/             # Database migrations
│   └── tests/               # 60+ pytest tests with coverage
├── mobile/
│   ├── app/
│   │   ├── (auth)/          # Login + Register screens
│   │   └── (tabs)/          # Dashboard, Inventory, Invoices, Settings
│   ├── context/             # Auth state (JWT + AsyncStorage)
│   ├── services/            # API client
│   ├── e2e/                 # Playwright iPhone smoke tests
│   └── .maestro/            # Native iOS simulator test flows
└── .github/workflows/
    ├── ci.yml               # Backend tests
    └── mobile-tests.yml     # iPhone tests + EAS OTA deploy
```

---

## Local Development

**Backend**
```bash
cd backend
cp ../.env.example .env      # fill in secrets
docker-compose up -d         # starts PostgreSQL
pip install -r requirements.txt
alembic upgrade head         # run migrations
uvicorn app.main:app --reload --port 8000
```

**Mobile**
```bash
cd mobile
npm install
npx expo start               # scan QR with Expo Go
```

**Run tests**
```bash
# Backend
cd backend && pytest tests/ -v --cov=app

# Mobile (Expo web + iPhone viewport)
cd mobile
npx expo export --platform web
npx playwright test
```

---

## Key Engineering Decisions

**Inventory state machine** — inventory items use a strict state machine enforced at the service layer. Invalid transitions (e.g. `paid → listed`) are rejected with a 400. This prevents data corruption across async operations.

**Stripe webhook idempotency** — payment events are deduplicated by `event_id` in the database. Re-delivered webhooks are a no-op, so billing state stays consistent even under network retries.

**Tier enforcement middleware** — a FastAPI dependency (`tier_limiter`) checks the user's subscription tier on every protected route. Free tier is capped at 50 items; Pro is unlimited. Checked at the dependency layer so no router needs to know about it.

**OTA updates** — mobile updates ship via EAS Update without requiring App Store review. Testers on the `preview` channel receive updates on next app open.

---

## Deployment

The backend deploys to `https://vendora.lexmakesit.com` via Docker.

```bash
docker-compose -f docker-compose.prod.yml up -d
```

Mobile OTA updates publish automatically via GitHub Actions on merge to `main`.
