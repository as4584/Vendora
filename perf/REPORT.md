# Vendora load test — 2026-10-12

Target: a production-identical clone on the production host (same Dockerfile,
`ENVIRONMENT=production`, Postgres 15, single `uvicorn` process, same 16-core
WSL host), with its own throwaway database. Production itself was not loaded.

Workload (`locustfile.py`): logged-in resellers on the iPhone app with 3–10 s
think time — app open (`/auth/me`, `/features`, `/subscriptions/me`,
`/dashboard`), browse inventory / item detail / activity, sales list,
invoices, add item, quick sale. ~0.18 req/s per user. Step ramp +100 users/min.

SLO: p95 ≤ 500 ms, p99 ≤ 1000 ms, errors ≤ 1%.

## Results

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
docker compose -p vendora-loadtest -f perf/docker-compose.loadtest.yml up -d --build --wait
python perf/seed_users.py http://127.0.0.1:18090 3000 perf/tokens.json
sh perf/run_breakpoint.sh <name>          # inside WSL as root
python perf/analyze.py perf/results/<name>/run perf/results/<name>/metrics.csv
```
Add `-f perf/docker-compose.loadtest-2workers.yml` for the 2-process variant.
