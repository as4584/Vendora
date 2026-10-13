#!/bin/sh
# Every 5s: CPU/memory of every load-test container and Postgres connection count.
while true; do
  ts=$(date +%s)
  docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" \
    $(docker ps -q --filter label=com.docker.compose.project=vendora-loadtest) | sed "s/^/$ts,/"
  echo "$ts,pg_connections,$(docker exec vendora-loadtest-db-1 psql -U vendora -d vendora -Atc "select count(*) from pg_stat_activity where datname='vendora'")"
  sleep 5
done
