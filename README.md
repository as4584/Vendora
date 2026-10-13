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
- **Lightspeed integration** — pull sales/inventory, publish catalog changes, and disconnect Lightspeed R-Series safely
- **Plans and partner tools** — Stripe upgrades, advanced analytics, verified public storefronts, and priority support
- **Market pricing** — compare UPC retail offers and the seller's own sales history from an item page

---

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | React Native (Expo 56, Expo Router) |
| Backend | FastAPI (Python 3.12) |
| Database | PostgreSQL + Alembic migrations |
| Auth | JWT (access tokens) |
| Payments | Stripe Connect + webhooks |
| POS Integration | Lightspeed R-Series OAuth |
| OTA Updates | EAS Update (Expo) |
| CI/CD | GitHub Actions |
| Containerization | Docker + docker-compose |
| Load balancing | nginx (least-connections across API replicas) |
| Connection pooling | PgBouncer (transaction mode) |
| Background jobs | Redis + RQ worker (email, Discord alerts, with retries) |
| Rate limiting | slowapi, counters shared in Redis |
| Load testing | Locust, distributed, against a production clone |

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

### Production topology

Everything runs on a single self-hosted machine behind a Cloudflare tunnel.

```
 iPhone app ──HTTPS──► Cloudflare ──tunnel──► nginx (load balancer)
                                                 │ least_conn, keepalive,
                                                 │ retries on a failed replica
                          ┌──────────────┬───────┴──────┬──────────────┐
                          ▼              ▼              ▼              ▼
                     API replica 1  API replica 2  API replica 3  API replica 4
                          │   (FastAPI/uvicorn, stateless)              │
              ┌───────────┴───────────────┬─────────────────────────────┘
              ▼                           ▼
          PgBouncer ──► PostgreSQL      Redis ◄── RQ worker ──► Resend / Discord
     (transaction pooling)        (job queue + shared
                                   rate-limit counters)
```

- **Stateless API replicas** scale with one setting (`VENDORA_API_REPLICAS`).
- **PgBouncer** lets hundreds of app connections share a few real Postgres
  connections, so adding replicas never exhausts `max_connections`.
- **Redis-backed rate limits**: N replicas still enforce one limit per client.
  If Redis is down, limits fall back to per-process memory instead of failing.
- **Background jobs**: emails and alerts leave the request path and retry on
  provider errors. Without Redis they run inline, so an outage costs latency,
  not delivery. Job logs never include arguments (reset tokens, addresses).
- **One-shot migrations**: a `migrate` service applies Alembic migrations once
  before replicas start, so replicas never race each other on schema changes.

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
        ├── Backend tests (pytest, 100% coverage gate, real PostgreSQL)
        └── Mobile smoke tests (Playwright, iPhone 12 + SE viewport)
        │
        ▼ (merge to main)
   Both test suites pass
        │
        ▼
   EAS Update → preview + production channels
        │
        ▼
   Tester/internal builds and production builds receive the same release
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
cp .env.example .env         # fill in secrets
cd .. && docker compose up -d db test-db
cd backend
pip install -r requirements-dev.txt
alembic upgrade head         # run migrations
uvicorn app.main:app --reload --port 8000
```

**Mobile**
```bash
cd mobile
npm install
npx expo start               # scan QR with Expo Go
```

Production billing and Lightspeed activation require `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PARTNER_PRICE_ID`,
`LIGHTSPEED_CLIENT_ID`, and `LIGHTSPEED_CLIENT_SECRET`. In-app support uses
`SENDGRID_API` and optionally `SUPPORT_EMAIL`. Never commit these values.

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

**Tier enforcement middleware** — a FastAPI dependency (`tier_limiter`) checks the user's subscription tier before inventory creation. Free tier is capped at 25 items; Pro is unlimited.

**Load-tested capacity** — breakpoint tests against a production clone (Locust, realistic reseller sessions) took the API from ~500 to ~3,500 concurrent users on the same hardware, with p99 under 100 ms and zero server errors. They also surfaced, and regression tests now guard, a thread-pool/connection-pool deadlock; requests past capacity now get a fast 503 instead of hanging the API. Details: [`perf/REPORT.md`](perf/REPORT.md).

**OTA updates** — mobile updates ship to both `preview` (tester/internal builds) and `production` after smoke tests pass. Expo Go users should reopen the shared channel link to refresh a cached project.

---

## Deployment

The backend deploys to `https://vendora.lexmakesit.com` via Docker.

```bash
docker compose -f docker-compose.prod.yml up -d --build   # VENDORA_API_REPLICAS=4 by default
```

Mobile OTA updates publish automatically via GitHub Actions on merge to `main`.
