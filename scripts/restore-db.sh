#!/usr/bin/env bash
# Restore Postgres from the restic repository written by scripts/backup-db.sh.
#   scripts/restore-db.sh --drill [snapshot]  restore into pai_restore, re-erase, print row counts, drop it (no downtime)
#   scripts/restore-db.sh [snapshot]          same, then stop the app and swap pai_restore in as pai;
#                                             the replaced database is kept as pai_old for rollback (max 7 days)
# snapshot defaults to latest. Before the swap, every account, device and passkey in the erasure ledger
# (the snapshot's, the live database's and the newest off-site copy) is deleted again. Runbook: docs/backup-restore.md.
set -Eeuo pipefail  # -E: the rollback ERR trap must also fire inside functions

drill=0
if [ "${1:-}" = --drill ]; then drill=1; shift; fi
snapshot=${1:-latest}
. "$(dirname "$0")/backup-common.sh"

counts() {
  sql "$1" "select string_agg(relname || '=' || (xpath('/row/c/text()',
    query_to_xml(format('select count(*) as c from %I', relname), false, true, '')))[1]::text, ' ' order by relname)
    from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace"
}
db_exists() { [ -n "$(sql postgres "select 1 from pg_database where datname = '$1'")" ]; }
# Renames fail while anyone is connected (a psql session, a running pg_dump).
kick() { sql postgres "select count(pg_terminate_backend(pid)) from pg_stat_activity
  where datname in ('pai', 'pai_old', 'pai_restore') and pid <> pg_backend_pid()" > /dev/null; }

# A failed run never leaves the scratch copy behind.
trap 'pg dropdb -U pai --if-exists pai_restore >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

echo "snapshot:"
if [ "$snapshot" = latest ]; then sel=(--tag pai-db --latest 1); else sel=("$snapshot"); fi
restic snapshots "${sel[@]}"
# Erasure ledger rows expire after ERASURE_LEDGER_DAYS (120, lib/store/types.ts): from an older
# snapshot, accounts whose erasure record has expired would come back.
MAX_SNAPSHOT_DAYS=115
taken=$(restic snapshots --json "${sel[@]}" | grep -o '"time":"[^"]*"' | head -1 | cut -d'"' -f4)
age=$(sql postgres "select extract(day from now() - '$taken'::timestamptz)::int")
if [ "$age" -gt "$MAX_SNAPSHOT_DAYS" ]; then
  if [ "$drill" = 0 ] && [ "${ALLOW_OLD_SNAPSHOT:-0}" != 1 ]; then
    echo "ERROR: snapshot is $age days old; erasures older than $MAX_SNAPSHOT_DAYS days are no longer in the ledger. Set ALLOW_OLD_SNAPSHOT=1 only after re-running those deletions by hand" >&2; exit 1
  fi
  echo "WARNING: snapshot is $age days old; accounts deleted more than $MAX_SNAPSHOT_DAYS days ago may come back" >&2
fi
restic dump --tag pai-db "$snapshot" /pai.dump > "$tmp/pai.dump"
pg pg_restore --list < "$tmp/pai.dump" > /dev/null

# The restored copy is about as large as the live database; the custom-format dump is compressed.
need=$(( $(sql postgres "select coalesce(sum(pg_database_size(datname)), 0) from pg_database where datname = 'pai'") + 4 * $(wc -c < "$tmp/pai.dump") ))
avail=$(( $(pg df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 }') * 1024 ))
if [ "$avail" -lt "$need" ]; then echo "not enough disk space: need ~$need bytes, have $avail" >&2; exit 1; fi

pg dropdb -U pai --if-exists pai_restore
pg createdb -U pai pai_restore
pg pg_restore -U pai -d pai_restore --no-owner --no-acl --exit-on-error < "$tmp/pai.dump"

# Delete again every account deleted after the snapshot: ledger rows from the live database (if it
# still answers) and the newest off-site ledger. Run again after the app stops, for the last minutes.
reerase() {
  : > "$tmp/erasures.tsv"
  local missing=""
  if sql pai "\copy erasures to stdout" > "$tmp/live.tsv"; then cat "$tmp/live.tsv" >> "$tmp/erasures.tsv"; else missing="live database"; fi
  if restic dump --tag pai-erasures latest /erasures.tsv > "$tmp/offsite.tsv"; then cat "$tmp/offsite.tsv" >> "$tmp/erasures.tsv"
  else
    # Without the off-site ledger, accounts deleted after the snapshot would come back (Art. 17).
    if [ "$drill" = 0 ] && [ "${ALLOW_NO_OFFSITE_LEDGER:-0}" != 1 ]; then
      echo "ERROR: could not read the off-site erasure ledger; fix restic access or set ALLOW_NO_OFFSITE_LEDGER=1 knowingly" >&2; exit 1
    fi
    missing="${missing:+$missing and }off-site ledger"
  fi
  if [ -n "$missing" ]; then echo "WARNING: could not read the erasure ledger from the $missing; accounts deleted and devices or passkeys removed after the snapshot may come back" >&2; fi
  pg psql -U pai -d pai_restore -v ON_ERROR_STOP=1 \
    -c "create temp table incoming (id_hash text, deleted_on date)" \
    -c "\copy incoming from pstdin" \
    -c "$(cat scripts/reerase.sql)" < "$tmp/erasures.tsv" | sed 's/^/re-erase: /'
}
reerase

restored=$(counts pai_restore)
# The live database may be gone (new host, the failure being recovered from).
live=$(counts pai 2>/dev/null || echo unavailable)
echo "snapshot $snapshot: $restored"
echo "live pai:      $live"

if [ "$drill" = 1 ]; then
  echo "drill ok: snapshot $snapshot restores cleanly"
  exit 0
fi

if db_exists pai_old; then
  echo "pai_old exists from an earlier restore; drop it first (dropdb -U pai pai_old)" >&2
  exit 1
fi
read -r -p "Stop the app and replace database pai with snapshot $snapshot? Type yes: " ok
[ "$ok" = yes ] || { echo aborted; exit 1; }

# On any failure from here on, put the previous database back and restart the app.
rollback() {
  trap - ERR
  echo "restore failed; putting the previous database back" >&2
  docker compose stop app || true
  if db_exists pai_old; then
    kick
    if db_exists pai; then sql postgres "alter database pai rename to pai_restore"; fi
    sql postgres "alter database pai_old rename to pai"
  fi
  docker compose up -d app
}
trap rollback ERR

docker compose stop app
kick
reerase
if db_exists pai; then sql postgres "alter database pai rename to pai_old"; fi
sql postgres "alter database pai_restore rename to pai"
docker compose up -d --wait app
trap - ERR
echo "restored; previous database kept as pai_old: check sign-in, then drop it within 7 days (docs/backup-restore.md)"
