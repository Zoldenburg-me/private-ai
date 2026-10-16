# Postgres backups and restore

Postgres holds accounts, passkeys, devices, sessions and entitlements. Losing it locks every user
out. Redis holds only short-lived counters and challenges; it runs with AOF on the `redisdata`
volume (`docker-compose.yml`) and is not backed up off-site.

## How it works

| Script | Where, when | What |
|---|---|---|
| `scripts/backup-db.sh` | app host, nightly | `pg_dump` → restic (tag `pai-db`), the erasure ledger (tag `pai-erasures`), then a dead-man's-switch ping |
| `scripts/backup-db.sh --erasures-only` | app host, hourly | only the erasure ledger |
| `scripts/backup-maintain.sh` | **another machine**, weekly | `restic forget --prune` (retention) and `restic check` |
| `scripts/restore-db.sh --drill` | app host, monthly | restore into a scratch database, re-erase, compare, drop |
| `scripts/restore-db.sh` | app host, when needed | the same, then swap it in as `pai` |

**Why restic, not age:** restic encrypts on the client (AES-256 + Poly1305), ships to any target
(SFTP / Hetzner Storage Box, S3-compatible, B2, rest-server) through `RESTIC_REPOSITORY`, and does
retention and integrity checks itself. With age we would still need an upload tool and our own
retention and pruning logic.

**The app host cannot destroy its backups.** Its credential is append-only (see Setup); only
`backup-maintain.sh`, run elsewhere with a separate credential, deletes old snapshots. An attacker
with root on the host can stop new backups, but not erase existing ones.

**Retention (fixed, stated in the privacy policy):** 7 daily, 4 weekly, 3 monthly snapshots. With
the weekly prune and storage snapshots (14 days at most), nothing is older than **4 months**. The
erasure ledger keeps entries for 120 days (`ERASURE_LEDGER_DAYS`), so it outlives every backup.
Changing either number means changing the other and the privacy policy.

### Deleted accounts stay deleted (GDPR Art. 17)

Deleting an account (`deleteAccount`) writes `sha256(account id)` and the day to the `erasures`
table, in the same transaction. Account ids are 128-bit random, so the hash cannot be reversed.
The ledger is shipped off-site hourly on its own. Before a restored database goes live,
`restore-db.sh` merges three ledgers: the snapshot's own, the live database's (if it still answers;
read again after the app stops), and the newest off-site copy. It then deletes every listed account
again (`scripts/reerase.sql`). Accounts removed by the inactivity purge are not ledgered: the purge
deletes them again on its next daily run.
A real restore stops if the off-site ledger can't be read (otherwise accounts deleted after the
snapshot would come back); set `ALLOW_NO_OFFSITE_LEDGER=1` only if you know that ledger is lost.
It also refuses a snapshot older than 115 days: ledger entries expire after 120, so accounts deleted
before then would come back. Set `ALLOW_OLD_SNAPSHOT=1` only after re-running those deletions by hand.

Remaining gap: if the host and its database are lost together, deletions from the last hour (since
the last ledger upload) can come back. Re-run any deletion requests from that hour by hand.

## Setup (once)

### 1. Storage target with an append-only host credential

Pick one:

- **Hetzner Storage Box (SFTP), recommended.** Create a sub-account for the app host and turn on
  automatic snapshots for the box (Hetzner console, keep at most 14). The host can write and delete
  files over SFTP, but it cannot touch the snapshots, so anything it deletes can be recovered.
  `backup-maintain.sh` uses the main account from the other machine.
- **rest-server** on another machine, started with `--append-only`, and a second, non-append-only
  user for maintenance.
- **S3-compatible storage with versioning and Object Lock** (compliance mode, 4 months), where the
  provider supports it. Give the host a key that may write but not delete versions.

A delete-free key alone (for example a B2 key without `deleteFiles`) does not work: restic must
remove its own lock files.

Storage Box over SFTP, on the app host as root (replace `u123456`; the box listens on port 23):

```bash
(umask 077; ssh-keygen -t ed25519 -N '' -f /root/.ssh/storagebox)
# Upload /root/.ssh/storagebox.pub for the sub-account (Hetzner docs: "Storage Box SSH keys").
ssh-keyscan -p 23 u123456-sub1.your-storagebox.de >> /root/.ssh/known_hosts
# Check the fingerprints you just added against the ones Hetzner publishes before continuing.
cat >> /root/.ssh/config <<'CFG'
Host storagebox
  HostName u123456-sub1.your-storagebox.de
  User u123456-sub1
  Port 23
  IdentityFile /root/.ssh/storagebox
  IdentitiesOnly yes
CFG
```

### 2. Key and settings on the app host (as root)

```bash
apt install restic
install -d -m 700 /etc/private-ai
(umask 077; openssl rand -base64 32 > /etc/private-ai/restic.key)
install -m 600 /dev/null /etc/private-ai/backup.env
install -m 600 /dev/null /var/log/private-ai-backup.log
```

Store `restic.key` **and the app's `.env`** in the password manager, off the host. Without the key
the backups cannot be read and nobody can recover it; without `.env`, `SESSION_SECRET` is lost and
every user's session token becomes invalid.

`/etc/private-ai/backup.env` (the scripts refuse to run unless it is mode 600 and owned by the user
running them). Keep it separate from the app's `.env`, which the app container loads:

```bash
RESTIC_REPOSITORY=sftp:storagebox:pai
RESTIC_PASSWORD_FILE=/etc/private-ai/restic.key
# Dead man's switch (any monitor that alerts when pings stop, e.g. a self-hosted Healthchecks):
BACKUP_PING_URL=
# S3 targets instead need AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY here.
```

Initialise the repository, take a first backup and run a drill:

```bash
(set -a; . /etc/private-ai/backup.env; set +a; restic init)
/srv/private-ai/scripts/backup-db.sh
/srv/private-ai/scripts/restore-db.sh --drill
```

### 3. Schedules

`/etc/cron.d/private-ai-backup` on the app host (adjust the checkout path). `flock -n` skips a run
while the previous one is still going:

```
15 3 * * * root flock -n /run/private-ai-backup.lock /srv/private-ai/scripts/backup-db.sh >> /var/log/private-ai-backup.log 2>&1
45 * * * * root flock -n /run/private-ai-backup.lock /srv/private-ai/scripts/backup-db.sh --erasures-only >> /var/log/private-ai-backup.log 2>&1
```

Set the monitor to expect one ping a day with a few hours' grace. It alerts on failed runs,
skipped runs and a dead cron alike.

`/etc/logrotate.d/private-ai-backup` (restic output only: snapshot ids and sizes, no data):

```
/var/log/private-ai-backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  create 600 root root
}
```

On the maintenance machine: a checkout of the repo, restic, and a `backup.env` with the full-access
credential (for the Storage Box: the main account). Run `scripts/backup-maintain.sh` weekly. If it
stops running, the 4-month promise breaks, so give it its own dead-man's switch too.

## Restore drill (monthly, and after any change to this setup)

1. On the maintenance machine, put the key **from the password manager** (not a copy from the
   host) in a temporary file and run `restic -p <that file> snapshots`. This proves the off-host
   key copy works. Delete the file afterwards.
2. On the app host:

   ```bash
   scripts/restore-db.sh --drill            # latest snapshot
   scripts/restore-db.sh --drill <snapshot> # a specific one (restic snapshots lists them)
   ```

   This checks free disk space, restores into a scratch database `pai_restore`, re-applies the
   erasure ledgers, prints row counts per table next to the live database, then drops it. The app
   keeps running. Counts should be close; the live database has moved on since the snapshot.
3. Check that the backup monitor shows a recent ping.

## Restore (data loss or corruption)

```bash
(set -a; . /etc/private-ai/backup.env; set +a; restic snapshots --tag pai-db)  # pick one
scripts/restore-db.sh <snapshot>                                               # or none for latest
```

The script shows the snapshot's time, restores into `pai_restore`, re-erases, and prints the counts.
After you type `yes`, it stops the app, ends leftover connections, re-erases once more, renames
`pai` to `pai_old` and `pai_restore` to `pai`, and starts the app. If any step fails, including
the app not starting, it puts the old `pai` back and restarts the app.

Then check sign-in with a test account and drop the old copy **within 7 days**:
`docker compose exec postgres dropdb -U pai pai_old`. Until then, account deletions do not reach
`pai_old`, and the next restore refuses to run.

**New host:** check out the repo; restore `.env` and `restic.key` from the password manager; set up
SSH and `backup.env` as above; run `docker compose up -d postgres redis`, then
`scripts/restore-db.sh` (it warns that the new, empty database has no ledger, which is expected),
then `docker compose up -d`. `WEBAUTHN_RP_ID` must stay the same, or existing passkeys stop working.

## Privacy policy text (proposal; needs legal review)

> **Backups.** To protect accounts against data loss, we keep encrypted copies of our account
> database (opaque ids, plans, timestamps, passkey public keys, Stripe ids; never chat content)
> with [provider], a processor under Art. 28 GDPR, in [EU country]. The copies are encrypted
> before they leave our server; the provider cannot read them. They are deleted after at most
> 4 months. If you delete your account, it is removed from the live database at once and drops
> out of the backups within those 4 months. If we ever restore a backup, deleted accounts are
> deleted again before the service resumes, using a list of one-way hashes of deleted account
> ids that we keep for 120 days.
