#!/usr/bin/env bash
# Encrypted off-site Postgres backup: pg_dump (custom format) and the erasure ledger -> restic.
#   scripts/backup-db.sh                  full backup (nightly), then pings BACKUP_PING_URL if set
#   scripts/backup-db.sh --erasures-only  just the erasure ledger (hourly), so a restore re-deletes
#                                         accounts deleted after the last full backup
# Runs on the docker compose host as root from cron, with an append-only repository credential:
# retention and checks run elsewhere (scripts/backup-maintain.sh). Runbook: docs/backup-restore.md.
set -euo pipefail
. "$(dirname "$0")/backup-common.sh"

if [ "${1:-}" != --erasures-only ]; then
  pg pg_dump -U pai -d pai --format=custom > "$tmp/pai.dump"
  # Reads only the archive's table of contents: catches an empty or truncated dump, not bad data.
  pg pg_restore --list < "$tmp/pai.dump" > /dev/null
  restic backup --tag pai-db --stdin --stdin-filename pai.dump < "$tmp/pai.dump"
fi

sql pai "\copy erasures to stdout" > "$tmp/erasures.tsv"
restic backup --tag pai-erasures --stdin --stdin-filename erasures.tsv < "$tmp/erasures.tsv"

# Dead man's switch: the monitor alerts when this ping stops arriving.
if [ "${1:-}" != --erasures-only ] && [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL"
fi
