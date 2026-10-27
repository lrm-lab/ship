#!/usr/bin/env bash
# Smoke test of a built Ship image against a disposable PostgreSQL: migrate, start, probe, stop.
# Usage: scripts/smoke-image.sh <image>
# Creates a private network and two containers named ship-smoke-<pid>*, all removed on exit.
set -euo pipefail

image="${1:?usage: smoke-image.sh <image>}"
name="ship-smoke-$$"
pg="$name-pg"
app="$name-app"

cleanup() {
  docker rm -f "$app" "$pg" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Exported so `docker run -e NAME` reads them: no credential or token on a command line.
POSTGRES_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export POSTGRES_PASSWORD
export POSTGRES_DB=ship
export DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@${pg}:5432/ship"
export APP_ORIGIN="http://localhost:3000"
export HOST=0.0.0.0
# The issuer is never contacted: the smoke test sends no token.
export SHIP_TRUSTED_ISSUERS='[{"issuer":"http://127.0.0.1:9/oidc","clientId":"ship-smoke"}]'

fail() {
  echo "smoke: $*" >&2
  docker logs "$app" >&2 2>&1 || true
  exit 1
}

docker network create "$name" >/dev/null
docker run --rm -d --name "$pg" --network "$name" -e POSTGRES_PASSWORD -e POSTGRES_DB postgres:17-alpine >/dev/null

# Over TCP: the image's init phase runs a temporary server on a unix socket only.
for _ in $(seq 60); do
  docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres -d ship && break
  sleep 1
done
docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres -d ship || fail "PostgreSQL did not become ready"

echo "smoke: migrate"
docker run --rm --network "$name" -e DATABASE_URL "$image" bunx --bun prisma migrate deploy

echo "smoke: start"
docker run -d --name "$app" --network "$name" -p 127.0.0.1::3000 \
  -e DATABASE_URL -e APP_ORIGIN -e HOST -e SHIP_TRUSTED_ISSUERS "$image" >/dev/null
port="$(docker port "$app" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
[ -n "$port" ] || fail "cannot find the mapped port"
base="http://127.0.0.1:${port}"

for _ in $(seq 30); do
  curl -fs "$base/healthz" >/dev/null && break
  sleep 1
done

status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
[ "$(status "$base/healthz")" = 200 ] || fail "/healthz is not 200"
[ "$(status "$base/.well-known/coforge-agent-manifest.json")" = 200 ] || fail "manifest is not 200"
curl -fs "$base/.well-known/coforge-agent-manifest.json" | grep -q '"schema":"coforge-agent-manifest.v1"' ||
  fail "manifest has the wrong schema"
[ "$(status "$base/public/v1/orgs/00000000-0000-7000-8000-000000000000/apps/none/releases/1.0.0")" = 404 ] ||
  fail "an unknown public release is not 404"

echo "smoke: stop"
docker stop -t 10 "$app" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$app")"
[ "$code" = 0 ] || fail "exited $code on SIGTERM, want 0"
echo "smoke: ok"
