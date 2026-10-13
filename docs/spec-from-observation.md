# Spec from public observation (clean-room)

**Method.** Black-box only. Sources are Venice's public marketing pages and public API docs, read as text on 2026-10-13. We did **not** look at, download, decompile, deobfuscate or copy any Venice client bundle, source map, prompt, asset or brand. We did not create accounts, log in or call the Venice API. Every requirement below is written in our own words and is a functional goal only; the design and code are ours.

Sources:
- https://venice.ai/pricing
- https://venice.ai/features
- https://venice.ai/blog/new-subscription-tiers
- https://docs.venice.ai/overview/privacy
- https://github.com/veniceai (public org: SDK/CLI/docs only; the app is not open source)

## Observed public feature set (summarised)
| Area | Publicly stated behaviour | Our requirement (ID) |
|---|---|---|
| Storage | Conversations stored locally on the device only | F-STO-1: chats persist in browser storage; server never stores chat content |
| Backup | Encrypted chat backup/restore (paid) | F-STO-2: optional backup encrypted client-side with a user-held key (Pro+) |
| No content logs | Proxy relays requests and does not store prompt/response | F-PRV-1: API route never logs or persists bodies; only metadata (counts) |
| Privacy levels | Per-model levels: anonymized → private (ZDR) → TEE (attested) → E2EE to a verified TEE | F-PRV-2: each model is tagged with a privacy level in the UI; default list shows only TEE/ZDR models |
| Attestation | TEE models support remote attestation | F-PRV-3: "Verify" button shows provider attestation / signed receipt for a response |
| E2EE | Client encrypts the prompt for a verified enclave; server-side features (search, memory) are off in this mode | F-PRV-4 (later): E2EE mode; disable server-side features while it is on |
| Text chat | System prompt, temperature, top-p, document upload, long context | F-CHT-1..4 |
| Models | Many open-weight models; a model catalogue with capabilities | F-MOD-1: model picker fed by provider `/models` plus our metadata |
| Characters | Custom personas, shareable | F-CHR-1 (later): persona = saved system prompt + name; sharing is opt-in |
| Images | Generation, upscale, background removal, variants | F-IMG-* (later phase) |
| Tiers | Free / Pro $18 / Pro+ $68 / Max $200; monthly credits with banking | F-BIL-1: 3 tiers + usage gate; credits later |
| API | OpenAI-compatible API, crypto (x402) pay-per-request | F-API-1 (later): expose our own API; x402 via Zold |

## Test cases (acceptance, for OUR app)
- **T-STO-1:** send a message, reload the page → the chat is still listed; the server has no chat record (no DB, and the route has no write path). *(unit test exists: tests/storage.test.ts)*
- **T-STO-2:** "Wipe all" → the storage key is removed and the list is empty. *(unit)*
- **T-PRV-1:** `/api/chat` responds with `Cache-Control: no-store` and does not log the request body. *(code review + e2e header check)*
- **T-PRV-2:** with no provider key configured, `/api/chat` returns 503 and sends nothing upstream.
- **T-PRV-3:** a provider without a TEE or ZDR tag is not offered by default. *(TODO)*
- **T-CHT-1:** the streamed response renders incrementally; partial SSE frames are handled. *(unit: tests/storage.test.ts › sse)*
- **T-BIL-1:** Free tier is blocked after 20 messages a day and on context over 8k. *(unit: tests/tiers.test.ts)*
- **T-BIL-2:** the tier must come from a server-verified entitlement. *(TODO, currently a stub)*
- **T-E2E-1:** the rea browser scenario `tests/e2e/rea-own-app-scenario.json` runs against **our own** localhost app only.
