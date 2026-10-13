# Venice API docs study (clean-room notes)

Read on 2026-10-13 from docs.venice.ai and a read-only clone of github.com/veniceai/api-docs. That repo has **no license**, so everything here is our own summary. We quote no passages and copy no code. Facts are paraphrased and each one cites its source page. This document is for understanding the product only; implementation stays clean-room.

Key sources:
- Privacy: https://docs.venice.ai/overview/privacy
- TEE/E2EE: https://docs.venice.ai/guides/features/tee-e2ee-models
- Pricing: https://docs.venice.ai/overview/pricing
- Models: https://docs.venice.ai/models/overview
- Rate limits: https://docs.venice.ai/api-reference/rate-limiting
- VVV/DIEM: https://docs.venice.ai/overview/vvv-diem
- x402: https://docs.venice.ai/guides/integrations/x402-venice-api
- Characters: https://docs.venice.ai/guides/features/characters
- API spec: https://docs.venice.ai/api-reference/api-spec (swagger.yaml in the repo)

## 1. Architecture and privacy model
- **Proxy for everything.** All traffic goes through Venice's proxy over TLS. The proxy does not store prompt or response content. It does keep operational metadata: account or wallet id, key id, timestamps, model, token counts, cost, rate-limit state, IP, device info and product events. *(privacy)*
- **Four privacy levels per model**, set at the runtime layer:
  1. **Anonymized:** an upstream provider (e.g. Claude, Gemini, GPT) sees the prompt but not who sent it.
  2. **Private:** zero data retention, enforced by contract.
  3. **TEE:** the model runs in an Intel TDX + NVIDIA confidential-computing enclave with remote attestation.
  4. **E2EE:** the client encrypts the prompt for an attested enclave, and Venice only relays ciphertext.
- **Model catalog privacy fields.** `/models` exposes `model_spec.privacy` (anonymized or private) and capability flags (`supportsTeeAttestation`, `supportsE2EE`). TEE and E2EE models share an `e2ee-` id prefix, and the request flow decides which mode applies. Text models only. *(privacy, tee-e2ee)*
- **Attestation.** `GET /tee/attestation?model=&nonce=` takes a 32-byte client nonce. It returns:
  - a server-side verified flag
  - the echoed nonce
  - the TEE provider
  - the raw Intel TDX quote
  - an NVIDIA payload
  - an enclave signing public key and the Ethereum-style address derived from it

  Venice recommends verifying on the client: parse the TDX quote, check the NVIDIA evidence, confirm the nonce matches, and **reject debug-mode enclaves**. *(tee-e2ee)*
- **Response signatures.** `GET /tee/signature?model=&request_id=` returns the enclave's signature over a completion, which can be checked against the attested signing address. *(tee-e2ee)*
- **E2EE flow** (summary):
  1. The client creates an ephemeral secp256k1 key pair per session.
  2. It fetches attestation with a nonce and checks the nonce, the non-debug flag and the evidence. It takes the model's public key from there.
  3. For each message: ECDH shared secret → HKDF-SHA256 → AES-256-GCM. The ciphertext is packed as the sender's ephemeral pubkey + nonce + tag + data, hex-encoded.
  4. **Every** user and system message must be encrypted; any plaintext in those roles is rejected.
  5. Headers carry the client pubkey, the model pubkey and the signing algorithm.
  6. Streamed chunks come back encrypted to the client key, and the client decrypts them.
  7. Anything that needs plaintext outside the enclave is disabled in this mode: web search, memory, summaries and some tools. *(tee-e2ee, privacy)*
- **What this implies about their stack:** some TEE models appear to run on Phala/dstack, according to the third-party directory confidentialinference.net. That matches what we saw in our own provider research.

## 2. API surface
- Base URL `https://api.venice.ai/api/v1`, OpenAI-compatible, Bearer API key. *(quick-start, openai-migration guide)*
- **Endpoint groups** (from swagger.yaml paths):
  - **Text:** `/chat/completions`, `/responses`
  - **Images:** `/image/generate`, `/images/generations` (OpenAI-style), `/image/styles`, `/image/upscale`, `/image/edit`, `/image/multi-edit`, `/image/background-remove`
  - **Audio:** `/audio/speech`, `/audio/transcriptions`, `/audio/voices`, plus queued music and voice-changer jobs with `quote`, `queue`, `retrieve` and `complete` steps
  - **Video:** jobs with the same `quote`, `queue`, `retrieve` and `complete` steps, plus `/video/transcriptions`
  - **Embeddings:** `/embeddings`
  - **Models:** `/models`, `/models/traits`, `/models/compatibility_mapping`
  - **Characters:** `/characters`, `/characters/{slug}`, `/characters/{slug}/reviews`
  - **Augment:** `/augment/search`, `/augment/scrape`, `/augment/text-parser`
  - **Keys and billing:** `/api_keys` (CRUD, rate limits and logs, `generate_web3_key`), `/billing/balance`, `/billing/usage`, `/billing/usage-analytics`, `/billing/usage-history`
  - **Crypto:** `/crypto/rpc/networks`, `/crypto/rpc/{network}`, `/x402/top-up`, `/x402/balance/{wallet}`, `/x402/transactions/{wallet}`
  - **Misc:** `/decisions`, `/systemone`
- **Standard OpenAI parameters** (messages, temperature, top_p, max tokens, stream, tools / function calling, response_format / structured output, vision inputs, reasoning), plus prompt caching with cache-read and cache-write pricing. *(guides/features/*)*
- **`venice_parameters` extension object** (sent via `extra_body` in the OpenAI SDKs). Fields include:
  - `character_slug`
  - `enable_web_search`, `enable_web_scraping`, `enable_web_citations`, `include_search_results_in_stream`
  - `include_venice_system_prompt`
  - `strip_thinking_response`, `disable_thinking`

  Options can also be passed as suffixes on the model name (the "model feature suffix" page). *(swagger.yaml, chat/model_feature_suffix)*
- **Characters API (preview):** public personas, each with a slug and a default model. Apply one per request with `character_slug`. *(characters)*

## 3. Model catalog and privacy tiers
- About 379 models in total. Of the 126 text models: about 59 Anonymized (proxied Claude, Gemini, GPT and similar frontier models), about 55 Private (open-weight models with zero retention) and 12 E2EE+Private. Each text model has a size class (XS, S, M or L) that sets its rate limits. *(models/overview)*
- Example prices per 1M tokens, in/out:
  - DeepSeek V4 Flash (Private): $0.13–0.14 / $0.26–0.28
  - E2EE DeepSeek V4 Flash: $0.18 / $0.37, so roughly a 30% premium for TEE/E2EE
  - Claude Sonnet 5.5 (Anonymized): $2.50 / $12.50
  - Claude Opus 5.x: $4.80–6.00 / $24–30
  - Some models cost more above a context threshold (e.g. above 100K or 200K tokens). *(pricing)*
- The catalog is reachable from code: `/models` gives capabilities and constraints, pricing in both USD and DIEM, and beta and offline flags. *(models/list, veniceai/skills)*

## 4. Pricing, credits, tiers and rate limits
- **Consumer plans** (website): Free, Pro $18, Pro+ $68 (7,500 credits a month, two-month banking), Max $200 (22,500 credits, three-month banking). Pro includes 100 credits a month for video, music, premium models and the API. *(venice.ai/pricing, blog/new-subscription-tiers)*
- **API funding order:** DIEM first, then bundled credits, then USD. USD and crypto credits never expire. *(vvv-diem)*
- **Rate limits per model size**, requests per minute / tokens per minute:
  - XS: 500 / 5M
  - S: 150 / 3M
  - M and L: 100 / 2M
  - Image: 20 rpm. Speech: 60 rpm.
  - Video and music aren't rate-limited, only billed.
  - Partner tier: roughly double.
- **Error budgets:** more than 50 failed requests, or more than 200 requests for unsupported features, per 30 s per model per key gives a 429.
- **Headers:** `x-ratelimit-*` tells clients their remaining requests and tokens.
- **Per-key spending caps** are available, in USD or DIEM. *(rate-limiting, vvv-diem)*

## 5. Payments
- **VVV/DIEM (Base):**
  - Stake VVV → get sVVV → lock it at a rising "mint rate" to mint DIEM.
  - Staking DIEM gives $1 of credit per DIEM per day. The allowance resets at 00:00 UTC, unused credit doesn't roll over, and the minimum is 0.1.
  - Unstaking DIEM takes 1 day. Unlocking sVVV takes 7 days after burning the DIEM.
  - The wallet is linked through Sign-In-With-Ethereum. Agents can mint API keys from a wallet with staked VVV (`generate_web3_key`). *(vvv-diem)*
- **x402 (no account, no key):**
  - Every request carries a fresh Sign-In-With-X header: SIWE/EIP-4361 on Base, or Ed25519 on Solana.
  - The wallet keeps a prepaid USDC balance on Base or Solana, topped up via `/x402/top-up` with an x402 payment header.
  - Responses report the remaining balance in a header.
  - DIEM from a linked account is spent first.
  - An official MIT client is published as `venice-x402-client`. *(x402)*

## 6. What we adopt / do differently
| Venice approach | Our decision | Req IDs |
|---|---|---|
| Proxy stores no content, keeps only billing metadata | **Adopt**, and go further: keep IP and device info out of logs and keep only daily counters. Document the metadata list publicly. | F-PRV-1 |
| Four privacy levels per model, shown in `/models` | **Adopt the idea, narrower scope:** launch with only *TEE-attested* and *ZDR* models (NEAR, Phala, Tinfoil, Privatemode). No "anonymized" frontier-model proxying at launch, so our privacy claim stays simple and honest. Every model gets a privacy badge. | F-PRV-2, T-PRV-3 |
| Attestation endpoint with nonce; client checks the TDX quote, NVIDIA evidence and debug flag | **Adopt using provider evidence:** a server route fetches NEAR, RedPill or Phala attestation and signed receipts. The UI "Verify" panel checks the nonce, the debug flag and the signing address. | F-PRV-3 |
| Per-response enclave signatures | **Adopt** through NEAR and RedPill receipts. Store the verification result locally next to the message. | F-PRV-3 |
| E2EE: secp256k1 ECDH → HKDF → AES-GCM to the enclave; server features disabled | **Later phase.** Use the provider's own E2EE scheme where it has one (e.g. Chutes, RedPill E2EE); we don't invent our own crypto. Turn off web search and memory in E2EE mode. | F-PRV-4 |
| Our relay sees plaintext unless E2EE is on | **Do differently:** run our Next.js relay inside a TEE (Phala dstack) and publish its attestation, so even non-E2EE chats are protected from us. | F-PRV-1 roadmap |
| Chats stored locally; encrypted backup on paid plans | **Adopt:** local-first (done) plus client-side-key backup for Pro and Max. | F-STO-1/2 |
| OpenAI-compatible API plus a vendor extension object | **Adopt:** our own `x_options` extension, with our own names, for web search and personas. Keep OpenAI compatibility for a future public API. | F-API-1 |
| Characters as public slugs | **Simplify:** personas are private by default (stored locally); sharing is opt-in by link. | F-CHR-1 |
| Plans: Free / $18 / $68 / $200 plus credits and banking | **Do differently:** 3 tiers (Free / €15 / €49, still a proposal). Include fair-use message quotas instead of a credit system at launch; add credits for media later. | F-BIL-1 |
| Rate limits by model size, error budgets, `x-ratelimit-*` headers | **Adopt the pattern:** per-tier rpm/tpm, 429 with reset headers, a failed-request budget against retry storms. | F-BIL-1, T-BIL-1 |
| VVV/DIEM staking token | **Don't copy.** No token at launch; there are regulatory issues (MiCA) for a German UG. | — |
| x402 USDC pay-per-request with wallet sign-in, no account | **Adopt via Zold** (x402 seller side already in the Zold repo, Base Sepolia → Base): use wallet sign-in instead of email accounts, which also fits privacy. | F-API-1, F-BIL-1 |
| Media (image, video, music, TTS, STT), web search and scrape, crypto RPC | **Later.** STT and embeddings are available privately on Privatemode and NEAR; image generation in TEEs is scarce. | F-IMG-* |

## 7. Open questions
- Which models we can claim as TEE-attested end to end (NEAR "Confidential TEE" vs "3P Confidential TEE").
- Legal review of the term "uncensored" and of the content policy (DSA/AGB) before marketing.
- Whether to offer anonymized frontier models (Claude, GPT) as a clearly labelled, lower-privacy option in Max.
