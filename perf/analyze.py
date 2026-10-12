"""Summarize a step-ramp run per user level: RPS, p50/p95/p99, error rate,
and backend/DB CPU, memory and Postgres connections from collect_metrics.sh."""
import csv, re, statistics as st, sys
from collections import defaultdict

run, metrics = sys.argv[1], sys.argv[2]
SLO_P95, SLO_P99, SLO_ERR = 500, 1000, 0.01

rows = [r for r in csv.DictReader(open(f"{run}_stats_history.csv")) if r["Name"] == "Aggregated"]
by_users = defaultdict(list)
for r in rows:
    by_users[int(r["User Count"])].append(r)

def num(x):
    try: return float(x)
    except ValueError: return 0.0

m = defaultdict(lambda: defaultdict(list))
ts_users = sorted((int(r["Timestamp"]), int(r["User Count"])) for r in rows)
def users_at(ts):
    u = 0
    for t, n in ts_users:
        if t <= ts: u = n
    return u
for line in open(metrics, errors="ignore"):
    parts = line.strip().split(",")
    if len(parts) < 3 or not parts[0].isdigit(): continue
    u = users_at(int(parts[0]))
    if parts[1] == "pg_connections" and parts[2].isdigit():
        m[u]["pg"].append(int(parts[2]))
    elif len(parts) >= 4:
        who = "be" if "backend" in parts[1] else "db"
        m[u][who + "_cpu"].append(num(parts[2].rstrip("%")))
        mem = re.match(r"([\d.]+)(\w+)", parts[3])
        if mem:
            v = float(mem.group(1)) * {"GiB": 1024, "MiB": 1, "KiB": 1 / 1024}.get(mem.group(2), 1)
            m[u][who + "_mem"].append(v)

print(f"{'users':>6} {'rps':>7} {'p50':>6} {'p95':>6} {'p99':>6} {'err%':>6} {'beCPU%':>7} {'beMB':>6} {'dbCPU%':>7} {'dbMB':>6} {'pgconn':>6} SLO")
first_fail = None
prev = None
for u in sorted(by_users):
    rs = by_users[u][2:] or by_users[u]  # skip ramp-in rows
    rps = st.median(num(r["Requests/s"]) for r in rs)
    fps = st.median(num(r["Failures/s"]) for r in rs)
    p = {k: st.median(num(r[k]) for r in rs) for k in ("50%", "95%", "99%")}
    err = fps / rps if rps else 0
    mm = m[u]
    f = lambda k, fn=max: fn(mm[k]) if mm[k] else 0
    ok = p["95%"] <= SLO_P95 and p["99%"] <= SLO_P99 and err <= SLO_ERR
    if not ok and first_fail is None:
        first_fail = u
    print(f"{u:>6} {rps:>7.1f} {p['50%']:>6.0f} {p['95%']:>6.0f} {p['99%']:>6.0f} {err*100:>6.2f} "
          f"{f('be_cpu', st.median):>7.0f} {f('be_mem'):>6.0f} {f('db_cpu', st.median):>7.0f} {f('db_mem'):>6.0f} {f('pg'):>6} {'PASS' if ok else 'FAIL'}")
print("first SLO failure at", first_fail, "users")
