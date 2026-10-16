# Sourced by the backup scripts: loads BACKUP_ENV, enters the compose project, makes a private temp dir.
BACKUP_ENV=${BACKUP_ENV:-/etc/private-ai/backup.env}
# It holds the repository key path and backend credentials: refuse it if anyone else can read or change it.
if [ -z "$(find "$BACKUP_ENV" -maxdepth 0 -user "$(id -u)" -perm 600 2>/dev/null)" ]; then
  echo "$BACKUP_ENV must exist, be owned by $(id -un) and have mode 600" >&2; exit 1
fi
set -a; . "$BACKUP_ENV"; set +a
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in $BACKUP_ENV}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE in $BACKUP_ENV}"

cd "$(dirname "$0")/.."
umask 077
# Plaintext dumps go to RAM (tmpfs) when the host has it, so they never touch the disk.
if [ -d /dev/shm ]; then export TMPDIR=/dev/shm; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pg() { docker compose exec -T postgres "$@"; }
sql() { pg psql -U pai -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"; }
