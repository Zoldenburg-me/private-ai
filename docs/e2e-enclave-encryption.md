# End-to-end encryption to the attested enclave

Design for board task #134. No code ships with this document. It answers items 1 and 2 of the 2026-10-27 trust
assessment ("HiddenSee / Privatai"): today Cloudflare and our relay see every prompt and reply in plaintext, and
the proof panel shows only what the relay hands the browser. The fix: the browser encrypts each request to a key
that it has itself verified to live in the attested enclave, so Cloudflare and the relay carry only ciphertext.

Facts about providers are marked **[confirmed]** (read in their docs or source, with a link) or **[inferred]**.

## 1. Today

```
browser ──TLS──▶ Cloudflare ──tunnel──▶ relay (home server) ──TLS / SDK──▶ provider enclave
          plaintext at Cloudflare      plaintext in relay memory
```

- `lib/client/chat-stream.ts` POSTs plain OpenAI JSON to `/api/chat` or `/api/agent`.
- `lib/handler.ts` parses it, adds the persona system prompt (`lib/extensions.ts`), estimates tokens for the quota,
  picks the provider (including `auto:` routing), adds the provider key, and `lib/relay.ts` streams the reply back.
- `lib/relay.ts` reads the stream: it counts reply characters for billing (`DELTA_TEXT`), takes `usage` from the tail,
  drops upstream `event:` blocks, and hashes the bytes for the `pai_receipt`.
- `lib/agent.ts` runs our own tool loop (Brave `web_search`, `generate_image`), reading tool calls and writing tool
  results into the conversation. For NEAR it passes NEAR's in-enclave `web_context_search` through (`lib/near-search.ts`).
- Attestation: the browser asks `/api/attestation`, which fetches the provider's report with our API key
  (`lib/evidence.ts`). `lib/attestation.ts` + `lib/client/proof.ts` check nonce, debug bit and `report_data`
  binding, but not the Intel DCAP chain, TCB status, NVIDIA NRAS, or which code the enclave runs.
- Tinfoil and Privatemode already encrypt to an attested key (`lib/tinfoil.ts`, `lib/privatemode.ts`), but the SDK
  runs **on our server**, so the relay still sees plaintext before it seals it. Their proof in the browser is only
  the relay's word: `lib/evidence.ts` answers `server_checked: true`.

Consequence: any check the browser runs today can be faked by whoever controls the relay, because the relay could
hand the browser a quote from a different machine, and the browser has no anchor that the relay cannot forge.

## 2. Goal and threat model

After the change, for an E2E chat:

| Party | Sees | Can it read or change content? |
|---|---|---|
| Cloudflare | TLS-terminated HTTP: headers, sizes, timing, ciphertext | No, unless it changes the JavaScript we serve (§8) |
| Our relay | account, model, sizes, timing, token counts, ciphertext | No, unless it changes the JavaScript we serve (§8) |
| Provider gateway outside the enclave | as the relay | No |
| Model enclave | plaintext | Yes: this is the party the attestation proves |

What the relay can still do, by design: see which model, how many tokens, sizes and timing; refuse or delay a chat;
replay a sealed request it saw (bounded by the account's own limits); and, because NEAR's fields carry no associated
data, drop, reorder or duplicate sealed fields or cut the stream. That last group is caught only by the reply
signature check (§7), which is therefore mandatory for the E2E badge.

Out of scope: traffic analysis, a compromised CPU vendor root, and the user's own device.

## 3. The trust anchor the browser needs

E2E encryption is only as strong as the browser's belief that the public key belongs to the right enclave. The relay
carries the attestation report, so every check that makes the key trustworthy must run **in the browser** against
roots that ship **in our client bundle**, not against anything the relay returns. Fetching the report and the
collateral through the relay is fine once they are checked against those roots. The relay can then still block
the chat, choose among genuine enclaves (hence the per-model allowlist in check 5), and serve collateral up to its
maximum age (check 3), but it cannot fake a key.

Checks, in order. A failure on any of them means no E2E chat (fail closed, no plaintext fallback):

1. **Fresh nonce.** The browser makes a 32-byte nonce per attestation; `report_data` must contain it (check 6).
   `verifyReport`'s "nonce echoed" item passes when the report omits `request_nonce`, so the binding that counts is
   the `report_data` one.
2. **Intel DCAP quote chain.** Verify the TDX quote signature → QE report → PCK certificate → Intel SGX Root CA.
   The Intel root certificate is pinned in the bundle. Not done today (the `dcap-chain` item in `lib/client/proof.ts`, shown as "Certificate chain" in `ProofDrawer`).
3. **TCB status and revocation.** Check the PCK CRL, TCB info and QE identity collateral (all signed by Intel) and
   refuse `OutOfDate`/`Revoked` TCB levels; collateral may come via the relay, but its signature and `nextUpdate`
   are checked in the browser, plus a maximum age set in the bundle (TCB info issued within a fixed number of days),
   so the relay cannot keep serving old collateral up to `nextUpdate`. Collateral that is missing, unreachable or
   too old fails closed with its own error text. N1b does this in `lib/client/e2e/dcap.ts` (maximum age 3 days,
   clock tolerance 10 minutes; `ConfigurationNeeded` and `SWHardeningNeeded` levels pass and their advisory ids are
   returned); not wired into the chat yet.
4. **Debug off.** Already done.
5. **Which code runs (measurements).** Without this, any TDX machine passes, including one we could rent ourselves
   and use to read the traffic. The browser must compare MRTD and RTMR0–2 (the CVM's firmware, kernel and OS
   image) to an allowlist, replay the event log into RTMR3, and check that the logged compose hash matches the
   provider's published app (for NEAR: `inference-proxy`) and equals `MRCONFIGID`
   (`expectedMrConfigId` in `lib/client/proof.ts` computes this, but on its own it only shows that the relay-supplied
   compose matches the quote; it proves something once the compose is pinned). The allowlist is **per model**:
   model → measurements, compose hash and image digests (by digest, not tag), each entry with an expiry and a link
   to the provider's public release, so the relay cannot answer model X with a genuine report for model Y. The
   browser picks the report entry for the chosen model itself and rejects entries it cannot verify (NEAR reports can
   carry several `model_attestations`, some in Chutes' format). The allowlist ships in the bundle and changes only
   by a public PR (§9 N2a). Honest limit: unless the provider's images build reproducibly, "the provider's published
   code" means "the image hash we listed".
6. **Key binding.** The encryption public key must be bound to the quote: `report_data` commits to the key and the
   nonce. For NEAR with `signing_algo=ed25519`, `report_data[0..32]` is the padded Ed25519 signing key, which is also
   the encryption key, and `[32..64]` the nonce **[confirmed]** (nearai-cloud-verifier). Today `lib/evidence.ts`
   asks for `signing_algo=ecdsa` and `verifyReport` binds a 20-byte ECDSA address; the E2E path adds the Ed25519
   report and key binding.
7. **GPU (NVIDIA) evidence.** Proves the GPU runs in confidential-computing mode, so the model's memory on the GPU is
   protected too. Not needed for the key binding, but without it a host could run the model on a GPU outside
   confidential-computing mode and read the GPU's memory, so the claim must say so until it is checked. Today we
   compare only the nonce in the GPU evidence, which does not tie that GPU to this CVM; the check must also bind
   the GPU evidence to the CVM's quote **[inferred]: how NEAR binds them is an N0 question**. NVIDIA's NRAS answers no CORS preflight
   **[confirmed]**, but its JWKS does, so the relay can submit the evidence to NRAS and the browser checks the
   returned token's signature (NVIDIA JWKS), nonce and evidence hash itself **[inferred]: needs a test**. Stage N2
   ships without it and says so; N3 adds it.

Checks 2, 3 and 5 are the work. DCAP verification in the browser needs ECDSA-P256 and X.509 parsing:
Web Crypto does P-256, and `@noble/curves` (already a dependency) does too. NEAR's verifier uses Phala's
`dcap-qvl` (Rust, with a Node binding) **[confirmed]**. N1a chose our own TypeScript parser over a Wasm build:
`lib/client/e2e/dcap.ts` (quote and QE report signatures, PCK chain to the pinned root, on `@noble/curves`), so no
`'wasm-unsafe-eval'` in the CSP; it is tested against dcap-qvl's sample quotes and not wired into the chat yet. Collateral: Intel PCS sends no CORS headers, Phala's PCCS does **[confirmed]**;
either way it is Intel-signed, so the relay may also fetch and cache it. N1b's relay route
`/api/attestation/collateral?fmspc=…&ca=…` (`lib/collateral.ts`) fetches it from Intel PCS server-side, so no new
CSP origin. Tested against dcap-qvl's sample quotes and collateral, plus re-signed fixtures for revoked and old collateral.

### Rules the client enforces

The relay is the party we guard against, so the rules that stop a downgrade live in the client bundle, not on the
relay:

- **The E2E list is in the bundle.** Which providers and models must be sealed is a constant in the client, not a
  catalog field the relay serves. The client never sends plaintext to a listed model.
- **Fail closed, visibly.** If any check fails, the chat shows the failed check and a retry button, and sends
  nothing. Leaving E2E for a message is only possible by an explicit, visible user choice (owner question 1, §9).
- **Keys live in memory only**, per tab (ghost chat writes nothing; each tab attests on its own). A verified key is
  reused until the earlier of the collateral's maximum age and a short fixed lifetime; on a decrypt or signature
  failure the tab re-attests once, then fails closed. The browser cannot see a key rotation, so it does not try to.
- **A fresh client key per request.** `X-Client-Pub-Key` travels in clear; reusing it would link chats.
- **Pin the backend.** The client sends `X-Model-Pub-Key` with the key it verified, so NEAR routes to that backend
  when a model runs on several. It is a routing hint only: it sits outside the seal and the relay can change it, but
  a wrong backend cannot decrypt, so the chat fails rather than leaks.
- **Unverified until signed.** A NEAR reply shows as "unverified" while it streams and until its signature checks
  out; on failure the message is marked failed and the badge drops.
- **Cheap checks while streaming.** Before the signature arrives, the browser stops the stream and marks the reply
  failed at once if: a sealed field does not decrypt; an `ephemeral_pub ‖ nonce` pair or a whole ciphertext repeats
  within the reply (replay or duplicate); the chunk `id` or `model` changes mid-stream; data follows the final chunk;
  or the stream ends without `finish_reason`, `usage` and `[DONE]` (truncation). These catch duplicates and cuts
  early. They do not catch injected or reordered fields, which only the signature check catches.
- **Clock.** The collateral age check uses the browser clock, so it allows a small tolerance and reports a skewed
  clock as its own error.

## 4. Request flow after the change

```
1  browser → relay  GET /api/attestation?model=near:X&nonce=N         (relay fetches it with our key; returns bytes as is)
2  browser          verify §3 checks → enclave public key K (kept in memory, see "Rules the client enforces")
3  browser          seal the body to K (provider's own protocol, §5); plaintext never leaves the tab
4  browser → relay  POST /api/chat  { model, e2e: { …provider headers… }, encrypted body }
5  relay            session, tier, quota, credits by size; add provider key; forward the body byte for byte
6  provider enclave decrypt, run, encrypt reply to the browser's ephemeral key
7  relay            pipe stream back; read only plaintext metadata (usage, finish); never decrypt
8  browser          decrypt, show, store in local encrypted history as today
```

We do not invent a wire format. Each provider's own E2E protocol is used as published (§5), so the enclave code that
decrypts is theirs and already attested.

### Speed and the first message

The first message decides whether a new user stays, so verification must not feel like waiting.

What it costs (estimates; N0 measures them against NEAR's real reports):

- Verification runs once per model per tab, not per message. The checks themselves are a few signature
  verifications, estimated at tens of milliseconds.
- Intel's collateral is cached on the relay (it is Intel-signed, so the cache cannot fake it). The relay fills the
  cache at startup and refreshes it before it expires, so the first user after a restart does not wait for PCCS.
- The verifier code (about 1 MB if `dcap-qvl` Wasm, [inferred]) is a content-hashed, `immutable` static asset,
  prefetched on the landing and sign-up pages and compiled with `WebAssembly.compileStreaming`, so it is usually in the
  HTTP cache before the chat page opens. No service worker: stale security code is the wrong risk to take for speed.
- Only the first E2E message to a model in a new tab can wait: fetching NEAR's report plus the checks, estimated at a
  few hundred milliseconds. Every later message reuses the key from memory.

How the UI hides it:

1. **Verify ahead.** For models on the bundle's E2E list, attest the selected model when the chat page opens, again
   when the user picks a model, and when the composer gets focus. Usually the check is done before the user presses
   send. The result is keyed by model id and never reused for another model; switching models drops the pending
   check. Verify-ahead calls go through `proxyEvidence`, so they share `LIMITS.evidence` (30 a minute per account,
   with per-reply signature fetches) and `LIMITS.evidenceAll` (600 a minute for everyone). Only the selected model is
   checked ahead, once per tab; with the background re-checks (item 4) and the re-attest after a decrypt or signature
   failure (§3: once, then fail closed, so forced failures cannot loop), N2f sizes the global cap for launch traffic.
2. **Optimistic message.** The thread already shows the user's message at once (`useLocalRuntime` in
   `components/app/ChatThread.tsx`); keep it that way, and mark it "not sent yet" until it is
   sealed and sent; the send button never waits on verification. Sending happens only after every check passed, so
   stopping before then sends and charges nothing.
3. **Skeleton with steps.** The reply placeholder is a skeleton with one short status line that moves on as each
   step ends: "Checking the enclave" → "Encrypting" → "Waiting for the model". The step names double as a trust
   signal instead of a bare spinner.
4. **Re-check in the background.** A verified key is used only while all of these hold: its collateral is inside the
   bundle's maximum age, its allowlist entry has not expired, and its own lifetime has not ended. Before the earliest
   of these, a background attestation runs the full §3 checks with a fresh nonce; its key replaces the old one only if
   it passes, and a failed re-check drops the old key at once. This is a speed rule, not an exception to §3.
5. **Fast, plain failure.** A failed check shows inline under the message with the reason and a retry button, never
   an endless skeleton.

Speed target, measured in the browser (Playwright, throttled Fast 4G profile, against the mock), so no new logged
field is needed: for a message sent within 2 s of opening the page, the extra time to first token over today's
plaintext path is at most 300 ms at p75 and 1 s at p95; later messages are no slower. The mock cannot show NEAR's
report and collateral latency, so the target counts as met only after the same measurement against live NEAR, run
from a local script with our key read from the environment (as in N0; never committed, logged or put in a
browser or trace), also passes.

## 5. Providers

Sources read: nearai/cloud-api@85f8600, nearai/inference-proxy@5faff1b, nearai/nearai-cloud-verifier@9455472,
tinfoilsh/tinfoil-js@9082953, tinfoilsh/encrypted-http-body-protocol@036e4a3, npm `privatemode-ai@1.60.0`, and the
provider docs linked below. Live checks were limited to CORS and auth (no encrypted chat was sent).

### NEAR AI Cloud (`near`): field-level E2EE, v2

- **Scheme [confirmed]** (inference-proxy `src/encryption.rs`, `nacl_v2`; docs.near.ai/cloud/guides/e2ee-chat-completions):
  Ed25519 keys on both sides, converted to X25519 for ECDH; HKDF-SHA256, no salt, info `ed25519_encryption`;
  XChaCha20-Poly1305, no AAD. Each encrypted field is hex of `ephemeral_pub(32) ‖ nonce(24) ‖ ciphertext+tag`, in
  both directions. The server key is the model's attested Ed25519 `signing_public_key`.
- **Headers [confirmed]:** `X-Signing-Algo: ed25519`, `X-Client-Pub-Key`, `X-Encryption-Version: 2`,
  `X-Encrypt-All-Fields: true`, `X-Model-Pub-Key` (pins the backend; the gateway strips it). Without the version
  header the server falls back to v1, which the verifier flags as broken: the client always sends `2`.
- **Encrypted [confirmed]:** each message's `content` and `reasoning`; with all-fields also tool definitions,
  `tool_choice`, tool-call names and arguments. Image messages: the whole content-parts array is serialised to JSON
  and encrypted as one string. In the stream, each chunk's `content`, `reasoning`, `tool_calls`, and
  `nearai_tool_result.output` are encrypted separately.
- **Plaintext [confirmed]:** `model` and sampling parameters, `id`, `role`, `finish_reason`, `tool_call_id`, the tool
  result's `name`/`status`, and `usage`. So the relay can still route, cap, and bill from real token counts.
- **Footguns [confirmed]:** a plaintext content array passes through unencrypted without an error, and all-fields
  decryption accepts plaintext too. The client seals every field itself; the relay also checks that every `content`
  (and, with tools, every tool field) is a hex string at least 56 bytes long, as a bug catcher, not as the defence.
- **No associated data [confirmed]:** roles, order, sampling parameters and `finish_reason` are outside the seal, so
  only the reply signature (§7) shows that the relay changed them: the browser compares the signed request hash
  with the hash of the exact bytes it sent, so any change to a plaintext field fails the check.
- **Where it is decrypted [confirmed]:** in the model's CVM (inference-proxy). NEAR's cloud-api gateway, itself a TDX
  enclave, forwards ciphertext and sees what our relay sees.
- **Web search [confirmed]:** `web_context_search` runs in the model CVM; only the query leaves it, to Brave, over
  TLS. Tool results reach us encrypted. Our relay can still count searches (tool-call indexes and
  `finish_reason: "tool_calls"` are plaintext), so the `maxPerRun` limit in `lib/agent.ts` keeps working, but the query text and the
  source list are decrypted and shown by the browser, not by `lib/near-search.ts`.
- **Signatures [confirmed]:** `/v1/signature/{id}` still works and signs `sha256(request body):sha256(response)` over
  the bytes as sent, i.e. the ciphertext, in the form `model:req:resp` (inference-proxy #50). The relay must forward
  the browser's body byte for byte (§6).
- **Attestation [confirmed]:** `/v1/attestation/report?model=&signing_algo=ed25519&nonce=` needs our API key (live:
  401 without), so the relay fetches it (as `lib/evidence.ts` does today) and the browser verifies it. CORS on
  cloud-api allows any origin, so a later direct path is possible, but it would need a key in the browser.
- **Alternative, not chosen [confirmed]:** NEAR's gateway also speaks OHTTP (`/.well-known/ohttp-gateway`,
  `POST /ohttp`, chunked for streams) and can inject an outer `Authorization`. That hides even `model` and usage from
  us, but the gateway enclave then sees plaintext, and we would lose billing data. Field encryption to the model CVM
  is the better fit.

### Tinfoil (`tinfoil`): whole-body EHBP

- **Scheme [confirmed]** (EHBP `SPEC.md`): HPKE X25519 / HKDF-SHA256 / AES-256-GCM, info `ehbp request`; response
  keys exported with label `ehbp response` plus a 32-byte response nonce. Headers `Ehbp-Encapsulated-Key`,
  `Ehbp-Response-Nonce`; bodies are length-prefixed chunks, so streaming works (chunk sizes leak). The key is at
  `/.well-known/hpke-keys`.
- **Key binding [confirmed]** (`packages/verifier/src/attestation.ts`): SEV-SNP `report_data[0..32]` is the TLS key
  fingerprint, `[32..64]` the HPKE key; the measurement is checked against a Sigstore bundle (Rekor, Fulcio) of the
  published enclave image. GPU attestation runs inside the enclave at boot and is trusted transitively (docs).
- **Browser [confirmed]:** `@tinfoilsh/verifier` is plain TypeScript and verifies the AMD SEV-SNP chain (AMD roots
  built in) and Sigstore in the browser. It has no TDX or NVIDIA code: a Tinfoil model on TDX would not verify
  (**[inferred]** our routed Tinfoil models are on SEV-SNP; checked per model in step T1).
- **Proxy pattern [confirmed]** (docs.tinfoil.sh/guides/proxy-server, `tinfoilsh/examples/encrypted-request-proxy-example`):
  the browser SDK takes `baseURL` and `attestationBundleURL` pointing at our relay; the relay forwards
  `/attestation` to Tinfoil and `/v1/*` to the enclave named in `X-Tinfoil-Enclave-Url` (allowlisted to
  `*.tinfoil.sh`), adds `Authorization`, and passes the `Ehbp-*` headers unchanged. `X-Tinfoil-Model` tells the relay
  the model and the enclave checks it against the body. With `X-Tinfoil-Request-Usage-Metrics: true`, usage comes
  back in `X-Tinfoil-Usage-Metrics` (an HTTP trailer for streams).
- **Our side:** today `lib/tinfoil.ts` runs the SDK on the server. E2E moves `SecureClient` into the browser and the
  relay becomes the documented proxy. The verifier also fetches from `kds-proxy.tinfoil.sh` and
  `github-proxy.tinfoil.sh` (AMD and Sigstore data, signed); we route those through the relay too, so CSP stays
  `'self'`. `user_cache_secret` moves into the sealed body as a random value (128 bits from `crypto.getRandomValues`) the browser makes per chat and keeps in
  memory, so no server-derived account secret reaches the tab; the cache is then shared only within one chat.
- **Gaps to close in T1:** the Sigstore bundle arrives through the relay, which could serve an older, validly signed
  release, so the bundle pins the config repo and a minimum release. Whether Tinfoil's router decrypts and re-seals
  between hops, so E2E would end at the router rather than the model enclave, is **[inferred] open** and gates the
  T1 claim. Tinfoil signs no replies, so a truncated or reordered stream is caught only if EHBP's framing marks the
  end; to be read in T1.
- **Fit:** the smallest build of all providers. Tinfoil does in-enclave search too (`web_search_options`, Exa) per
  the #92 research notes, not yet checked under EHBP.

### Privatemode (`privatemode`)

- **[confirmed]** (npm `privatemode-ai@1.60.0`): the SDK's ~27 MB Wasm runs in a browser
  (`dangerouslyAllowBrowser: true`); options include `apiBaseURL`, `auth` (key or JWT) and `expectedWasmHash`. Key
  agreement with Privatemode's secret service uses post-quantum HPKE (X25519MLKEM768), then AES-GCM over the whole
  body, sealed per event when streaming. Plaintext headers: model, estimated token count, secret id, shard key.
- **[inferred]:** our relay as `apiBaseURL`, adding the key, would see only ciphertext. Not documented; needs a test
  and a question to Edgeless. 27 MB in the chat bundle needs lazy loading and `'wasm-unsafe-eval'` in the CSP.

### Phala (`phala`) and RedPill (`redpill`)

- **[confirmed]:** `inference.phala.com/v1` is an attested gateway; clients verify with `/v1/aci/attestation`
  (legacy `/v1/attestation/report`), TLS pinning and signed receipts. The report lists encryption keys
  (`secp256k1-aes-256-gcm-hkdf-sha256`, version `2`) but no client procedure or headers are documented.
- **Consequence:** no E2E from the browser until Phala documents it. A browser behind our relay cannot pin Phala's
  TLS. RedPill's relationship to Phala today was not confirmed.

### Venice (`venice`), Liquid (`liquid`), Custom (`custom`), Mock (`mock`)

- **Venice [confirmed]** (docs.venice.ai/guides/features/tee-e2ee-models): separate `e2ee-*` models in TEEs,
  secp256k1 + HKDF (`ecdsa_encryption`) + AES-256-GCM, `X-Venice-TEE-*` headers, attestation at
  `/api/v1/tee/attestation`; text only, no web search, no file uploads, tool definitions not encrypted. Our Venice
  routes today are the anonymized (non-TEE) models; E2E would mean adding the `e2ee-*` models as a TEE provider.
- **Liquid:** nothing found (absence not confirmed). Anonymized gateway: no enclave, no E2E possible.
- **Custom:** no enclave; never E2E. **Mock:** gets a test implementation of the NEAR scheme, plus a test-only
  trust root and allowlist injected only in test builds (`lib/mock-tee.ts` has no Intel chain); a build test proves
  neither is in the production bundle.

## 6. What the relay still sees and still does

The relay keeps every job that does not need the text.

| Job | Today | After |
|---|---|---|
| Auth (session, device, invite gate) | cookie + headers | unchanged |
| Routing (`provider:model`) | body `model` | plaintext `model` field, as today |
| `auto:` routing | relay picks the provider after parsing | the browser asks for the route first (`GET /api/route?model=auto:X`), checks the answer against its own E2E list, then attests that provider; the relay rejects a body whose plaintext `model` differs from the route |
| Persona system prompt | relay prepends it (`lib/extensions.ts`) | the browser prepends it before sealing |
| Body validation (roles, message count, images only in user messages) | relay parses messages (`lib/extensions.ts`) | not possible on ciphertext; the enclave rejects malformed bodies. The relay keeps the byte cap (`MAX_BODY_BYTES`) |
| Quota estimate before the call | `estimateBodyTokens` on plaintext | the client declares the image count and plaintext text length in a header; the relay estimates as today (text bytes, plus the flat `IMAGE_TOKENS` per image), so an image is not counted by its bytes. The daily quota uses that estimate; the **credit** pre-check uses the hard upper bound from the sealed body size, so under-declaring cannot pass a balance check it would fail. The charge uses NEAR's plaintext `usage` |
| Output cap (`max_tokens`), `stream_options.include_usage`, Liquid/Tinfoil extras | relay rewrites the body | the relay must not touch the body (NEAR signs its exact bytes; EHBP seals all of it). The browser sets these from the limits the relay already returns, and the relay **checks** them: NEAR's are plaintext fields; Tinfoil's cap is checked after the fact from `X-Tinfoil-Usage-Metrics` |
| Credit billing | `usage` from the stream tail, else `replyChars/3` | NEAR: `usage` is plaintext, unchanged. Tinfoil: the usage header/trailer. Privatemode: estimate from sealed reply bytes until tested. A missing `usage` is never billed as zero: it is logged (`usage_missing`) and charged from the sealed body bound plus the sealed reply bytes |
| `pai_receipt` hashes | relay hashes upstream bytes | NEAR signs the ciphertext hashes, so the relay's hashes still match, but the browser hashes what it sent and received and uses its own; the relay's receipt becomes a hint |
| Reply text count (`DELTA_TEXT`) | regex over plaintext deltas | a raw byte count of the reply, enough for the stop-early charge (NEAR's `usage` is plaintext) |
| Upstream `event:` filter, appended `pai_receipt` | relay drops named events and appends its receipt to the stream | E2E mode passes the upstream stream through unmodified, so the browser hashes exactly the bytes the enclave signed; no receipt in the stream (the browser uses its own hashes). The browser, not the relay, ignores events it does not know |
| Logs | metadata only | unchanged; no `e2e` log field. The collateral cache (N1b) lives in process memory, not Redis, so `lib/data-inventory.ts` gets no new entry; if either changes, the inventory changes in the same PR |

New relay rule, on the browser routes (`/api/chat`, `/api/agent`) only: a model on the E2E list accepts only sealed
bodies, and a plaintext body is a 400. This catches our own bugs; the defence against a hostile relay is the client
rule in §3. `/api/v1/chat/completions` shares `handleChat` and stays plaintext, with a test.

Forwarding byte for byte is new work: `relay()` takes the body as an object and re-serialises it with
`JSON.stringify` for both the upstream bytes and `req_sha256`. The E2E path needs a raw-body path through
`lib/handler.ts` and `lib/relay.ts`.

## 7. What breaks or changes

- **Our Brave search loop** (`lib/agent.ts`, tool `web_search`): needs to read the model's tool call and write the
  results into the conversation, so it cannot run on an E2E chat. NEAR's in-enclave `web_context_search` keeps working:
  its tool calls and results are encrypted to the browser (§5). Other providers: agent mode is off for E2E chats, and the UI says
  "Web search sends your query outside the enclave; turn it on to leave end-to-end mode for this message."
- **Image generation tool** (`generate_image`): same reason; off in E2E chats. A later step can let the browser call
  the image model with its own sealed request.
- **Receipts and reply signatures**: NEAR signs `sha256(request):sha256(response)` over the ciphertext **[confirmed]**.
  The browser computes both hashes itself over the exact bytes it sent and received, then checks the signature from
  `/api/signature` against **its own** hashes (the signed request hash must equal the hash of the bytes it sent, so a
  relay that changed any field fails) and the attested key (Ed25519 for the E2E report). Stronger than today:
  the relay can no longer feed matching hashes. This check is mandatory for the E2E badge, since it is the only thing
  that catches dropped, reordered or truncated fields (§2). The 3-part `model:req:resp` form is accepted by
  `verifySignedResponse` once PR #76 merges (open at the time of writing); the E2E step adds the Ed25519 path.
  Tinfoil and Privatemode sign no replies; nothing changes there.
- **Usage counting**: see §6. For flat-quota models nothing changes in practice; for credit models the estimate is
  coarser only where a provider seals `usage`.
- **Attachments**: documents are already text inside the user message, so they are sealed with it. Images
  (`image_url` data URLs) are sealed on NEAR (the parts array as one encrypted string) and on Tinfoil and Privatemode
  (whole body). Venice's E2EE models take no files. Hex encoding doubles a NEAR body, so the 4 MiB cap
  (`MAX_BODY_BYTES`) needs a separate E2E constant (about 8.5 MiB) with a test, or images shrink before sealing.
- **History**: unchanged. It is decrypted and stored in the browser as today (`lib/client/vault.ts`).
- **The OpenAI-compatible API** (`/api/v1/chat/completions`): stays plaintext; API clients that want E2E use the
  provider's own SDK against our endpoint later (out of scope here). The docs say which routes are E2E.
- **Proof panel**: the badge reads "Encrypted to verified enclave" only when every §3 check ran in this browser and
  the chat was sealed; otherwise it shows today's levels. The DCAP/TCB/measurement items move from "not checked yet"
  to real results.
- **CSP**: no new origin while all traffic goes through the relay. Wasm (a `dcap-qvl` build, Privatemode's SDK) needs
  `'wasm-unsafe-eval'` in `script-src` of `buildCsp()`, with a case in `tests/csp.test.ts`. A direct fetch from a
  provider would add its origin the same way.

## 8. The hole this does not close: we serve the code

The browser runs JavaScript that our server (and Cloudflare, which terminates TLS) delivers. A malicious relay or
Cloudflare could ship a client that skips the checks or copies the plaintext. E2E moves trust from "the relay at
every request" to "the client code we publish", which is a real gain (one artifact anyone can check, instead of
invisible server behaviour), but not "trust no one". Steps that narrow it, in order of cost:

1. Open-source the web client and relay, with a reproducible build and the bundle hash published per release
   (trust assessment item 4).
2. Turn off every Cloudflare feature that rewrites responses (Rocket Loader, Zaraz, email obfuscation, Auto Minify)
   and pin that in the Cloudflare config.
3. Later, not on the board: a small verifier (browser extension or native app) that checks the served bundle hash
   against the published one.

The public claim must say this (§10).

## 9. Rollout

Board-sized steps, NEAR first. Each is one PR unless marked as a spike. Order: C2 and C1a first (cheap, honest
today); N0; then N1a and N2b in parallel; N1b after N1a; N2a after N1b; N2c1 after N0; N2c2 any time before N2d;
N2d after all of those; N2f after N2d; C1a and N2f before N2e. T1 reuses N2c1's passthrough mode, so it starts after N2c1. N3 is optional
after N2 (N2's claim states the GPU gap).

| Step | Size | What (files) | Done when |
|---|---|---|---|
| C2 | small | Every non-E2E route says so in the model picker and proof drawer ("Our server passes this chat on in plaintext") (`lib/client/proof.ts`, `components/app/ProofDrawer.tsx`, `lib/client/levels.ts`) | no route claims more than it does |
| C1a | small | Cloudflare response-rewriting features (Rocket Loader, Zaraz, email obfuscation, Auto Minify) off and pinned in config | checked on the zone; noted in AGENTS.md |
| N0 | spike | Live probe of NEAR E2EE v2 with our key from a script (no product code): field coverage incl. an image, `usage` plaintext, signature form on the Ed25519 path, `web_context_search` under E2E, several backends per model, how GPU evidence binds to the CVM, whether every streamed chunk keeps one `id` and the stream ends with `usage` and `[DONE]` under E2EE (needed by the in-stream checks, §3), whether a third party holding only `X-Client-Pub-Key` can forge reply fields that decrypt; pick `dcap-qvl` Wasm or our own parser | a note in the shared folder; §5 updated where it differs |
| N1a | medium | Browser DCAP: quote signature, QE report, PCK chain to the Intel root pinned in the bundle; CSP `'wasm-unsafe-eval'` if Wasm (`middleware.ts`, `tests/csp.test.ts`) | `dcap-chain` passes or fails for real; fixtures incl. a forged quote |
| N1b | medium | TCB info, QE identity, CRLs, maximum collateral age; collateral through a cached relay route (process memory), filled at startup and refreshed before expiry | fixtures incl. revoked and too-old collateral fail closed with their own text |
| N2a | medium | Per-model NEAR allowlist (measurements, compose hash, image digests, expiry, release link), RTMR3 replay, report entry chosen by the browser; Ed25519 report (`lib/evidence.ts` `signing_algo`, `lib/attestation.ts` `verifyReport` key binding); update procedure in this doc | a quote from an unknown image, or a genuine report for another model, fails in the browser |
| N2b | medium | `lib/client/e2e/near.ts`: per-request Ed25519 key, seal request fields (image parts as one string, tool fields), open streamed fields; mock speaks the scheme, with a test-only trust root (`lib/mock-tee.ts`) | round-trip tests, one fixed vector from NEAR's Python verifier, a build test that the test root is not in the prod bundle |
| N2c1 | medium | Relay E2E mode on `/api/chat` and `/api/agent`: raw-body passthrough and unmodified reply stream (`lib/relay.ts`, `lib/handler.ts`), shape check (plaintext → 400), declared-count quota (`lib/tiers.ts`); `/api/agent` for an E2E NEAR chat no longer needs Brave configured (`handleAgent` returns 503 without it today), cap and `include_usage` checked not written, E2E body-cap constant, raw byte count | relay tests: plaintext refused, sealed body forwarded byte for byte, billing from plaintext `usage`, API route still plaintext |
| N2c2 | small | `GET /api/route` for `auto:` (`lib/routing.ts`, new `app/api/route`); persona prompt moved to the browser, per-chat random `user_cache_secret` (`lib/extensions.ts`) | tests for both |
| N2d | medium | UI: the bundle's E2E list; chats to listed models are sealed or not sent (error with the failed check, retry); in-memory key cache; verify ahead (page open, model pick, composer focus) and the optimistic "not sent yet" message; fast inline failure with retry (§4); in-enclave search events decrypted in the browser; Brave and image tools off on E2E chats (`lib/agent.ts`, `app/api/agent`); signature checked against the browser's own hashes, badge only if it passes (`lib/client/chat-stream.ts`, `lib/client/proof.ts`, `components/app/ProofDrawer.tsx`) | browser-pane check at phone and desktop width; one sealed chat against the mock end to end |
| N2f | small | First-message polish (§4): skeleton with step names; background re-check before expiry; verifier prefetched on landing and sign-up as an immutable asset | the §4 speed target met against the mock and against live NEAR; `LIMITS.evidenceAll` sized for launch traffic |
| N2e | small | Behind a flag, then on for NEAR; `/datenschutz`, `/privacy/metadata`, `app/agb` and the homepage get the §10 N2 claim | flag on in prod; pages match the claim |
| N3 | medium, optional | NVIDIA evidence: relay submits to NRAS, browser checks the token (NVIDIA JWKS), nonce, evidence hash and binding to the CVM quote | "GPU evidence" passes for real; claim drops the GPU sentence |
| T1 | medium | Tinfoil in the browser: `SecureClient` with `baseURL`/`attestationBundleURL` = relay; relay as the documented proxy (enclave-URL allowlist, `Ehbp-*` passthrough, `/attestation`, KDS and Sigstore data); pinned minimum release; usage from `X-Tinfoil-Usage-Metrics`; per-model SEV-SNP check; router-hop question answered | Tinfoil chats sealed; `lib/tinfoil.ts` server SDK only for the API route |
| P1 | spike | Privatemode SDK in the browser with the relay as `apiBaseURL`; ask Edgeless whether that is supported; measure the 27 MB load | go / no-go note |
| C1b | medium | Open-source client and relay, reproducible build, bundle hash published per release | anyone can rebuild and compare the served bundle |

Not a board task: ask Phala for a documented client E2E procedure; until then Phala and RedPill stay
relay-visible and labelled (C2).

Owner decisions, one question each:

1. **Failure:** when the browser cannot verify the enclave, should the chat stay blocked (recommended: a hostile relay
   could force failures to steer users into plaintext), or may the user send that one message unencrypted after a
   warning that our server and Cloudflare will see it (per message, never remembered, never retried automatically)?
2. **Web search:** on E2E chats without in-enclave search, should web search be off, or allowed per message with a
   warning that this message is not end-to-end encrypted?
3. **Max Privacy:** once NEAR and Tinfoil are E2E, should Max Privacy offer only E2E routes?
4. **Source:** will you publish both the web client and the relay source (C1b)? Without it the §10 C1b line cannot be
   claimed.
5. **Venice:** should we add Venice's `e2ee-*` TEE models as a provider (text only, no search, no files)?

## 10. What we may claim at each stage

The honest-wording task sets today's text. Each later line replaces the matching part only when its steps are on
`main` and deployed. Never claim "no one can see", "zero-knowledge" or "trustless": the enclave reads the text by
design, and the relay still sees metadata.

| Stage | Claim we can make |
|---|---|
| Today | "Your chat runs in a hardware enclave at the model provider. Our server and Cloudflare pass it on in memory, in plaintext, and store nothing." |
| N1a + N1b | Today's line, plus: "Your browser checks the enclave's Intel certificate chain itself." |
| N2 (NEAR) | "With NEAR models, and as long as the web app we serve is unmodified, your browser encrypts each message to a key it has verified belongs to NEAR's attested enclave (Intel TDX), running the image versions we list for that model. Our server and Cloudflare forward only ciphertext; we still see which model, how many tokens, and when. The GPU's attestation is not checked in your browser yet, so the enclave's GPU memory is not proven protected." Other providers keep today's line. |
| N3 | The NEAR line without the GPU sentence. |
| T1 (Tinfoil) | Only once the router-hop question (§5) is answered: "With Tinfoil models, and as long as the web app we serve is unmodified, your browser verifies the enclave (AMD SEV-SNP) and its published code (Sigstore), and encrypts each message to it. Our server and Cloudflare forward only ciphertext; we still see which model, how many tokens, and when." |
| C1b | Adds: "You can rebuild the web app and compare it with what we serve." |
| Phala, RedPill, Privatemode (until P1), Venice, Liquid, Custom | Today's line or the incognito line; never the E2E line. |
