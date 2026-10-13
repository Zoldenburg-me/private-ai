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

## Dev
```
npm install
cp .env.example .env.local   # add NEAR_AI_API_KEY
npm run dev
npm test && npm run typecheck
```

## TODO
- [ ] Accounts (privacy-preserving: email-less / passkey / wallet) and server-verified entitlements (gate currently trusts client!)
- [ ] Payments: Stripe subscriptions or crypto via Zold
- [ ] Usage counters (count only, no content)
- [ ] Client-side attestation verification UI (NEAR/RedPill receipts)
- [ ] Optional encrypted backup (client-side keys)
- [ ] Markdown rendering, model picker from provider /models, image gen, doc upload
- [ ] Brand, legal (Impressum, Datenschutz, AGB), DSGVO review

## Licenses
Dependencies: next (MIT), react/react-dom (MIT), typescript (Apache-2.0), vitest (MIT). No third-party UI code copied.
