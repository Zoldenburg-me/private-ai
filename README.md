# private-ai (working title)

Clean-room private AI chat by Zoldenburg UG. Feature goals are drawn from public descriptions of private-AI chat products. **.** All code is original (MIT-compatible deps only; see Licenses).

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
| phala | Phala Confidential AI | TEE, `provider.zdr` / `aci_verified` routing | https://inference.phala.com/v1 | |
| redpill | RedPill gateway | aggregates Phala/Tinfoil/NEAR/Chutes, signed receipts | env | |
| tinfoil | Tinfoil | TEE (SEV-SNP/TDX + NVIDIA CC) | env | |
| privatemode | Privatemode (Edgeless) | TEE, Contrast attestation, local proxy encrypts | env | |
| custom | any OpenAI-compatible | depends (ZDR by contract) | env | |

Configure in `.env.local` (copy `.env.example`). Never commit keys.

## Tiers (PROPOSAL placeholders, lib/tiers.ts)
| Tier | €/mo | Msgs/day | Context | Models |
|---|---|---|---|---|
| Free | 0 | 20 | 8k | basic |
| Pro | 15 | 1,000 | 128k | all |
| Max | 49 | unlimited (fair use) | 1M | all |

## Implemented (clean-room, see docs/venice-docs-study.md §6)
- **Model catalog** (`/api/models`, `/api/v1/models`): every model gets a privacy badge (TEE / PRIVATE / ANONYMIZED, plus E2EE). Launch policy: only TEE or zero-retention models can be selected, and the server enforces it with a 403.
- **Relay** (`lib/relay.ts`): never logs or stores content. The only logger is `lib/log.ts`, which accepts metadata fields only. The relay sends hashes of the upstream request and response as a `pai_receipt` SSE event.
- **Server-side tiers and fair use** (`lib/session.ts`, `lib/ratelimit.ts`): anonymous HMAC-signed session tokens, entitlements stored on the server, daily, per-minute and context limits, `x-ratelimit-*` and `x-usage-*` headers, and a budget of 20 errors per 30 s.
- **Enclave proof** (`lib/attestation.ts`): the client creates a nonce, then checks the echoed nonce, that the TDX debug bit is off, that `report_data` binds the signer and the nonce, and the GPU evidence nonce. It also checks the provider's response signature (EIP-191 recover → attested address, and the signed hashes must match our receipt). UI: "Verified enclave" and "signed by enclave".
  - **Not yet:** Intel DCAP certificate chain and TCB checks (dcap-qvl) and NVIDIA NRAS. Results carry `chainVerified: false`.
- **Encrypted backup** (`lib/backup.ts`): PBKDF2-SHA256 (310k) → AES-256-GCM in the browser; each export is decrypted once to check it before download.
- **Personas** (`lib/personas.ts`): stored in the browser, private by default.
- **OpenAI-compatible API**: `POST /api/v1/chat/completions` with `Authorization: Bearer <apiToken from /api/session>`, `model: "<provider>:<model>"`, and the extension `pai_options: { persona: { system_prompt }, web_search: false }`. Unknown fields are dropped.
- **Persistence** (`lib/store/`): `AccountStore` (Postgres via `postgres` + plain SQL in `migrations/`, applied automatically under an advisory lock) and `CounterStore` (Redis via `ioredis`, one atomic Lua call per request). In-memory implementations are used when `DATABASE_URL` / `REDIS_URL` are unset (dev/test). If a backend is configured but unreachable, requests **fail closed with 503**; production refuses the memory fallback unless `PAI_ALLOW_MEMORY_STORE=1`.
- **Passkeys** (`lib/passkey.ts`, `/api/auth/passkey/*`): optional upgrade of the anonymous account. The WebAuthn user handle is the opaque account id; logging in on another device issues a token for the same id, so the plan follows. Challenges live in Redis (5 min, single use). User verification (PIN/biometric) is required. Once an account has a passkey, adding or removing one and deleting the account need a passkey login from the last 5 minutes (step-up, bound to that account), so a copied session cookie alone cannot take the account over.
- **Account rights** (`lib/account-routes.ts`): `GET /api/account/export` returns everything stored server-side as JSON; `DELETE /api/account` deletes the Stripe customer(s) first (fails closed if Stripe is unreachable) and then the account row, which cascades. Both are in the sidebar under Account.
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
Sessions, plans and today's usage survive `docker compose restart` and `down`/`up` (volumes `pgdata`, `redisdata`; Redis uses AOF). On Hetzner, put Caddy or nginx with TLS in front and do not log client IPs there. Add a per-IP request limit in the proxy for `/api/session` and `/api/auth/passkey/login/*` (e.g. nginx `limit_req_zone $binary_remote_addr`, kept in memory only); the app itself never sees or stores IPs.

**Integration tests against real backends** (the store and rate-limit contract tests run against both memory and the real service):
```
docker compose up -d postgres redis   # or any Postgres 16 / Redis 7
TEST_DATABASE_URL=postgres://pai:<pw>@127.0.0.1:5432/pai_test TEST_REDIS_URL=redis://127.0.0.1:6379/1 npx vitest run
```
The Postgres/Redis ports are not published by the compose file; expose them locally (e.g. a `docker-compose.override.yml`) or use local servers.

**Stripe test mode:** create Pro/Max monthly + yearly prices, put the price ids in `STRIPE_PRICE_*`, then
`stripe listen --forward-to localhost:3000/api/billing/webhook` and copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
Enable the Customer Portal (cancel + plan switch) in the Stripe dashboard. Events used: `checkout.session.completed`, `customer.subscription.{created,updated,deleted,paused,resumed}`.

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
- [x] Self-service account export and deletion (incl. Stripe customer), passkey removal
- [x] Abuse limits on session minting and passkey login; CSP + HSTS; passkey user verification required
- [ ] Per-IP limits in the reverse proxy config (not in this repo yet)
- [ ] Session revocation (tokens are deterministic per account; a leaked cookie stays valid, and after account deletion an old token can still start a new, empty account with the same id)
- Note: passkeys are now registered and verified with user verification required; a passkey created earlier without PIN/biometric can no longer log in.
- [ ] Payments via crypto (x402 / Zold) as an accountless alternative
- [ ] DCAP quote chain + NVIDIA NRAS verification (dcap-qvl wasm)
- [ ] Model picker from provider /models, image gen, doc upload
- [ ] Zero-access encrypted sync (P3 in docs/venice-lumo-integration-plan.md), now that persistence exists
- [ ] CI job running the integration tests against Postgres/Redis services
- [ ] Brand

## Licenses
Dependencies: next (MIT), react/react-dom (MIT), postgres (Unlicense, public-domain dedication), ioredis (MIT), @simplewebauthn/server + /browser (MIT), stripe (MIT), react-markdown (MIT), remark-gfm (MIT), @noble/* (MIT); dev: typescript (Apache-2.0), vitest (MIT). Next itself pulls in sharp/libvips (LGPL-3.0, optional image optimisation, dynamically linked) and caniuse-lite (CC-BY-4.0). No third-party UI code copied; nothing from Proton Lumo (GPLv3) or Venice.

## Clean-room observation and REA
`docs/lumo-docs-study.md` (Proton Lumo) and `docs/venice-lumo-integration-plan.md` (prioritised work items from both studies) follow the same public-docs method. `docs/code-study-summary.md` summarises the architecture of Lumo's GPLv3 web client and Venice's MIT repos. It is written in our own words and copies no code; Venice's closed web app was not touched. `docs/spec-from-observation.md` is the feature spec, built only from public pages and docs. [REA](https://github.com/morluto/rea) (MIT) is a reverse-engineering MCP and CLI. Its bundle, decompile and traffic tools must **not** be used on third-party products here. We use it only as a browser-scenario harness against our own app (`tests/e2e/rea-own-app-scenario.json`). No REA code is vendored.
