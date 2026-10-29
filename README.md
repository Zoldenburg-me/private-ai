# Hiddensee

Clean-room private AI chat by Zoldenburg UG. Feature goals are drawn from public descriptions of private-AI chat products. All code is original (MIT-compatible deps only; see Licenses).

## Architecture
```
Browser (Next.js client)
  ├─ chat history in localStorage only (lib/storage.ts), every write via lib/persist.ts (ghost gate)
  ├─ optional passkey (WebAuthn) → same opaque account on other devices
  └─ POST /api/chat ──► Next.js route (no body logging)
                          ├─ session + entitlement (lib/session.ts) ──► Postgres: ids, tier, timestamps
                          ├─ fair-use gate (lib/ratelimit.ts) ──────► Redis: counters (atomic Lua)
                          └─ provider abstraction (lib/providers.ts)
                               └─ OpenAI-compatible /chat/completions, stream=true
                                    ├─ NEAR AI Cloud (default, TEE + attestation)
                                    ├─ Phala / RedPill / Tinfoil / Privatemode
                                    └─ custom endpoint
Stripe Checkout / Portal ──webhook──► /api/billing/webhook ──► entitlement (Postgres)
```

## Privacy model
- **No server-side chat storage**: conversations live only in the user's browser. Ghost chats are not stored even there.
- **Server-side data is metadata only**: opaque account ids, tier, timestamps, counters, Stripe ids, passkey public keys. No IPs, no user agents, no email. The full list is generated at `/privacy/metadata` and checked against the schema by a test.
- **No content logging**: `/api/chat` streams upstream bytes through; never log bodies.
- **TEE inference**: default provider runs models in Intel TDX + NVIDIA CC enclaves with attestation.
- Caveat: our Next.js server still sees plaintext in transit (it holds the provider key). Roadmap: run the proxy itself in a TEE (e.g. Phala dstack) and/or expose attestation verification + E2EE to the client.

## Providers
| id | Provider | Privacy | Base URL | Notes |
|---|---|---|---|---|
| near | NEAR AI Cloud | TEE (TDX + NVIDIA CC), attestation per response | https://cloud-api.near.ai/v1 | per-token, no subscription |
| phala | Phala Confidential AI | TEE only for models its `/models` routes to Phala alone (`phalaOnly` in `lib/catalog.ts`) | https://inference.phala.com/v1 | |
| redpill | RedPill gateway | aggregates Phala/Tinfoil/NEAR/Chutes, signed receipts | env | |
| tinfoil | Tinfoil | TEE (SEV-SNP/TDX + NVIDIA CC) | env | |
| privatemode | Privatemode (Edgeless) | TEE, attestation verified and requests encrypted by the privatemode-ai SDK on our server | https://api.privatemode.ai/v1 | chat models only (task `generate`); Auto route for GLM 5.3 |
| custom | any OpenAI-compatible | depends (ZDR by contract) | env | |

Configure in `.env.local` (copy `.env.example`). Never commit keys.

## Tiers (lib/tiers.ts)
| Tier | €/mo | Max Privacy/day | Top Max/day | Private & Incognito/day | Frontier credit/mo | Context | Agent steps |
|---|---|---|---|---|---|---|---|
| Free | 0 | 20 | 0 | 50 | €0 | 8k | 3 |
| Plus | 8 | 300 | 10 | 300 | €1 | 32k | 5 |
| Pro | 15 | 1,000 | 25 | 1,000 | €2 | 128k | 8 |
| Max | 49 | 5,000 | 100 | 5,000 | €8 | 1M | 15 |

## Implemented
- **Model catalog** (`/api/models`, `/api/v1/models`): every model gets a privacy badge (TEE / PRIVATE / ANONYMIZED, plus E2EE). Policy: TEE and zero-retention models can be selected, plus anonymized frontier models (GPT, Claude, Gemini) through the Venice gateway (`VENICE_*`), which are never the default and show "No enclave" instead of an enclave proof. Any other model is blocked, and the server enforces it with a 403.
- **Relay** (`lib/relay.ts`): never logs or stores content. The only logger is `lib/log.ts`, which accepts metadata fields only. The relay sends hashes of the upstream request and response as a `pai_receipt` SSE event.
- **Server-side tiers and fair use** (`lib/session.ts`, `lib/ratelimit.ts`): anonymous HMAC-signed session tokens, entitlements stored on the server, daily, per-minute and context limits, `x-ratelimit-*` and `x-usage-*` headers, and a budget of 20 errors per 30 s.
- **Enclave proof** (`lib/attestation.ts`): the client creates a nonce, then checks the echoed nonce, that the TDX debug bit is off, that `report_data` binds the signer and the nonce, and the GPU evidence nonce. It also checks the provider's response signature (EIP-191 recover → attested address, and the signed text must be our receipt's `req:resp` hashes, or NEAR's `model:req:resp` naming the model we called). UI: "Enclave attested", with the checks that did not run listed in the proof drawer, and, per reply, "Signed by enclave key". "Verified" and "Signed in the enclave" are shown only once the Intel/NVIDIA certificate chain is verified, which the app does not do yet.
  - **Not yet:** Intel DCAP certificate chain and TCB checks (dcap-qvl) and NVIDIA NRAS. Results carry `chainVerified: false`.
- **Encrypted backup** (`lib/backup.ts`): PBKDF2-SHA256 (310k) → AES-256-GCM in the browser; each export is decrypted once to check it before download.
- **Personas** (`lib/personas.ts`): stored in the browser, private by default.
- **OpenAI-compatible API**: `POST /api/v1/chat/completions` with `Authorization: Bearer <apiToken from /api/session>`, `model: "<provider>:<model>"`, and the extension `pai_options: { persona: { system_prompt }, web_search: false }`. Unknown fields are dropped.
- **Agent mode (web search)**: the web app's "Web search" toggle posts to `POST /api/agent` with `pai_options.web_search: true`. The server runs a tool loop: the model may call `web_search` (Brave Search API, only the query text is sent), up to the tier's step limit (free 3, pro 8, max 15), each step counted against the rate limit. Off unless `BRAVE_SEARCH_API_KEY` is set; under the invite gate it needs an account.
- **Persistence** (`lib/store/`): `AccountStore` (Postgres via `postgres` + plain SQL in `migrations/`, applied automatically under an advisory lock) and `CounterStore` (Redis via `ioredis`, one atomic Lua call per request). In-memory implementations are used when `DATABASE_URL` / `REDIS_URL` are unset (dev/test). If a backend is configured but unreachable, requests **fail closed with 503**; production refuses the memory fallback unless `PAI_ALLOW_MEMORY_STORE=1`.
- **Passkeys** (`lib/passkey.ts`, `/api/auth/passkey/*`): the first passkey turns the anonymous account into a real one. The WebAuthn user handle is the opaque account id. Every passkey sign-in (and the first registration) gives that browser its own device token (`pai_<account>.<device>.<hmac>`, `devices` table), valid only while its row exists: `POST /api/auth/signout` and removing a device under Settings → Account revoke it. Once an account has a passkey or a device, its anonymous token stops working, so plan, usage and passkeys follow the account, not the browser. Challenges live in Redis (5 min, single use). User verification (PIN/biometric) is required. Once an account has a passkey, adding or removing one and deleting the account need a passkey login from the last 5 minutes (step-up, bound to that account), so a copied session cookie alone cannot take the account over.
- **Account rights** (`lib/account-routes.ts`): `GET /api/account/export` returns everything stored server-side as JSON; `DELETE /api/account` deletes the Stripe customer(s) first (fails closed if Stripe is unreachable) and then the account row, which cascades. Both are under Settings → Account.
- **Abuse limits** (`lib/limits.ts`): anonymous tokens are minted without a database write (the row appears on first use); new sessions, passkey logins and per-account actions are capped with Redis counters keyed by route or account id, never by IP (`PAI_LIMIT_*` in `.env.example`). Per-client limits belong in the reverse proxy. Trade-off of not using IPs: one client can exhaust the global new-session or anonymous passkey-login bucket and briefly block those for everyone; signed-in account actions (including step-up logins) use per-account buckets and are not affected.
- **Security headers** (`middleware.ts`): per-request nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, same-origin `connect-src`/`img-src`, `frame-ancestors 'none'`), HSTS in production. Pages therefore render dynamically.
- **Stripe subscriptions** (`lib/billing.ts`, `/api/billing/*`): Checkout for Pro/Max monthly or yearly, signed webhook that re-reads the subscription and sets/clears the entitlement, Customer Portal for cancel/manage. Only customer/subscription ids + status are stored.
- **Ghost chat**: toggle in the UI; `persist()` is the only source of a `Writer`, and every storage write function requires one, so ghost mode cannot write by construction (type-checked and tested).
- **Markdown** (`components/markdown.tsx`): react-markdown + remark-gfm, no raw HTML, images rendered as links (never loaded), links `rel="noopener noreferrer"`.
- **Legal**: `/impressum`, `/datenschutz`, `/agb`, `/privacy/metadata` in German and English, with TODO markers for lawyer review. Inactive accounts are purged after 365 days (`lib/retention.ts`).
- **Deployment**: multi-stage `Dockerfile` (standalone output, non-root), `docker-compose.yml` with Postgres + Redis, `/api/health`.
- **Mock enclave provider** (`MOCK_PROVIDER=1`, dev and test only) for tests and the REA e2e run (`tests/e2e/`).

## Dev
```
npm install
cp .env.example .env.local   # add NEAR_AI_API_KEY (or MOCK_PROVIDER=1 for the mock enclave)
npm run dev                  # no DATABASE_URL / REDIS_URL -> in-memory stores
npm test && npm run typecheck
```

**With Postgres + Redis (same as production):**
```
cp .env.example .env         # set SESSION_SECRET (>= 32 chars), POSTGRES_PASSWORD, provider keys,
                             # WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, APP_URL, STRIPE_* (test mode)
docker compose up -d --build # app on 127.0.0.1:${APP_PORT:-3000}, migrations run on first request
curl localhost:3000/api/health
```
Sessions, plans and today's usage survive `docker compose restart` and `down`/`up` (volumes `pgdata`, `redisdata`; Redis uses AOF).

**Production:** `hiddensee.app` runs on the owner's home server behind a Cloudflare Tunnel, with no open ports and no Caddy. `AGENTS.md` ("Where it runs") has the stack and the deploy steps.

**Public VPS with Caddy (not used in production):** the `caddy` service (`deploy/caddy/`, compose profile `proxy`) is the only public entry. Point DNS at the box and set in `.env`:
```
DOMAIN=chat.example.com
WEBAUTHN_RP_ID=chat.example.com
WEBAUTHN_ORIGIN=https://chat.example.com
APP_URL=https://chat.example.com
```
Open TCP 80 and 443, and UDP 443 (HTTP/3; no other UDP port is needed), then `docker compose --profile proxy up -d --build`. Caddy gets the certificate automatically (volume `caddydata`). It runs on the host network, so it sees the real client IP, and proxies to the app on `127.0.0.1:${APP_PORT:-3000}`; the app is never published on a public interface. Its admin API is off: after editing the Caddyfile, rebuild and restart the container.
- **No client IPs in logs:** Caddy writes no access log; IPs, ports and request headers are stripped from its error lines, and `X-Forwarded-For`, `X-Real-IP` and `Forwarded` are not passed to the app, so the app never sees an IP.
- **Per-client limits** (in Caddy's memory only, reset on restart): `/api/session` 60/min, `/api/auth/passkey/login/*` 60/min, answered with 429. IPv4 is limited per address, IPv6 per /64 (a host can rotate through its whole /64; `tests/caddy-ratelimit-key.test.ts` checks the key). Users behind one NAT, CGNAT or Tor exit share a limit. These sit in front of the app's global limits (`PAI_LIMIT_*`); change them in `deploy/caddy/Caddyfile` and rebuild.
- **Check the config:** `docker compose --profile proxy build caddy && docker compose --profile proxy run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile` (CI runs the same).
- **After the first deploy, check that Caddy sees real IPs and logs none:** temporarily add `respond /whoami "{remote_host}"` at the top of the site block, rebuild, and run `curl -4 https://chat.example.com/whoami` and `curl -6 https://chat.example.com/whoami` from outside (IPv6 if the box has an AAAA record). Each must print your own public address, not a `172.x` or `fe80::` Docker address. Remove the line again and rebuild. Then `docker compose logs caddy | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f]{0,4}::[0-9a-f:]+|([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}' | sort -u` must print nothing but `127.0.0.1` (the upstream app); look at any other hit by eye.

**Production image (`Dockerfile`):** Node 24 (`node:24.x-bookworm-slim`, pinned by digest; the comment in the
Dockerfile says how to bump it), Next standalone output, runs as the unprivileged `node` user (uid 1000) with
`NODE_ENV=production`, npm/corepack removed from the runtime image, no source maps, no secrets in any layer (`.env` is in
`.dockerignore`; all config comes from the environment at run time). Compose runs it read-only with all
capabilities dropped. CI (`image` job) builds it on every PR and runs `scripts/smoke-image.sh` against Postgres 16 and
Redis 7; run that script yourself before a release if you change the image.

| Variable | Required in production | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes, >= 32 chars | Signs session tokens. Changing it signs everyone out. |
| `DATABASE_URL`, `REDIS_URL` | yes (compose sets both) | Accounts/plans in Postgres, counters/limits in Redis. Unset = refused (503) unless `PAI_ALLOW_MEMORY_STORE=1`. |
| `POSTGRES_PASSWORD` | yes (compose) | Builds `DATABASE_URL` and initialises the `postgres` service. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | yes | Passkeys; the public host name and `https://` origin. |
| `APP_URL` | yes, with Stripe | Stripe return URLs. |
| `ADMIN_KEY_KEK` | for stored provider keys | 32 random bytes, base64. Only in `.env`. |
| `ADMIN_ACCOUNT_IDS` | for `/admin` | Account ids allowed into the admin panel. |
| `INVITE_CODES` / `INVITE_ONLY` | in production (boot fails without) | Signup gate (see below). |
| `NEAR_AI_API_KEY` etc., `DEFAULT_PROVIDER` | at least one provider | Inference providers (`.env.example` lists all). |
| `STRIPE_*` | for payments | Secret key, webhook secret, price ids. |
| `DOMAIN` | only with Caddy (VPS) | Public host name for TLS. |
| `PAI_AUTO_MIGRATE`, `PAI_RETENTION_JOB`, `PAI_COLLATERAL_PREFETCH`, `PAI_LOG`, `PAI_LIMIT_*` | no | Defaults are fine (see `.env.example`). |

- **Boot checks:** the server exits with code 1 and a one-line `boot check failed: …` message (the setting's name,
  never its value) if `SESSION_SECRET` is missing or short, `ADMIN_KEY_KEK` is set but not 32 bytes, or
  `MOCK_PROVIDER=1`. Compose's restart policy then retries it; `docker compose logs app` shows the reason.
- **Migrations:** `migrations/*.sql` are applied in order on the first database use after start, inside one
  transaction under a Postgres advisory lock, so several replicas starting at once are safe and each file runs once
  (`schema_migrations`). To run them yourself, set `PAI_AUTO_MIGRATE=0`, create the ledger once with
  `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  then apply the files in order with `psql` and insert each file name into it. Migrations are forward-only.
- **Health:** `GET /api/health` answers 200 only when Postgres and Redis answer, otherwise 503 (no details). The image's
  `HEALTHCHECK` polls it every 15 s; on a VPS, Caddy waits for `healthy` before starting.
- **Shutdown:** `docker compose stop` sends SIGTERM; the server stops accepting connections, finishes open requests
  and exits 0 (Docker kills it after 10 s by default).
- **Upgrade:** take a backup (`scripts/backup-db.sh`, runbook `docs/backup-restore.md`), keep the current image as
  `docker tag private-ai:latest private-ai:previous`, then `git pull && docker compose up -d --build app` and check
  `curl -fsS 127.0.0.1:3000/api/health`.
- **Rollback:** `docker tag private-ai:previous private-ai:latest && docker compose up -d --no-build app`. An older image
  runs against the newer schema only if the migrations since were additive; otherwise restore the backup taken before
  the upgrade.

**Integration tests against real backends** (the store and rate-limit contract tests run against both memory and the real service):
```
docker compose up -d postgres redis   # or any Postgres 16 / Redis 7
TEST_DATABASE_URL=postgres://pai:<pw>@127.0.0.1:5432/pai_test TEST_REDIS_URL=redis://127.0.0.1:6379/1 npx vitest run
```
The Postgres/Redis ports are not published by the compose file; expose them locally (e.g. a `docker-compose.override.yml`) or use local servers.

**Stripe test mode:** create Pro/Max monthly + yearly prices, put the price ids in `STRIPE_PRICE_*`, then
`stripe listen --forward-to localhost:3000/api/billing/webhook` and copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
Enable the Customer Portal (cancel + plan switch) in the Stripe dashboard. Events used: `checkout.session.completed`, `customer.subscription.{created,updated,deleted,paused,resumed}`.

**Invite-only signup:** set `INVITE_CODES=code1,code2` (long random strings, e.g. `openssl rand -hex 12`). The first
passkey (account creation) asks for a code; logins and extra passkeys do not. Codes are shared and reusable; remove one
from INVITE_CODES and restart to revoke it (a signup already started with it can still finish within 5 minutes). While the gate is on, signed-out visitors can still
chat in the web app (ghost chat, nothing saved) with the free TEE models only, under one instance-wide cap (`PAI_LIMIT_ANON_CHATS_PER_MIN`, default 10, never per IP); the API (`/api/v1`) needs a signed-in
passkey account. Panel codes count a use only when the passkey is created, so a cancelled prompt spends nothing. Code attempts are capped instance-wide before the code is checked, so a correct guess past the cap is refused too (`PAI_LIMIT_INVITE_FAILS_PER_MIN`, default 30).

**Admin panel (`/admin`):** operators only, not linked from the site and `noindex`. Set `ADMIN_ACCOUNT_IDS` to the
account ids (Settings → Account) allowed in; they sign in with that account's passkey and get a separate 2-hour
`pai_admin` cookie (scoped to `/api/admin`). Removing an id from the list ends its session on the next request. Every
write (plan, device sign-out, account delete, keys, invites) needs a fresh passkey confirmation, and every action is
written to the audit log (admin id, action, target, time; no IPs or secrets; kept 365 days). Admin API calls are
limited per admin (`PAI_LIMIT_ADMIN_PER_MIN`, default 120) and admin logins instance-wide (`PAI_LIMIT_ADMIN_LOGINS_PER_MIN`, 30). The login
limit is shared by everyone, so a flood of login attempts can delay an admin sign-in for up to a minute; on a VPS, Caddy's per-IP
limits blunt that (the home server has none), and an existing admin session is not affected. An account listed in `ADMIN_ACCOUNT_IDS` cannot be
deleted from the panel; remove it from the list first.
- *Users:* search by account id prefix; see plan, Stripe status, usage, passkey count and devices; sign out a device;
  set or clear a **manual** plan (Stripe plans stay with the webhooks); delete an account through the same erasure
  path as the user's own delete (Stripe first, then the account, recorded in the erasure ledger).
- *Provider keys:* set `ADMIN_KEY_KEK` (`openssl rand -base64 32`; keep it only in `.env`, never in the database or
  backups' reach). Keys are stored AES-256-GCM encrypted and shown afterwards only as their last 4 characters.
  **The stored key wins:** a provider with an active stored key uses it; without one it uses its env key
  (`<PREFIX>_API_KEY`). Saving a new key rotates (the old one is disabled). A stored key that cannot be decrypted
  (KEK missing or changed) switches that provider off rather than falling back to env; to retire stored keys, disable
  or remove them. New providers in `lib/providers.ts` (e.g. Venice) appear in the panel automatically. Other app
  instances pick up a change within 30 seconds.
- *Invites:* codes created in the panel are shown once, stored only as a hash, have a use limit and can be revoked.
  They are accepted alongside `INVITE_CODES` (which stay env-only and read-only in the panel). They never switch the gate
  on by themselves: set `INVITE_CODES` or `INVITE_ONLY=1`. Next to a new code, "Copy invite link" copies
  `https://<host>/chat#invite=<code>`: the code sits in the URL fragment, which browsers never send to the server, and
  /chat keeps it in memory only and fills it in at signup (a rejected code falls back to the prompt).

**Pro for testers:** run Stripe in test mode (above) and let testers check out with card `4242 4242 4242 4242`; the
webhook grants Pro like a real payment. To comp one account without Checkout, add its full id (Settings → Account →
Export, `account.id`) to `ENTITLEMENTS='{"<account id>":"pro"}'` and restart.

**Passkeys locally:** `http://localhost` is a secure context, so passkeys work in dev without TLS. In production `WEBAUTHN_RP_ID` (e.g. `chat.example.com`) and `WEBAUTHN_ORIGIN` (`https://chat.example.com`) are required.

## TODO
- [x] Persist sessions, entitlements and counters (Postgres + Redis, fail closed)
- [x] Passkey login (optional, no email)
- [x] Payments: Stripe subscriptions (Pro/Max, monthly + yearly, portal)
- [x] Usage counters (count only, no content)
- [x] Optional encrypted backup (client-side keys)
- [x] Ghost chat, Markdown rendering
- [x] Legal page drafts (Impressum, Datenschutz, AGB, stored-metadata list)
- [ ] **Lawyer review** of all `TODO` markers on the legal pages (Widerrufsrecht, Haftung, Stripe/Hetzner/provider DPAs, third-country transfers); fill in company details
- [x] Self-service account export and deletion (incl. Stripe customer), passkey removal, sign-out and device removal
- [x] Abuse limits on session minting and passkey login; CSP + HSTS; passkey user verification required
- [x] Reverse proxy config for a public VPS (Caddy, auto TLS, per-IP limits in memory, no IP logs)
- [ ] Session revocation (tokens are deterministic per account; a leaked cookie stays valid, and after account deletion an old token can still start a new, empty account with the same id)
- Note: passkeys are now registered and verified with user verification required; a passkey created earlier without PIN/biometric can no longer log in.
- [ ] Payments via crypto (x402 / Zold) as an accountless alternative
- [ ] DCAP quote chain + NVIDIA NRAS verification (dcap-qvl wasm)
- [ ] Model picker from provider /models, image gen, doc upload
- [ ] Zero-access encrypted sync, now that persistence exists
- [x] CI job running the integration tests against Postgres/Redis services
- [ ] Brand

## Licenses
Dependencies: next (MIT), react/react-dom (MIT), postgres (Unlicense, public-domain dedication), ioredis (MIT), @simplewebauthn/server + /browser (MIT), stripe (MIT), react-markdown (MIT), remark-gfm (MIT), @noble/* (MIT); dev: typescript (Apache-2.0), vitest (MIT). Next itself pulls in sharp/libvips (LGPL-3.0, optional image optimisation, dynamically linked) and caniuse-lite (CC-BY-4.0). All code is original.

