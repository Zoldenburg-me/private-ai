# Bringing Venice and Lumo ideas into private-ai

Based on `docs/venice-docs-study.md`, `docs/lumo-docs-study.md` and the source-code summary in `docs/code-study-summary.md` (Lumo's GPLv3 web client and Venice's MIT repos, read for architecture only, no code copied). No REA, bundle, decompile or traffic analysis was run against either product. This file turns the findings into work items mapped to our code; the security rules in `code-study-summary.md` §3 apply to every item.

## Positioning in one line
Venice proves privacy for *some* models with TEE + E2EE. Lumo encrypts *everything* end to end inside its own pipeline but asks you to trust it, and it syncs history with zero-access encryption. **Our target is both:** encryption to an *attested* enclave for every model we offer, plus optional zero-access sync, with all code open.

## Work items (in priority order)

### P1. Ghost chat (from Lumo guest mode) — small
- In the UI (`app/page.tsx`), a toggle where the chat lives only in React state. `saveChat` from `lib/storage.ts` is never called, and the chat is gone on reload.
- Show a badge on the chat. Persona, backup and export are hidden for ghost chats.
- Test: with ghost mode on, the `KV` mock receives no `setItem` call.

### P2. Web search toggle, off by default (both products) — medium
- `pai_options.web_search` is already parsed in `lib/extensions.ts` and currently dropped.
- Add `lib/search.ts`: the server calls a privacy-respecting search API with **no user id, IP or session id** attached, then injects the results as a system message.
- Turned off and enforced off for E2EE models (P4). Log the metadata flag only.
- Lumo runs search on the server as a tool, with the result coming back as an encrypted `tool_result`. We follow the same split: search runs on the server, the user never sees the provider, and citations come back as numbered markers.

### P3. Zero-access sync (from Lumo's key hierarchy) — medium/large, Pro/Max
- Keys:
  - The user key is derived from a passphrase with PBKDF2 (reuse the parameters in `lib/backup.ts`), later from a passkey PRF.
  - It wraps a random master key (AES-KW or AES-GCM).
  - The master key wraps one random key per chat.
  - Each chat is encrypted with AES-256-GCM, using the chat id and version as AAD.
- Server: `PUT/GET /api/sync/:blobId` stores only `{ciphertext, wrappedKey, version}` per anonymous session id. Writes need a matching `If-Match` version. No titles in plaintext: the title is inside the ciphertext.
- Needs persistent storage. This is the existing "Persist sessions (Redis/DB)" TODO in the README.
- Tests: round-trip encryption; the server never sees plaintext (assert in the route test); rotating the passphrase re-wraps only the master key.
- From the code study:
  - One data key per chat or project, derived with HKDF from a wrapped random key.
  - The AD binds id, role, parent **and a version**; the version is missing in Lumo, which allows rollback.
  - Server-side only opaque ids, timestamps and sizes. Put the message tree shape (parent ids) **inside** the ciphertext; Lumo leaks it.
  - Last-writer-wins per object with a version check, instead of Lumo's "local dirty copy always wins".

### P4. E2EE to an attested enclave (Venice E2EE + Lumo U2L pattern) — large
- Flow, which is also how the Lumo request ID / AEAD idea fits in:
  1. Use the enclave public key from the attestation `lib/attestation.ts` has already verified.
  2. Create a per-request ephemeral key and run ECDH → HKDF-SHA256 → AES-256-GCM.
  3. Bind the request id as AAD.
  4. Encrypt every user and system message.
  5. Decrypt the streamed chunks on the client.
- Our relay (`lib/relay.ts`) forwards ciphertext without change. It must refuse plaintext for E2EE models.
- Use the provider's published scheme (Venice E2EE models, NEAR or RedPill if they offer one); we don't design our own wire format.
- Precondition: the DCAP chain and NRAS checks are done (README TODO). Otherwise "E2EE to an enclave" rests on an unverified key.
- Wire rules (code-study-summary §3):
  - The AD carries request id, direction, role and index; chunks carry a sequence number and a final "end" frame.
  - Fail closed on any decryption failure or plaintext frame.
  - A new key for each upstream call.
  - Tool calls and results travel inside encrypted content.
- For the Venice upstream, stay compatible with their wire format: secp256k1 ECDH (X coordinate) → HKDF-SHA256 with info `ecdsa_encryption` → AES-256-GCM, hex of pubkey ‖ nonce ‖ ciphertext, and the three `X-Venice-TEE-*` headers (details in code-study-summary §0).

### P5. Venice as an optional upstream provider — small, behind a flag
- Venice has a public OpenAI-compatible API (`https://api.venice.ai/api/v1`); Lumo has **no public API**, so Lumo can only be learned from, not integrated.
- Add a `venice` entry in `lib/providers.ts` with the `VENICE_*` env vars.
- In `lib/catalog.ts`, mark only `e2ee-*` models (TEE) and models where `model_spec.privacy=private` (ZDR) as selectable. **Anonymized frontier models stay blocked** by the existing launch policy.
- Attestation path differs: `GET /tee/attestation?model=&nonce=` and `/tee/signature`, not NEAR's `/attestation/report`. `lib/evidence.ts` needs a per-provider endpoint map.
- Open question (business): reselling Venice means Venice's metadata retention applies (account, IP, token counts). We must disclose it in the privacy policy.

### P5b. Accountless paid access (Venice x402) — medium
- Wallet sign-in with an EIP-4361 message: our own domain, a 5-minute window and a one-time nonce. Prepaid USDC balance through an x402 top-up with an EIP-3009 authorization. This is the seller side in Zold.
- Always pay the `payTo` from the 402 response; never a hard-coded address.

### P6. Projects (Lumo) — medium
- A project = a persona (`lib/personas.ts`) + pinned documents + instructions, stored locally (and in P3 sync if enabled).
- Document upload is parsed client-side and sent as context. No server-side file store.
- Retrieval: Lumo uses BM25 over a local index, with no embeddings. We copy the idea with our own implementation: an encrypted index in IndexedDB, top-k chunks within a file token budget, and files the user attached explicitly are dropped last.

### P6b. Context compaction (Lumo) — medium
- Estimate tokens client-side and leave exact limits to the server. Compact in tiers: clear old tool results → drop tool pairs → strip file context → LLM summary of history older than a recent tail. Trigger on the server's context-length error or at about 90% of the budget.

### P6c. Feedback without leakage — small
- If we add thumbs-down feedback, it sends **nothing** by default. Sending the conversation is an explicit, unchecked opt-in that previews exactly what goes out. Lumo checks it by default.

### P7. Pricing check
| | Venice | Lumo | Our proposal |
|---|---|---|---|
| Entry paid tier | Pro $18 | Plus $12.99/mo ($9.99/mo billed yearly) | Pro €15 |
| Top tier | Max $200 | — (Business ~€23–28) | Max €49 |

Our Pro sits between the two. Lumo's yearly price suggests also offering an annual price (about €12/mo).

## Explicitly out of scope
- Running REA's bundle, decompile or traffic tools on venice.ai or lumo.proton.me. This is against our clean-room policy and probably against their terms.
- Reading or copying Lumo's GPLv3 client code into this repo.
- Venice-style token staking (VVV/DIEM); see the MiCA note in the Venice study.
