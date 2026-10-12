#!/bin/sh
# Step-ramp breakpoint test against the load-test clone, run from a container
# on the clone's Docker network. Usage: sh run_breakpoint.sh <out-dir-name>
set -e
cd "$(dirname "$0")"
OUT=results/$1; mkdir -p "$OUT"
sh collect_metrics.sh > "$OUT/metrics.csv" 2>&1 &
MET=$!
docker run --rm --network vendora-loadtest_default -v "$PWD:/mnt/perf" -w /mnt/perf \
  -e VENDORA_TOKENS=/mnt/perf/tokens.json -e STEP=${STEP:-100} -e STEP_SECONDS=${STEP_SECONDS:-60} \
  -e MAX_USERS=${MAX_USERS:-3000} -e SPAWN_RATE=${SPAWN_RATE:-25} \
  locustio/locust:2.43.1 -f locustfile.py --headless --host http://backend:8000 \
  --csv "$OUT/run" --csv-full-history --only-summary > "$OUT/locust.log" 2>&1 || true
kill $MET
