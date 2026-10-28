#!/usr/bin/env bash
# Smoke test of the two Ship images against a disposable PostgreSQL: migrate with the migrate image,
# start the server image, probe it, stop it.
# Usage: scripts/smoke-image.sh <server-image> <migrate-image>
# Creates a private network and two containers named ship-smoke-<pid>*, all removed on exit.
set -euo pipefail

server_image="${1:?usage: smoke-image.sh <server-image> <migrate-image>}"
migrate_image="${2:?usage: smoke-image.sh <server-image> <migrate-image>}"
name="ship-smoke-$$"
pg="$name-pg"
app="$name-app"
# One reference for the tests and this script.
postgres_image="$(tr -d '[:space:]' <"$(dirname "$0")/../test/support/postgres-image.txt")"

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
# The issuer is never contacted: the smoke test sends no token.
export SHIP_TRUSTED_ISSUERS='[{"issuer":"http://127.0.0.1:9/oidc","clientId":"ship-smoke"}]'

fail() {
  echo "smoke: $*" >&2
  exit 1
}

fail_with_logs() {
  echo "smoke: $1" >&2
  docker logs "$2" >&2 2>&1 || true
  exit 1
}

docker network create "$name" >/dev/null
docker run -d --name "$pg" --network "$name" -e POSTGRES_PASSWORD -e POSTGRES_DB "$postgres_image" >/dev/null

# Over TCP: the image's init phase runs a temporary server on a unix socket only.
pg_ready() { docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres -d ship; }
for _ in $(seq 60); do
  pg_ready && break
  sleep 1
done
pg_ready || fail_with_logs "PostgreSQL did not become ready" "$pg"

echo "smoke: migrate"
docker run --rm --network "$name" -e DATABASE_URL "$migrate_image"

echo "smoke: start"
docker run -d --name "$app" --network "$name" -p 127.0.0.1::3000 \
  -e DATABASE_URL -e APP_ORIGIN -e SHIP_TRUSTED_ISSUERS "$server_image" >/dev/null

# The mapped port exists only while the container runs; a crash at boot ends in its logs, not here.
base=""
for _ in $(seq 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$app")" = true ] || fail_with_logs "the server exited at boot" "$app"
  mapped="$(docker port "$app" 3000/tcp 2>/dev/null || true)"
  port="$(printf '%s\n' "$mapped" | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
  if [ -n "$port" ]; then
    base="http://127.0.0.1:${port}"
    curl -fs "$base/healthz" >/dev/null 2>&1 && break
  fi
  sleep 1
done
[ -n "$base" ] || fail_with_logs "cannot find the mapped port" "$app"

status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
[ "$(status "$base/healthz")" = 200 ] || fail_with_logs "/healthz is not 200" "$app"
manifest="$(curl -fs "$base/.well-known/coforge-agent-manifest.json")" || fail_with_logs "manifest is not 200" "$app"
case "$manifest" in
  *'"schema":"coforge-agent-manifest.v1"'*) ;;
  *) fail_with_logs "manifest has the wrong schema" "$app" ;;
esac
[ "$(status "$base/public/v1/orgs/00000000-0000-7000-8000-000000000000/apps/none/releases/1.0.0")" = 404 ] ||
  fail_with_logs "an unknown public release is not 404" "$app"

# Longer than the server's own 10 s shutdown timeout, so a hang shows as a kill (exit 137), not a pass.
echo "smoke: stop"
docker stop -t 15 "$app" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$app")"
[ "$code" = 0 ] || fail_with_logs "exited $code on SIGTERM, want 0" "$app"
echo "smoke: ok"
