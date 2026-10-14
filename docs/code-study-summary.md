# Source-code architecture summary: Lumo and Venice

**What was read** (2026-10-14):

| Source | License | Commit | Scope |
|---|---|---|---|
| ProtonMail/WebClients: `applications/lumo`, `packages/lumo-api-client`, `packages/lumo-ui`, `packages/llm` | GPLv3 | `64862561` | ≈118k lines of TS/TSX, the Lumo web client |
| veniceai/venice-cli | MIT | `c1ccec43` | CLI, including the full E2EE client |
| veniceai/venice-mcp-server | MIT | `cb85d624` | MCP server |
| veniceai/x402-client | MIT | `af98a196` | wallet auth and top-up |
| veniceai/skills | MIT | `5eaeac57` | API usage guides |

**What was not read:**
- Venice's web app. It is closed source, and we did not obtain, deobfuscate or capture its bundle or traffic.
- Lumo's server. It is proprietary and not published.
- `@protontech/crypto`. It is not part of the checkout, so the points that depend on it are marked *inferred* in the notes.

**Rules followed:**
- This summary is the only record kept from the study. The detailed per-area notes were deleted so that implementers work from this page and from `venice-lumo-integration-plan.md` only.
- The summary contains no code and no verbatim prompts; everything is in our own words.
- No code from these repos may be pasted into private-ai. The Lumo code is GPLv3; copying it would make our code GPL.

**Caveat:** this is not a strict black-box clean room, because the source was read. Our protection is that we copy nothing and write our own design and code.

## 0. Interop facts needed for the Venice provider
These are the facts needed to talk to Venice's public API; they are interface facts, not implementation.
- **E2EE wire format:**
  - Attestation: `GET /api/v1/tee/attestation?model=&nonce=<64 hex>`, no auth. The returned `signing_key` (uncompressed secp256k1) is also the encryption key. Its Keccak-256 address must equal the first 20 bytes of the TDX REPORTDATA; reject the quote if the debug bit is set.
  - Encryption: per message, a fresh ephemeral secp256k1 key pair → ECDH (X coordinate) → HKDF-SHA256 (no salt, info `ecdsa_encryption`, 32 bytes) → AES-256-GCM (12-byte nonce, no AAD). The wire format is hex of ephemeral pubkey (65 bytes) ‖ nonce ‖ ciphertext and tag. Only `user` and `system` contents are encrypted.
  - Request: headers `X-Venice-TEE-Client-Pub-Key`, `X-Venice-TEE-Model-Pub-Key` and `X-Venice-TEE-Signing-Algo: ecdsa`, plus `venice_parameters.enable_e2ee: true`. Streaming is required.
  - Response: each `delta.content` is a separate ciphertext addressed to the client's session key.
  - Signatures: `GET /tee/signature?request_id=&model=` returns an EIP-191 signature over the request and response hashes. The recovered signer must be the attested address.
- **x402 auth (no account):**
  - Header `SIGN-IN-WITH-X`: base64 of JSON with `address`, `message`, `signature`, and optionally `chainId` and `timestamp`.
  - The message is EIP-4361 on Base (chain 8453): 5-minute validity and a one-time nonce. On Solana it is signed with Ed25519.
  - Top-up: POST `/x402/top-up` → 402 with `accepts[]` → sign an EIP-3009 USDC transfer authorization to the given `payTo` → retry with the `PAYMENT-SIGNATURE` header.
  - Balance arrives in the `x-venice-balance-usd` / `x-venice-balance-diem` response headers.

## 1. Lumo architecture in one page
1. **Transport (U2L).** The chat request is OpenAI-compatible. It goes to Proton's `ai/v1/chat/completions` using the account session.
   - **Per-request key:** the client makes a fresh AES-256-GCM key and wraps it with OpenPGP to a server key that is **pinned in the client build** (Curve25519). There is no runtime fetching or rotation.
   - **Associated data:** a fixed string built from the request ID (one for request turns, one for response chunks).
   - **What is encrypted:** each turn's content, images, tool calls (sent as an encrypted `lumo_tool_call` role) and tool results.
   - **What stays plaintext:** the model, tool schemas, roles, order and sizes.
   - **Response:** an SSE stream where each delta is a separate GCM ciphertext. Server progress shows up as `: queued` and `: ingesting` comment lines.
2. **Storage.** The key chain is account PGP key → AES-KW master key (stored on the server, PGP-encrypted) → per-space key → HKDF → an AES-GCM data key.
   - Spaces (chat or project), conversations, messages and attachments each have a plaintext envelope and an encrypted body.
   - Associated data binds the ids, role and parent. The message tree stores edits and regenerations as siblings.
   - IndexedDB keeps the same ciphertext as the server, with dirty flags.
   - Redux-saga does write-through and push/pull, driven by an event stream; for conflicts, the local dirty copy wins.
3. **Pipeline.** The client adds only small system turns: a compaction summary, instructions (personalization plus project instructions, or memories), and visualization and artifact hints. The **server** adds the persona and the tools.
   - The token estimate is characters ÷ 4.
   - Compaction works in four steps: clear tool results, drop tool pairs, strip files, then an LLM summary.
   - Files are parsed in the browser (pdf.js, pandoc-wasm, SheetJS). Project retrieval is **BM25 over a local index, with no embeddings**.
   - Memories: every 10 prompts, the model pulls facts from recent prompts.
4. **App.**
   - **Guest mode** keeps everything in memory, and logged-out chats can be moved into an account after login.
   - **Ghost chats** skip all persistence.
   - **Projects, custom agents and Drive linking** are available.
   - **Limits:** about 30 Unleash feature flags. Server-reported quotas arrive through usage data and 429 responses. The free tier's 7-day retention is enforced by the client.
5. **Trust gap.** There is no attestation. Plaintext exists on Proton's GPU workers, and users have to trust Proton.

## 2. Venice (public code) in one page
1. **Auth.** There are three ways to authenticate:
   - a Bearer API key, which can carry spending caps and a privacy limit
   - a web3-minted key: the wallet signs a JWT, and it needs staked VVV
   - x402 with no account: a `SIGN-IN-WITH-X` header carrying an EIP-4361 message (5-minute window, one-time nonce) or an Ed25519 signature on Solana. USDC top-ups use EIP-3009 signatures, sent after a 402 response.
2. **E2EE.**
   - **Enclave key:** fetch `/tee/attestation` with a 32-byte nonce. The enclave's signing key (secp256k1) also serves as its encryption key.
   - **Encryption:** each message uses a fresh ephemeral key, then ECDH (X coordinate) → HKDF-SHA256 (info `ecdsa_encryption`) → AES-256-GCM with **no associated data**. The wire format is hex of pubkey ‖ nonce ‖ ciphertext.
   - **Headers:** three `X-Venice-TEE-*` headers.
   - **Limits:** streaming is required, and there is no system prompt, search or tools.
   - **Signatures:** `/tee/signature` returns an EIP-191 signature over the request and response hashes.
3. **Gap in their client.** It does not verify the DCAP quote chain or pin measurements. It relies on Venice's own `server_verification` result.

## 3. Lessons for private-ai: what we do *better* than both
| Weakness found | Where | Our rule |
|---|---|---|
| Associated data has no sequence number or position; chunks can be reordered or dropped, and a bad chunk is silently skipped | Lumo transport | AD = request id ‖ direction ‖ role ‖ index (chunks: sequence number, plus a final "end" frame). A decryption failure **aborts** the stream. |
| Plaintext chunks are accepted on an encrypted request (downgrade) | Lumo transport | Once a request is encrypted, reject any plaintext frame. |
| One key and AD reused across title, suggestion and tool-round requests | Lumo transport | Use a new key and request id for each upstream call. |
| Silent fallback to plaintext when no key is available | Lumo transport | Encryption is required for E2EE models; fail closed. |
| Associated data has no version → the server can roll back to an older ciphertext | Lumo storage | Put a monotonic version in the AD and keep the highest version seen on the client. |
| Search index stored as plaintext full text in IndexedDB | Lumo storage | Encrypt every local store, with no exceptions. |
| Ghost-mode checks are inconsistent (the attachment push has no check) | Lumo app | One `persist` gate that every write goes through, with a test. |
| Thumbs-down feedback uploads the whole conversation, opted in by default | Lumo app | Off by default; show exactly what is sent and get explicit consent. |
| `console.log` writes prompts and attachments | Lumo | Keep `lib/log.ts` metadata-only and add a lint rule against `console.*` in the client. |
| Server key pinned in the build with no attestation | Lumo | Take the enclave key from a **verified attestation** (`lib/attestation.ts`). |
| Client trusts the server's attestation verdict and does not check the DCAP chain | Venice CLI | Verify the DCAP chain and NRAS ourselves (README TODO), and pin MRTD/RTMR allowlists. |
| E2EE uses no associated data at all | Venice | Our own scheme uses AD as above. For Venice upstream we must stay wire-compatible, so keep their format there. |

## 4. Patterns worth reimplementing (in our own code)
- Carry tool calls and results inside **encrypted content** rather than plaintext `tool_calls` (Lumo `lumo_tool_call`).
- SSE comment frames for queue status (`queued` / `ingesting`) so the UI can show "waiting for enclave GPU".
- A per-entity split into plaintext envelope and encrypted body, with AD binding id, role and parent (+ version, see above).
- A message tree with sibling branches for edits and regenerations.
- Compaction in tiers before calling the LLM to summarize.
- Local BM25 project retrieval. It needs no embeddings server, so no plaintext leaves the browser.
- Moving a guest chat into an account, sealed with a short time limit.
- `#fragment` parameters instead of `?query` for prefilled prompts, so the prompts never reach server logs.
- From Venice: x402 / SIWX wallet sign-in for accountless paid use (fits Zold), and E2EE wire-compatibility for the Venice provider.

See `../venice-lumo-integration-plan.md` for the prioritised work items.
