import { randomBytes } from "node:crypto";
import { DEFS, loadProviders, type ProviderConfig } from "./providers";
import { kek, openKey, sealKey } from "./keyvault";
import { stores } from "./store";
import { metaLogger } from "./log";

/**
 * Provider API keys managed in the admin panel. Precedence: the DB wins. A provider with an
 * active stored key uses it; a provider without one uses its env key (<PREFIX>_API_KEY). A stored
 * key that cannot be decrypted (ADMIN_KEY_KEK missing or wrong) switches the provider off instead
 * of silently falling back to env. Keys are decrypted only here, server-side, and cached in
 * memory for CACHE_MS; admin changes clear the cache of this process, other processes follow
 * within CACHE_MS.
 */
const CACHE_MS = 30_000;
/** last_used_at is written at most this often per key and process. */
const USED_EVERY_MS = 10 * 60_000;

type Resolved = Map<string, { id: string; key: string } | null>;
// Shared via globalThis: Next bundles each route separately, and admin routes must clear the chat routes' cache.
const g = globalThis as unknown as { __paiKeys?: { until: number; keys: Resolved }; __paiKeyUsed?: Map<string, number>; __paiKeyGen?: number };
/** Bumped on every local key change: drops the cache, discards loads already in flight, and tells the catalog cache to refresh. */
export const keyGeneration = () => g.__paiKeyGen ?? 0;
export const invalidateKeys = () => { g.__paiKeys = undefined; g.__paiKeyGen = keyGeneration() + 1; };
export const _resetKeyCache = () => { invalidateKeys(); g.__paiKeyUsed = undefined; };

/** Keys for services that are not chat providers: the agent's video tool (lib/video-gen.ts) reads BFL_API_KEY. */
const TOOL_KEYS = [{ id: "bfl", name: "Black Forest Labs (FLUX 3 Video, Anon mode)", prefix: "BFL" }];

/** Providers an admin can store keys for: all but the dev-only mock, plus TOOL_KEYS. A new provider in DEFS (e.g. Venice) shows up here. */
export const keyProviders = () => [...DEFS.filter((d) => d.id !== "mock").map(({ id, name, prefix }) => ({ id, name, prefix })), ...TOOL_KEYS];

const aad = (provider: string, id: string) => `${provider}:${id}`;

async function storedKeys(): Promise<Resolved> {
  if (g.__paiKeys && Date.now() < g.__paiKeys.until) return g.__paiKeys.keys;
  const gen = keyGeneration();
  const rows = await (await stores()).accounts.activeProviderKeys();
  let k: Buffer | null = null;
  try { k = kek(); } catch { k = null; }
  const keys: Resolved = new Map(rows.map((r) => {
    try {
      if (!k) throw new Error("no KEK");
      return [r.provider, { id: r.id, key: openKey(r.ciphertext, aad(r.provider, r.id), k) }] as const;
    } catch {
      metaLogger({ provider: r.provider, event: "provider_key_unusable" });
      return [r.provider, null] as const;
    }
  }));
  // A key changed while this load was running: its rows may be stale, so do not cache them.
  if (gen === keyGeneration()) g.__paiKeys = { until: Date.now() + CACHE_MS, keys };
  return keys;
}

/** `env` with stored keys as <PREFIX>_API_KEY; an undecryptable one blanks it. Throws StoreUnavailableError when Postgres is down (fail closed). */
export async function liveEnv(env: Record<string, string | undefined> = process.env): Promise<Record<string, string | undefined>> {
  const keys = await storedKeys();
  if (keys.size === 0) return env;
  const merged = { ...env };
  for (const d of keyProviders()) if (keys.has(d.id)) merged[`${d.prefix}_API_KEY`] = keys.get(d.id)?.key ?? "";
  return merged;
}

/** loadProviders with stored keys applied. Throws StoreUnavailableError when Postgres is down (fail closed). */
export async function liveProviders(env: Record<string, string | undefined> = process.env): Promise<ProviderConfig[]> {
  const keys = await storedKeys();
  return loadProviders(await liveEnv(env)).map((p) => { const k = keys.get(p.id); return k ? { ...p, keyId: k.id } : p; });
}

/** Record that a stored key was used (throttled). */
export async function markKeyUsed(id: string, now = Date.now()): Promise<void> {
  const used = (g.__paiKeyUsed ??= new Map());
  if (now - (used.get(id) ?? 0) < USED_EVERY_MS) return;
  used.set(id, now);
  await (await stores()).accounts.markProviderKeyUsed(id, now);
}

/** True if ADMIN_KEY_KEK is set and well-formed. */
export const kekUsable = () => { try { return kek() !== null; } catch { return false; } };

export class KeyError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Printable ASCII without spaces; at least 8 characters so the 4-character suffix does not give most of it away. */
const KEY_SHAPE = /^[\x21-\x7e]{8,1024}$/;

/** Encrypt and store `key` as the provider's active key. Returns the new key id and suffix, never the key. */
export async function storeProviderKey(provider: unknown, key: unknown): Promise<{ id: string; suffix: string }> {
  if (typeof provider !== "string" || !keyProviders().some((p) => p.id === provider)) throw new KeyError(400, "unknown provider");
  if (typeof key !== "string" || !KEY_SHAPE.test(key.trim())) throw new KeyError(400, "key must be 8 to 1024 printable characters");
  let k: Buffer | null;
  try { k = kek(); } catch { throw new KeyError(503, "ADMIN_KEY_KEK is invalid (must be 32 bytes, base64)"); }
  if (!k) throw new KeyError(503, "ADMIN_KEY_KEK is not configured on this server");
  const plain = key.trim();
  const id = `pk_${randomBytes(9).toString("base64url")}`;
  const suffix = plain.slice(-4);
  await (await stores()).accounts.addProviderKey({ id, provider, ciphertext: sealKey(plain, aad(provider, id), k), suffix, createdAt: Date.now() });
  invalidateKeys();
  return { id, suffix };
}
