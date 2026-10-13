# private-ai (working title)

Clean-room private AI chat by Zoldenburg UG. Feature goals are drawn from public descriptions of private-AI chat products. **No third-party proprietary code, assets or branding is used.** All code is original (MIT-compatible deps only; see Licenses).

## Architecture
```
Browser (Next.js client)
  ├─ chat history in localStorage only (lib/storage.ts), wipe button
  └─ POST /api/chat ──► Next.js route (no body logging, no DB)
                          ├─ tier/usage gate stub (lib/tiers.ts)
                          └─ provider abstraction (lib/providers.ts)
                               └─ OpenAI-compatible /chat/completions, stream=true
                                    ├─ NEAR AI Cloud (default, TEE + attestation)
                                    ├─ Phala / RedPill / Tinfoil / Privatemode
                                    └─ custom endpoint
```

## Privacy model
- **No server-side chat storage**: conversations live only in the user's browser.
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
- **Mock enclave provider** (`MOCK_PROVIDER=1`, dev and test only) for tests and the REA e2e run (`tests/e2e/`).

## Dev
```
npm install
cp .env.example .env.local   # add NEAR_AI_API_KEY
npm run dev
npm test && npm run typecheck
```

## TODO
- [ ] Persist sessions, entitlements and counters (Redis/DB); passkey or wallet login
- [ ] DCAP quote chain + NVIDIA NRAS verification (dcap-qvl wasm)
- [ ] Payments: Stripe subscriptions or crypto via Zold
- [ ] Usage counters (count only, no content)
- [ ] Optional encrypted backup (client-side keys)
- [ ] Markdown rendering, model picker from provider /models, image gen, doc upload
- [ ] Brand, legal (Impressum, Datenschutz, AGB), DSGVO review

## Licenses
Dependencies: next (MIT), react/react-dom (MIT), typescript (Apache-2.0), vitest (MIT). No third-party UI code copied.

## Clean-room observation and REA
`docs/spec-from-observation.md` is the feature spec, built only from public pages and docs. [REA](https://github.com/morluto/rea) (MIT) is a reverse-engineering MCP and CLI. Its bundle, decompile and traffic tools must **not** be used on third-party products here. We use it only as a browser-scenario harness against our own app (`tests/e2e/rea-own-app-scenario.json`). No REA code is vendored.
