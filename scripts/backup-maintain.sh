#!/usr/bin/env bash
# Retention and integrity check for the backup repository. Run weekly from a machine other than the
# app host, with a credential that may delete (the app host's credential is append-only).
# Needs only restic and a BACKUP_ENV with that credential; no docker. Runbook: docs/backup-restore.md.
set -euo pipefail
. "$(dirname "$0")/backup-common.sh"

# Fixed retention, stated in the privacy policy: nothing older than about 3 months survives a run.
restic forget --group-by tags --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 3
restic check
