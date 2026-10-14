# Lumo (Proton) public docs study (clean-room notes)

Read on 2026-10-14 from Proton's public pages. We did **not** run REA or any other bundle, decompile or traffic tool on Lumo, and we did not log in or call Lumo. Lumo's web client source (GPLv3) was later read for architecture only; see `code-study-summary.md`. No code was copied, because GPL code would bring GPL obligations into this project. Everything below is our own summary with a source for each fact.

Key sources:
- Security model: https://proton.me/blog/lumo-security-model
- Privacy FAQ: https://proton.me/support/lumo-privacy
- Product and plans: https://proton.me/lumo
- History and licensing: https://en.wikipedia.org/wiki/Lumo_(AI_assistant)
- Open-source claims, critical view: https://discuss.privacyguides.net/t/proton-markets-lumo-as-open-source-but-support-calls-it-a-long-term-intention-not-the-instantaneous-state/30004

## 1. Architecture and privacy model
Lumo's protection rests on two separate layers. *(security-model)*

**a) "User-to-Lumo" (U2L) encryption, for prompts in transit:**
1. The client fetches Lumo's **static PGP public key**, which is published in advance.
2. For each request it creates a fresh **AES key**. It encrypts the whole conversation with that key; the full history is sent each time because the LLM server is memoryless.
3. It wraps the AES key with Lumo's public key and attaches a **request ID**. The request ID is bound as AEAD associated data, so a request or response cannot be swapped or replayed.
4. TLS ends at Proton's edge. Load balancers, backend services and queues forward the payload **still encrypted**.
5. The GPU/LLM server unwraps the key and decrypts in memory. It streams tokens back, each chunk AES-encrypted with the same per-request key and bound to the request ID. The client decrypts them.
6. Proton calls this U2L, not E2EE, because the inference server sees cleartext.

**b) Zero-access chat history, at rest:**
- Key chain: the user's PGP key pair (unlocked by the account password) wraps a per-user **master key**. The master key wraps per-conversation **conversation keys**. Conversation keys encrypt messages, metadata and attachments.
- The server stores and syncs ciphertext only. The browser cache uses the same scheme. *(security-model, privacy)*

**Logs and metadata.** Proton says Lumo keeps no logs of questions or answers, and that it does not store metadata such as timestamps, IP addresses or chat context. Server data is erased after each response. *(privacy)*

**Trust basis.** This rests on **policy and operation**, not cryptographic proof. There is no TEE, no remote attestation and no signed responses; a user has to trust that Proton's inference servers behave as described. Proton runs the models on its own hardware in Europe and uses no third-party inference. *(security-model, privacy)*

**Guest use.** Lumo works without an account, including over Tor. Guest chats are erased when the session ends. *(proton.me/lumo, privacy)*

## 2. Product features (public)
| Feature | Public description | Source |
|---|---|---|
| Models | Open-weight models (Qwen 3.5, GLM 5.3, Apertus 1.5, image models). A router picks the model for each request, and the routing logic is not published. | privacy, wikipedia |
| Web search | Off by default; the user turns it on per chat. Search engines are chosen for privacy. | privacy |
| Projects | Workspaces with files and instructions: 1 on Free, unlimited on Plus. | lumo |
| Custom Lumos | User-defined assistants: unlimited on Plus. | lumo |
| Drive integration | Link Proton Drive files and folders into a chat. | lumo |
| Images | Generation, editing and recognition (v2.0, June 2026). | lumo, wikipedia |
| Memories | Longer context with memories (v2.0). | wikipedia |
| Training | Chats are not used for training. The exception is Apertus feedback that the user chooses to submit. | privacy |
| Apps | Web, iOS and Android. Clients are GPLv3; the server, system prompt and router are proprietary. | wikipedia |

## 3. Plans
- **Free:** limited messages, history, image generations and Max-model use; 1 project.
- **Plus:** $12.99 a month, or $9.99 a month billed yearly ($119.88). More usage, unlimited projects and Custom Lumos. *(proton.me/lumo)*
- **Business:** from about €23 a month (annual) or €28 (monthly), part of Proton Business Suite. This is from the 2025 announcement and may be out of date. *(wikipedia)*

## 4. Lumo vs Venice vs us
| | Venice | Lumo | private-ai (now) |
|---|---|---|---|
| Who sees plaintext | Venice proxy, plus the upstream for non-E2EE models | Proton's LLM server only (U2L); the edge sees ciphertext | Our Next.js relay, plus the TEE provider |
| Proof | TEE attestation and E2EE for some models | None, policy only | TEE attestation and enclave signatures (DCAP chain still TODO) |
| History | Local only; encrypted backup on paid plans | Zero-access encrypted **server sync** across devices | Local only, plus an encrypted backup file |
| Accountless | Yes (x402 wallet) | Yes (guest, Tor) | Yes (anonymous HMAC session) |
| Open code | SDK and docs only | Clients GPLv3 | Everything, MIT-compatible |

## 5. What we adopt / do differently
| Lumo approach | Our decision | Req IDs |
|---|---|---|
| U2L: per-request symmetric key wrapped to a server public key, AEAD bound to the request ID, relay sees ciphertext only | **Adopt the idea, keep the key in an enclave.** Our relay only ever forwards ciphertext; the client encrypts to a key that lives in an **attested** TEE. With a verified enclave key this is Venice-style E2EE, which is stronger than Lumo. Use the provider's scheme where one exists; we don't invent crypto. | F-PRV-4 |
| Zero-access server sync (password → user key → master key → conversation keys) | **Adopt as opt-in sync for Pro/Max.** Same key layering using WebCrypto. The key is derived from a passphrase (or passkey PRF) and never leaves the browser; the server stores opaque blobs and a version counter only. This extends the current `lib/backup.ts`. | F-STO-3 (new) |
| Guest mode, chats erased at session end | **Adopt:** a "Ghost chat" toggle that keeps the conversation in memory only and never writes it to localStorage. | F-STO-4 (new) |
| No logs, no IP or timestamp metadata | **Already adopted:** `lib/log.ts` is metadata-only. Next step: drop the IP even from rate-limit keys (hash with a daily salt). | F-PRV-1 |
| Web search off by default, per-chat toggle | **Adopt.** Search requests go through our relay with no user identifiers, and search is disabled in E2EE mode. | F-SRCH-1 |
| Projects (files + instructions) and Custom Lumos | **Adopt as local-first.** Personas already exist; a project is persona + pinned files, stored encrypted in the browser. | F-CHR-1, F-PRJ-1 (new) |
| Own hardware, no attestation | **Do differently.** Our claim is verifiable: TEE attestation per response. We say this openly in marketing. | F-PRV-3 |
| Hidden model router | **Do differently.** The user picks the model, and any "auto" routing rule is published. | F-MOD-1 |
| GPLv3 clients | **Don't reuse their code** (GPL is incompatible with our licensing plan). We read it for architecture only (`code-study-summary.md`); no code is copied. | — |
