import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

/**
 * NEAR AI Cloud field-level E2EE, version 2 (docs/e2e-enclave-encryption.md §5, step N2b), as in
 * nearai/inference-proxy `src/encryption.rs` (`nacl_v2`): Ed25519 keys converted to X25519, ECDH with a
 * fresh ephemeral key, HKDF-SHA256 (no salt, info "ed25519_encryption"), XChaCha20-Poly1305 without AAD.
 * Each field is hex of ephemeral_pub(32) ‖ nonce(24) ‖ ciphertext+tag, in both directions.
 *
 * Only content travels sealed: model, sampling parameters, roles, ids, finish_reason and usage stay plain,
 * and nothing binds fields to their place, so only the reply signature (§7) catches a relay that moves,
 * drops or repeats them. Not wired into the chat yet; the enclave key must come from a verified report (§3).
 */

export class NearE2eError extends Error {}

const INFO = utf8ToBytes("ed25519_encryption");
const MIN_BYTES = 32 + 24 + 16;
const HEX = /^(?:[0-9a-f]{2})+$/i;

/** Ed25519 key pair; `secret` is the 32-byte seed and stays in memory. */
export type NearKey = { secret: Uint8Array; publicHex: string };

export function nearKey(): NearKey {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, publicHex: bytesToHex(ed25519.getPublicKey(secret)) };
}

const fieldKey = (shared: Uint8Array) => hkdf(sha256, shared, undefined, INFO, 32);

function x25519Pub(edPubHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(edPubHex)) throw new NearE2eError("near e2e: enclave key is not 32 bytes of hex");
  try {
    return edwardsToMontgomeryPub(edPubHex);
  } catch (e) {
    throw new NearE2eError("near e2e: enclave key is not an Ed25519 point", { cause: e });
  }
}

/** Seals `text` to an Ed25519 public key. `rand` is for the fixed test vector only. */
export function sealField(text: string, recipientPubHex: string, rand: (n: number) => Uint8Array = randomBytes): string {
  const recipient = x25519Pub(recipientPubHex);
  const eph = rand(32);
  const nonce = rand(24);
  const ct = xchacha20poly1305(fieldKey(x25519.getSharedSecret(eph, recipient)), nonce).encrypt(utf8ToBytes(text));
  return bytesToHex(concatBytes(x25519.getPublicKey(eph), nonce, ct));
}

/** Opens one sealed field with the recipient's Ed25519 seed; throws on plaintext, a wrong key or tampering. */
export function openField(hex: string, secret: Uint8Array): string {
  if (!HEX.test(hex)) throw new NearE2eError("near e2e: field is not sealed (not hex)");
  const b = hexToBytes(hex);
  if (b.length < MIN_BYTES) throw new NearE2eError("near e2e: sealed field too short");
  try {
    const key = fieldKey(x25519.getSharedSecret(edwardsToMontgomeryPriv(secret), b.subarray(0, 32)));
    return new TextDecoder("utf-8", { fatal: true }).decode(xchacha20poly1305(key, b.subarray(32, 56)).decrypt(b.subarray(56)));
  } catch (e) {
    throw new NearE2eError("near e2e: field does not decrypt", { cause: e });
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const each = (v: unknown, f: (o: Obj) => void) => Array.isArray(v) && v.filter(isObj).forEach(f);
/** Applies `f` to a non-empty string field, as NEAR does (empty strings are never sealed). */
const str = (o: unknown, k: string, f: (s: string) => string) => {
  if (isObj(o) && typeof o[k] === "string" && o[k] !== "") o[k] = f(o[k] as string);
};
/** Like `str`, but arrays and objects go as one JSON string (content parts, tool parameter schemas). */
const json = (o: unknown, k: string, f: (s: string) => string) => {
  if (isObj(o) && typeof o[k] === "object" && o[k] !== null) o[k] = f(JSON.stringify(o[k]));
  else str(o, k, f);
};
const fnFields = (fn: unknown, f: (s: string) => string) => {
  str(fn, "name", f);
  str(fn, "arguments", f);
};

/**
 * Applies `f` to every request field inference-proxy decrypts with X-Encrypt-All-Fields (a copy; the input
 * is not changed). The client seals with it; the mock enclave opens with it.
 */
export function mapRequestFields<T extends object>(body: T, f: (s: string) => string): T {
  const b = structuredClone(body) as Obj;
  each(b.messages, (m) => {
    json(m, "content", f);
    for (const k of ["reasoning_content", "reasoning", "refusal", "name"]) str(m, k, f);
    each(m.tool_calls, (tc) => fnFields(tc.function, f));
    fnFields(m.function_call, f);
  });
  each(b.tools, (t) => {
    if (!isObj(t.function)) return;
    str(t.function, "name", f);
    str(t.function, "description", f);
    json(t.function, "parameters", f);
  });
  if (isObj(b.tool_choice)) str(b.tool_choice.function, "name", f);
  if (isObj(b.function_call)) str(b.function_call, "name", f);
  return b as T;
}

function odd(what: string): never {
  throw new NearE2eError(`near e2e: unexpected reply shape (${what})`);
}

/**
 * Applies `f` to every field inference-proxy seals in a reply chunk or message (a copy). Content in any
 * other shape than NEAR sends throws, so a relay cannot slip plaintext past the opener.
 */
export function mapReplyFields<T extends object>(chunk: T, f: (s: string) => string): T {
  const c = structuredClone(chunk) as Obj;
  /** The object at `o[k]`, or undefined; anything else is not NEAR's shape. */
  const obj = (o: Obj, k: string): Obj | undefined => (o[k] == null ? undefined : isObj(o[k]) ? o[k] : odd(k));
  const list = (o: Obj, k: string): Obj[] =>
    o[k] == null ? [] : Array.isArray(o[k]) && o[k].every(isObj) ? (o[k] as Obj[]) : odd(k);
  const field = (o: Obj | undefined, k: string) => {
    if (o && o[k] != null && typeof o[k] !== "string") odd(k);
    str(o, k, f);
  };
  for (const choice of list(c, "choices")) {
    if (choice.text !== undefined) odd("choices[].text");
    if (choice.logprobs != null) odd("logprobs"); // sealed per token by NEAR; we never ask for them
    // Both, so a plaintext `message` slipped next to a `delta` cannot pass unopened.
    for (const m of [obj(choice, "delta"), obj(choice, "message")]) {
      if (!m) continue;
      if (Array.isArray(m.content))
        for (const part of list(m, "content")) field(typeof part.text === "string" ? part : odd("content part"), "text");
      else field(m, "content");
      for (const k of ["reasoning_content", "reasoning", "refusal"]) field(m, k);
      for (const fn of [...list(m, "tool_calls").map((tc) => obj(tc, "function")), obj(m, "function_call")]) {
        field(fn, "name");
        field(fn, "arguments");
      }
      field(obj(m, "nearai_tool_result"), "output");
    }
  }
  return c as T;
}

/**
 * Seals a chat request to the enclave's verified Ed25519 key with a fresh client key: a reused
 * X-Client-Pub-Key would link chats. Send `body` as JSON with `headers`; keep `key` to open the reply.
 */
export function sealRequest<T extends object>(body: T, enclavePubHex: string): { body: T; headers: Record<string, string>; key: NearKey } {
  x25519Pub(enclavePubHex); // refuse a bad key even when no field needs sealing
  const key = nearKey();
  return {
    body: mapRequestFields(body, (s) => sealField(s, enclavePubHex)),
    headers: {
      "X-Signing-Algo": "ed25519",
      "X-Client-Pub-Key": key.publicHex,
      "X-Encryption-Version": "2", // without it NEAR falls back to v1
      "X-Encrypt-All-Fields": "true",
      "X-Model-Pub-Key": enclavePubHex.toLowerCase(),
    },
    key,
  };
}

/** The reply fields the client may read: what NEAR seals, plus the plaintext it leaves for routing and billing. */
export type NearFunction = { name?: string; arguments?: string };
export type NearMessage = {
  role?: string;
  content?: string | { type?: string; text: string }[] | null;
  reasoning_content?: string;
  reasoning?: string;
  refusal?: string;
  tool_calls?: { index?: number; id?: string; type?: string; function?: NearFunction }[];
  function_call?: NearFunction;
  nearai_tool_result?: { tool_call_id?: string; name?: string; status?: string; output?: string };
};
export type NearChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: { index?: number; finish_reason?: string | null; delta?: NearMessage; message?: NearMessage }[];
};

const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
/** Copies only those `keys` of `o` that hold a scalar, so no relay text hides in an object; undefined for a missing object. */
function pick(o: unknown, keys: string[], ok = scalar): Obj | undefined {
  if (!isObj(o)) return undefined;
  return Object.fromEntries(keys.filter((k) => ok(o[k])).map((k) => [k, o[k]]));
}
const defined = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function message(m: unknown): NearMessage | undefined {
  if (!isObj(m)) return undefined;
  const fn = (f: unknown) => pick(f, ["name", "arguments"]);
  return defined({
    ...pick(m, ["role", "content", "reasoning_content", "reasoning", "refusal"]),
    ...(Array.isArray(m.content) && { content: m.content.map((p) => pick(p, ["type", "text"])) }),
    tool_calls: Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc: Obj) => defined({ ...pick(tc, ["index", "id", "type"]), function: fn(tc.function) }))
      : undefined,
    function_call: fn(m.function_call),
    nearai_tool_result: pick(m.nearai_tool_result, ["tool_call_id", "name", "status", "output"]),
  }) as NearMessage;
}

/**
 * Opens one streamed chunk (or a whole reply) and returns only the fields listed in NearChunk: anything
 * else a relay adds is dropped, a sealed field that does not open or an odd shape throws. An error body is
 * not a chunk; callers handle errors by HTTP status.
 * What opens is still UNVERIFIED: X-Client-Pub-Key travels in clear, so a relay can seal text of its own
 * to it, or swap the header for its own key, read the reply and re-seal it. Show the text as unverified and
 * act on no tool call until the reply signature (§7) checks out over the exact bytes received.
 */
export function openReply(chunk: object, secret: Uint8Array): NearChunk {
  const c = mapReplyFields(chunk, (s) => openField(s, secret)) as Obj;
  return defined({
    ...pick(c, ["id", "object", "created", "model"]),
    usage: pick(c.usage, ["prompt_tokens", "completion_tokens", "total_tokens"], (v) => typeof v === "number"),
    choices: Array.isArray(c.choices)
      ? c.choices.map((ch: Obj) => defined({ ...pick(ch, ["index", "finish_reason"]), delta: message(ch.delta), message: message(ch.message) }))
      : undefined,
  }) as NearChunk;
}
