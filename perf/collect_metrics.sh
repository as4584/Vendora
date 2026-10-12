#!/bin/sh
# Every 5s: container CPU/memory and Postgres connection count for the clone.
while true; do
  ts=$(date +%s)
  docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" vendora-loadtest-backend-1 vendora-loadtest-db-1 | sed "s/^/$ts,/"
  echo "$ts,pg_connections,$(docker exec vendora-loadtest-db-1 psql -U vendora -d vendora -Atc "select count(*) from pg_stat_activity where datname='vendora'")"
  sleep 5
done
