#!/usr/bin/env bash
# Boots the production app image the way docker-compose.yml runs it and checks it end to end.
# Needs a fresh Postgres 16 and Redis 7 on 127.0.0.1:5432 / :6379 (CI service containers).
#   IMAGE=pai-app PG_CONTAINER=<id> REDIS_CONTAINER=<id> scripts/smoke-image.sh
# Throwaway test values only; nothing here is a real secret.
set -euo pipefail
IMAGE=${IMAGE:?} PG=${PG_CONTAINER:?} REDIS=${REDIS_CONTAINER:?}
DB_URL=${SMOKE_DATABASE_URL:-postgres://pai:pai@127.0.0.1:5432/pai_test}
SECRET=$(openssl rand -hex 32) KEK=$(openssl rand -base64 32)
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$SECRET"; echo "::add-mask::$KEK"; fi
trap 'docker rm -f app1 app2 >/dev/null 2>&1 || true' EXIT
fail() {
  echo "FAIL: $*" >&2
  for c in app1 app2; do docker logs "$c" 2>&1 | tail -30 >&2 || true; done
  exit 1
}
# Same hardening as docker-compose.yml.
run() { docker run --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
wait_health() { # container, wanted docker health status
  for _ in $(seq 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = "$2" ] && return 0; sleep 1; done
  fail "$1 never became $2"
}
psql_q() { docker exec "$PG" psql -U pai -d pai_test -tAc "$1"; }

echo "== image: non-root, NODE_ENV, no npm, no app source maps"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" = 1000 ] || fail "not running as uid 1000"
[ "$(docker run --rm --entrypoint printenv "$IMAGE" NODE_ENV)" = production ] || fail "NODE_ENV is not production"
docker run --rm --entrypoint sh "$IMAGE" -c '! command -v npm && ! command -v corepack' >/dev/null || fail "npm/corepack in runtime image"
[ -z "$(docker run --rm --entrypoint find "$IMAGE" /app/.next -name '*.map')" ] || fail "source maps in image"

echo "== boot checks exit 1 with a clear message"
boot_fails() { # expected message, docker run args...
  local want=$1 out rc; shift
  set +e; out=$(timeout 60 docker run --rm "$@" "$IMAGE" 2>&1); rc=$?; set -e
  [ "$rc" = 1 ] || fail "expected exit 1 ($want), got $rc: $out"
  grep -q "$want" <<<"$out" || fail "missing '$want' in: $out"
}
boot_fails "SESSION_SECRET must be at least 32"
boot_fails "SESSION_SECRET must be at least 32" -e SESSION_SECRET=short
boot_fails "INVITE_CODES or INVITE_ONLY=1 is required" -e SESSION_SECRET="$SECRET"
boot_fails "ADMIN_KEY_KEK must be 32 bytes" -e SESSION_SECRET="$SECRET" -e INVITE_ONLY=1 -e ADMIN_KEY_KEK=dGVzdA==
boot_fails "MOCK_PROVIDER=1 is not allowed" -e SESSION_SECRET="$SECRET" -e MOCK_PROVIDER=1

echo "== two replicas on an empty database: migrations apply once, under the advisory lock"
ENV=(-e SESSION_SECRET="$SECRET" -e ADMIN_KEY_KEK="$KEK" -e DATABASE_URL="$DB_URL" -e REDIS_URL=redis://127.0.0.1:6379/0
     -e WEBAUTHN_RP_ID=localhost -e WEBAUTHN_ORIGIN=http://localhost:3000 -e APP_URL=http://localhost:3000 -e INVITE_ONLY=1)
run -d --name app1 -e PORT=3000 "${ENV[@]}" "$IMAGE" >/dev/null
run -d --name app2 -e PORT=3001 "${ENV[@]}" "$IMAGE" >/dev/null
wait_health app1 healthy; wait_health app2 healthy
want=$(ls migrations/*.sql | wc -l | tr -d ' ')
[ "$(psql_q 'SELECT count(*) FROM schema_migrations')" = "$want" ] || fail "schema_migrations != $want files"

echo "== pages, assets, health, headers"
B=http://127.0.0.1:3000
[ "$(code $B/)" = 200 ] || fail "/ not 200"
[ "$(code $B/chat)" = 200 ] || fail "/chat not 200"
[ "$(code $B/brand/narwhal.svg)" = 200 ] || fail "public/ asset missing"
chunk=$(curl -s $B/ | grep -o '/_next/static/[^"]*\.js' | sed -n 1p)
[ -n "$chunk" ] && [ "$(code "$B$chunk")" = 200 ] || fail "static chunk '$chunk' not served"
curl -s $B/api/health | grep -q '"ok":true' || fail "health not ok"
headers=$(curl -sI $B/)
grep -qi '^content-security-policy:' <<<"$headers" || fail "no CSP header"
grep -qi '^strict-transport-security: max-age=63072000' <<<"$headers" || fail "no HSTS header"
if grep -qi '^x-powered-by' <<<"$headers"; then fail "x-powered-by present"; fi

echo "== fail closed: 503 while Redis, then Postgres, is down"
for svc in "$REDIS" "$PG"; do
  docker stop "$svc" >/dev/null
  [ "$(code $B/api/health)" = 503 ] || fail "health not 503 with $svc down"
  wait_health app1 unhealthy
  docker start "$svc" >/dev/null
  for _ in $(seq 30); do [ "$(code $B/api/health)" = 200 ] && break; sleep 1; done
  [ "$(code $B/api/health)" = 200 ] || fail "no recovery after $svc restart"
  wait_health app1 healthy # so the next round cannot pass on a stale "unhealthy"
done

echo "== graceful shutdown on SIGTERM"
start=$(date +%s); docker stop -t 30 app1 >/dev/null; took=$(( $(date +%s) - start ))
[ "$(docker inspect -f '{{.State.ExitCode}}' app1)" = 0 ] || fail "exit code on SIGTERM not 0"
[ "$took" -lt 10 ] || fail "shutdown took ${took}s"
echo "OK: image size $(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.0f MB", $1/1e6}')"
