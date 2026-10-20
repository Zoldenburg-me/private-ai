# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Devin, …) working in this repo.

## What this is

Private AI: a Next.js 15 / TypeScript chat app on attested TEE inference. Chat content never
touches our servers' storage; the server keeps only opaque ids, plans, timestamps and counters.
Privacy claims on `/datenschutz` and `/privacy/metadata` are promises to users: code must keep
them true.

## Commands

```
npm ci
npm run dev               # no DATABASE_URL / REDIS_URL -> in-memory stores
npm run typecheck
npm test                  # vitest, in-memory stores
npm run test:integration  # same suite against real Postgres 16 + Redis 7 (TEST_DATABASE_URL / TEST_REDIS_URL)
npm run build
```

Run `typecheck`, `test` and `build` before every commit. Run `test:integration` whenever you touch
`lib/store/`, `migrations/` or Redis/SQL code.

## Layout

- `app/` routes and pages; `app/api/**/route.ts` files are thin and call into `lib/*-routes.ts`.
- `lib/store/` persistence behind `AccountStore` / `CounterStore` (memory, Postgres, Redis).
- `lib/billing*.ts` Stripe, `lib/passkey*.ts` WebAuthn, `lib/account-routes.ts` export/delete/devices, `lib/session.ts` tokens and device sessions,
  `lib/limits.ts` abuse limits, `middleware.ts` CSP + HSTS.
- `migrations/NNN_*.sql` plain SQL, applied automatically under an advisory lock.
- `tests/` vitest; store and counter tests are contract tests that run on every backend.

## Invariants (tests enforce most of them; do not weaken the tests)

- **No content on the server.** Never log or store prompts, replies or request bodies. Log only
  through `metaLogger` in `lib/log.ts` (field allowlist).
- **Every stored field is listed.** A new column, Redis key family or log field must be added to
  `lib/data-inventory.ts` (DE + EN); `tests/data-inventory.test.ts` fails otherwise.
- **No IP addresses, user agents or emails** in our database, Redis or logs. Abuse limits key on
  route or account id; per-IP limits belong in the reverse proxy.
- **Ghost chat writes nothing:** browser storage is written only via `persist()` in
  `lib/persist.ts`. Chat switches go through `openChat()` / `ChatScope`.
- **Fail closed:** a configured but unreachable Postgres/Redis gives 503, never a memory fallback.
- **Tier and entitlements are server-side** and come from Stripe webhooks (re-read from Stripe)
  or manual ops entries, never from the client.
- **Untrusted model output:** assistant Markdown goes through `components/markdown.tsx` only (no
  raw HTML, images never auto-load).
- **CSP:** a new external origin (API, iframe, OAuth popup) must be added to `buildCsp()` in
  `middleware.ts`, with a test in `tests/csp.test.ts`.
- **Legal pages** (`app/impressum`, `app/datenschutz`, `app/agb`) keep their `<Todo>` markers until
  a lawyer has reviewed them. Never invent company details, addresses or register numbers.

## Where it runs (hiddensee.app)

- **Public:** `https://hiddensee.app`, an invite-only test (`INVITE_ONLY=1`, Stripe off). DNS is on
  Cloudflare; the apex is a CNAME to the Cloudflare Tunnel `private-ai`. No open ports.
- **Host:** the owner's home server (`ssh homeserver`, Tailscale only), Compose stack
  `/opt/stacks/private-ai`: `app`, `postgres`, `redis`, `cloudflared`. Source in `src/`, data in
  `data/`, secrets in `.env` (mode 600, generated on the box). Keep one copy of `.env` in the
  owner's password manager, off the box (`docs/backup-restore.md`): without it a lost box takes
  `SESSION_SECRET` (all sessions) and `ADMIN_KEY_KEK` (all stored provider keys) with it. Never put
  it in the repo, a PR or a chat. The box has its own rules in its README: read them before
  changing anything there.
- **Admin:** `/admin` and `/api/admin` sit behind the Cloudflare Access app "Hiddensee admin"
  (owner email only), then the app's passkey login and `ADMIN_ACCOUNT_IDS`.
- **Deploy an update** (the README's Upgrade steps, adapted; steps 1, 3 and 4 run on the box in
  `/opt/stacks/private-ai`, step 2 from a checkout):
  1. Back up: `(umask 077 && docker compose exec -T postgres pg_dump -U pai -Fc pai > data/pre-upgrade.dump)`
     and `docker tag private-ai:latest private-ai:previous`.
  2. `git fetch origin`, note the commit (`git rev-parse --short origin/main`), then replace the
     source as a whole, so files deleted upstream do not stay in the build:
     `git archive <commit> | ssh homeserver 'cd /opt/stacks/private-ai && rm -rf src.new src.old && mkdir src.new && tar -x -C src.new && mv src src.old && mv src.new src'`.
     `compose.yaml`, `.env` and `data/` live outside `src/` and are not touched.
  3. `docker compose up -d --build app`, then check `https://hiddensee.app/api/health` and that
     `docker compose logs app` shows a fresh start. Once the new version is confirmed (within 7
     days), `rm data/pre-upgrade.dump`: it still holds accounts deleted since.
  4. Rollback: `mv src src.bad && mv src.old src`, `docker tag private-ai:previous private-ai:latest`,
     `docker compose up -d --no-build app`. Restore the dump only if a migration since was not
     additive, and never straight into `pai`: accounts deleted after the dump would come back
     (GDPR Art. 17). With `P="docker compose exec -T postgres"`:
     - Preconditions, stop if either fails: the dump is the one from step 1 of this upgrade and at
       most 115 days old (the erasure ledger keeps 120, so older deletions are no longer listed):
       `find data/pre-upgrade.dump -mtime -115 | grep -q . || echo TOO OLD`; and no `pai_old` is left
       from an earlier restore: `$P psql -U pai -d postgres -Atc "select datname from pg_database where datname = 'pai_old'"`
       prints nothing (otherwise check that restore, then `$P dropdb -U pai pai_old`).
     - `docker compose stop app`;
       `(umask 077 && $P psql -U pai -d pai -Atc '\copy erasures to stdout' > data/erasures.tsv)`;
       `$P sh -c 'dropdb -U pai --if-exists pai_restore && createdb -U pai pai_restore'`;
       `$P pg_restore -U pai -d pai_restore --no-owner --no-acl --exit-on-error < data/pre-upgrade.dump`;
       `$P psql -U pai -d pai_restore -v ON_ERROR_STOP=1 -c 'create temp table incoming (id_hash text, deleted_on date)' -c '\copy incoming from pstdin' -c "$(cat src/scripts/reerase.sql)" < data/erasures.tsv`;
       `$P psql -U pai -d postgres -c 'ALTER DATABASE pai RENAME TO pai_old' -c 'ALTER DATABASE pai_restore RENAME TO pai'`;
       `rm -f data/erasures.tsv data/pre-upgrade.dump`; `docker compose up -d app`.
     - Check sign-in, then `$P dropdb -U pai pai_old` within 7 days, as `scripts/restore-db.sh` does
       (it runs these steps from restic snapshots, once off-site backups exist). If any step fails
       before the rename, `rm -f data/erasures.tsv` and `$P dropdb -U pai --if-exists pai_restore`.

  The Caddy setup (`deploy/caddy`) is for a Hetzner box and is not used here, so there are no
  per-IP limits.
- **Not yet:** off-site Postgres backups (`docs/backup-restore.md` needs a storage target).

## Workflow

- Tests first: write the failing test, then the fix (see existing tests for style).
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Branch off `main`; never push to `main` directly. Merges happen through PRs.

## Leak hygiene (mandatory)

Use the **repo-leak-scan** skill (`~/.claude/skills/repo-leak-scan`, slash commands `/leak-check`
and `/repo-leak-scan`):

1. **Before every commit:** the global pre-commit and commit-msg hooks run `leak-check`
   automatically. Never bypass them with `--no-verify`. If it blocks, fix the cause.
2. **Before every push / PR:** run `/leak-check --range origin/main...HEAD` (or
   `python3 ~/.claude/skills/repo-leak-scan/scripts/precommit.py . --range origin/main...HEAD`).
   It checks the diff, every commit message and every author/committer email.
3. **Before making the repo public, and after large merges:** run `/repo-leak-scan` (full history,
   all branches and PR text).

What it blocks, and what you must never put in a commit, PR, issue or file:

- secrets, keys, tokens, `.env` values (use env vars; `.env.example` holds empty placeholders only);
- **Claude conversation links** (`claude.ai/code/session_…`, `claude.ai/chat/…`, `claude.ai/share/…`),
  including `Claude-Session:` trailers;
- **guessed git identities:** git must have `user.email` set to a GitHub no-reply address
  (`<id>+<user>@users.noreply.github.com`). An unset email makes git use `user@<hostname>`, which
  leaks the machine and network;
- personal emails, phone numbers, IBANs, home-directory paths, wallet keys or mnemonics.
