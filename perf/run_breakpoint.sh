#!/bin/sh
# Step-ramp breakpoint test against the load-test clone, run from containers
# on the clone's Docker network. Usage: sh run_breakpoint.sh <out-dir-name>
# LOCUST_WORKERS > 0 runs a distributed load generator (one master plus N
# worker containers), so the generator is not the bottleneck at high load.
set -e
cd "$(dirname "$0")"
OUT=results/$1; mkdir -p "$OUT"
NET=vendora-loadtest_default
IMG=locustio/locust:2.43.1
WORKERS=${LOCUST_WORKERS:-0}
RUN="docker run --rm --ulimit nofile=65536:65536 --network $NET -v $PWD:/mnt/perf -w /mnt/perf -e VENDORA_TOKENS=/mnt/perf/tokens.json"
sh collect_metrics.sh > "$OUT/metrics.csv" 2>&1 &
MET=$!
ROLE=""
if [ "$WORKERS" -gt 0 ]; then
  ROLE="--master --expect-workers $WORKERS"
  for i in $(seq 1 "$WORKERS"); do
    $RUN -d --name "locust-worker-$i" $IMG -f locustfile.py --worker --master-host locust-master >/dev/null
  done
fi
$RUN --name locust-master -e START=${START:-0} -e STEP=${STEP:-100} -e STEP_SECONDS=${STEP_SECONDS:-60} \
  -e MAX_USERS=${MAX_USERS:-3000} -e SPAWN_RATE=${SPAWN_RATE:-25} \
  $IMG -f locustfile.py $ROLE --headless --host ${TARGET:-http://backend:8000} \
  --csv "$OUT/run" --csv-full-history --only-summary > "$OUT/locust.log" 2>&1 || true
for i in $(seq 1 "$WORKERS"); do docker rm -f "locust-worker-$i" >/dev/null 2>&1 || true; done
kill $MET
