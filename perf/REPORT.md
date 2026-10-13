# Vendora load test — 2026-10-12

Target: a production-identical clone on the production host (same Dockerfile,
`ENVIRONMENT=production`, Postgres 15, single `uvicorn` process, same 16-core
WSL host), with its own throwaway database. Production itself was not loaded.

Workload (`locustfile.py`): logged-in resellers on the iPhone app with 3–10 s
think time — app open (`/auth/me`, `/features`, `/subscriptions/me`,
`/dashboard`), browse inventory / item detail / activity, sales list,
invoices, add item, quick sale. ~0.18 req/s per user. Step ramp +100 users/min.

SLO: p95 ≤ 500 ms, p99 ≤ 1000 ms, errors ≤ 1%.

## Published capacity limits

Vendora runs on a single self-hosted server. Measured limits on that hardware
(people with the app open and active at the same moment):

| Setup | People online at once | Roughly equals daily active users |
|---|---|---|
| Current deployment (1 API process) | ~500 | ~5,000–10,000 |
| Tier 3, 4 API replicas (this branch, default) | ~2,500 | ~25,000–50,000 |
| Tier 3, 8 API replicas (`VENDORA_API_REPLICAS=8`) | ~3,500 | ~35,000–70,000 |

Daily-user estimates assume 5–10% of daily users are online in the busiest minute.

## Tier 3 architecture results

Layout (docker-compose.prod.yml): nginx load balancer → N stateless API
replicas → PgBouncer (transaction pooling) → Postgres, plus Redis (job queue
and shared rate-limit counters), an RQ worker for email/Discord, and a one-shot
migration service. Clone: `perf/docker-compose.loadtest-tier3.yml`. Load
generator: distributed Locust (1 master + 4 workers), same user model, step
ramp +250 users/min.

| Configuration | Max sustainable users | RPS | p95 | p99 | Server errors | API CPU | API mem | DB CPU | PgBouncer CPU | What limits it |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 replicas | **~2,500** | ~480 | 87 ms | 140 ms | 0 | ~125% per replica (1 core each, GIL) | ~135 MB each | ~120% | ~80% | API processes: throughput flat at ~500 RPS |
| 8 replicas | **~3,500** | ~690 | 44 ms | 70 ms | 0 | ~70% per replica | ~126 MB each | ~137% | **~99%** | PgBouncer is single-threaded; at 3,750 users p95 610 ms |

Past the limit the API now **degrades instead of deadlocking**: with 4
replicas at 3,250 users throughput held at ~500 RPS, latency rose to ~1.6 s,
under 0.5% of requests got a fast 503, and the API recovered by itself when
load dropped. The only failed requests in the 8-replica run (449 of 240,939)
were 403s from free-plan test accounts hitting the 25-item cap, which the
locustfile now counts as expected.

### Bugs the load tests found and fixed

1. **PgBouncer pool too small** (40 server connections for 4 × 40 threads):
   clean to ~2,000 users, then cascading 502s. Raised to 75 + 10 reserve
   (fits under Postgres' 100).
2. **Hold-and-wait deadlock across thread hops.** A request keeps its DB
   connection from its first query until its session closes, but FastAPI runs
   the auth dependency, the endpoint and response serialization as separate
   thread-pool jobs. With more requests in flight than connections, all 40
   threads waited for connections held by requests waiting for a thread;
   py-spy showed 40 threads in pool checkout and 75 server connections "idle
   in transaction", still stuck after load stopped. Fixes: the auth
   dependency ends its transaction before the endpoint runs, and
   `app/request_limit.py` admits at most `MAX_IN_FLIGHT_REQUESTS` (40, ≤ pool
   capacity) per process; extra requests queue on the event loop and get a
   503 after 10 s. Regression tests: `tests/test_db_pool_capacity.py`,
   `tests/test_request_limit.py`.
3. **Migrations raced across replicas** (every replica ran Alembic at
   startup). Now a one-shot `migrate` service runs first.
4. **Rate limits were per process**, so N replicas allowed N× the limit.
   Counters now live in Redis (verified: exactly 5 password-reset requests,
   then 429, across 4 replicas), falling back to memory if Redis is down.
5. **Job logs would have leaked reset tokens and email addresses** (RQ logs
   each call with its arguments). Jobs are described by function name only;
   verified in the worker log.

Next limit: PgBouncer's single core. Options when needed: a second PgBouncer
with `so_reuseport`, or fewer queries per request (dashboard and inventory
list dominate).

## Baseline results (single process, before Tier 3)

| Configuration | Max sustainable users | RPS | p50 | p95 | p99 | Errors | Backend CPU | Backend mem | DB CPU | DB conns | First failure |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **As deployed today** (1 process, default 5+10 DB pool) | **~500** | ~80–93 | 9 ms | 34–400 ms | 54–515 ms | 0% | ~55% | 141 MB | ~14% | 16 (pool full) | ~600 users: **deadlock** — 0 RPS, 60 s timeouts |
| 1 process + DB pool fix (20+30) | **~600** | ~113 | 9 ms | 43 ms | 71 ms | 0% | ~62% (≈1 core w/ GIL) | 130 MB | ~20% | 21 | 650 users: p95 560 ms, throughput flat at ~120 RPS |
| 2 processes + pool fix | **~1,500** | ~287 | 15 ms | 60 ms | 96 ms | 0% | ~170% | 283 MB | ~46% | 80 | 1,600 users: connections reset (likely 1,024-fd per-process limit with one socket per simulated phone) |

## Bottlenecks, in order

1. **DB pool smaller than the worker threadpool (bug, deployed now).** Sync
   endpoints run on AnyIO's 40 threads; SQLAlchemy's default pool is 15. At
   ~600 users py-spy showed all 40 threads blocked in `get_current_user`
   waiting for a connection while 15 connections sat "idle in transaction"
   held by requests that needed a thread to finish — a full API stall until
   30 s pool timeouts. Fixed: pool 20 + 30 overflow (≥ 40), regression test
   `backend/tests/test_db_pool_capacity.py`.
2. **Single Python process (GIL).** With the fix, throughput plateaus at
   ~120 RPS while Postgres sits at ~20% CPU. Doubling processes raised
   capacity 2.5× (600 → 1,500 users), confirming the limit is the app process,
   not the database.
3. Next limit beyond ~1,500 simulated users was connection-level, not CPU.
   Cloudflare's tunnel multiplexes client traffic over few connections, so
   this is probably an artifact of one-socket-per-phone in the test; re-check
   through the tunnel before relying on numbers above 1,500.

Login/signup are CPU-heavy (bcrypt ~180 ms each) but parallel across threads:
~24 hashes/s measured during seeding (~12 signups/s or ~24 logins/s).

## Not covered

- The Cloudflare edge + tunnel path (would mean loading the live site).
- Long soak (> 1 h) for leaks.

## Reproduce

```
docker compose -p vendora-loadtest -f perf/docker-compose.loadtest-tier3.yml up -d --build --wait
python perf/seed_users.py http://127.0.0.1:18090 3000 perf/tokens.json
START=1500 STEP=250 LOCUST_WORKERS=4 TARGET=http://lb:8000 MAX_USERS=6000   sh perf/run_breakpoint.sh <name>        # on the Docker host
python perf/analyze.py perf/results/<name>/run perf/results/<name>/metrics.csv
```
For the baseline, use `perf/docker-compose.loadtest.yml` (add
`-f perf/docker-compose.loadtest-2workers.yml` for 2 processes) and
`TARGET=http://backend:8000`. Seeded tokens expire after 60 minutes.
