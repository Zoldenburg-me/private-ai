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
- `lib/billing*.ts` Stripe, `lib/passkey*.ts` WebAuthn, `lib/account-routes.ts` export/delete,
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
